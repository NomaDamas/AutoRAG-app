import { baselineJev } from "./baseline-jev";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentInteraction } from "../src/main/agent-interaction";
import { createInteractionHub } from "../src/main/interaction-hub";
import { InteractiveSearchAgent } from "../src/main/interactive-search-agent";
import type { ApprovalMode, InteractionAnswer, InteractionRequest } from "../src/shared/interaction-contract";

/**
 * The real librarian agent (v2.12) on pi's scripted model, with the app's hub behind its questions: what the
 * person is asked and what the model then sees, end to end through the file-change gate and `ask_user`.
 */

let root: string;
const disposers: (() => void)[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-interactive-agent-")));
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	rmSync(root, { recursive: true, force: true });
});

interface ToolResult {
	readonly toolName: string;
	readonly isError: boolean;
	readonly text: string;
}

async function build(
	mode: ApprovalMode,
	responses: FauxResponseStep[],
	respond: (request: InteractionRequest) => InteractionAnswer,
	input: ("text" | "image")[] = ["text", "image"],
) {
	const registration = registerFauxProvider({ api: `faux-dazzi-${randomUUID()}`, models: [{ id: "interactive", input }] });
	registration.setResponses(responses);
	disposers.push(() => registration.unregister());
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const model = registration.getModel();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));

	const requests: InteractionRequest[] = [];
	const hub = createInteractionHub({
		emitRequest: (request) => {
			requests.push(request);
			// Answered the way the window would: after the request has been shown.
			queueMicrotask(() => hub.answer(request.id, respond(request)));
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
			piSessionDir: join(root, "sessions"),
			jev: baselineJev(),
			filee: false,
			permissionMode: "full",
		},
		createAgentInteraction(),
	);
	agent.setApprovalMode(mode);
	// The chat's conversation is what the host UI is bound to: nothing can be asked before it is open.
	await agent.openSession();
	disposers.push(() => agent.closeSession());
	agent.bindRun({ open: (body, signal) => hub.open("run-1", body, signal) });

	const results: ToolResult[] = [];
	agent.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		const content: unknown = event.result?.content;
		const text = Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
		results.push({ toolName: event.toolName, isError: event.isError === true, text });
	});
	return { agent, hub, requests, results };
}

/** Fast answer, then the verification pass in which the model calls a tool and finishes. */
function toolThenFinish(toolName: string, args: Parameters<typeof fauxToolCall>[1]): FauxResponseStep[] {
	return [
		fauxAssistantMessage("fast answer", { stopReason: "stop" }),
		fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("all done", { stopReason: "stop" }),
	];
}

// The model's shell is bash, where unquoted backslashes in a Windows path are escapes.
const shellPath = (path: string): string => path.replaceAll("\\", "/");
const removeFile = (path: string) => toolThenFinish("bash", { command: `rm ${shellPath(path)}` });

describe("readonly / full permission gate through InteractiveSearchAgent", () => {
	it("readonly mode: blocks write tool and kernel-blocks shell deletions without asking Jev or opening dialogs", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const created = join(root, "new.txt");
		const t = await build(
			"readonly",
			[
				fauxAssistantMessage("fast answer", { stopReason: "stop" }),
				fauxAssistantMessage([fauxToolCall("write", { path: created, content: "nope" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: `rm ${shellPath(file)}` })], { stopReason: "toolUse" }),
				fauxAssistantMessage("all done", { stopReason: "stop" }),
			],
			() => ({ kind: "cancel" }),
		);

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(0);
		expect(existsSync(created)).toBe(false);
		expect(existsSync(file)).toBe(true);
		expect(t.results.find((result) => result.toolName === "write")?.text).toMatch(/read-only/i);
		expect(t.results.find((result) => result.toolName === "bash")?.isError).toBe(true);
	});

	it("readonly mode: still allows reading files via bash", async () => {
		const file = join(root, "notes.txt");
		writeFileSync(file, "hello-readonly");
		const t = await build("readonly", toolThenFinish("bash", { command: `cat ${shellPath(file)}` }), () => ({ kind: "cancel" }));

		await t.agent.searchDocuments("read the notes");

		expect(t.requests).toHaveLength(0);
		const bashRes = t.results.find((result) => result.toolName === "bash");
		expect(bashRes?.isError).toBe(false);
		expect(bashRes?.text).toContain("hello-readonly");
	});

	it("full mode allows file modifications, and switching readonly -> full mid-session takes effect immediately", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("readonly", removeFile(file), () => ({ kind: "cancel" }));
		t.agent.setApprovalMode("full");

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(0);
		expect(existsSync(file)).toBe(false);
	});
});

describe("ask_user through the app's interaction hub", () => {
	const askReport = {
		question: "Which report should I use?",
		context: "Found two",
		options: [{ title: "Q3", description: "older" }, { title: "Q4", description: "latest" }],
	};

	it("shows the model's question and hands the chosen option back as the tool result", async () => {
		const t = await build("readonly", toolThenFinish("ask_user", askReport), () => ({
			kind: "question",
			answers: [{ kind: "selection", selections: ["Q4"] }],
		}));

		await t.agent.searchDocuments("summarize the report");

		expect(t.requests).toHaveLength(1);
		expect(t.requests[0]).toMatchObject({
			kind: "question",
			questions: [
				{
					question: "Which report should I use?",
					context: "Found two",
					options: [{ title: "Q3", description: "older" }, { title: "Q4", description: "latest" }],
					allowMultiple: false,
					allowFreeform: true,
				},
			],
		});
		expect(t.results.find((result) => result.toolName === "ask_user")?.text).toBe("User answered: Q4");
	});

	it("tells the model the person cancelled instead of inventing an answer", async () => {
		const t = await build("readonly", toolThenFinish("ask_user", askReport), () => ({ kind: "cancel" }));

		await t.agent.searchDocuments("summarize the report");

		expect(t.results.find((result) => result.toolName === "ask_user")?.text).toBe("User cancelled the question");
	});
});

describe("onLocalTrack on the real librarian agent", () => {
	const answer = (text: string): FauxResponseStep => fauxAssistantMessage(text, { stopReason: "stop" });

	it("calls back once when a first question takes the local search track", async () => {
		const t = await build("readonly", [answer("fast answer"), answer("verified answer")], () => ({ kind: "cancel" }));
		const taken = vi.fn();
		const stop = t.agent.onLocalTrack(taken);
		disposers.push(stop);

		await t.agent.searchDocuments("what do my notes say about the refund policy?");

		expect(taken).toHaveBeenCalledTimes(1);
	});

	it("stays quiet for a follow-up the conversation answers by itself", async () => {
		const t = await build("readonly", [answer("fast answer"), answer("verified answer"), answer("follow-up answer")], () => ({ kind: "cancel" }));
		await t.agent.searchDocuments("what do my notes say about the refund policy?");
		const taken = vi.fn();
		disposers.push(t.agent.onLocalTrack(taken));

		await t.agent.searchDocuments("and who approves it?");

		expect(taken).not.toHaveBeenCalled();
	});

	it("reads the route the librarian's own progress tracker reports, so a librarian release that renames it fails here", async () => {
		const t = await build("readonly", [], () => ({ kind: "cancel" }));
		const tracker: unknown = Reflect.get(t.agent, "searchProgress");
		const progress = tracker as { begin(query: string): void; end(): void; beginStep(id: string, label: string): void; endStep(id: string, status: "done" | "failed", detail?: string): void };
		const taken = vi.fn();
		disposers.push(t.agent.onLocalTrack(taken));

		progress.begin("rename the invoices");
		progress.beginStep("route", "Routing the question");
		progress.endStep("route", "done", "organize");
		progress.end();
		expect(taken).not.toHaveBeenCalled();

		progress.begin("what is in my notes?");
		progress.beginStep("route", "Routing the question");
		expect(taken).not.toHaveBeenCalled();
		progress.endStep("route", "done", "local");
		expect(taken).toHaveBeenCalledTimes(1);
		progress.end();
	});
});

describe("pictures attached to a question", () => {
	const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

	/** The image blocks of every request the scripted model received, as the provider would send them. */
	function recordImages(requests: number[]): FauxResponseStep[] {
		const seen = (context: { messages: readonly { content: unknown }[] }): AssistantMessage => {
			const count = context.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block: { type?: string }) => block.type === "image").length;
			requests.push(count);
			return fauxAssistantMessage("answer", { stopReason: "stop" });
		};
		return [(context) => seen(context), (context) => seen(context), (context) => seen(context)];
	}

	it("puts them in front of the model on the first question and on a follow-up", async () => {
		const counts: number[] = [];
		const t = await build("readonly", recordImages(counts), () => ({ kind: "cancel" }));

		t.agent.setAttachmentImages([png]);
		await t.agent.searchDocuments("what is in this screenshot?");
		expect(counts.length).toBeGreaterThan(0);
		expect(counts.every((count) => count === 1)).toBe(true);

		counts.length = 0;
		t.agent.setAttachmentImages([png]);
		await t.agent.searchDocuments("and now?");
		// The first picture stays in the conversation and the follow-up adds its own.
		expect(Math.max(...counts)).toBe(2);
	});

	it("sends a question without pictures when none were set", async () => {
		const counts: number[] = [];
		const t = await build("readonly", recordImages(counts), () => ({ kind: "cancel" }));

		await t.agent.searchDocuments("hello");

		expect(counts.every((count) => count === 0)).toBe(true);
	});

	it("leaves them out for a model that takes no images, and still answers", async () => {
		const counts: number[] = [];
		const t = await build("readonly", recordImages(counts), () => ({ kind: "cancel" }), ["text"]);

		t.agent.setAttachmentImages([png]);
		await t.agent.searchDocuments("what is in this screenshot?");

		expect(counts.length).toBeGreaterThan(0);
		expect(counts.every((count) => count === 0)).toBe(true);
	});

	it("does not repeat them on the next question", async () => {
		const counts: number[] = [];
		const t = await build("readonly", recordImages(counts), () => ({ kind: "cancel" }));
		t.agent.setAttachmentImages([png]);
		await t.agent.searchDocuments("first");
		counts.length = 0;

		await t.agent.searchDocuments("second");

		expect(Math.max(...counts)).toBe(1);
	});
});

describe("explicit Turn-1 routeOverride", () => {
	it("bypasses Jev route classification when routeOverride is passed (organize / extra / local)", async () => {
		const askedQuestionIds: string[] = [];
		const registration = registerFauxProvider({ api: `faux-route-${randomUUID()}`, models: [{ id: "interactive", input: ["text"] }] });
		registration.setResponses([fauxAssistantMessage("organized files", { stopReason: "stop" })]);
		disposers.push(() => registration.unregister());
		const agentDir = join(root, "agent-route");
		mkdirSync(agentDir, { recursive: true });
		const model = registration.getModel();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));

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
				jev: {
					backend: {
						name: "recording-override",
						async judge(request) {
							askedQuestionIds.push(...request.questions.map((q) => q.id));
							return { answers: request.questions.map(() => ({ answer: 0.1 })) };
						},
					},
				},
				filee: false,
				permissionMode: "full",
			},
			createAgentInteraction(),
		);
		await agent.openSession();
		disposers.push(() => agent.closeSession());

		const response = await agent.searchDocuments("sort my files", { routeOverride: "organize" });
		expect(response.answer).toContain("organized files");
		// Jev route classification ("route") must NOT be called when routeOverride is explicit.
		expect(askedQuestionIds).not.toContain("route");
		expect(response.diagnostics?.some((d) => d.code === "query-routed" && d.source === "route-override" && d.message.includes("organize"))).toBe(true);
	});
});
