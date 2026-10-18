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
import { applyDazziThinkingLevels, openPlanRuntime, preferPlanOAuth } from "./dazzi-session-auth";
import { applyAppIndexing, readAppIndexing } from "./app-indexing";
import { agentOptionsForSemantic, applySemanticPolicyToAgent } from "./semantic-policy";
import type {
	AnswerPhase,
	AnswerPhaseName,
	ChatAttachment,
	ChatMessageAssistant,
	ChatRecord,
	ChatMessageUser,
	SearchBridge,
	SearchStreamEvent,
} from "../shared/search-contract";
import { SEARCH_CHANNELS } from "../shared/search-contract";
import { AttachmentContextAgent, buildAttachmentContext } from "./attachment-context";
import type { ChatStore } from "./chat-store";
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

export function createSearchService(deps: SearchServiceDeps): SearchBridge {
	const now = deps.now ?? (() => new Date());
	const active = new Map<string, SearchRun>();

	/**
	 * One agent per chat: the librarian keys its conversation memory ("everything
	 * judged earlier in this conversation") to the agent instance, so a follow-up
	 * in the same chat must reach the same agent. Only the New chat button starts
	 * a new chat id, and with it a new agent. Oldest chats are evicted past the cap.
	 */
	const agents = new Map<string, SearchAgent>();
	async function agentFor(chatId: string): Promise<SearchAgent> {
		const cached = agents.get(chatId);
		if (cached !== undefined) {
			// Re-insert so the Map's order is least recently used first.
			agents.delete(chatId);
			agents.set(chatId, cached);
			return cached;
		}
		const built = await deps.agentFactory();
		agents.set(chatId, built);
		for (const stale of [...agents.keys()].slice(0, Math.max(0, agents.size - MAX_CHAT_AGENTS))) agents.delete(stale);
		return built;
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
			let agent: SearchAgent;
			try {
				// A bad config (e.g. a search root that no longer exists) throws
				// here; the panel must show it instead of waiting forever.
				agent = await agentFor(chatId);
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
			run.agent?.abort?.();
			emit({ type: "cancelled", searchId });
			await saveRunMessage(run, true);
			active.delete(searchId);
			run.resolveFinish();
		},
		historyList: () => deps.chatStore.list(),
		historyGet: (chatId) => deps.chatStore.get(chatId),
		historySearch: (query) => deps.chatStore.search(query),
		historyClear: () => deps.chatStore.clear(),
		onEvent: () => () => undefined,
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

export function createDefaultAgentFactory(): () => Promise<SearchAgent> {
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
		// Credentials resolve fresh from auth.json/process.env on every agent build,
		// so a login or key change reaches the next search without a restart.
		// The signed-in plan authenticates through its stored OAuth credential; the
		// session must not replace it with an API key (see dazzi-session-auth.ts).
		const resolved = await preferPlanOAuth(await resolveAgentModel(effective, { env: input.env, cwd: input.cwd }), () => openPlanRuntime(getAgentDir(), input.env));
		const decomposition = await resolveDecomposition(effective, input.env, input.cwd);
		// The decomposition model's thinking is upstream-fixed off; only the
		// two-phase answer model takes config thinking.fast/final.
		const thinking = readThinking(raw);
		const options: AutoRAGAgentOptions = {
			...buildAgentOptions(effective),
			model: applyDazziThinkingLevels(resolved.model),
			...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
			...(resolved.providerApiKeys !== undefined ? { providerApiKeys: resolved.providerApiKeys } : {}),
			...(decomposition !== undefined ? { queryDecomposition: decomposition } : {}),
			...(thinking !== undefined ? { thinking } : {}),
		};
		const semantic = readAppIndexing(raw).semanticSearch;
		const agent = new AttachmentContextAgent(agentOptionsForSemantic(options, semantic));
		applySemanticPolicyToAgent(agent, semantic);
		return agent as SearchAgent;
	};
}
