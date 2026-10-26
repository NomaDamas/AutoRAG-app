import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function build(mode: ApprovalMode, responses: FauxResponseStep[], respond: (request: InteractionRequest) => InteractionAnswer) {
	const registration = registerFauxProvider({ api: `faux-dazzi-${randomUUID()}`, models: [{ id: "interactive" }] });
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
			jev: false,
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

describe("file-change gate through the app's interaction hub", () => {
	it("ask mode: the person is asked before the shell runs, and Deny keeps the file", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("ask", removeFile(file), () => ({ kind: "approval", choice: "deny" }));

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(1);
		expect(t.requests[0]).toMatchObject({ kind: "approval", searchId: "run-1", call: `rm ${shellPath(file)}`, sessionScope: "all", categories: [] });
		expect(existsSync(file)).toBe(true);
		expect(t.results.find((result) => result.toolName === "bash")?.text).toMatch(/denied/i);
	});

	it("ask mode: Allow once lets the call run", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("ask", removeFile(file), () => ({ kind: "approval", choice: "allow-once" }));

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(1);
		expect(existsSync(file)).toBe(false);
	});

	it("passes the person's note to the model when they deny with one", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("ask", removeFile(file), () => ({ kind: "approval", choice: "deny-with-note", note: "work on a copy instead" }));

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(1);
		expect(existsSync(file)).toBe(true);
		expect(t.results.find((result) => result.toolName === "bash")?.text).toContain("work on a copy instead");
	});

	it("full mode never asks, and switching to it mid-session stops the questions", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("ask", removeFile(file), () => ({ kind: "approval", choice: "deny" }));
		t.agent.setApprovalMode("full");

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(0);
		expect(existsSync(file)).toBe(false);
	});

	it("auto mode with no judgment model asks about the call instead of letting it through", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("auto", removeFile(file), () => ({ kind: "approval", choice: "deny" }));

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(1);
		expect(t.requests[0]).toMatchObject({ kind: "approval", sessionScope: "unclassified", reason: "Jev is not configured" });
		expect(existsSync(file)).toBe(true);
	});

	it("blocks the call when nobody is bound to answer (between runs), rather than waiting forever", async () => {
		const file = join(root, "report.pdf");
		writeFileSync(file, "x");
		const t = await build("ask", removeFile(file), () => ({ kind: "approval", choice: "allow-once" }));
		t.agent.bindRun(undefined);

		await t.agent.searchDocuments("delete the report");

		expect(t.requests).toHaveLength(0);
		expect(existsSync(file)).toBe(true);
	});
});

describe("ask_user through the app's interaction hub", () => {
	const askReport = {
		question: "Which report should I use?",
		context: "Found two",
		options: [{ title: "Q3", description: "older" }, { title: "Q4", description: "latest" }],
	};

	it("shows the model's question and hands the chosen option back as the tool result", async () => {
		const t = await build("auto", toolThenFinish("ask_user", askReport), () => ({
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
		const t = await build("auto", toolThenFinish("ask_user", askReport), () => ({ kind: "cancel" }));

		await t.agent.searchDocuments("summarize the report");

		expect(t.results.find((result) => result.toolName === "ask_user")?.text).toBe("User cancelled the question");
	});
});
