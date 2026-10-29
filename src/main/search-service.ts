import { access } from "node:fs/promises";
import {
	buildAgentOptions,
	resolveConfigReadOnly,
	type AutoRAGAgent,
	type AutoRAGAgentOptions,
	type SearchDocumentsResponse,
	type SearchDocumentsStreamEvent,
} from "@autorag/librarian";
import { readRawConfigObject, resolveAgentModel, resolveConfigPath, type CliConfig } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../shared/settings-contract";
import { applyDazziThinkingLevels, resolveSessionModel } from "@autorag/librarian/profiles";
import { applyAppIndexing, readAppIndexing } from "./app-indexing";
import { resolveNodeBinary, runAutomationToolOnNode } from "./automation-runtime";
import { ensureEmbeddingForConfig } from "./embedding-daemon";
import { agentOptionsForSemantic, applySemanticPolicyToAgent } from "./semantic-policy";
import { syncCalendarMcpConfig } from "./calendar-mcp";
import type {
	AnswerPhase,
	AnswerPhaseName,
	ChatAttachment,
	ChatMessage,
	ChatMessageAssistant,
	ChatRecord,
	ChatMessageUser,
	IndexNotice,
	SearchBridge,
	SearchErrorAction,
	SearchStreamEvent,
} from "../shared/search-contract";
import { SEARCH_CHANNELS } from "../shared/search-contract";
import { buildAttachmentContext } from "./attachment-context";
import { InteractiveSearchAgent, type OpenedSession, type OpenSessionOptions, type SeedTurn } from "./interactive-search-agent";
import { createAgentInteraction } from "./agent-interaction";
import type { RunInteraction } from "./host-ui";
import type { InteractionHub } from "./interaction-hub";
import { type ApprovalMode, DEFAULT_APPROVAL_MODE } from "../shared/interaction-contract";
import type { ChatStore } from "./chat-store";
import type { ChatSessionIndex } from "./chat-sessions";
import { t } from "../shared/i18n/core";
import { durationBucket, type Analytics } from "./analytics-core";

/**
 * The slice of a pi agent event the live stream reads. `searchDocumentsStream`
 * only yields progress/preliminary/complete, so thinking and the answer text
 * come from `subscribe`.
 */
export interface LiveAgentEvent {
	readonly type: string;
	readonly message?: {
		readonly role?: string;
		readonly stopReason?: string;
	};
	readonly assistantMessageEvent?: {
		readonly type: string;
		readonly delta?: string;
	};
}

type ChatSession = {
	readonly agent: {
		subscribe(listener: (event: unknown) => void): () => void;
	};
	prompt(text: string): Promise<void>;
	dispose(): void;
};

type SearchAgent = {
	readonly searchDocumentsStream: (query: string) => AsyncGenerator<SearchDocumentsStreamEvent, void, void>;
	/** The attachment block the next run puts in front of the model ("" for none). */
	readonly setAttachmentContext: (context: string) => void;
	readonly subscribe?: (listener: (event: LiveAgentEvent) => void) => () => void;
	readonly abort?: () => void;
	/** Correct the running search; false when it no longer takes steers. */
	readonly steer?: (text: string) => boolean;
	readonly createChatSession?: (options: { readonly systemPrompt: string }) => ChatSession;
	/** Names the run the agent's questions and approvals belong to; `undefined` once it ended. */
	readonly bindRun?: (run: RunInteraction | undefined) => void;
	/** Applies the approval mode to this agent's file-change gate. */
	readonly setApprovalMode?: (mode: ApprovalMode) => void;
	/**
	 * Opens the chat's model conversation: resumes `resumeFile`, else starts one with `seed` (the chat's earlier turns)
	 * already in it. Without it each question is a separate model session.
	 */
	readonly openSession?: (options: OpenSessionOptions) => Promise<OpenedSession>;
	/** Ends the conversation's session in this process; its file stays for a later resume. */
	readonly closeSession?: () => Promise<void>;
	/** Calls `listener` once per run, when the run takes the local track and so searches the person's index; returns the stop function. */
	readonly onLocalTrack?: (listener: () => void) => () => void;
};

export interface SearchServiceDeps {
	readonly agentFactory: () => SearchAgent | Promise<SearchAgent>;
	readonly chatStore: ChatStore;
	readonly send: (channel: string, payload: SearchStreamEvent) => void;
	readonly now?: () => Date;
	/** Reads a message's attachments into the agent's context block. Defaults to {@link buildAttachmentContext}. */
	readonly attachmentContext?: (attachments: readonly ChatAttachment[]) => Promise<string>;
	/** Usage analytics; absent (tests, a build with no project key) means nothing is reported. */
	readonly analytics?: Pick<Analytics, "track">;
	/** Where the agent's questions and approvals reach the person. Absent: the agent has nobody to ask. */
	readonly interaction?: InteractionHub;
	/** The approval mode in force, read when a chat's agent is built. Absent: {@link DEFAULT_APPROVAL_MODE}. */
	readonly approvalMode?: () => Promise<ApprovalMode>;
	/**
	 * Asked before a run builds its agent or sends anything to a model: a refusal (its message already in the person's
	 * language, and the action the panel offers for it) stops the run and is shown as its error, null lets it go.
	 * A preflight that throws never stops a run.
	 */
	readonly preflight?: () => Promise<SearchRefusal | null>;
	/** Where each chat's conversation file is remembered; without it a chat's conversation lasts only while the app runs. */
	readonly sessions?: ChatSessionIndex;
	/**
	 * Whether the index a local-track run is about to search is ready: a notice when it is still being built, stopped,
	 * empty or small, `null` when it is fine. A call that throws is the same as `null`.
	 */
	readonly indexReadiness?: () => Promise<IndexNotice | null>;
}

/** Why a run was not started, as the person is told. */
export interface SearchRefusal {
	readonly message: string;
	readonly action?: SearchErrorAction;
}

/**
 * The finished turns of a chat, for a conversation that has no session file to resume. A question counts with the
 * answer the person ended up with (Deep over Quick); a corrected-while-running message belongs to the turn it
 * corrected, and a turn that was stopped before any answer carries nothing over.
 */
function seedTurnsOf(messages: readonly ChatMessage[]): SeedTurn[] {
	const turns: SeedTurn[] = [];
	let question: string | undefined;
	for (const message of messages) {
		if (message.role === "user") {
			if (message.steer === undefined) question = message.text;
			continue;
		}
		const answer = (message.deep?.answer ?? message.quick?.answer ?? "").trim();
		if (question !== undefined && answer !== "") turns.push({ question, answer });
		question = undefined;
	}
	return turns;
}

interface SearchRun {
	readonly searchId: string;
	readonly chatId: string;
	/** Null while the async agent factory is still building it. */
	agent: SearchAgent | null;
	readonly finish: Promise<void>;
	readonly resolveFinish: () => void;
	cancelled: boolean;
	/** The stream ended: the run takes no more steers. */
	ended: boolean;
	quick: AnswerPhase | null;
	deep: AnswerPhase | null;
	sessionId: string;
	/** Messages the chat held before this run's question: earlier turns, left untouched by this run's writes. */
	base: number;
	/** Steers sent that no model request has taken yet. */
	pendingSteers: number;
	/** Chat-store writes of this run, in order: each reads the record the previous one wrote. */
	writes: Promise<void>;
	/** `now()` when the run began, in ms: the only timing usage analytics keeps, and only as a bucket. */
	readonly startedAt: number;
	/** The agent threw while streaming. */
	failed: boolean;
	/** `ai_search_finished` was already reported for this run. */
	reported: boolean;
}

/**
 * The model cites with the evidence ids the librarian's tools print
 * (`[e3]`, `[e3, e7]`, `[e3][e7]`) or `[file:<path>]`. They become `[n]` chips
 * only on the authoritative `quick`/`deep` event, so a draft shows none of
 * them. A trailing, still-incomplete marker (`[e`, `[file:/a/b`) is held back
 * as well, or it would flash as text until the closing bracket arrives.
 */
const COMPLETE_CITATION = /\s*\[(?:e\d+(?:\s*,\s*e\d+)*|file:[^\]\n]*)\]/gu;
const PARTIAL_CITATION = /\s*\[(?:e[\d,\s]*|f(?:i(?:l(?:e(?::[^\]\n]*)?)?)?)?)?$/u;

export function draftText(raw: string): string {
	return raw.replace(COMPLETE_CITATION, "").replace(PARTIAL_CITATION, "");
}

/**
 * Turns raw agent events into thinking/draft stream events for one run.
 * Reasoning text is dropped: only the first thinking token of each phase is
 * forwarded, as a `thinking` signal.
 *
 * The two-phase flow runs the fast (Quick) prompt first and the verification
 * (Deep) prompt second, so the phase is the number of `agent_start` events
 * seen. Both answer in plain assistant text. Whether a message is the answer
 * is not known while its text streams: a message that goes on to call a tool
 * (`stopReason: "toolUse"`) is a progress note ("checking X next"), which the
 * stream reports as `progress`, never as part of the answer. So a draft is the
 * text of the message currently streaming, and it is withdrawn (an empty
 * draft) the moment that message starts a tool call, which is announced when
 * its text ends and well before the tool has finished running.
 */
function createLiveStreamMapper(searchId: string, emit: (event: SearchStreamEvent) => void): (event: LiveAgentEvent) => void {
	let agentRuns = 0;
	let current = "";
	let lastDraft = "";
	let lastStopReason: string | undefined;
	const thinkingPhases = new Set<AnswerPhaseName>();
	const phase = (): AnswerPhaseName => (agentRuns > 1 ? "deep" : "quick");
	const setDraft = (text: string): void => {
		if (text === lastDraft) return;
		lastDraft = text;
		emit({ type: phase() === "quick" ? "quick-draft" : "deep-draft", searchId, text });
	};
	return (event) => {
		if (event.type === "agent_start") {
			// If the first phase failed with a provider error before producing a fast
			// answer, the next agent_start produces the run's only answer (delivered
			// into the Quick slot on `complete`), so keep streaming it as Quick.
			if (!(agentRuns === 1 && lastStopReason === "error")) {
				agentRuns += 1;
			}
			lastStopReason = undefined;
			current = "";
			lastDraft = "";
			return;
		}
		if (event.type === "message_start" && event.message?.role === "assistant") {
			current = "";
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			lastStopReason = event.message.stopReason;
			// Backstop for a provider that announces no tool call before the message ends.
			if ((event.message.stopReason === "toolUse" || event.message.stopReason === "error") && lastDraft !== "") {
				setDraft("");
			}
			current = "";
			return;
		}
		const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
		if (update === undefined) return;
		switch (update.type) {
			case "thinking_delta": {
				const now = phase();
				if (!update.delta || thinkingPhases.has(now)) return;
				thinkingPhases.add(now);
				emit({ type: "thinking", searchId, phase: now });
				return;
			}
			case "text_delta": {
				if (!update.delta) return;
				current += update.delta;
				const visible = draftText(current);
				if (visible.trim() !== "") setDraft(visible);
				return;
			}
			case "toolcall_start": {
				// The message is a progress note, not the answer: take back its text.
				if (lastDraft !== "") setDraft("");
				current = "";
				return;
			}
			default:
				return;
		}
	};
}

/**
 * The one progress sentence the librarian writes itself (`searchDocumentsStream` opens every run with it, in English).
 * Every other `progress` text is the model's: the intent it gave a tool call, or what it said before calling one, in the
 * language it answers in. The panel shows the translated sentence from the moment a run starts, so the English one must
 * not replace it.
 */
const LIBRARIAN_OPENING_NOTE = "Reviewing the query.";

function progressText(text: string): string {
	return text === LIBRARIAN_OPENING_NOTE ? t("aiSearch.reviewing") : text;
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The librarian prefixes the provider's own words with this in the `model-request-failed` diagnostic. */
const MODEL_REQUEST_FAILED_PREFIX = /^The model request failed:\s*/u;

/**
 * The provider's error when the run's model request failed, else null. The librarian does not throw for it: it ends the
 * run with a degraded "ended without a final answer" text and this diagnostic, which the panel must not show as an answer.
 */
function modelRequestFailure(response: SearchDocumentsResponse): string | null {
	const diagnostic = response.diagnostics?.find((entry) => entry.code === "model-request-failed");
	return diagnostic === undefined ? null : diagnostic.message.replace(MODEL_REQUEST_FAILED_PREFIX, "");
}

function mapPhase(response: SearchDocumentsResponse): AnswerPhase {
	return {
		answer: response.answer,
		evidence: response.results.map((result) => ({
			number: result.number,
			title: result.title,
			summary: result.summary,
			source: result.source ?? null,
			excerpts: result.evidence.map((evidence) => evidence.excerpt),
			// The librarian derives results from the answer's citations and
			// measures no confidence; do not invent one.
			...(result.confidence === undefined ? {} : { confidence: result.confidence }),
		})),
	};
}

function assistantMessage(run: SearchRun, stopped: boolean, now: () => Date): ChatMessageAssistant {
	return {
		role: "assistant",
		sessionId: run.sessionId,
		quick: run.quick,
		deep: run.deep,
		stopped,
		at: now().toISOString(),
	};
}

/** Chats whose agent stays alive for follow-ups. */
const MAX_CHAT_AGENTS = 8;

/** The search bridge plus what the main process drives itself. */
export interface SearchService extends SearchBridge {
	/** Applies the approval mode to every chat's agent, running or built later. */
	setApprovalMode(mode: ApprovalMode): void;
	/** Ends every open conversation (the app is quitting); the session files stay. */
	dispose(): Promise<void>;
	/**
	 * The config changed under the open agents (the error-fix helper repaired it): lets go of every agent that is not
	 * answering, so the next question of a chat builds one on the current config and resumes from the chat's file.
	 */
	resetAgents(): Promise<void>;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
	const now = deps.now ?? (() => new Date());
	const active = new Map<string, SearchRun>();

	/**
	 * One agent, and with it one model conversation, per chat: a follow-up reaches the agent that holds the chat's
	 * earlier questions and answers. Only the New chat button starts a new chat id, and with it a new conversation.
	 * Past the cap the oldest chats that are not answering are closed; their session files stay, and asking in such a
	 * chat again resumes from its file.
	 */
	const agents = new Map<string, SearchAgent>();
	/** The mode the person last chose; agents built after that start in it. */
	let chosenMode: ApprovalMode | undefined;
	async function agentFor(chatId: string, earlier: readonly ChatMessage[]): Promise<SearchAgent> {
		const cached = agents.get(chatId);
		if (cached !== undefined) {
			// Re-insert so the Map's order is least recently used first.
			agents.delete(chatId);
			agents.set(chatId, cached);
			return cached;
		}
		const built = await deps.agentFactory();
		try {
			const initialMode = deps.approvalMode === undefined ? DEFAULT_APPROVAL_MODE : await deps.approvalMode();
			built.setApprovalMode?.(chosenMode ?? initialMode);
			if (built.openSession !== undefined && deps.sessions !== undefined) {
				// The chat's own conversation file if it kept one; else a new conversation that starts with what the chat
				// already holds (a chat from before conversations were kept, or one whose file is gone).
				const resumeFile = (await deps.sessions.fileFor(chatId)) ?? undefined;
				const opened = await built.openSession({ resumeFile, seed: resumeFile === undefined ? seedTurnsOf(earlier) : [] });
				if (opened.sessionFile !== undefined) await deps.sessions.remember(chatId, opened.sessionFile);
			}
		} catch (error) {
			await built.closeSession?.().catch(() => undefined);
			throw error;
		}
		agents.set(chatId, built);
		const answering = new Set([...active.values()].map((run) => run.agent));
		const surplus = [...agents.keys()].slice(0, Math.max(0, agents.size - MAX_CHAT_AGENTS));
		for (const stale of surplus) {
			const agent = agents.get(stale);
			if (agent === undefined || answering.has(agent)) continue;
			agents.delete(stale);
			void agent.closeSession?.().catch(() => undefined);
		}
		return built;
	}

	/** Ends every open conversation, waiting for each; one that fails to close does not stop the others. */
	async function closeAgents(): Promise<void> {
		const open = [...agents.values()];
		agents.clear();
		await Promise.allSettled(open.map((agent) => agent.closeSession?.()));
	}

	/** Closes the agents that are idle; one that is answering finishes on the config it started with. */
	async function resetAgents(): Promise<void> {
		const answering = new Set([...active.values()].map((run) => run.agent));
		const idle = [...agents].filter(([, agent]) => !answering.has(agent));
		for (const [chatId] of idle) agents.delete(chatId);
		await Promise.allSettled(idle.map(([, agent]) => agent.closeSession?.()));
	}

	const emit = (event: SearchStreamEvent): void => deps.send(SEARCH_CHANNELS.event, event);

	/** Usage analytics: one `ai_search_finished` per run, with coarse facts only (no query, answer, path or source name). */
	function reportFinished(run: SearchRun, outcome: "answered" | "failed" | "stopped"): void {
		if (run.reported) return;
		run.reported = true;
		deps.analytics?.track("ai_search_finished", { outcome, deepened: run.deep !== null, duration: durationBucket(now().getTime() - run.startedAt) });
	}

	/** Runs one read-modify-write of the run's chat record after every earlier one. */
	function writeChat(run: SearchRun, update: (existing: ChatRecord) => ChatRecord): Promise<void> {
		const write = run.writes.then(async () => {
			const existing = await deps.chatStore.get(run.chatId);
			if (existing !== null) await deps.chatStore.save(update(existing));
		});
		run.writes = write.catch(() => undefined);
		return write;
	}

	function saveRunMessage(run: SearchRun, stopped: boolean): Promise<void> {
		return writeChat(run, (existing) => ({
			...existing,
			messages: [
				...existing.messages.slice(0, run.base),
				...existing.messages.slice(run.base).filter((message) => message.role !== "assistant"),
				assistantMessage(run, stopped, now),
			],
			updatedAt: now().toISOString(),
		}));
	}

	/** A steer joins the run's user turns, before its one assistant message. */
	function saveSteer(run: SearchRun, text: string): Promise<void> {
		const steer: ChatMessageUser = {
			role: "user",
			text,
			attachments: [],
			at: now().toISOString(),
			steer: run.quick === null ? "before-quick" : "after-quick",
		};
		return writeChat(run, (existing) => {
			const earlier = existing.messages.slice(0, run.base);
			const turn = existing.messages.slice(run.base);
			const users = turn.filter((message) => message.role !== "assistant");
			const assistant = turn.filter((message) => message.role === "assistant");
			return { ...existing, messages: [...earlier, ...users, steer, ...assistant], updatedAt: steer.at };
		});
	}

	/**
	 * The run is searching the person's index: warn when that index is not ready. The check runs beside the search and
	 * never holds it up; a run that ended or was stopped before the answer to it came needs no warning.
	 */
	async function announceIndexReadiness(run: SearchRun): Promise<void> {
		let notice: IndexNotice | null;
		try {
			notice = (await deps.indexReadiness?.()) ?? null;
		} catch {
			// Not knowing is not a reason to warn: the run goes on without it.
			return;
		}
		if (notice === null || run.cancelled || run.ended) return;
		emit({ type: "index-notice", searchId: run.searchId, notice });
	}

	async function consume(run: SearchRun, agent: SearchAgent, query: string, attachments: readonly ChatAttachment[]): Promise<void> {
		const mapLive = createLiveStreamMapper(run.searchId, (event) => {
			if (!run.cancelled) emit(event);
		});
		// Subscribe before the generator starts the run, or the first thinking
		// tokens are lost.
		const unsubscribe = agent.subscribe?.((event) => {
			mapLive(event);
			// Each model request starts with a user message, and queued steers go out with it.
			if (event.type !== "message_start" || event.message?.role !== "user" || run.pendingSteers === 0) return;
			run.pendingSteers = 0;
			if (!run.cancelled) emit({ type: "steer-delivered", searchId: run.searchId });
		});
		// A run that searches the person's index while it is not ready says so as soon as the search starts, not with the answer.
		const stopLocalTrack = deps.indexReadiness === undefined ? undefined : agent.onLocalTrack?.(() => void announceIndexReadiness(run));
		try {
			// Reading a large PDF can outlast a Stop; a cancelled run never reaches the agent.
			const context = await (deps.attachmentContext ?? buildAttachmentContext)(attachments);
			if (run.cancelled) return;
			agent.setAttachmentContext(context);
			const hub = deps.interaction;
			agent.bindRun?.(hub === undefined ? undefined : { open: (body, signal) => hub.open(run.searchId, body, signal) });
			for await (const event of agent.searchDocumentsStream(query)) {
				if (run.cancelled) return;
				switch (event.type) {
					case "progress":
						emit({ type: "progress", searchId: run.searchId, text: progressText(event.text) });
						break;
					case "preliminary": {
						run.sessionId = event.response.sessionId;
						run.quick = mapPhase(event.response);
						emit({
							type: "quick",
							searchId: run.searchId,
							sessionId: run.sessionId,
							phase: run.quick,
						});
						await saveRunMessage(run, false);
						break;
					}
					case "complete": {
						const failure = modelRequestFailure(event.response);
						if (failure !== null) {
							// No answer was made: the Quick answer, if one was shown, stays as it is and the error comes with it.
							run.failed = true;
							emit({ type: "error", searchId: run.searchId, message: failure });
							break;
						}
						run.sessionId = event.response.sessionId;
						const phase = mapPhase(event.response);
						// Without a preliminary this is the run's only answer: Jev judged the
						// fast answer final (or routed straight to a direct answer), so no
						// verification ran. It belongs in the Quick slot, which already shows
						// its streamed draft; a Deep block would repeat that same text.
						if (run.quick === null) {
							run.quick = phase;
							emit({ type: "quick", searchId: run.searchId, sessionId: run.sessionId, phase });
						} else {
							run.deep = phase;
							emit({ type: "deep", searchId: run.searchId, sessionId: run.sessionId, phase });
						}
						await saveRunMessage(run, false);
						break;
					}
					default:
						break;
				}
			}
		} catch (error) {
			run.failed = true;
			if (!run.cancelled) {
				emit({ type: "error", searchId: run.searchId, message: errorText(error) });
			}
		} finally {
			unsubscribe?.();
			stopLocalTrack?.();
			// Nobody is asked once the run is over: a question still open closes, and its tool call is already unblocked.
			agent.bindRun?.(undefined);
			deps.interaction?.closeRun(run.searchId, "ended");
			run.ended = true;
			if (!run.cancelled) {
				emit({ type: "done", searchId: run.searchId });
				// A stream that ended with no answer at all did not answer.
				reportFinished(run, run.failed || (run.quick === null && run.deep === null) ? "failed" : "answered");
			}
			active.delete(run.searchId);
			run.resolveFinish();
		}
	}

	return {
		setApprovalMode: (mode) => {
			chosenMode = mode;
			for (const agent of agents.values()) agent.setApprovalMode?.(mode);
		},
		start: async (searchId, chatId, query, attachments) => {

			let resolveFinish = (): void => undefined;
			const finish = new Promise<void>((resolve) => {
				resolveFinish = resolve;
			});
			const at = now().toISOString();
			const userMessage: ChatMessageUser = {
				role: "user",
				text: query,
				attachments,
				at,
			};
			const run: SearchRun = {
				searchId,
				chatId,
				agent: null,
				finish,
				resolveFinish,
				cancelled: false,
				ended: false,
				quick: null,
				deep: null,
				sessionId: "",
				base: 0,
				pendingSteers: 0,
				writes: Promise.resolve(),
				startedAt: now().getTime(),
				failed: false,
				reported: false,
			};
			// Register before the async factory resolves so Stop during creation
			// cancels the run instead of racing it.
			active.set(searchId, run);
			const existing = await deps.chatStore.get(chatId);
			run.base = existing?.messages.length ?? 0;
			deps.analytics?.track("ai_search_started", { has_attachments: attachments.length > 0, follow_up: run.base > 0 });
			await deps.chatStore.save({
				id: chatId,
				title: query,
				snippet: "",
				updatedAt: at,
				messages: [...(existing?.messages ?? []), userMessage],
			});
			let refusal: SearchRefusal | null = null;
			try {
				refusal = (await deps.preflight?.()) ?? null;
			} catch {
				// Not knowing is not a reason to refuse: the run goes ahead and the model's server has the last word.
			}
			if (refusal !== null) {
				active.delete(searchId);
				if (!run.cancelled) {
					reportFinished(run, "failed");
					emit({ type: "error", searchId, message: refusal.message, ...(refusal.action === undefined ? {} : { action: refusal.action }) });
					emit({ type: "done", searchId });
				}
				run.resolveFinish();
				return;
			}
			let agent: SearchAgent;
			try {
				// A bad config (e.g. a search root that no longer exists) throws
				// here; the panel must show it instead of waiting forever.
				agent = await agentFor(chatId, existing?.messages ?? []);
			} catch (error) {
				active.delete(searchId);
				if (!run.cancelled) {
					reportFinished(run, "failed");
					emit({ type: "error", searchId, message: errorText(error) });
					emit({ type: "done", searchId });
				}
				run.resolveFinish();
				return;
			}
			if (run.cancelled) {
				// Stop landed while the agent was being built; never start it.
				run.resolveFinish();
				return;
			}
			run.agent = agent;
			void consume(run, agent, query, attachments);
			await finish;
		},
		steer: async (searchId, text) => {
			const run = active.get(searchId);
			const trimmed = text.trim();
			// A run still building its agent has no search to steer yet; the caller asks it next.
			if (run === undefined || run.cancelled || run.ended || run.agent?.steer === undefined || trimmed === "") return false;
			if (!run.agent.steer(trimmed)) return false;
			run.pendingSteers += 1;
			await saveSteer(run, trimmed);
			return true;
		},
		cancel: async (searchId) => {
			const run = active.get(searchId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			reportFinished(run, "stopped");
			// A question or approval the run is waiting on closes with Stop, so nothing keeps the stopped run alive.
			deps.interaction?.closeRun(searchId, "cancelled");
			run.agent?.abort?.();
			emit({ type: "cancelled", searchId });
			await saveRunMessage(run, true);
			active.delete(searchId);
			run.resolveFinish();
		},
		historyList: () => deps.chatStore.list(),
		historyGet: (chatId) => deps.chatStore.get(chatId),
		historySearch: (query) => deps.chatStore.search(query),
		historyClear: async () => {
			await closeAgents();
			await deps.sessions?.clear();
			await deps.chatStore.clear();
		},
		onEvent: () => () => undefined,
		dispose: closeAgents,
		resetAgents,
	};
}

/** Thinking levels pi accepts; the config-service validator keeps the same list. */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Upstream `DEFAULT_QUERY_DECOMPOSITION_MODEL`; `queryDecomposition` absent means this default. */
const DEFAULT_QUERY_DECOMPOSITION: { readonly provider: string; readonly id: string } = {
	provider: "openrouter",
	id: "qwen/qwen3.7-flash",
};

type AgentThinking = NonNullable<AutoRAGAgentOptions["thinking"]>;
type AgentThinkingLevel = NonNullable<AgentThinking["final"]>;
type AgentQueryDecomposition = AutoRAGAgentOptions["queryDecomposition"];

/**
 * Default web-search fallback order: keyless Parallel MCP and DuckDuckGo HTML
 * lead the chain ahead of Perplexity's rate-limited anonymous endpoint and
 * bot-challenged scrapers.
 */
export const DEFAULT_WEB_SEARCH_PROVIDER_ORDER = ["parallel", "duckduckgo"] as const;

/**
 * Re-attach `webSearch` from the raw config object (librarian's `resolveConfig`
 * drops it) and apply {@link DEFAULT_WEB_SEARCH_PROVIDER_ORDER} when enabled
 * without an explicit `order`.
 */
export function resolveWebSearchConfig(raw: Record<string, unknown>): NonNullable<CliConfig["webSearch"]> {
	const webSearch = raw.webSearch;
	if (webSearch === false) return { enabled: false };
	if (!isJsonObject(webSearch)) return { order: [...DEFAULT_WEB_SEARCH_PROVIDER_ORDER] };
	if (webSearch.enabled === false) return webSearch as NonNullable<CliConfig["webSearch"]>;
	if (webSearch.order !== undefined) return webSearch as NonNullable<CliConfig["webSearch"]>;
	return {
		...webSearch,
		order: [...DEFAULT_WEB_SEARCH_PROVIDER_ORDER],
	} as NonNullable<CliConfig["webSearch"]>;
}

function readThinking(raw: Record<string, unknown>): AgentThinking | undefined {
	const value = raw.thinking;
	if (!isJsonObject(value)) return undefined;
	const pick = (key: "fast" | "final"): AgentThinkingLevel | undefined => {
		const level = value[key];
		return typeof level === "string" && THINKING_LEVELS.includes(level) ? (level as AgentThinkingLevel) : undefined;
	};
	const fast = pick("fast");
	const final = pick("final");
	if (fast === undefined && final === undefined) return undefined;
	return { ...(fast === undefined ? {} : { fast }), ...(final === undefined ? {} : { final }) };
}

/**
 * Resolve the question-decomposition model through the librarian's own resolver
 * (the public `resolveQueryDecompositionModel` is not exported from the package
 * entry, so this mirrors it exactly): `false` disables it, an absent section
 * uses the upstream default, an explicit section uses its model.
 */
async function resolveDecomposition(
	config: CliConfig,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<AgentQueryDecomposition> {
	if (config.queryDecomposition === false) return undefined;
	const reference = config.queryDecomposition?.model ?? DEFAULT_QUERY_DECOMPOSITION;
	const resolved = await resolveAgentModel({ ...config, model: reference }, { env, cwd });
	const apiKey = resolved.apiKey ?? resolved.providerApiKeys?.[resolved.model.provider];
	return { model: applyDazziThinkingLevels(resolved.model), ...(apiKey === undefined ? {} : { apiKey }) };
}

/**
 * `sessionDir` is where pi keeps each chat's conversation file: an app-owned folder, so the files move with the
 * app's data and "clear history" can delete exactly them.
 */
export function createDefaultAgentFactory(options: { readonly sessionDir: string }): () => Promise<SearchAgent> {
	return async () => {
		const input = { flags: {}, env: process.env, cwd: process.cwd() };
		const config = resolveConfigReadOnly(input);
		const configPath = resolveConfigPath(input).configPath;
		const raw = (await access(configPath).then(() => true, () => false)) ? readRawConfigObject(configPath) : {};
		// librarian's resolveConfig drops `webSearch`; re-attach the raw block so
		// buildAgentOptions applies it, then layer the app's code-folder exclusions.
		const withWebSearch: CliConfig = {
			...config,
			webSearch: resolveWebSearchConfig(raw),
		};
		const effective = await applyAppIndexing(withWebSearch, raw);
		// A semantic search embeds its query through the local server; a server still loading at launch is waited for here.
		if (readAppIndexing(raw).semanticSearch) await ensureEmbeddingForConfig(raw);
		// The model and credentials come from the one resolver every agent in the
		// app shares (`resolveSessionModel` in @autorag/librarian/profiles): fresh on every agent build.
		const resolved = await resolveSessionModel(effective, input.env, input.cwd, getAgentDir());
		const agentDir = input.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		syncCalendarMcpConfig(raw, raw, agentDir);
		const decomposition = await resolveDecomposition(effective, input.env, input.cwd);
		// The decomposition model's thinking is upstream-fixed off; only the
		// two-phase answer model takes config thinking.fast/final.
		const thinking = readThinking(raw);
		const agentOptions: AutoRAGAgentOptions = {
			...buildAgentOptions(effective),
			model: resolved.model,
			piAgentDir: agentDir,
			piSessionDir: options.sessionDir,
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.providerApiKeys !== undefined ? { providerApiKeys: resolved.providerApiKeys } : {}),
			...(decomposition !== undefined ? { queryDecomposition: decomposition } : {}),
			...(thinking !== undefined ? { thinking } : {}),
		};
		const semantic = readAppIndexing(raw).semanticSearch;
		const agent = new InteractiveSearchAgent(agentOptionsForSemantic(agentOptions, semantic), createAgentInteraction());
		applySemanticPolicyToAgent(agent, semantic);
		// `manage_automations` starts programs by asking for "this Node"; in the app that would be the app itself.
		runAutomationToolOnNode(agent, () => resolveNodeBinary({ resourcesPath: process.resourcesPath ?? "", env: process.env, platform: process.platform }));
		return agent as SearchAgent;
	};
}
