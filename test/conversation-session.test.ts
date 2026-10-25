import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { JevBackend } from "jev-use";
import type { BackendRequest, RawAnswer } from "jev-use/dist/backends/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentInteraction } from "../src/main/agent-interaction";
import { createInteractionHub } from "../src/main/interaction-hub";
import { InteractiveSearchAgent } from "../src/main/interactive-search-agent";
import type { InteractionAnswer, InteractionRequest } from "../src/shared/interaction-contract";

/**
 * A chat is one model conversation, like the librarian's terminal UI: every question of the chat reaches the model with
 * the questions and answers before it, and the conversation resumes from its session file after a restart (pi's `/resume`).
 * The real librarian agent runs here on pi's scripted model; the scripted model records what it is sent.
 */

let root: string;
const disposers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-conversation-")));
});

afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	rmSync(root, { recursive: true, force: true });
});

/** The text of one transcript message, whatever its content shape. */
function textOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { text?: string; name?: string }) => part.text ?? "").join("\n");
}

/** One scripted model turn: its answer, or a tool call it makes. */
type Step = string | { readonly tool: string; readonly args: Parameters<typeof fauxToolCall>[1] };

interface Harness {
	readonly agent: InteractiveSearchAgent;
	/** Every model request so far: the transcript the model was sent. */
	readonly sent: string[][];
	readonly script: (...steps: Step[]) => void;
	readonly hub: ReturnType<typeof createInteractionHub>;
	readonly requests: InteractionRequest[];
}

interface Options {
	readonly sessionDir?: string;
	readonly jev?: JevBackend;
	readonly respond?: (request: InteractionRequest) => InteractionAnswer;
	readonly permissionMode?: "ask" | "auto" | "full";
}

function harness(options: Options = {}): Harness {
	const registration = registerFauxProvider({ api: `faux-conversation-${randomUUID()}`, models: [{ id: "conversation" }] });
	disposers.push(() => registration.unregister());
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const model = registration.getModel();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));

	const sent: string[][] = [];
	const script = (...steps: Step[]): void => {
		registration.appendResponses(
			steps.map((step): FauxResponseFactory => (context) => {
				sent.push(context.messages.map((message) => `[${message.role}] ${textOf(message)}`));
				return typeof step === "string"
					? fauxAssistantMessage(step, { stopReason: "stop" })
					: fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
			}),
		);
	};

	const requests: InteractionRequest[] = [];
	const hub = createInteractionHub({
		emitRequest: (request) => {
			requests.push(request);
			if (options.respond !== undefined) queueMicrotask(() => hub.answer(request.id, options.respond?.(request)));
		},
		emitClosed: () => undefined,
	});
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
			piSessionDir: options.sessionDir ?? join(root, "sessions"),
			filee: false,
			permissionMode: options.permissionMode ?? "full",
			...(options.jev === undefined ? { jev: false as const } : { jev: { backend: options.jev } }),
		},
		createAgentInteraction(),
	);
	agent.bindRun({ open: (body, signal) => hub.open("run-1", body, signal) });
	disposers.push(() => agent.closeSession());
	return { agent, sent, script, hub, requests };
}

/** Everything the model was sent on its last request. */
const lastRequest = (h: Harness): string => (h.sent.at(-1) ?? []).join("\n");

describe("a chat is one model conversation", () => {
	it("sends the earlier turns of the chat with a follow-up", async () => {
		const h = harness();
		await h.agent.openSession();
		// The first question runs the librarian's two phases (a fast answer, then verification); a follow-up is one plain turn.
		h.script("Nice to meet you, Moyaho.", "Verified: nice to meet you.", "You said your name is Moyaho grandpa.");

		await h.agent.searchDocuments("hi, my name is Moyaho grandpa");
		const afterFirst = h.sent.length;
		await h.agent.searchDocuments("what did I say my name was?");

		expect(h.sent.length).toBe(afterFirst + 1);
		const request = lastRequest(h);
		expect(request).toContain("hi, my name is Moyaho grandpa");
		expect(request).toContain("Verified: nice to meet you.");
		expect(request).toContain("what did I say my name was?");
	});

	it("keeps a vague follow-up about the chat's own topic: it does not need the other chats' questions to make sense", async () => {
		const h = harness();
		await h.agent.openSession();
		h.script("A.", "A, verified.", "No, I will search the web now.");

		await h.agent.searchDocuments("search recent news about the Seoul marathon within 3 days");
		await h.agent.searchDocuments("no, search the internet");

		const request = lastRequest(h);
		expect(request).toContain("search recent news about the Seoul marathon within 3 days");
		expect(request).toContain("no, search the internet");
	});

	it("does not mix chats: a chat that never heard of the topic is sent none of it", async () => {
		const first = harness();
		await first.agent.openSession();
		first.script("A.", "A, verified.");
		await first.agent.searchDocuments("my secret codeword is pineapple");

		const second = harness({ sessionDir: join(root, "other-sessions") });
		await second.agent.openSession();
		second.script("B.", "B, verified.");
		await second.agent.searchDocuments("what is the weather");

		expect(second.sent.flat().join("\n")).not.toContain("pineapple");
	});

	it("resumes the conversation from its session file after a restart", async () => {
		const sessions = join(root, "sessions");
		const before = harness({ sessionDir: sessions });
		const opened = await before.agent.openSession();
		before.script("Hello Moyaho.", "Hello Moyaho, verified.");
		await before.agent.searchDocuments("my name is Moyaho grandpa");
		const file = before.agent.sessionFile;
		expect(file).toBeDefined();
		expect(opened.resumed).toBe(false);
		expect(existsSync(file ?? "")).toBe(true);
		await before.agent.closeSession();

		// A new process: a fresh agent, handed the session file the chat kept.
		const after = harness({ sessionDir: sessions });
		const resumed = await after.agent.openSession({ resumeFile: file });
		expect(resumed.resumed).toBe(true);
		expect(after.agent.sessionFile).toBe(file);
		after.script("You are Moyaho grandpa.");
		await after.agent.searchDocuments("who am I?");

		const request = lastRequest(after);
		expect(request).toContain("my name is Moyaho grandpa");
		expect(request).toContain("Hello Moyaho, verified.");
		expect(request).toContain("who am I?");
	});

	it("starts a new conversation when the session file is gone, instead of failing the chat", async () => {
		const h = harness();
		const opened = await h.agent.openSession({ resumeFile: join(root, "sessions", "missing.jsonl") });
		expect(opened.resumed).toBe(false);
		h.script("Fresh.", "Fresh, verified.");
		await expect(h.agent.searchDocuments("hello")).resolves.toBeDefined();
	});

	it("opens a chat that has history but no session with that history already in the conversation", async () => {
		const h = harness();
		const opened = await h.agent.openSession({
			seed: [
				{ question: "my name is Moyaho grandpa", answer: "Nice to meet you, Moyaho." },
				{ question: "is the sky blue?", answer: "Yes, on a clear day." },
			],
		});
		expect(opened).toMatchObject({ resumed: false, seeded: 2 });
		h.script("You told me: Moyaho grandpa.");

		await h.agent.searchDocuments("what was my name again?");

		// A seeded conversation is a conversation: one plain turn, no first-question pipeline.
		expect(h.sent).toHaveLength(1);
		const request = lastRequest(h);
		expect(request).toContain("my name is Moyaho grandpa");
		expect(request).toContain("Nice to meet you, Moyaho.");
		expect(request).toContain("is the sky blue?");
		expect(request).toContain("Yes, on a clear day.");
	});

	it("writes a session file only once the conversation has an answer, so an unused chat leaves nothing behind", async () => {
		const sessions = join(root, "sessions");
		const h = harness({ sessionDir: sessions });
		await h.agent.openSession();
		expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
		// Resuming replaces the throwaway session the runtime opened first; it must not leave a file either.
		const other = harness({ sessionDir: sessions });
		h.script("A.", "A, verified.");
		await h.agent.searchDocuments("something");
		const file = h.agent.sessionFile;
		await other.agent.openSession({ resumeFile: file });
		expect(readdirSync(sessions)).toHaveLength(1);
	});

	it("puts attachments in front of a follow-up too, where the librarian builds no prompt of its own", async () => {
		const h = harness();
		await h.agent.openSession();
		h.script("A.", "A, verified.", "It is a budget file.");
		await h.agent.searchDocuments("hello");

		h.agent.setAttachmentContext("<attachments>budget-2026.xlsx</attachments>");
		await h.agent.searchDocuments("what is the attached file?");

		const request = lastRequest(h);
		expect(request).toContain("<attachments>budget-2026.xlsx</attachments>");
		expect(request).toContain("what is the attached file?");

		// And it is not repeated on the next follow-up once the panel clears it.
		h.agent.setAttachmentContext("");
		h.script("Still a budget file.");
		await h.agent.searchDocuments("and now?");
		const attachmentMentions = lastRequest(h).split("<attachments>budget-2026.xlsx</attachments>").length - 1;
		expect(attachmentMentions).toBe(1);
	});
});

describe("what the person said reaches Jev's approval judgment", () => {
	/** Jev that routes every question `direct`, classifies nothing as risky, and keeps the state of every permission request. */
	function jevThatRecords(): { backend: JevBackend; states: string[] } {
		const states: string[] = [];
		const backend: JevBackend = {
			name: "recording",
			judge: async (request: BackendRequest) => {
				if (request.questions.some((question) => question.id === "permission_delete")) {
					states.push(typeof request.state === "string" ? request.state : JSON.stringify(request.state));
				}
				const answer = (question: BackendRequest["questions"][number]): RawAnswer => {
					if (question.id === "route") return { answer: "direct", distribution: { local: 0.05, web: 0.05, direct: 0.9 }, confidence: 0.9 };
					if (question.id === "permission_gate") return { answer: "allow", distribution: { allow: 0.97, deny: 0.03 }, confidence: 0.97 };
					if (question.id.startsWith("permission_")) return { answer: question.id === "permission_delete" ? 0.95 : 0.02 };
					return { answer: 0.05 };
				};
				return { answers: request.questions.map(answer) };
			},
		};
		return { backend, states };
	}

	it("tells Jev what was asked in this chat, follow-ups included, so `auto` can approve what the person clearly asked for", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const jev = jevThatRecords();
		const h = harness({ jev: jev.backend, permissionMode: "auto" });
		await h.agent.openSession();
		h.script("Hello.");
		await h.agent.searchDocuments("hello there");

		// The follow-up asks for the deletion; the model answers with a shell call, then a closing sentence.
		h.script({ tool: "bash", args: { command: `rm ${file}` } }, "Deleted it.");
		await h.agent.searchDocuments("please delete report.pdf");

		// Jev approved on what was said, so nobody was asked, and the call ran.
		expect(h.requests).toHaveLength(0);
		expect(existsSync(file)).toBe(false);
		expect(jev.states.length).toBeGreaterThan(0);
		const judged = jev.states.at(-1) ?? "";
		expect(judged).toContain("please delete report.pdf");
		expect(judged).toContain("hello there");
	});
});
