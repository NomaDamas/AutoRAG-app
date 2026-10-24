import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore, type ChatStore } from "../src/main/chat-store";
import type { RunInteraction } from "../src/main/host-ui";
import { createInteractionHub } from "../src/main/interaction-hub";
import type { InteractionAnswer, InteractionRequest } from "../src/shared/interaction-contract";
import { buildAgentOptions, type CliConfig } from "@autorag/librarian";
import {
	createSearchService,
	DEFAULT_WEB_SEARCH_PROVIDER_ORDER,
	resolveWebSearchConfig,
	type LiveAgentEvent,
} from "../src/main/search-service";
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
	const listeners = new Set<(event: LiveAgentEvent) => void>();
	const live = (event: LiveAgentEvent): void => {
		for (const listener of listeners) listener(event);
	};
	return {
		listeners,
		live,
		searchDocumentsStream: vi.fn(() => stream(live)),
		subscribe: (listener: (event: LiveAgentEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		abort: vi.fn(),
		steer: vi.fn((_text: string): boolean => true),
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
			},
		]);
	});

	it("signals thinking once per phase without its text and streams each plain-text answer as that phase's draft", async () => {
		const update = (assistantMessageEvent: NonNullable<LiveAgentEvent["assistantMessageEvent"]>): LiveAgentEvent => ({
			type: "message_update",
			assistantMessageEvent,
		});
		const assistant = (type: "message_start" | "message_end", stopReason?: string): LiveAgentEvent => ({
			type,
			message: { role: "assistant", ...(stopReason === undefined ? {} : { stopReason }) },
		});
		const text = (delta: string): LiveAgentEvent => update({ type: "text_delta", delta });
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live(assistant("message_start"));
			live(update({ type: "thinking_delta", delta: "Check the " }));
			live(update({ type: "thinking_delta", delta: "policy." }));
			live(text("Quick"));
			live(text(" answer"));
			live(assistant("message_end", "stop"));
			live({ type: "agent_end" });
			yield { type: "preliminary", response: createResponse("session-1", "Quick answer", 1) };
			live({ type: "agent_start" });
			live(assistant("message_start"));
			live(update({ type: "thinking_delta", delta: "Verify." }));
			live(text("Deep"));
			live(text(" answer"));
			live(assistant("message_end", "stop"));
			live({ type: "agent_end" });
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

	it("withdraws the draft of a message that turns out to end on a tool call", async () => {
		// A message that ends on a tool call is a progress note ("checking X next"),
		// not the answer. It streams like one, so it is only known afterwards.
		const update = (delta: string): LiveAgentEvent => ({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta },
		});
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live(update("Checking the July review."));
			live({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
			live({ type: "message_start", message: { role: "assistant" } });
			live(update("Final answer."));
			live({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
			yield { type: "complete", response: createResponse("session-note", "Final answer.", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-note", "chat-note", "refund approval", []);

		expect(events.filter((event) => event.type === "deep-draft")).toEqual([
			{ type: "deep-draft", searchId: "search-note", text: "Checking the July review." },
			{ type: "deep-draft", searchId: "search-note", text: "" },
			{ type: "deep-draft", searchId: "search-note", text: "Final answer." },
		]);
	});

	it("withdraws a progress note's draft as soon as the tool call starts, not when the message ends", async () => {
		// The tool runs after message_end, which can be seconds away; the note must
		// not sit in the answer area for that long.
		const { events, send } = collectEvents();
		let eventsAtToolStart = -1;
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking the July review." } });
			live({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } });
			// Everything the mapper emitted up to this point, before message_end is sent.
			eventsAtToolStart = events.filter((event) => event.type === "deep-draft").length;
			live({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
			yield { type: "complete", response: createResponse("session-tool", "Final answer.", 1) };
		});
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-tool", "chat-tool", "refund approval", []);

		// The note, then its withdrawal, were both out before message_end was sent.
		expect(eventsAtToolStart).toBe(2);
		const drafts = events.filter((event) => event.type === "deep-draft");
		expect(drafts).toEqual([
			{ type: "deep-draft", searchId: "search-tool", text: "Checking the July review." },
			{ type: "deep-draft", searchId: "search-tool", text: "" },
		]);
	});

	it("hides the librarian's citation markers in drafts, including a marker still being typed", async () => {
		const text = (delta: string): LiveAgentEvent => ({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta },
		});
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live(text("The cap is 28% [e"));
			live(text("3, e7]. Renews yearly [file:/Users/jeff/a"));
			live(text(".pdf] done."));
			live({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
			yield { type: "preliminary", response: createResponse("session-cite", "The cap is 28% [1].", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-cite", "chat-cite", "cap", []);

		const drafts = events.flatMap((event) => (event.type === "quick-draft" ? [event.text] : []));
		expect(drafts).toEqual(["The cap is 28%", "The cap is 28%. Renews yearly", "The cap is 28%. Renews yearly done."]);
		expect(drafts.some((draft) => /\[(?:e|file)/.test(draft))).toBe(false);
	});

	it("streams a plain-text fast phase as the Quick draft", async () => {
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Director " } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "approval." } });
			live({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
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

	it("sends a complete answer that no preliminary preceded as the Quick phase and stores it once", async () => {
		// Jev judged the fast answer final: the run streams only `complete`. Sent as
		// `deep` it would render beside the Quick draft that already shows its text.
		const response = createResponse("session-only", "Only answer", 4);
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response };
		});
		const { events, send } = collectEvents();
		const store = await createStore();
		const service = createSearchService({ agentFactory: () => agent, chatStore: store, send, now });

		await service.start("search-2", "chat-2", "refund approval", []);

		expect(events.filter((event) => event.type === "deep")).toEqual([]);
		const quick = events.find((event) => event.type === "quick");
		assert(quick !== undefined);
		expect(quick.searchId).toBe("search-2");
		expect(quick.sessionId).toBe("session-only");
		expect(quick.phase.answer).toBe("Only answer");
		const saved = await store.get("chat-2");
		const assistant = saved?.messages.find((message) => message.role === "assistant");
		assert(assistant?.role === "assistant");
		expect(assistant.quick?.answer).toBe("Only answer");
		expect(assistant.deep).toBeNull();
	});

	it("keeps streaming as Quick when the first agent_start errors without a preliminary answer", async () => {
		const agent = createFakeAgent(async function*(live) {
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
			live({ type: "agent_end" });
			live({ type: "agent_start" });
			live({ type: "message_start", message: { role: "assistant" } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Single " } });
			live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer." } });
			live({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
			live({ type: "agent_end" });
			yield { type: "complete", response: createResponse("session-fallback", "Single answer. [1]", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-fallback", "chat-fallback", "refund approval", []);

		expect(events.filter((event) => event.type === "deep-draft" || event.type === "deep")).toEqual([]);
		expect(events.filter((event) => event.type === "quick-draft")).toEqual([
			{ type: "quick-draft", searchId: "search-fallback", text: "Single " },
			{ type: "quick-draft", searchId: "search-fallback", text: "Single answer." },
		]);
		expect(events.filter((event) => event.type === "quick")).toHaveLength(1);
	});
	it("maps the complete event after a preliminary to the Deep phase", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "preliminary", response: createResponse("session-deep", "Quick answer", 1) };
			yield { type: "complete", response: createResponse("session-deep", "Deep answer", 4) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-2", "chat-2", "refund approval", []);

		expect(events.filter((event) => event.type === "quick" || event.type === "deep").map((event) => event.type)).toEqual(["quick", "deep"]);
		const deep = events.find((event) => event.type === "deep");
		assert(deep !== undefined);
		expect(deep.phase.answer).toBe("Deep answer");
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

	describe("follow-up questions in one chat", () => {
		it("appends each turn to the same chat record and reuses the chat's agent", async () => {
			let turn = 0;
			const agent = createFakeAgent(async function*() {
				turn += 1;
				yield { type: "complete", response: createResponse(`session-${turn}`, `Answer ${turn}`, 1) };
			});
			const agentFactory = vi.fn(() => agent);
			const service = createSearchService({ agentFactory, chatStore: await createStore(), send: () => undefined, now });

			await service.start("search-a", "chat-follow", "First question", []);
			await service.start("search-b", "chat-follow", "Second question", []);

			expect(agentFactory).toHaveBeenCalledTimes(1);
			const record = await service.historyGet("chat-follow");
			expect(record?.title).toBe("First question");
			expect(record?.messages).toMatchObject([
				{ role: "user", text: "First question" },
				{ role: "assistant", sessionId: "session-1", quick: { answer: "Answer 1" } },
				{ role: "user", text: "Second question" },
				{ role: "assistant", sessionId: "session-2", quick: { answer: "Answer 2" } },
			]);
		});

		it("builds a fresh agent for a new chat", async () => {
			const agentFactory = vi.fn(() =>
				createFakeAgent(async function*() {
					yield { type: "complete", response: createResponse("s", "A", 1) };
				}),
			);
			const service = createSearchService({ agentFactory, chatStore: await createStore(), send: () => undefined, now });

			await service.start("search-a", "chat-one", "Q1", []);
			await service.start("search-b", "chat-two", "Q2", []);

			expect(agentFactory).toHaveBeenCalledTimes(2);
		});

		it("keeps a follow-up's steer inside its own turn, after the earlier turn", async () => {
			const release = Promise.withResolvers<void>();
			const streaming = Promise.withResolvers<void>();
			let turn = 0;
			const agent = createFakeAgent(async function*() {
				turn += 1;
				if (turn === 2) {
					streaming.resolve();
					await release.promise;
				}
				yield { type: "complete", response: createResponse(`session-${turn}`, `Answer ${turn}`, 1) };
			});
			const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send: () => undefined, now });

			await service.start("search-a", "chat-steer-follow", "First", []);
			const second = service.start("search-b", "chat-steer-follow", "Second", []);
			await streaming.promise;
			expect(await service.steer("search-b", "Use June.")).toBe(true);
			release.resolve();
			await second;

			expect((await service.historyGet("chat-steer-follow"))?.messages).toMatchObject([
				{ role: "user", text: "First" },
				{ role: "assistant", sessionId: "session-1" },
				{ role: "user", text: "Second" },
				{ role: "user", text: "Use June.", steer: "before-quick" },
				{ role: "assistant", sessionId: "session-2" },
			]);
		});
	});

	describe("steer", () => {
		/** A run that waits for `quick` before its Quick answer and for `finish` before its Deep answer. */
		async function runningSearch({ afterQuick = true }: { readonly afterQuick?: boolean } = {}) {
			const quick = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const quickSeen = Promise.withResolvers<void>();
			const streaming = Promise.withResolvers<void>();
			const agent = createFakeAgent(async function*() {
				streaming.resolve();
				await quick.promise;
				yield { type: "preliminary", response: createResponse("session-steer", "Quick: May", 0) };
				await finish.promise;
				yield { type: "complete", response: createResponse("session-steer", "Deep: July", 1) };
			});
			const events: SearchStreamEvent[] = [];
			const store = await createStore();
			const service = createSearchService({
				agentFactory: () => agent,
				chatStore: store,
				send: (_channel, payload) => {
					events.push(payload);
					if (payload.type === "quick") quickSeen.resolve();
				},
				now,
			});
			const started = service.start("search-steer", "chat-steer", "When is the launch?", []);
			await streaming.promise;
			const showQuick = async (): Promise<void> => {
				quick.resolve();
				await quickSeen.promise;
			};
			if (afterQuick) await showQuick();
			return {
				agent,
				events,
				service,
				started,
				showQuick,
				finish: () => {
					quick.resolve();
					finish.resolve();
				},
			};
		}

		it("hands a message sent after the Quick answer to that run's agent and records it as the user's steer", async () => {
			const run = await runningSearch();

			expect(await run.service.steer("search-steer", "Use the June plan.")).toBe(true);
			run.finish();
			await run.started;

			expect(run.agent.steer).toHaveBeenCalledWith("Use the June plan.");
			// One run: the steer started no second search.
			expect(run.agent.searchDocumentsStream).toHaveBeenCalledTimes(1);
			const record = await run.service.historyGet("chat-steer");
			expect(record?.messages).toMatchObject([
				{ role: "user", text: "When is the launch?" },
				{ role: "user", text: "Use the June plan.", steer: "after-quick" },
				{ role: "assistant", deep: { answer: "Deep: July" } },
			]);
			expect(record?.messages[0]).not.toHaveProperty("steer");
		});

		it("records a steer sent before the Quick answer as such, ahead of that answer", async () => {
			const run = await runningSearch({ afterQuick: false });

			expect(await run.service.steer("search-steer", "Only last week's messages.")).toBe(true);
			await run.showQuick();
			run.finish();
			await run.started;

			expect((await run.service.historyGet("chat-steer"))?.messages).toMatchObject([
				{ role: "user", text: "When is the launch?" },
				{ role: "user", text: "Only last week's messages.", steer: "before-quick" },
				{ role: "assistant" },
			]);
		});

		it("reports delivery once a model request took the pending steers", async () => {
			const run = await runningSearch();
			await run.service.steer("search-steer", "Use the June plan.");

			// The run's own prompt is a user message too; only one after a steer counts.
			run.agent.live({ type: "message_start", message: { role: "assistant" } });
			expect(run.events.some((event) => event.type === "steer-delivered")).toBe(false);
			run.agent.live({ type: "message_start", message: { role: "user" } });
			run.agent.live({ type: "message_start", message: { role: "user" } });
			run.finish();
			await run.started;

			expect(run.events.filter((event) => event.type === "steer-delivered")).toEqual([
				{ type: "steer-delivered", searchId: "search-steer" },
			]);
		});

		it("refuses a steer the agent no longer takes and records nothing", async () => {
			const run = await runningSearch();
			run.agent.steer.mockReturnValueOnce(false);

			expect(await run.service.steer("search-steer", "Too late.")).toBe(false);
			run.finish();
			await run.started;

			const record = await run.service.historyGet("chat-steer");
			expect(record?.messages.filter((message) => message.role === "user")).toHaveLength(1);
		});

		it("refuses a steer for a finished, stopped, or unknown run without touching the agent", async () => {
			const finished = await runningSearch();
			finished.finish();
			await finished.started;
			expect(await finished.service.steer("search-steer", "After the answer.")).toBe(false);

			const stopped = await runningSearch();
			await stopped.service.cancel("search-steer");
			await stopped.started;
			expect(await stopped.service.steer("search-steer", "After Stop.")).toBe(false);

			expect(await stopped.service.steer("search-unknown", "Nobody runs this.")).toBe(false);
			expect(finished.agent.steer).not.toHaveBeenCalled();
			expect(stopped.agent.steer).not.toHaveBeenCalled();
		});

		it("refuses a blank steer", async () => {
			const run = await runningSearch();

			expect(await run.service.steer("search-steer", "   ")).toBe(false);
			run.finish();
			await run.started;

			expect(run.agent.steer).not.toHaveBeenCalled();
		});
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

describe("createSearchService usage analytics", () => {
	interface Tracked {
		readonly event: string;
		readonly properties: unknown;
	}

	function recorder(): { tracked: Tracked[]; analytics: { track: (event: never, properties: never) => void } } {
		const tracked: Tracked[] = [];
		return { tracked, analytics: { track: (event, properties) => void tracked.push({ event, properties }) } };
	}

	it("reports a started and a finished run with only coarse facts, never the query or the answer", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "preliminary", response: createResponse("session-a", "Quick answer about 분기 매출", 1) };
			yield { type: "complete", response: createResponse("session-a", "Deep answer", 1) };
		});
		const { tracked, analytics } = recorder();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send: () => undefined, now, analytics });

		await service.start("search-a", "chat-a", "분기 매출 계약서", []);

		expect(tracked).toEqual([
			{ event: "ai_search_started", properties: { has_attachments: false, follow_up: false } },
			{ event: "ai_search_finished", properties: { outcome: "answered", deepened: true, duration: "lt_1s" } },
		]);
		expect(JSON.stringify(tracked)).not.toMatch(/분기|refund|Quick answer|Deep answer/u);
	});

	it("marks a quick-only answer as not deepened", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-b", "Only answer", 1) };
		});
		const { tracked, analytics } = recorder();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send: () => undefined, now, analytics });

		await service.start("search-b", "chat-b", "refund approval", []);

		expect(tracked.at(-1)).toEqual({ event: "ai_search_finished", properties: { outcome: "answered", deepened: false, duration: "lt_1s" } });
	});

	it("flags a follow-up turn in an existing chat and a run that carries attachments", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-c", "Answer", 1) };
		});
		const { tracked, analytics } = recorder();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send: () => undefined,
			now,
			analytics,
			attachmentContext: async () => "",
		});

		await service.start("search-c1", "chat-c", "first question", []);
		await service.start("search-c2", "chat-c", "second question", [{ kind: "file", id: "/Users/jeff/Documents/secret.pdf", name: "secret.pdf" }]);

		expect(tracked.filter((entry) => entry.event === "ai_search_started").map((entry) => entry.properties)).toEqual([
			{ has_attachments: false, follow_up: false },
			{ has_attachments: true, follow_up: true },
		]);
		expect(JSON.stringify(tracked)).not.toMatch(/secret|Users|question/u);
	});

	it("reports a failed run, whether the agent throws or cannot be built", async () => {
		const throwing = createFakeAgent(async function*() {
			yield { type: "progress", sessionId: "", query: "q", text: "working" };
			throw new Error("provider exploded at /Users/jeff/Documents");
		});
		const first = recorder();
		await createSearchService({ agentFactory: () => throwing, chatStore: await createStore(), send: () => undefined, now, analytics: first.analytics }).start("search-d1", "chat-d1", "q", []);
		expect(first.tracked.at(-1)).toEqual({ event: "ai_search_finished", properties: { outcome: "failed", deepened: false, duration: "lt_1s" } });
		expect(JSON.stringify(first.tracked)).not.toMatch(/exploded|Users/u);

		const second = recorder();
		await createSearchService({
			agentFactory: () => {
				throw new Error("search root does not exist");
			},
			chatStore: await createStore(),
			send: () => undefined,
			now,
			analytics: second.analytics,
		}).start("search-d2", "chat-d2", "q", []);
		expect(second.tracked.map((entry) => entry.event)).toEqual(["ai_search_started", "ai_search_finished"]);
		expect(second.tracked.at(-1)?.properties).toEqual({ outcome: "failed", deepened: false, duration: "lt_1s" });
	});

	it("reports a stopped run exactly once", async () => {
		const quickSeen = Promise.withResolvers<void>();
		const agent = createFakeAgent(async function*() {
			yield { type: "preliminary", response: createResponse("session-e", "Quick answer", 1) };
			await Promise.withResolvers<void>().promise;
		});
		const { tracked, analytics } = recorder();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send: (_channel, payload) => {
				if (payload.type === "quick") quickSeen.resolve();
			},
			now,
			analytics,
		});

		const started = service.start("search-e", "chat-e", "refund approval", []);
		await quickSeen.promise;
		await service.cancel("search-e");
		await started;

		expect(tracked.filter((entry) => entry.event === "ai_search_finished")).toEqual([
			{ event: "ai_search_finished", properties: { outcome: "stopped", deepened: false, duration: "lt_1s" } },
		]);
	});

	it("runs unchanged without an analytics sink", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-f", "Answer", 1) };
		});
		const { events, send } = collectEvents();
		await createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now }).start("search-f", "chat-f", "q", []);
		expect(events.at(-1)).toEqual({ type: "done", searchId: "search-f" });
	});
});

describe("resolveWebSearchConfig", () => {
	const baseConfig: CliConfig = {
		searchPaths: ["/tmp/docs"],
		workspacePath: "/tmp/workspace",
		memoryPath: "/tmp/memory.json",
	};

	it("puts parallel and duckduckgo first in the fallback chain when webSearch is absent", () => {
		expect(DEFAULT_WEB_SEARCH_PROVIDER_ORDER).toEqual(["parallel", "duckduckgo"]);
		const webSearch = resolveWebSearchConfig({});
		expect(webSearch).toEqual({ order: ["parallel", "duckduckgo"] });
		const agentOpts = buildAgentOptions({ ...baseConfig, webSearch });
		expect(agentOpts.webSearch).toEqual({ order: ["parallel", "duckduckgo"] });
	});

	it("fills in the default order when webSearch is an object without an explicit order", () => {
		const webSearch = resolveWebSearchConfig({ webSearch: { timeoutSeconds: 30, fetch: { timeoutSeconds: 15 } } });
		expect(webSearch).toEqual({
			timeoutSeconds: 30,
			fetch: { timeoutSeconds: 15 },
			order: ["parallel", "duckduckgo"],
		});
		const agentOpts = buildAgentOptions({ ...baseConfig, webSearch });
		expect(agentOpts.webSearch).toEqual({
			timeoutSeconds: 30,
			fetch: { timeoutSeconds: 15 },
			order: ["parallel", "duckduckgo"],
		});
	});

	it("preserves an explicit user-configured webSearch.order", () => {
		const webSearch = resolveWebSearchConfig({ webSearch: { order: ["duckduckgo", "parallel", "mojeek"] } });
		expect(webSearch).toEqual({ order: ["duckduckgo", "parallel", "mojeek"] });
	});

	it("preserves disabled webSearch (false or enabled: false)", () => {
		expect(resolveWebSearchConfig({ webSearch: false })).toEqual({ enabled: false });
		expect(buildAgentOptions({ ...baseConfig, webSearch: resolveWebSearchConfig({ webSearch: false }) }).webSearch).toBe(false);

		expect(resolveWebSearchConfig({ webSearch: { enabled: false } })).toEqual({ enabled: false });
		expect(buildAgentOptions({ ...baseConfig, webSearch: resolveWebSearchConfig({ webSearch: { enabled: false } }) }).webSearch).toBe(false);
	});
});

describe("createSearchService interaction", () => {
	function hubFor(requests: InteractionRequest[]) {
		return createInteractionHub({ emitRequest: (request) => requests.push(request), emitClosed: () => undefined });
	}
	const question = {
		kind: "question",
		questions: [{ question: "Which?", options: [{ title: "A" }], allowMultiple: false, allowFreeform: false }],
	} as const;

	it("lets the agent ask the person while the run streams, and stops asking once it ended", async () => {
		const requests: InteractionRequest[] = [];
		const hub = hubFor(requests);
		let bound: RunInteraction | undefined;
		let answer: InteractionAnswer | undefined;
		const agent = {
			...createFakeAgent(async function*() {
				answer = await bound?.open(question);
				yield { type: "complete", response: createResponse("session-ask", "Done", 1) };
			}),
			bindRun: vi.fn((run: RunInteraction | undefined) => {
				bound = run;
			}),
		};
		const { send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now, interaction: hub });

		const run = service.start("search-ask", "chat-ask", "which one", []);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		expect(requests[0]).toMatchObject({ kind: "question", searchId: "search-ask" });
		hub.answer(requests[0]?.id ?? "", { kind: "question", answers: [{ kind: "selection", selections: ["A"] }] });
		await run;

		expect(answer).toEqual({ kind: "question", answers: [{ kind: "selection", selections: ["A"] }] });
		expect(bound).toBeUndefined();
		expect(hub.pending()).toHaveLength(0);
	});

	it("closes the open question when the run is stopped, so the agent is not left waiting", async () => {
		const requests: InteractionRequest[] = [];
		const hub = hubFor(requests);
		let bound: RunInteraction | undefined;
		let answered: Promise<InteractionAnswer> | undefined;
		const agent = {
			...createFakeAgent(async function*() {
				answered = bound?.open(question);
				await answered;
				yield { type: "complete", response: createResponse("session-stop", "Never", 1) };
			}),
			bindRun: (run: RunInteraction | undefined) => {
				bound = run;
			},
		};
		const { send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now, interaction: hub });

		const run = service.start("search-stop", "chat-stop", "which one", []);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		await service.cancel("search-stop");
		await run;

		await expect(answered).resolves.toEqual({ kind: "cancel" });
		expect(hub.pending()).toHaveLength(0);
		expect(agent.abort).toHaveBeenCalled();
	});

	it("starts every agent in the mode in force, and moves running agents when it changes", async () => {
		const first = { ...createFakeAgent(async function*() {}), setApprovalMode: vi.fn() };
		const second = { ...createFakeAgent(async function*() {}), setApprovalMode: vi.fn() };
		const agents = [first, second];
		const { send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agents.shift() ?? second,
			chatStore: await createStore(),
			send,
			now,
			approvalMode: async () => "ask",
		});

		await service.start("search-a", "chat-a", "one", []);
		expect(first.setApprovalMode).toHaveBeenLastCalledWith("ask");

		service.setApprovalMode("full");
		expect(first.setApprovalMode).toHaveBeenLastCalledWith("full");

		// A chat opened afterwards starts in what the person chose, not in what was stored at launch.
		await service.start("search-b", "chat-b", "two", []);
		expect(second.setApprovalMode).toHaveBeenLastCalledWith("full");
	});

	it("falls back to auto when nothing says otherwise", async () => {
		const agent = { ...createFakeAgent(async function*() {}), setApprovalMode: vi.fn() };
		const { send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now });

		await service.start("search-c", "chat-c", "one", []);

		expect(agent.setApprovalMode).toHaveBeenLastCalledWith("auto");
	});
});

describe("createSearchService preflight", () => {
	it("refuses a run the preflight stops: the person is told why, and no agent is built or asked", async () => {
		const agentFactory = vi.fn(() => createFakeAgent(async function*() {}));
		const { events, send } = collectEvents();
		const store = await createStore();
		const service = createSearchService({
			agentFactory,
			chatStore: store,
			send,
			now,
			preflight: async () => ({ message: "Weekly credits are used up." }),
		});

		await service.start("search-q", "chat-q", "what is in a.txt", []);

		expect(events).toEqual([
			{ type: "error", searchId: "search-q", message: "Weekly credits are used up." },
			{ type: "done", searchId: "search-q" },
		]);
		expect(agentFactory).not.toHaveBeenCalled();
		// The question stays in the chat, so the person can ask it again once the credits are back.
		expect((await store.get("chat-q"))?.messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("runs as usual when the preflight has nothing to say", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-ok", "Fine", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({ agentFactory: () => agent, chatStore: await createStore(), send, now, preflight: async () => null });

		await service.start("search-ok", "chat-ok", "question", []);

		expect(events.some((event) => event.type === "quick")).toBe(true);
		expect(events.some((event) => event.type === "error")).toBe(false);
	});

	it("does not let a failing preflight stop the run: the server still has the last word", async () => {
		const agent = createFakeAgent(async function*() {
			yield { type: "complete", response: createResponse("session-pf", "Fine", 1) };
		});
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => agent,
			chatStore: await createStore(),
			send,
			now,
			preflight: async () => {
				throw new Error("account lookup blew up");
			},
		});

		await service.start("search-pf", "chat-pf", "question", []);

		expect(events.some((event) => event.type === "quick")).toBe(true);
	});
});

describe("createSearchService preflight action", () => {
	it("passes the action a refusal carries on to the panel, so it can offer the way out", async () => {
		const { events, send } = collectEvents();
		const service = createSearchService({
			agentFactory: () => createFakeAgent(async function*() {}),
			chatStore: await createStore(),
			send,
			now,
			preflight: async () => ({ message: "Weekly credits are used up.", action: "open-plan" }),
		});

		await service.start("search-action", "chat-action", "question", []);

		expect(events[0]).toEqual({ type: "error", searchId: "search-action", message: "Weekly credits are used up.", action: "open-plan" });
	});
});
