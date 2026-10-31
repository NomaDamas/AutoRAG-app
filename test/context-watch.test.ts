import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentInteraction } from "../src/main/agent-interaction";
import { type ContextEvent, cutMessages } from "../src/main/context-watch";
import { InteractiveSearchAgent } from "../src/main/interactive-search-agent";

/**
 * Issue #389: what pi does to a chat's conversation when it no longer fits the model (it summarises the earlier turns,
 * then retries), and what the librarian's context guard leaves out of a request, must reach the AI Search panel. The
 * real librarian agent runs here on pi's scripted model.
 */

let root: string;
const disposers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-context-watch-")));
});

afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	rmSync(root, { recursive: true, force: true });
});

function textOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

/** What the scripted model answers to one request that is not pi's own summary request. */
type Reply = string | { readonly error: string } | { readonly tool: string; readonly id: string };

/** The provider's words for a request that is larger than the model's window (the hosted server's `context_length_exceeded`). */
const OVERFLOW = "400 context_length_exceeded: This model's maximum context length is 40000 tokens. However, you requested about 61000 tokens.";
const SUMMARY = "Earlier: the person asked about the refund policy and the budget.";

/** A tool that brings back far more text than the model's window holds, like the Spotlight result of 2026-10-31. */
const HUGE = "spotlight hit ".repeat(30_000);
const hugeTool: AgentTool = {
	name: "fetch_everything",
	label: "Fetch everything",
	description: "Returns every matching document in full.",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: HUGE }], details: undefined }),
};

interface Harness {
	readonly agent: InteractiveSearchAgent;
	readonly events: ContextEvent[];
	/** The tool results of every non-summary request, by call id: the text the model was sent. */
	readonly sentResults: Map<string, string>[];
	readonly reply: (...replies: Reply[]) => void;
}

async function harness(options: { readonly contextWindow?: number } = {}): Promise<Harness> {
	const registration = registerFauxProvider({
		api: `faux-context-${randomUUID()}`,
		models: [{ id: "context", contextWindow: options.contextWindow ?? 200_000, maxTokens: 8_000 }],
	});
	disposers.push(() => registration.unregister());
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const model = registration.getModel();
	// Keep only the newest turn whole, so a short conversation already has earlier turns to summarise.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id, compaction: { keepRecentTokens: 1 } }),
	);

	const replies: Reply[] = [];
	const sentResults: Map<string, string>[] = [];
	const respond: FauxResponseFactory = (context) => {
		// pi's own summary requests (the earlier turns, and the start of a turn cut in two) run under its summariser prompt.
		if (context.messages.some((message) => message.role === "system" && textOf(message).includes("context summarization assistant"))) {
			return fauxAssistantMessage(SUMMARY, { stopReason: "stop" });
		}
		const results = new Map<string, string>();
		for (const message of context.messages) {
			if (message.role === "toolResult") results.set(message.toolCallId, textOf(message));
		}
		sentResults.push(results);
		const next = replies.shift() ?? "Done.";
		if (typeof next === "string") return fauxAssistantMessage(next, { stopReason: "stop" });
		if ("error" in next) return fauxAssistantMessage([], { stopReason: "error", errorMessage: next.error });
		return fauxAssistantMessage([fauxToolCall(next.tool, {}, { id: next.id })], { stopReason: "toolUse" });
	};
	registration.appendResponses(Array.from({ length: 40 }, () => respond));

	const agent = new InteractiveSearchAgent(
		{
			model,
			apiKey: "test-key",
			searchPaths: [root],
			workspacePath: root,
			memoryPath: join(root, "memory.json"),
			minSync: { autoInstall: false },
			jikji: false,
			piAgentDir: agentDir,
			piSessionDir: join(root, "sessions"),
			filee: false,
			permissionMode: "full",
			jev: false,
			tools: [hugeTool],
		},
		createAgentInteraction(),
	);
	disposers.push(() => agent.closeSession());
	// A chat with earlier turns: the follow-up below is one plain turn of the conversation.
	await agent.openSession({
		seed: [
			{ question: "what does the refund policy say?", answer: "Refunds over $500 need director approval." },
			{ question: "and the budget?", answer: "The 2026 budget is in budget-2026.xlsx." },
		],
	});
	const events: ContextEvent[] = [];
	disposers.push(agent.onContext((event) => events.push(event)));
	return { agent, events, sentResults, reply: (...next) => replies.push(...next) };
}

describe("the conversation's context reaches the app", () => {
	it("reports the summary pi writes when a request overflows the model, then the retry answers", async () => {
		const h = await harness();
		h.reply({ error: OVERFLOW }, "The answer after the summary.");

		const response = await h.agent.searchDocuments("summarise everything we talked about");

		expect(h.events).toEqual([{ type: "compaction_start" }, { type: "compaction_end", compacted: true }]);
		expect(response.answer).toContain("The answer after the summary.");
	});

	it("reports a recovery that failed: the summary was written, but the retry overflowed again", async () => {
		const h = await harness();
		h.reply({ error: OVERFLOW }, { error: OVERFLOW });

		const response = await h.agent.searchDocuments("summarise everything we talked about");

		expect(h.events).toEqual([
			{ type: "compaction_start" },
			{ type: "compaction_end", compacted: true },
			{ type: "compaction_end", compacted: false },
		]);
		const failure = response.diagnostics?.find((entry) => entry.code === "model-request-failed");
		expect(failure?.message).toContain("context_length_exceeded");
	});

	it("names the tool results a request carried only part of, and only those", async () => {
		// The window holds the conversation and the system prompt, not the tool's 420k characters.
		const h = await harness({ contextWindow: 40_000 });
		h.reply({ tool: "fetch_everything", id: "call-huge" }, "Here is what I found.");

		await h.agent.searchDocuments("find every document about refunds");

		const sent = h.sentResults.at(-1)?.get("call-huge") ?? "";
		expect(sent.length).toBeGreaterThan(0);
		expect(sent.length).toBeLessThan(HUGE.length);
		const cuts = h.events.filter((event) => event.type === "request_cut");
		expect(cuts.some((event) => event.toolCallIds.includes("call-huge"))).toBe(true);
		expect(cuts.every((event) => event.toolCallIds.every((id) => id === "call-huge"))).toBe(true);
	});

	it("says nothing when every request carried the conversation whole", async () => {
		const h = await harness();
		h.reply("A short answer.");

		await h.agent.searchDocuments("hello again");

		expect(h.events).toEqual([]);
	});
});

describe("cutMessages", () => {
	const user = (text: string, timestamp: number) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp });

	it("names a prompt the request carried only part of, by its timestamp", () => {
		const prompt = user("Baseline retrieval evidence: [e1] a long hit [e2] another long hit", 2_000);
		const cut = user("Baseline retrieval evidence: [e1] a long hit", 2_000);

		expect(cutMessages([user("earlier", 1_000), prompt], [user("earlier", 1_000), cut])).toEqual({ toolCallIds: [], userMessages: [2_000] });
	});

	it("never compares two messages that share a millisecond, as a seeded chat's turns do", () => {
		const held = [user("what does the refund policy say?", 1_000), user("and the budget?", 1_000)];

		expect(cutMessages(held, held)).toEqual({ toolCallIds: [], userMessages: [] });
	});

	it("ignores what other steps add, like the memory block put in front", () => {
		const held = [user("hello", 1_000)];

		expect(cutMessages(held, [user("<memory_context>\nshort\n</memory_context>", 1_000), ...held])).toEqual({ toolCallIds: [], userMessages: [] });
	});
});
