import {
	AutoRAGAgent,
	buildAgentOptions,
	EMIT_AUTORAG_RESULTS_TOOL_NAME,
	resolveConfigReadOnly,
	type AutoRAGAgentOptions,
	type SearchDocumentsResponse,
	type SearchDocumentsStreamEvent,
} from "@autorag/librarian";
import { resolveAgentModel } from "@autorag/librarian/core";
import type {
	AnswerPhase,
	AnswerPhaseName,
	ChatMessageAssistant,
	ChatMessageUser,
	SearchBridge,
	SearchStreamEvent,
} from "../shared/search-contract";
import { SEARCH_CHANNELS } from "../shared/search-contract";
import type { ChatStore } from "./chat-store";

/**
 * The librarian registers this fast-phase tool but does not export its name.
 * It is the tool whose `answer` argument becomes the Quick answer.
 */
const EMIT_FAST_ANSWER_TOOL_NAME = "emit_fast_answer";

/**
 * The slice of a pi agent event the live stream reads. `searchDocumentsStream`
 * only yields progress/preliminary/complete, so thinking and the answer text
 * streamed inside the emit tool-call arguments come from `subscribe`.
 */
export interface LiveAgentEvent {
	readonly type: string;
	readonly toolName?: string;
	readonly assistantMessageEvent?: {
		readonly type: string;
		readonly delta?: string;
		readonly contentIndex?: number;
		readonly partial?: { readonly content?: readonly unknown[] };
	};
}

type ChatSession = {
	readonly agent: {
		subscribe(listener: (event: unknown) => void): () => void;
	};
	prompt(text: string): Promise<void>;
	dispose(): void;
};

type SearchAgent = Pick<AutoRAGAgent, "recordFeedbackByNumbers"> & {
	readonly searchDocumentsStream: (query: string) => AsyncGenerator<SearchDocumentsStreamEvent, void, void>;
	readonly subscribe?: (listener: (event: LiveAgentEvent) => void) => () => void;
	readonly abort?: () => void;
	readonly createChatSession?: (options: { readonly systemPrompt: string }) => ChatSession;
};

export interface SearchServiceDeps {
	readonly agentFactory: () => SearchAgent;
	readonly chatStore: ChatStore;
	readonly send: (channel: string, payload: SearchStreamEvent) => void;
	readonly now?: () => Date;
}

interface SearchRun {
	readonly searchId: string;
	readonly chatId: string;
	readonly agent: SearchAgent;
	readonly startedAt: number;
	readonly finish: Promise<void>;
	readonly resolveFinish: () => void;
	cancelled: boolean;
	quick: AnswerPhase | null;
	deep: AnswerPhase | null;
	sessionId: string;
}

/** Answer text streamed so far in an emit tool call's partially parsed arguments. */
function streamedToolAnswer(event: NonNullable<LiveAgentEvent["assistantMessageEvent"]>): { readonly tool: string; readonly answer: string } | null {
	if (event.contentIndex === undefined) return null;
	const block = event.partial?.content?.[event.contentIndex];
	if (block === null || typeof block !== "object") return null;
	const { type, name, arguments: args } = block as { type?: unknown; name?: unknown; arguments?: unknown };
	if (type !== "toolCall" || typeof name !== "string" || args === null || typeof args !== "object") return null;
	const answer = (args as { answer?: unknown }).answer;
	return typeof answer === "string" ? { tool: name, answer } : null;
}

/**
 * Turns raw agent events into thinking/draft stream events for one run.
 * The two-phase flow runs the fast (Quick) prompt first; the phase flips to
 * Deep once emit_fast_answer has executed or the agent starts its second run
 * (the refinement prompt).
 */
function createLiveStreamMapper(searchId: string, emit: (event: SearchStreamEvent) => void): (event: LiveAgentEvent) => void {
	let agentRuns = 0;
	let fastAnswerDone = false;
	let quickText = "";
	let quickDraft = "";
	let deepDraft = "";
	const phase = (): AnswerPhaseName => (fastAnswerDone || agentRuns > 1 ? "deep" : "quick");
	const setQuickDraft = (text: string): void => {
		if (text === quickDraft || text.trim() === "") return;
		quickDraft = text;
		emit({ type: "quick-draft", searchId, text });
	};
	return (event) => {
		if (event.type === "agent_start") {
			agentRuns += 1;
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName === EMIT_FAST_ANSWER_TOOL_NAME) {
			fastAnswerDone = true;
			return;
		}
		const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
		if (update === undefined) return;
		switch (update.type) {
			case "thinking_delta":
				if (update.delta) emit({ type: "thinking-delta", searchId, phase: phase(), text: update.delta });
				return;
			case "text_delta":
				// A fast phase that answers in plain text (no emit_fast_answer call)
				// becomes the Quick answer, so its text is the Quick draft.
				if (phase() === "quick" && update.delta) {
					quickText += update.delta;
					setQuickDraft(quickText);
				}
				return;
			case "toolcall_delta": {
				const streamed = streamedToolAnswer(update);
				if (streamed === null) return;
				if (streamed.tool === EMIT_FAST_ANSWER_TOOL_NAME && phase() === "quick") {
					setQuickDraft(streamed.answer);
				} else if (streamed.tool === EMIT_AUTORAG_RESULTS_TOOL_NAME && streamed.answer !== deepDraft && streamed.answer.trim() !== "") {
					deepDraft = streamed.answer;
					emit({ type: "deep-draft", searchId, text: streamed.answer });
				}
				return;
			}
			default:
				return;
		}
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function mapPhase(response: SearchDocumentsResponse, elapsedMs: number): AnswerPhase {
	return {
		answer: response.answer,
		evidence: response.results.map((result) => ({
			number: result.number,
			title: result.title,
			summary: result.summary,
			source: result.source ?? null,
			excerpts: result.evidence.map((evidence) => evidence.excerpt),
			confidence: result.confidence,
			feedbackId: result.feedbackId,
		})),
		meta: `${(elapsedMs / 1000).toFixed(1)}s · ${response.searched} sources`,
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

export function createSearchService(deps: SearchServiceDeps): SearchBridge {
	const now = deps.now ?? (() => new Date());
	const active = new Map<string, SearchRun>();

	const emit = (event: SearchStreamEvent): void => deps.send(SEARCH_CHANNELS.event, event);

	async function saveRunMessage(run: SearchRun, stopped: boolean): Promise<void> {
		const existing = await deps.chatStore.get(run.chatId);
		if (existing === null) return;
		const messages = existing.messages.filter((message) => message.role !== "assistant");
		await deps.chatStore.save({
			...existing,
			messages: [...messages, assistantMessage(run, stopped, now)],
			updatedAt: now().toISOString(),
		});
	}

	async function consume(run: SearchRun, query: string): Promise<void> {
		const mapLive = createLiveStreamMapper(run.searchId, (event) => {
			if (!run.cancelled) emit(event);
		});
		// Subscribe before the generator starts the run, or the first thinking
		// tokens are lost.
		const unsubscribe = run.agent.subscribe?.(mapLive);
		try {
			for await (const event of run.agent.searchDocumentsStream(query)) {
				if (run.cancelled) return;
				switch (event.type) {
					case "progress":
						emit({ type: "progress", searchId: run.searchId, text: event.text });
						break;
					case "preliminary": {
						run.sessionId = event.response.sessionId;
						run.quick = mapPhase(event.response, now().getTime() - run.startedAt);
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
						run.sessionId = event.response.sessionId;
						run.deep = mapPhase(event.response, now().getTime() - run.startedAt);
						emit({
							type: "deep",
							searchId: run.searchId,
							sessionId: run.sessionId,
							phase: run.deep,
						});
						await saveRunMessage(run, false);
						break;
					}
					default:
						break;
				}
			}
		} catch (error) {
			if (!run.cancelled) {
				emit({ type: "error", searchId: run.searchId, message: errorText(error) });
			}
		} finally {
			unsubscribe?.();
			if (!run.cancelled) emit({ type: "done", searchId: run.searchId });
			active.delete(run.searchId);
			run.resolveFinish();
		}
	}

	return {
		start: async (searchId, chatId, query, attachments) => {
			let agent: SearchAgent;
			try {
				// A bad config (e.g. a search root that no longer exists) throws
				// here; the panel must show it instead of waiting forever.
				agent = deps.agentFactory();
			} catch (error) {
				emit({ type: "error", searchId, message: errorText(error) });
				emit({ type: "done", searchId });
				return;
			}
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
				agent,
				startedAt: now().getTime(),
				finish,
				resolveFinish,
				cancelled: false,
				quick: null,
				deep: null,
				sessionId: "",
			};
			active.set(searchId, run);
			const existing = await deps.chatStore.get(chatId);
			await deps.chatStore.save({
				id: chatId,
				title: query,
				snippet: "",
				updatedAt: at,
				messages: [...(existing?.messages ?? []), userMessage],
			});
			void consume(run, query);
			await finish;
		},
		cancel: async (searchId) => {
			const run = active.get(searchId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.agent.abort?.();
			emit({ type: "cancelled", searchId });
			await saveRunMessage(run, true);
			active.delete(searchId);
			run.resolveFinish();
		},
		feedback: async (sessionId, useful, notUseful) => {
			deps.agentFactory().recordFeedbackByNumbers(sessionId, [...useful], [...notUseful]);
		},
		historyList: () => deps.chatStore.list(),
		historyGet: (chatId) => deps.chatStore.get(chatId),
		historySearch: (query) => deps.chatStore.search(query),
		historyClear: () => deps.chatStore.clear(),
		onEvent: () => () => undefined,
	};
}

export function createDefaultAgentFactory(): () => SearchAgent {
	return () => {
		const config = resolveConfigReadOnly({ flags: {}, env: process.env, cwd: process.cwd() });
		const resolved = resolveAgentModel(config);
		const options: AutoRAGAgentOptions = {
			...buildAgentOptions(config),
			model: resolved.model,
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.providerApiKeys !== undefined ? { providerApiKeys: resolved.providerApiKeys } : {}),
		};
		return new AutoRAGAgent(options) as SearchAgent;
	};
}
