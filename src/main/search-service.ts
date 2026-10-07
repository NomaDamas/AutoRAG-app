import { existsSync } from "node:fs";
import {
	buildAgentOptions,
	EMIT_AUTORAG_RESULTS_TOOL_NAME,
	resolveConfigReadOnly,
	type AutoRAGAgent,
	type AutoRAGAgentOptions,
	type SearchDocumentsResponse,
	type SearchDocumentsStreamEvent,
} from "@autorag/librarian";
import { readRawConfigObject, resolveAgentModel, resolveConfigPath, type CliConfig } from "@autorag/librarian/core";
import { applyAppIndexing } from "./app-indexing";
import type {
	AnswerPhase,
	AnswerPhaseName,
	ChatAttachment,
	ChatMessageAssistant,
	ChatMessageUser,
	SearchBridge,
	SearchStreamEvent,
} from "../shared/search-contract";
import { SEARCH_CHANNELS } from "../shared/search-contract";
import { AttachmentContextAgent, buildAttachmentContext } from "./attachment-context";
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
	/** The attachment block the next run puts in front of the model ("" for none). */
	readonly setAttachmentContext: (context: string) => void;
	readonly subscribe?: (listener: (event: LiveAgentEvent) => void) => () => void;
	readonly abort?: () => void;
	readonly createChatSession?: (options: { readonly systemPrompt: string }) => ChatSession;
};

export interface SearchServiceDeps {
	readonly agentFactory: () => SearchAgent | Promise<SearchAgent>;
	readonly chatStore: ChatStore;
	readonly send: (channel: string, payload: SearchStreamEvent) => void;
	readonly now?: () => Date;
	/** Reads a message's attachments into the agent's context block. Defaults to {@link buildAttachmentContext}. */
	readonly attachmentContext?: (attachments: readonly ChatAttachment[]) => Promise<string>;
}

interface SearchRun {
	readonly searchId: string;
	readonly chatId: string;
	/** Null while the async agent factory is still building it. */
	agent: SearchAgent | null;
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
 * Reasoning text is dropped: only the first thinking token of each phase is
 * forwarded, as a `thinking` signal.
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
	const thinkingPhases = new Set<AnswerPhaseName>();
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
			case "thinking_delta": {
				const current = phase();
				if (!update.delta || thinkingPhases.has(current)) return;
				thinkingPhases.add(current);
				emit({ type: "thinking", searchId, phase: current });
				return;
			}
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

function mapPhase(response: SearchDocumentsResponse): AnswerPhase {
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
	/** Most recently built agent, reused to record feedback without a rebuild. */
	let lastAgent: SearchAgent | null = null;

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

	async function consume(run: SearchRun, agent: SearchAgent, query: string, attachments: readonly ChatAttachment[]): Promise<void> {
		const mapLive = createLiveStreamMapper(run.searchId, (event) => {
			if (!run.cancelled) emit(event);
		});
		// Subscribe before the generator starts the run, or the first thinking
		// tokens are lost.
		const unsubscribe = agent.subscribe?.(mapLive);
		try {
			// Reading a large PDF can outlast a Stop; a cancelled run never reaches the agent.
			const context = await (deps.attachmentContext ?? buildAttachmentContext)(attachments);
			if (run.cancelled) return;
			agent.setAttachmentContext(context);
			for await (const event of agent.searchDocumentsStream(query)) {
				if (run.cancelled) return;
				switch (event.type) {
					case "progress":
						emit({ type: "progress", searchId: run.searchId, text: event.text });
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
						run.sessionId = event.response.sessionId;
						run.deep = mapPhase(event.response);
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
				quick: null,
				deep: null,
				sessionId: "",
			};
			// Register before the async factory resolves so Stop during creation
			// cancels the run instead of racing it.
			active.set(searchId, run);
			const existing = await deps.chatStore.get(chatId);
			await deps.chatStore.save({
				id: chatId,
				title: query,
				snippet: "",
				updatedAt: at,
				messages: [...(existing?.messages ?? []), userMessage],
			});
			let agent: SearchAgent;
			try {
				// A bad config (e.g. a search root that no longer exists) throws
				// here; the panel must show it instead of waiting forever.
				agent = await deps.agentFactory();
			} catch (error) {
				active.delete(searchId);
				if (!run.cancelled) {
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
			lastAgent = agent;
			void consume(run, agent, query, attachments);
			await finish;
		},
		cancel: async (searchId) => {
			const run = active.get(searchId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.agent?.abort?.();
			emit({ type: "cancelled", searchId });
			await saveRunMessage(run, true);
			active.delete(searchId);
			run.resolveFinish();
		},
		feedback: async (sessionId, useful, notUseful) => {
			// Reuse the agent that produced the session; only build one when no
			// search has run yet in this process.
			const agent = lastAgent ?? (await deps.agentFactory());
			await agent.recordFeedbackByNumbers(sessionId, [...useful], [...notUseful]);
		},
		historyList: () => deps.chatStore.list(),
		historyGet: (chatId) => deps.chatStore.get(chatId),
		historySearch: (query) => deps.chatStore.search(query),
		historyClear: () => deps.chatStore.clear(),
		onEvent: () => () => undefined,
	};
}

export function createDefaultAgentFactory(): () => Promise<SearchAgent> {
	return async () => {
		const input = { flags: {}, env: process.env, cwd: process.cwd() };
		const config = resolveConfigReadOnly(input);
		const configPath = resolveConfigPath(input).configPath;
		const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
		// librarian's resolveConfig drops `webSearch`; re-attach the raw block so
		// buildAgentOptions applies it, then layer the app's code-folder exclusions.
		const withWebSearch: CliConfig =
			raw.webSearch === undefined
				? config
				: { ...config, webSearch: raw.webSearch as NonNullable<CliConfig["webSearch"]> };
		const effective = await applyAppIndexing(withWebSearch, raw);
		const resolved = await resolveAgentModel(effective);
		const options: AutoRAGAgentOptions = {
			...buildAgentOptions(effective),
			model: resolved.model,
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.providerApiKeys !== undefined ? { providerApiKeys: resolved.providerApiKeys } : {}),
		};
		return new AttachmentContextAgent(options) as SearchAgent;
	};
}
