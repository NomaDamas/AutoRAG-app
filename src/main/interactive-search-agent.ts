import { existsSync } from "node:fs";
import type { AutoRAGAgentOptions, RetrievalOptions, SearchDocumentsResponse } from "@autorag/librarian";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode } from "../shared/interaction-contract";
import type { AgentInteraction } from "./agent-interaction";
import { AttachmentContextAgent } from "./attachment-context";
import type { RunInteraction } from "./host-ui";
import { watchLocalTrack } from "./local-track";

/**
 * The AI Search agent for one chat: the librarian agent with attachment context, able to ask the person, and holding
 * ONE model conversation for the whole chat, the way the librarian's terminal UI does.
 *
 * Without a conversation, every question of a chat would start a new model session and the model would not see the
 * questions and answers before it ("no, search the internet" would mean nothing). With the pi session the librarian
 * binds through {@link AutoRAGAgent.createPiInteractiveRuntime}, the first question runs the librarian's full
 * pipeline (fast answer, verification) and every follow-up is a plain turn of the same transcript: the model answers
 * from the conversation or searches by tool call. The conversation lives in a session file, so after a restart
 * {@link openSession} resumes it, like pi's `/resume`.
 *
 * The person answers in the AI Search panel: `ask_user` questions, and the approvals the librarian's file-change
 * gate asks for in `ask` and `auto` mode. {@link bindRun} says which run is asking.
 */

/** One finished turn of a chat that has no session file yet. */
export interface SeedTurn {
	readonly question: string;
	readonly answer: string;
}

export interface OpenSessionOptions {
	/** The session file this chat kept: the conversation resumes from it. A file that is gone starts a new conversation. */
	readonly resumeFile?: string | undefined;
	/** The turns of a chat that predates its session file; the new conversation starts with them already in it. */
	readonly seed?: readonly SeedTurn[] | undefined;
}

export interface OpenedSession {
	/** Where the conversation is kept. Pi writes the file with the first answer, not before. */
	readonly sessionFile: string | undefined;
	readonly resumed: boolean;
	readonly seeded: number;
}

type Runtime = Awaited<ReturnType<InteractiveSearchAgent["createPiInteractiveRuntime"]>>;

/** What the librarian calls the user's own words in a conversation: Jev reads them to judge what the person asked for. */
interface UserRequestSink {
	record(text: string): void;
}

/**
 * The conversation's log of what the person said. The librarian feeds it from its terminal input hook, and a host
 * that runs searches itself has no way to: the log is a private field of the agent, so it is reached here by name.
 * Without it Jev would judge a file change against nothing and `auto` could never approve one. Missing or reshaped
 * after a librarian release: the agent fails to build, instead of quietly judging against nothing.
 */
function userRequestsOf(agent: object): UserRequestSink {
	const log: unknown = Reflect.get(agent, "userRequests");
	const record: unknown = typeof log === "object" && log !== null ? Reflect.get(log, "record") : undefined;
	if (typeof record !== "function") {
		throw new Error("The librarian no longer keeps AutoRAGAgent.userRequests: feed what the person said to Jev another way.");
	}
	return { record: (text) => void Reflect.apply(record, log, [text]) };
}

function zeroUsage(): AssistantMessage["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Writes a session file holding `turns` through pi's own writer, so its format is pi's; undefined when pi keeps none. */
function writeSeededSession(cwd: string, sessionDir: string | undefined, model: Model<Api>, turns: readonly SeedTurn[]): string | undefined {
	const manager = SessionManager.create(cwd, sessionDir);
	for (const turn of turns) {
		const at = Date.now();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: turn.question }], timestamp: at });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: at,
		});
	}
	return manager.getSessionFile();
}

export class InteractiveSearchAgent extends AttachmentContextAgent {
	readonly #interaction: AgentInteraction;
	readonly #sessionDir: string | undefined;
	readonly #userRequests: UserRequestSink;
	#runtime: Runtime | undefined;

	constructor(options: AutoRAGAgentOptions, interaction: AgentInteraction) {
		super({
			...options,
			tools: [...(options.tools ?? []), interaction.askUserTool],
			// The app's own `ask_user` (a question card) stands in for the librarian's terminal one, which it would
			// otherwise load into the conversation as well.
			piExtensionPaths: options.piExtensionPaths ?? [],
		});
		this.#interaction = interaction;
		this.#sessionDir = options.piSessionDir;
		this.#userRequests = userRequestsOf(this);
	}

	/**
	 * Opens the chat's conversation: resumes `resumeFile`, else starts one (with `seed` already in it). Must be called
	 * before the first question; the questions of the chat then share this conversation.
	 */
	async openSession(options: OpenSessionOptions = {}): Promise<OpenedSession> {
		if (this.#runtime !== undefined) throw new Error("This chat's conversation is already open.");
		const resumeFile = options.resumeFile !== undefined && existsSync(options.resumeFile) ? options.resumeFile : undefined;
		const seed = resumeFile === undefined ? (options.seed ?? []) : [];
		const runtime = await this.#openRuntime();
		try {
			if (resumeFile !== undefined) {
				const result = await runtime.runtime.switchSession(resumeFile);
				return { sessionFile: runtime.runtime.session.sessionFile, resumed: !result.cancelled, seeded: 0 };
			}
			const file = seed.length === 0 ? undefined : writeSeededSession(runtime.runtime.cwd, this.#sessionDir, runtime.runtime.session.model as Model<Api>, seed);
			if (file !== undefined) await runtime.runtime.switchSession(file);
			return { sessionFile: runtime.runtime.session.sessionFile, resumed: false, seeded: file === undefined ? 0 : seed.length };
		} catch (error) {
			// A session file that cannot be read must not take the chat with it: the chat goes on in a new conversation.
			console.warn("[search] could not open the chat's session, starting a new one:", error instanceof Error ? error.message : error);
			await this.closeSession();
			const fresh = await this.#openRuntime();
			return { sessionFile: fresh.runtime.session.sessionFile, resumed: false, seeded: 0 };
		}
	}

	async #openRuntime(): Promise<Runtime> {
		const runtime = await this.createPiInteractiveRuntime();
		this.#runtime = runtime;
		// pi's own RPC mode does exactly this: a replaced session (resume, new) is bound again to the same host UI.
		runtime.runtime.setRebindSession(async (session) => this.#bind(session));
		await this.#bind(runtime.runtime.session);
		return runtime;
	}

	async #bind(session: AgentSession): Promise<void> {
		await session.bindExtensions({ uiContext: this.#interaction.ui, mode: "rpc" });
	}

	/** The file this chat's conversation is kept in, once it has one. */
	get sessionFile(): string | undefined {
		return this.#runtime?.runtime.session.sessionFile;
	}

	/** Ends the conversation's session in this process; the file stays, and {@link openSession} resumes from it. */
	async closeSession(): Promise<void> {
		const runtime = this.#runtime;
		this.#runtime = undefined;
		await runtime?.dispose();
	}

	override async searchDocuments(query: string, options: RetrievalOptions = {}): Promise<SearchDocumentsResponse> {
		const text = query.trim();
		if (this.#runtime !== undefined && text !== "") {
			// In a conversation the librarian assumes its terminal hook already logged the question, and builds no
			// prompt of its own for a follow-up, so both are done here before it runs.
			await this.#deliverAttachments();
			this.#userRequests.record(text);
		}
		return super.searchDocuments(query, options);
	}

	/**
	 * A follow-up is sent to the model as typed, so the attachment block (which the first question gets in its prompt)
	 * goes into the conversation as a message of its own, ahead of the question.
	 */
	async #deliverAttachments(): Promise<void> {
		const context = this.attachmentContext;
		const session = this.#runtime?.runtime.session;
		if (context === "" || session === undefined || !session.messages.some((message) => message.role === "assistant")) return;
		await session.sendCustomMessage({ customType: "dazzi.attachments", content: [{ type: "text", text: context }], display: false }, { triggerTurn: false });
	}

	/** Calls `listener` once per run, when the run takes the local track (see {@link watchLocalTrack}); returns the stop function. */
	onLocalTrack(listener: () => void): () => void {
		return watchLocalTrack(this, listener);
	}

	/** The run the next dialogs belong to; `undefined` once it ended. */
	bindRun(run: RunInteraction | undefined): void {
		this.#interaction.bind(run);
	}

	/** Takes effect on the next gated call; the session's "allow for this session" grants end with the old mode. */
	setApprovalMode(mode: ApprovalMode): void {
		this.permissionControl.set(mode);
	}
}
