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
import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, type ImageContent, isContextOverflow } from "@earendil-works/pi-ai";
import { isJsonObject, type SettingsBridge } from "../shared/settings-contract";
import { applyDazziThinkingLevels, resolveSessionModel } from "@autorag/librarian/profiles";
import { loadAttachmentImages, prepareAttachmentImage } from "./attachment-images";
import type { PastedImageStore } from "./pasted-images";
import { applyAppIndexing, readAppIndexing } from "./app-indexing";
import { resolveNodeBinary, runAutomationToolOnNode } from "./automation-runtime";
import {
	createAutomationVerificationTracker,
	createTestAutomationInSandboxTool,
	testAutomationInSandbox,
} from "./automation-sandbox";
import type { ReplyLanguage } from "./agents/profile-progress";
import { verifyMagicActionInSandbox } from "./magic-action-sandbox";
import { createMagicActionTools } from "./magic-action-tools";
import { buildUnifiedWorkflowsPrompt, isMagicActionManagementQuery } from "./workflow-sandbox";
import { ensureEmbeddingForConfig } from "./embedding-daemon";
import { OPENROUTER_DEFAULT_DECOMPOSITION_MODEL, resolveSllmDecisionModel } from "./decision-model";
import { agentOptionsForSemantic, applySemanticPolicyToAgent } from "./semantic-policy";
import { withoutAgentAutoTrain } from "./ltr-service";
import { syncCalendarMcpConfig } from "./calendar-mcp";
import type {
	AnswerPhase,
	AnswerPhaseName,
	ChatAttachment,
	ChatMessage,
	ChatMessageAssistant,
	ChatRecord,
	ChatMessageUser,
	ContextNotice,
	IndexNotice,
	SearchBridge,
	SearchErrorAction,
	SearchStreamEvent,
} from "../shared/search-contract";
import { SEARCH_CHANNELS, type FollowUpKind } from "../shared/search-contract";
import { type AnswerRevision, isAnswerChange, remainderAfterRevised, revisedAnswer } from "../shared/answer-revision";
import { buildAttachmentContext, buildViewingFolderContext } from "./attachment-context";
import { InteractiveSearchAgent, type OpenedSession, type OpenSessionOptions, type SeedTurn } from "./interactive-search-agent";
import type { ContextEvent } from "./context-watch";
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
		readonly timestamp?: number;
	};
	readonly assistantMessageEvent?: {
		readonly type: string;
		readonly delta?: string;
	};
	/** On `tool_execution_*`: the call the event belongs to. */
	readonly toolCallId?: string;
}

type ChatSession = {
	readonly agent: {
		subscribe(listener: (event: unknown) => void): () => void;
	};
	prompt(text: string): Promise<void>;
	dispose(): void;
};

export type SearchAgent = {
	readonly searchDocumentsStream: (query: string) => AsyncGenerator<SearchDocumentsStreamEvent, void, void>;
	/** The attachment block the next run puts in front of the model ("" for none). */
	readonly setAttachmentContext: (context: string) => void;
	/** The pictures the next run sends with the question (image files among its attachments). */
	readonly setAttachmentImages?: (images: readonly ImageContent[]) => void;
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
	/** Calls `listener` with what the conversation does to the model's view of it (see {@link ContextEvent}); returns the stop function. */
	readonly onContext?: (listener: (event: ContextEvent) => void) => () => void;
};

export interface SearchServiceDeps {
	readonly agentFactory: () => SearchAgent | Promise<SearchAgent>;
	readonly chatStore: ChatStore;
	readonly send: (channel: string, payload: SearchStreamEvent) => void;
	readonly now?: () => Date;
	/** Reads a message's attachments into the agent's context block. Defaults to {@link buildAttachmentContext}. */
	readonly attachmentContext?: (attachments: readonly ChatAttachment[]) => Promise<string>;
	/** Reads a message's image attachments for the model. Defaults to {@link loadAttachmentImages}. */
	readonly attachmentImages?: (attachments: readonly ChatAttachment[]) => Promise<readonly ImageContent[]>;
	/** Where pasted images are kept; without it a paste is refused. */
	readonly pastedImages?: PastedImageStore;
	/** Whether the model the chat runs on takes images; absent means it does. A paste is dropped silently when it does not. */
	readonly acceptsImages?: () => Promise<boolean>;
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
	/**
	 * Called once a search has answered and its `done` event is sent, never before: the answer is already on screen.
	 * Learning-to-rank training hangs here. Fire and forget: a hook that throws or rejects is dropped and never fails
	 * the search it follows.
	 */
	readonly afterAnsweredSearch?: () => void | Promise<unknown>;
	/**
	 * Writes a chat's short title from its first question and answer, or null. Asked once per chat, after its first
	 * answered run; the title is kept on the record and sent as a `title` event. Absent: a chat is titled by its first question.
	 */
	readonly titleChat?: (question: string, answer: string) => Promise<string | null>;
	/** Says whether a message sent during a run corrects it or is the next question. Absent: always the next question. */
	readonly sortFollowUp?: (question: string, followUp: string) => Promise<FollowUpKind>;
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
		// The answer the person ended up with: the Quick answer with its corrections applied, then whatever Deep added.
		const changes = (message.revisions ?? []).some(isAnswerChange);
		const answer = (
			changes
				? [revisedAnswer(message.quick?.answer ?? "", message.revisions ?? []), message.deep?.answer ?? ""].filter((part) => part.trim() !== "").join("\n\n")
				: (message.deep?.answer ?? message.quick?.answer ?? "")
		).trim();
		if (question !== undefined && answer !== "") turns.push({ question, answer });
		question = undefined;
	}
	return turns;
}

interface SearchRun {
	readonly searchId: string;
	readonly chatId: string;
	/** The question the run is answering. */
	readonly question: string;
	/** Null while the async agent factory is still building it. */
	agent: SearchAgent | null;
	readonly finish: Promise<void>;
	readonly resolveFinish: () => void;
	cancelled: boolean;
	/** The stream ended: the run takes no more steers. */
	ended: boolean;
	quick: AnswerPhase | null;
	deep: AnswerPhase | null;
	/** The first answer exactly as the librarian wrote it: the corrections' `original` claims are cut from it, not from the Quick text, which also holds the notes the model wrote on the way. */
	firstAnswer: string;
	/** The corrections the verification made to the Quick answer, in order. */
	revisions: AnswerRevision[];
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
	/** What the run did to the model's view of the chat, in order (stored with its answer). */
	readonly context: ContextNotice[];
	/**
	 * The tool calls this run made and the user messages it sent (by timestamp): a request that cut one of them showed the
	 * model only part of what this run searched for.
	 */
	readonly toolCalls: Set<string>;
	readonly userMessages: Set<number>;
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
 * (`stopReason: "toolUse"`) is a note the model wrote on the way ("checking X
 * next"). What the person has watched stream stays on screen: such a message
 * is kept, in order, ahead of the messages that follow it, so a phase's draft
 * is every message the phase wrote so far, and the answer the phase ends with
 * carries the same text ({@link LiveStream.takeNotes}). Only a message that
 * failed (`stopReason: "error"`) is taken back: it never finished.
 */
interface LiveStream {
	readonly handle: (event: LiveAgentEvent) => void;
	/** The notes `phase` wrote before its last message (each already shown in its drafts); handing them over forgets them. */
	readonly takeNotes: (phase: AnswerPhaseName) => readonly string[];
	/** The text is a note the stream keeps in the answer: the librarian also reports it as progress, which would show it twice. */
	readonly isNote: (text: string) => boolean;
}

const NOTE_SEPARATOR = "\n\n";

function createLiveStreamMapper(searchId: string, emit: (event: SearchStreamEvent) => void): LiveStream {
	let agentRuns = 0;
	/** Text of the message that is streaming now. */
	let current = "";
	let lastDraft = "";
	let lastStopReason: string | undefined;
	/** The finished messages of each phase that went on to call a tool, in order. */
	const notes: Record<AnswerPhaseName, string[]> = { quick: [], deep: [] };
	const everNoted = new Set<string>();
	/** The streaming message was already added to `notes`. */
	let committed = false;
	const thinkingPhases = new Set<AnswerPhaseName>();
	const phase = (): AnswerPhaseName => (agentRuns > 1 ? "deep" : "quick");
	const setDraft = (text: string): void => {
		if (text === lastDraft) return;
		lastDraft = text;
		emit({ type: phase() === "quick" ? "quick-draft" : "deep-draft", searchId, text });
	};
	/** What the phase shows: its notes, then the message streaming now. */
	const drafted = (visible: string): string => [...notes[phase()], ...(visible.trim() === "" ? [] : [visible])].join(NOTE_SEPARATOR);
	const commit = (): void => {
		if (committed) return;
		const visible = draftText(current).trim();
		if (visible !== "") {
			notes[phase()].push(visible);
			everNoted.add(visible);
		}
		committed = true;
		current = "";
	};
	const handle = (event: LiveAgentEvent): void => {
		if (event.type === "agent_start") {
			// If the first phase failed with a provider error before producing a fast
			// answer, the next agent_start produces the run's only answer (delivered
			// into the Quick slot on `complete`), so keep streaming it as Quick.
			if (!(agentRuns === 1 && lastStopReason === "error")) {
				agentRuns += 1;
				notes[phase()].length = 0;
			}
			lastStopReason = undefined;
			current = "";
			committed = false;
			lastDraft = "";
			return;
		}
		if (event.type === "message_start" && event.message?.role === "assistant") {
			current = "";
			committed = false;
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			lastStopReason = event.message.stopReason;
			if (event.message.stopReason === "toolUse") {
				// Backstop for a provider that announces no tool call before the message ends.
				commit();
			} else if (event.message.stopReason === "error" && !committed) {
				// A message that failed never finished: take its text back.
				current = "";
				setDraft(drafted(""));
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
				if (!update.delta || committed) return;
				current += update.delta;
				const visible = draftText(current);
				if (visible.trim() !== "") setDraft(drafted(visible));
				return;
			}
			case "toolcall_start": {
				// The message is a note on the way to the answer: keep what was written, and start the next message below it.
				commit();
				return;
			}
			default:
				return;
		}
	};
	return {
		handle,
		takeNotes: (name) => notes[name].splice(0, notes[name].length),
		isNote: (text) => everNoted.has(text.trim()),
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

/**
 * The action for a run's error: `new-chat` when the model refused the request as larger than its window, in pi's reading
 * of the provider's words (the same test pi compacts and retries on), so the error says why and what to do next.
 */
function errorAction(message: string): { readonly action?: SearchErrorAction } {
	const failed = { role: "assistant", stopReason: "error", errorMessage: message } as AssistantMessage;
	return isContextOverflow(failed) ? { action: "new-chat" } : {};
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
		...(run.context.length === 0 ? {} : { context: [...run.context] }),
		...(run.revisions.length === 0 ? {} : { revisions: [...run.revisions] }),
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
	/** Agents that were answering when the config or credentials changed: they finish on what they started with, then are rebuilt. */
	const staleAgents = new Set<SearchAgent>();
	/** The mode the person last chose; agents built after that start in it. */
	let chosenMode: ApprovalMode | undefined;
	async function agentFor(chatId: string, earlier: readonly ChatMessage[]): Promise<SearchAgent> {
		const cached = agents.get(chatId);
		if (cached !== undefined && staleAgents.has(cached)) {
			agents.delete(chatId);
			staleAgents.delete(cached);
			await cached.closeSession?.().catch(() => undefined);
		} else if (cached !== undefined) {
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
		staleAgents.clear();
		await Promise.allSettled(open.map((agent) => agent.closeSession?.()));
	}

	/** Closes the agents that are idle; one that is answering finishes on the config it started with. */
	async function resetAgents(): Promise<void> {
		const answering = new Set([...active.values()].map((run) => run.agent));
		const idle = [...agents].filter(([, agent]) => !answering.has(agent));
		for (const [, agent] of agents) if (answering.has(agent)) staleAgents.add(agent);
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

	/** The post-search hook, detached: whatever it does or throws, the search that triggered it is already over. */
	function runAfterAnswered(): void {
		const hook = deps.afterAnsweredSearch;
		if (hook === undefined) return;
		try {
			Promise.resolve(hook()).catch(() => undefined);
		} catch {
			// A synchronous throw is dropped for the same reason.
		}
	}

	/** Chats whose title is being written, so a quick follow-up does not ask for a second one. */
	const titling = new Set<string>();

	/** Gives an answered chat its model-written title once: detached, and silent when the model has none to give. */
	function titleChatOnce(run: SearchRun): void {
		const titleChat = deps.titleChat;
		if (titleChat === undefined || titling.has(run.chatId)) return;
		titling.add(run.chatId);
		void (async () => {
			const record = await deps.chatStore.get(run.chatId);
			if (record === null || record.summaryTitle !== undefined) return;
			const question = record.messages.find((message) => message.role === "user");
			const answer = record.messages.find((message) => message.role === "assistant" && (message.quick ?? message.deep) !== null);
			if (question?.role !== "user" || answer?.role !== "assistant") return;
			const title = await titleChat(question.text, (answer.quick ?? answer.deep)?.answer ?? "");
			if (title === null) return;
			await writeChat(run, (existing) => ({ ...existing, summaryTitle: title }));
			emit({ type: "title", searchId: run.searchId, chatId: run.chatId, title });
		})()
			.catch(() => undefined)
			.finally(() => titling.delete(run.chatId));
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

	/**
	 * Records what the run did to the model's view of the chat, tells the panel, and stores it with the answer already
	 * kept. A kind is marked once per place (before or after the Quick answer): pi may summarise twice in a row (the
	 * overflow's summary, then a threshold one once the retry answered), and the second divider would only repeat the first.
	 */
	function addContextNotice(run: SearchRun, kind: ContextNotice["kind"]): void {
		const notice: ContextNotice = { kind, timing: run.quick === null ? "before-quick" : "after-quick" };
		if (run.context.some((earlier) => earlier.kind === kind && earlier.timing === notice.timing)) return;
		run.context.push(notice);
		emit({ type: "context-notice", searchId: run.searchId, notice });
		// Before the Quick answer nothing of the run is stored yet; the answer carries the notice when it is.
		if (run.quick !== null) void saveRunMessage(run, false).catch(() => undefined);
	}

	function noteContext(run: SearchRun, event: ContextEvent): void {
		if (run.cancelled || run.ended) return;
		switch (event.type) {
			case "compaction_start":
				emit({ type: "compacting", searchId: run.searchId, active: true });
				return;
			case "compaction_end":
				emit({ type: "compacting", searchId: run.searchId, active: false });
				if (event.compacted) addContextNotice(run, "compacted");
				return;
			case "request_cut":
				// Said once a run, and only for what this run searched for: an earlier turn's result cut to make room is the
				// conversation's housekeeping, not news about this answer.
				if (run.context.some((notice) => notice.kind === "trimmed")) return;
				if (event.toolCallIds.some((id) => run.toolCalls.has(id)) || event.userMessages.some((at) => run.userMessages.has(at))) {
					addContextNotice(run, "trimmed");
				}
				return;
		}
	}

	async function consume(run: SearchRun, agent: SearchAgent, query: string, attachments: readonly ChatAttachment[], viewingFolder: string | undefined): Promise<void> {
		const live = createLiveStreamMapper(run.searchId, (event) => {
			if (!run.cancelled) emit(event);
		});
		/** The phase as the person saw it stream: the notes the model wrote on the way, then the answer that ends the phase. */
		const withNotes = (phase: AnswerPhase, ...names: readonly AnswerPhaseName[]): AnswerPhase => {
			const notes = names.flatMap((name) => live.takeNotes(name));
			return notes.length === 0 ? phase : { ...phase, answer: [...notes, phase.answer].join(NOTE_SEPARATOR) };
		};
		// Subscribe before the generator starts the run, or the first thinking
		// tokens are lost.
		const unsubscribe = agent.subscribe?.((event) => {
			live.handle(event);
			if (event.type === "tool_execution_start" && event.toolCallId !== undefined) run.toolCalls.add(event.toolCallId);
			if (event.type === "message_start" && event.message?.role === "user" && event.message.timestamp !== undefined) run.userMessages.add(event.message.timestamp);
			// Each model request starts with a user message, and queued steers go out with it.
			if (event.type !== "message_start" || event.message?.role !== "user" || run.pendingSteers === 0) return;
			run.pendingSteers = 0;
			if (!run.cancelled) emit({ type: "steer-delivered", searchId: run.searchId });
		});
		// A run that searches the person's index while it is not ready says so as soon as the search starts, not with the answer.
		const stopLocalTrack = deps.indexReadiness === undefined ? undefined : agent.onLocalTrack?.(() => void announceIndexReadiness(run));
		const stopContext = agent.onContext?.((event) => noteContext(run, event));
		try {
			// Reading a large PDF can outlast a Stop; a cancelled run never reaches the agent.
			const attached = await (deps.attachmentContext ?? buildAttachmentContext)(attachments);
			// The folder in view is only a hint; the renderer sends it when nothing is selected.
			const context = [attached, buildViewingFolderContext(viewingFolder)].filter((part) => part !== "").join("\n\n");
			const images = await (deps.attachmentImages ?? loadAttachmentImages)(attachments);
			if (run.cancelled) return;
			agent.setAttachmentContext(context);
			agent.setAttachmentImages?.(images);
			const hub = deps.interaction;
			agent.bindRun?.(hub === undefined ? undefined : { open: (body, signal) => hub.open(run.searchId, body, signal) });
			for await (const event of agent.searchDocumentsStream(query)) {
				if (run.cancelled) return;
				switch (event.type) {
					case "progress":
						// A note the answer already shows is not repeated on the shimmer line.
						emit({ type: "progress", searchId: run.searchId, text: live.isNote(event.text) ? "" : progressText(event.text) });
						break;
					case "preliminary": {
						run.sessionId = event.response.sessionId;
						run.firstAnswer = event.response.answer;
						run.quick = withNotes(mapPhase(event.response), "quick");
						emit({
							type: "quick",
							searchId: run.searchId,
							sessionId: run.sessionId,
							phase: run.quick,
						});
						await saveRunMessage(run, false);
						break;
					}
					case "revision":
						run.revisions.push(event.revision);
						emit({ type: "revision", searchId: run.searchId, revision: event.revision });
						await saveRunMessage(run, false);
						break;
					case "complete": {
						const failure = modelRequestFailure(event.response);
						if (failure !== null) {
							// No answer was made: the Quick answer, if one was shown, stays as it is and the error comes with it.
							run.failed = true;
							emit({ type: "error", searchId: run.searchId, message: failure, ...errorAction(failure) });
							break;
						}
						run.sessionId = event.response.sessionId;
						// A run that corrected the Quick answer ends with that answer corrected; only what follows it is new.
						const mapped = mapPhase(event.response);
						const added = run.quick !== null && run.revisions.some(isAnswerChange) ? remainderAfterRevised(run.firstAnswer, run.revisions, mapped.answer) : null;
						const phase = run.quick === null ? withNotes(mapped, "quick", "deep") : withNotes(added === null ? mapped : { ...mapped, answer: added }, "deep");
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
				const message = errorText(error);
				emit({ type: "error", searchId: run.searchId, message, ...errorAction(message) });
			}
		} finally {
			unsubscribe?.();
			stopLocalTrack?.();
			stopContext?.();
			// Nobody is asked once the run is over: a question still open closes, and its tool call is already unblocked.
			agent.bindRun?.(undefined);
			deps.interaction?.closeRun(run.searchId, "ended");
			run.ended = true;
			if (!run.cancelled) {
				emit({ type: "done", searchId: run.searchId });
				// A stream that ended with no answer at all did not answer.
				const answered = !(run.failed || (run.quick === null && run.deep === null));
				reportFinished(run, answered ? "answered" : "failed");
				if (answered) {
					runAfterAnswered();
					titleChatOnce(run);
				}
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
		start: async (searchId, chatId, query, attachments, viewingFolder) => {

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
				question: query,
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
				context: [],
				firstAnswer: "",
				revisions: [],
				toolCalls: new Set(),
				userMessages: new Set(),
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
				// A follow-up keeps the title the chat was given.
				...(existing?.summaryTitle === undefined ? {} : { summaryTitle: existing.summaryTitle }),
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
			void consume(run, agent, query, attachments, viewingFolder);
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
		classifyFollowUp: async (searchId, text) => {
			const run = active.get(searchId);
			const trimmed = text.trim();
			if (run === undefined || run.cancelled || run.ended || trimmed === "" || deps.sortFollowUp === undefined) return "next";
			return deps.sortFollowUp(run.question, trimmed).catch(() => "next" as const);
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
		pasteImage: async (mimeType, base64) => {
			if (typeof mimeType !== "string" || typeof base64 !== "string" || deps.pastedImages === undefined) return null;
			try {
				if (deps.acceptsImages !== undefined && !(await deps.acceptsImages())) return null;
				const saved = await deps.pastedImages.save(mimeType, base64);
				// Scale it while the person types, so sending does not wait for it.
				void prepareAttachmentImage(saved);
				return saved;
			} catch {
				return null;
			}
		},
		historyClear: async () => {
			await closeAgents();
			await deps.sessions?.clear();
			await deps.chatStore.clear();
			await deps.pastedImages?.clear();
		},
		onEvent: () => () => undefined,
		dispose: closeAgents,
		resetAgents,
	};
}

/** Thinking levels pi accepts; the config-service validator keeps the same list. */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
	const reference = config.queryDecomposition?.model ?? OPENROUTER_DEFAULT_DECOMPOSITION_MODEL;
	const resolved = await resolveAgentModel({ ...config, model: reference }, { env, cwd });
	const apiKey = resolved.apiKey ?? resolved.providerApiKeys?.[resolved.model.provider];
	return { model: applyDazziThinkingLevels(resolved.model), ...(apiKey === undefined ? {} : { apiKey }) };
}

/**
 * `sessionDir` is where pi keeps each chat's conversation file: an app-owned folder, so the files move with the
 * app's data and "clear history" can delete exactly them.
 */
export interface DefaultAgentFactoryOptions {
	readonly sessionDir: string;
	/** When provided, the main AI Agent can also list, create, verify, customize, and delete right-click Magic Actions directly. */
	readonly settings?: Pick<SettingsBridge, "get" | "set">;
	readonly language?: () => ReplyLanguage;
}

type LibrarianAgentTool = NonNullable<AutoRAGAgentOptions["tools"]>[number];

function toLibrarianAgentTools(tools: readonly ToolDefinition[]): LibrarianAgentTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate, undefined as never),
	}));
}

export function createDefaultAgentFactory(options: DefaultAgentFactoryOptions): () => Promise<SearchAgent> {
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
		const sllm = await resolveSllmDecisionModel(effective, input.env, input.cwd, agentDir, { allowFallback: false });
		// The decomposition model's thinking is upstream-fixed off; only the
		// two-phase answer model takes config thinking.fast/final.
		const thinking = readThinking(raw);
		const baseOptions = buildAgentOptions(effective);
		const findNode = (): string | undefined =>
			resolveNodeBinary({ resourcesPath: process.resourcesPath ?? "", env: process.env, platform: process.platform });
		const automationSandboxDeps = {
			env: process.env,
			platform: process.platform,
			resourcesPath: process.resourcesPath ?? "",
			findNode,
		};
		const automationVerificationTracker = createAutomationVerificationTracker();
		const sandboxAutomationTool = createTestAutomationInSandboxTool({
			...automationSandboxDeps,
			tracker: automationVerificationTracker,
		});
		const language = options.language ?? (() => "ko" as const);
		const interaction = createAgentInteraction();
		const magicActionTools: LibrarianAgentTool[] =
			options.settings === undefined
				? []
				: toLibrarianAgentTools(
						createMagicActionTools({
							settings: options.settings,
							includeListTool: true,
							platform: process.platform,
							language,
							testMagicAction: (verifyInput) =>
								verifyMagicActionInSandbox(verifyInput, {
									resolveModel: async () => resolved,
									agentDir,
									env: process.env,
									platform: process.platform,
									language,
								}),
						}).tools,
					);
		const agentOptions: AutoRAGAgentOptions = {
			...baseOptions,
			tools: [...(baseOptions.tools ?? []), sandboxAutomationTool, ...magicActionTools],
			...(sllm !== undefined ? { jev: { ...baseOptions.jev, sllm } } : {}),
			model: resolved.model,
			piAgentDir: agentDir,
			piSessionDir: options.sessionDir,
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.providerApiKeys !== undefined ? { providerApiKeys: resolved.providerApiKeys } : {}),
			...(decomposition !== undefined ? { queryDecomposition: decomposition } : {}),
			...(thinking !== undefined ? { thinking } : {}),
		};
		const semantic = readAppIndexing(raw).semanticSearch;
		// The agent would retrain inside this (Electron main) process; the app trains in a child process instead (`ltr-service`).
		const agent = new InteractiveSearchAgent(
			agentOptionsForSemantic(withoutAgentAutoTrain(agentOptions), semantic),
			interaction,
			{
				systemPromptAddendum: buildUnifiedWorkflowsPrompt(process.platform, {
					includeMagicActions: magicActionTools.length > 0,
				}),
				...(magicActionTools.length > 0 ? { routeToDirectAction: isMagicActionManagementQuery } : {}),
			},
		);
		applySemanticPolicyToAgent(agent, semantic);
		// `manage_automations` starts programs by asking for "this Node"; in the app that would be the app itself.
		// Also enforces temporary-sandbox verification when saving new or edited automation rules.
		// Verified saves persist directly without popping a redundant confirmation form card.
		runAutomationToolOnNode(agent, findNode, {
			tracker: automationVerificationTracker,
			verifyRule: (rule, originalPaths) =>
				testAutomationInSandbox({ rule, originalPaths }, automationSandboxDeps),
		});
		return agent as SearchAgent;
	};
}

/**
 * Runs `question` through the same agent the AI Search panel builds, with no chat around it, and returns the sources
 * the answer cites, in order, or null when it produced no answer. The first-run tour calls this before it offers a
 * question, so the question it types into AI Search is one this index has already answered with a citation.
 * A model failure (a run that ends in the degraded "no final answer" text) is no answer, and so is an empty one.
 */
export async function answerQuestion(createAgent: () => Promise<SearchAgent>, question: string, signal?: AbortSignal): Promise<readonly string[] | null> {
	const agent = await createAgent();
	try {
		let final: SearchDocumentsResponse | null = null;
		for await (const event of agent.searchDocumentsStream(question)) {
			signal?.throwIfAborted();
			if (event.type === "complete") final = event.response;
		}
		if (final === null || modelRequestFailure(final) !== null || final.answer.trim() === "") return null;
		return final.results.flatMap((result) => (result.source === undefined ? [] : [result.source]));
	} finally {
		agent.abort?.();
	}
}
