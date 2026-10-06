import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore, type ChatStore } from "../src/main/chat-store";
import { createSearchService, type LiveAgentEvent } from "../src/main/search-service";
import { SEARCH_CHANNELS, type ChatRecord, type SearchStreamEvent } from "../src/shared/search-contract";

interface TestResponse {
	readonly sessionId: string;
	readonly query: string;
	readonly results: readonly {
		readonly number: number;
		readonly title: string;
		readonly summary: string;
		readonly evidence: readonly { readonly excerpt: string; readonly lineNumber?: number }[];
		readonly confidence: number;
		readonly feedbackId: string;
		readonly source?: string;
	}[];
	readonly answer: string;
	readonly searched: number;
	readonly warnings: readonly "empty-query"[];
	readonly diagnostics: readonly [];
	readonly retrievalTrace: readonly [];
}

type TestStreamEvent =
	| { readonly type: "progress"; readonly sessionId: string; readonly query: string; readonly text: string }
	| { readonly type: "preliminary"; readonly response: TestResponse }
	| { readonly type: "complete"; readonly response: TestResponse };

const tempDirs: string[] = [];

function now(): Date {
	return new Date(0);
}

async function createStore(): Promise<ChatStore> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-search-service-"));
	tempDirs.push(directory);
	return createChatStore({ directory, now });
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createResponse(sessionId: string, answer: string, searched: number): TestResponse {
	return {
		sessionId,
		query: "refund approval",
		results: [
			{
				number: 1,
				title: "Refund policy",
				summary: "Director approval is required before payout.",
				evidence: [{ excerpt: "Refund exceptions require director approval before payout.", lineNumber: 3 }],
				confidence: 0.92,
				feedbackId: `${sessionId}:1`,
				source: "/Users/jeff/Documents/refund-policy.md",
			},
		],
		answer,
		searched,
		warnings: [],
		diagnostics: [],
		retrievalTrace: [],
	};
}

function createFakeAgent(stream: (live: (event: LiveAgentEvent) => void) => AsyncGenerator<TestStreamEvent, void, void>) {
	const feedbackCalls: { sessionId: string; useful: readonly number[]; notUseful: readonly number[] }[] = [];
	const listeners = new Set<(event: LiveAgentEvent) => void>();
	const live = (event: LiveAgentEvent): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		feedbackCalls,
		listeners,
		searchDocumentsStream: vi.fn(() => stream(live)),
		subscribe: (listener: (event: LiveAgentEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		recordFeedbackByNumbers: vi.fn(
			(sessionId: string, useful: readonly number[], notUseful: readonly number[] = []) => {
				feedbackCalls.push({ sessionId, useful, notUseful });
			},
		),
		abort: vi.fn(),
		setAttachmentContext: vi.fn((_context: string) => undefined),
	};
}

function collectEvents(): { events: SearchStreamEvent[]; send: (channel: string, payload: SearchStreamEvent) => void } {
	const events: SearchStreamEvent[] = [];
	return {
		events,
		send: (channel, payload) => {
			expect(channel).toBe(SEARCH_CHANNELS.event);
			events.push(payload);
		},
	};
}

describe("createSearchService", () => {
	it("maps the preliminary stream event to a Quick phase", async () => {
		const quickResponse = createResponse("session-quick", "**Quick** answer [1]", 2);
		const agent = createFakeAgent(async function*() {
			yield { type: "progress", sessionId: "", query: "refund approval", text: "Reviewing the query." };
			yield { type: "preliminary", response: quickResponse };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
		});

		await service.start("search-1", "chat-1", "refund approval", []);

		const progress = events.find((event) => event.type === "progress");
		assert(progress !== undefined);
		expect(progress).toEqual({ type: "progress", searchId: "search-1", text: "Reviewing the query." });
		const quick = events.find((event) => event.type === "quick");
		assert(quick !== undefined);
		expect(quick.searchId).toBe("search-1");
		expect(quick.sessionId).toBe("session-quick");
		expect(quick.phase.answer).toBe("**Quick** answer [1]");
		expect(quick.phase.evidence).toEqual([
			{
				number: 1,
				title: "Refund policy",
				summary: "Director approval is required before payout.",
				source: "/Users/jeff/Documents/refund-policy.md",
				excerpts: ["Refund exceptions require director approval before payout."],
				confidence: 0.92,
				feedbackId: "session-quick:1",
			},
		]);
	});

	it("signals thinking once per phase without its text and streams the emit tool-call answers as drafts", async () => {
		const update = (assistantMessageEvent: NonNullable<LiveAgentEvent["assistantMessageEvent"]>): LiveAgentEvent => ({
			type: "message_update",
			assistantMessageEvent,
		});
		const toolDelta = (name: string, answer: string): LiveAgentEvent =>
			update({
				type: "toolcall_delta",
				delta: "…",
				contentIndex: 1,
				partial: { content: [{ type: "thinking" }, { type: "toolCall", name, arguments: { answer } }] },
			});
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live(update({ type: "thinking_delta", delta: "Check the " }));
			live(update({ type: "thinking_delta", delta: "policy." }));
			live(toolDelta("emit_fast_answer", "Quick"));
			live(toolDelta("emit_fast_answer", "Quick answer"));
			live({ type: "tool_execution_end", toolName: "emit_fast_answer" });
			yield { type: "preliminary", response: createResponse("session-1", "Quick answer", 1) };
			live({ type: "agent_start" });
			live(update({ type: "thinking_delta", delta: "Verify." }));
			live(update({ type: "text_delta", delta: "Plan note." }));
			live(toolDelta("emit_autorag_results", "Deep"));
			live(toolDelta("emit_autorag_results", "Deep answer"));
			yield { type: "complete", response: createResponse("session-1", "Deep answer", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
		});

		await service.start("search-live", "chat-live", "refund approval", []);

		expect(events).toEqual([
			{ type: "thinking", searchId: "search-live", phase: "quick" },
			{ type: "quick-draft", searchId: "search-live", text: "Quick" },
			{ type: "quick-draft", searchId: "search-live", text: "Quick answer" },
			{ type: "quick", searchId: "search-live", sessionId: "session-1", phase: expect.anything() },
			{ type: "thinking", searchId: "search-live", phase: "deep" },
			{ type: "deep-draft", searchId: "search-live", text: "Deep" },
			{ type: "deep-draft", searchId: "search-live", text: "Deep answer" },
			{ type: "deep", searchId: "search-live", sessionId: "session-1", phase: expect.anything() },
			{ type: "done", searchId: "search-live" },
		]);
		expect(agent.listeners.size).toBe(0);
	});

	it("streams a plain-text fast phase as the Quick draft", async () => {
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Director " } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "approval." } });
			yield { type: "preliminary", response: createResponse("session-text", "Director approval.", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-text", "chat-text", "refund approval", []);

		expect(events.filter((event) => event.type === "quick-draft")).toEqual([
			{ type: "quick-draft", searchId: "search-text", text: "Director " },
			{ type: "quick-draft", searchId: "search-text", text: "Director approval." },
		]);
	});

	it("reports an agent construction failure as an error and ends the run", async () => {
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => {
				throw new Error("AutoRAG search root does not exist: /gone");
			},
			chatStore: await createStore(),
			send,
			now,
		});

		await service.start("search-bad", "chat-bad", "refund approval", []);

		expect(events).toEqual([
			{ type: "error", searchId: "search-bad", message: "Error: AutoRAG search root does not exist: /gone" },
			{ type: "done", searchId: "search-bad" },
		]);
	});

	it("maps the complete stream event to a Deep phase", async () => {
		const deepResponse = createResponse("session-deep", "Deep answer", 4);
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: deepResponse };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
		});

		await service.start("search-2", "chat-2", "refund approval", []);

		const deep = events.find((event) => event.type === "deep");
		assert(deep !== undefined);
		expect(deep.searchId).toBe("search-2");
		expect(deep.sessionId).toBe("session-deep");
		expect(deep.phase.answer).toBe("Deep answer");
		expect(deep.phase.evidence[0]?.feedbackId).toBe("session-deep:1");
	});

	it("cancels an in-flight stream, emits cancelled once, and stops iteration", async () => {
		let continuedAfterCancel = false;
		let notifyQuick: () => void = () => undefined;
		const quickSeen = new Promise<void>((resolve) => {
			notifyQuick = resolve;
		});
		const agent = createFakeAgent(async function*() {
			yield { type: "preliminary", response: createResponse("session-cancel", "Quick answer", 1) };
			await new Promise<void>(() => undefined);
			continuedAfterCancel = true;
			yield { type: "complete", response: createResponse("session-cancel", "Deep answer", 1) };
		});
		const events: SearchStreamEvent[] = [];
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send: (_channel, payload) => {
				events.push(payload);
				if (payload.type === "quick") notifyQuick();
			},
			now,
		});

		const started = service.start("search-3", "chat-3", "refund approval", []);
		await quickSeen;
		await service.cancel("search-3");
		await started;

		expect(agent.abort).toHaveBeenCalledTimes(1);
		expect(events.filter((event) => event.type === "cancelled")).toEqual([
			{ type: "cancelled", searchId: "search-3" },
		]);
		expect(events.some((event) => event.type === "deep")).toBe(false);
		expect(continuedAfterCancel).toBe(false);
		const record = await service.historyGet("chat-3");
		expect(record?.messages.at(-1)).toMatchObject({ role: "assistant", stopped: true });
	});

	it("emits an agent failure verbatim as an error event", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "progress", sessionId: "", query: "refund approval", text: "Reviewing the query." };
			throw new Error("provider exploded");
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
		});

		await service.start("search-4", "chat-4", "refund approval", []);

		expect(events.slice(-2)).toEqual([
			{ type: "error", searchId: "search-4", message: "Error: provider exploded" },
			{ type: "done", searchId: "search-4" },
		]);
	});

	it("delegates numbered feedback without changing the arrays", async () => {
		const agent = createFakeAgent(async function*() { });
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send: () => undefined,
			now,
		});

		await service.feedback("session-1", [1, 3], [2]);

		expect(agent.recordFeedbackByNumbers).toHaveBeenCalledWith("session-1", [1, 3], [2]);
		expect(agent.feedbackCalls).toEqual([{ sessionId: "session-1", useful: [1, 3], notUseful: [2] }]);
	});

	it("hands the attachment context to the agent before the run and keeps the query plain", async () => {
		const directory = await mkdtemp(join(tmpdir(), "autorag-search-attach-"));
		tempDirs.push(directory);
		const path = join(directory, "refund-exceptions.md");
		await writeFile(path, "Refund exceptions over 1M KRW need CFO sign-off.");
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-attach", "CFO sign-off [1]", 1) };
		});
		const store = await createStore();
		const service = createSearchService({ agentFactory: () => agent, chatStore: store, send: () => undefined, now });
		const attachments = [
			{ kind: "file" as const, id: path, name: "refund-exceptions.md" },
			{ kind: "url" as const, id: "https://example.com/policy", name: "example.com/policy" },
		];

		await service.start("search-attach", "chat-attach", "who signs off refund exceptions?", attachments);

		expect(agent.setAttachmentContext).toHaveBeenCalledTimes(1);
		const context = agent.setAttachmentContext.mock.calls[0]?.[0] ?? "";
		// The block writes paths as JSON strings, so Windows backslashes render escaped.
		expect(context).toContain(JSON.stringify(path));
		expect(context).toContain("Refund exceptions over 1M KRW need CFO sign-off.");
		expect(context).toContain("https://example.com/policy");
		expect(agent.searchDocumentsStream).toHaveBeenCalledWith("who signs off refund exceptions?");
		expect(agent.setAttachmentContext.mock.invocationCallOrder[0]).toBeLessThan(
			agent.searchDocumentsStream.mock.invocationCallOrder[0] ?? 0,
		);
		const record = await service.historyGet("chat-attach");
		expect(record?.messages[0]).toMatchObject({ role: "user", text: "who signs off refund exceptions?", attachments });
	});

	it("never starts the agent when the run is cancelled while attachments are read", async () => {
		const reading = Promise.withResolvers<void>();
		const context = Promise.withResolvers<string>();
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-late", "Late answer", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
			attachmentContext: () => {
				reading.resolve();
				return context.promise;
			},
		});

		const started = service.start("search-slow", "chat-slow", "summarize", [{ kind: "file", id: "/tmp/big.pdf", name: "big.pdf" }]);
		await reading.promise;
		await service.cancel("search-slow");
		context.resolve("context");
		await started;
		// The run's continuation after the read is pure microtasks; one macrotask
		// turn lets every one of them settle without a wall-clock wait.
		const drained = Promise.withResolvers<void>();
		setImmediate(drained.resolve);
		await drained.promise;

		expect(agent.searchDocumentsStream).not.toHaveBeenCalled();
		expect(events).toEqual([{ type: "cancelled", searchId: "search-slow" }]);
	});

	it("cancels a run while the async agent factory is still building the agent", async () => {
		const built = Promise.withResolvers<void>();
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-build", "Late answer", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: async () => {
				await built.promise;
				return agent;
			},
			chatStore: await createStore(),
			send,
			now,
		});

		const started = service.start("search-build", "chat-build", "refund approval", []);
		await service.cancel("search-build");
		built.resolve();
		await started;

		expect(agent.searchDocumentsStream).not.toHaveBeenCalled();
		expect(events).toEqual([{ type: "cancelled", searchId: "search-build" }]);
	});

	it("delegates history reads and clear to the chat store", async () => {
		const store = await createStore();
		const record: ChatRecord = {
			id: "chat-history",
			title: "Refund approval",
			snippet: "Director approval is required.",
			updatedAt: "2026-09-28T10:00:00.000Z",
			messages: [
				{ role: "user", text: "Refund approval", attachments: [], at: "2026-09-28T10:00:00.000Z" },
			],
		};
		await store.save(record);
		const service = createSearchService({
			agentFactory: () => createFakeAgent(async function*() { }),
			chatStore: store,
			send: () => undefined,
			now,
		});

		expect(await service.historyList()).toEqual([
			{
				id: "chat-history",
				title: "Refund approval",
				snippet: "Director approval is required.",
				updatedAt: "2026-09-28T10:00:00.000Z",
			},
		]);
		expect(await service.historyGet("chat-history")).toEqual(record);
		expect(await service.historySearch("approval")).toHaveLength(1);
		await service.historyClear();
		expect(await service.historyList()).toEqual([]);
	});
});
