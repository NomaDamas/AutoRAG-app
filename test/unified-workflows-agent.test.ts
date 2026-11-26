import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineJev } from "./baseline-jev";
import { createAgentInteraction } from "../src/main/agent-interaction";
import { resolveNodeBinary, runAutomationToolOnNode } from "../src/main/automation-runtime";
import {
	createAutomationVerificationTracker,
	createTestAutomationInSandboxTool,
	testAutomationInSandbox,
} from "../src/main/automation-sandbox";
import { InteractiveSearchAgent } from "../src/main/interactive-search-agent";
import { verifyMagicActionInSandbox } from "../src/main/magic-action-sandbox";
import { createMagicActionTools } from "../src/main/magic-action-tools";
import { buildUnifiedWorkflowsPrompt, isMagicActionManagementQuery } from "../src/main/workflow-sandbox";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";

let root: string;
const disposers: (() => void)[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-unified-workflows-")));
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	rmSync(root, { recursive: true, force: true });
});

interface TraceEntry {
	readonly toolName: string;
	readonly isError: boolean;
	readonly text: string;
}

function makeMemorySettings() {
	let current: AppSettings = structuredClone(DEFAULT_SETTINGS);
	return {
		get: async () => structuredClone(current),
		set: async (patch: Partial<AppSettings>) => {
			current = { ...current, ...patch };
			return structuredClone(current);
		},
		peek: () => current,
	};
}

function parseSessionJsonlTrace(sessionFile: string): readonly { readonly role: string; readonly toolNames: string[] }[] {
	const raw = readFileSync(sessionFile, "utf8");
	const entries: { role: string; toolNames: string[] }[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const rec = JSON.parse(trimmed) as {
			readonly type?: string;
			readonly message?: {
				readonly role?: string;
				readonly toolName?: string;
				readonly content?: readonly { readonly type?: string; readonly name?: string }[];
			};
		};
		if (rec.type !== "message" || rec.message === undefined) continue;
		const role = rec.message.role ?? "";
		if (role === "assistant" && Array.isArray(rec.message.content)) {
			const toolNames = rec.message.content
				.filter((p) => p.type === "toolCall" && typeof p.name === "string")
				.map((p) => p.name as string);
			if (toolNames.length > 0) entries.push({ role: "assistant:toolCall", toolNames });
		} else if (role === "toolResult" && typeof rec.message.toolName === "string") {
			entries.push({ role: "toolResult", toolNames: [rec.message.toolName] });
		}
	}
	return entries;
}

async function buildUnifiedAgent(responses: FauxResponseStep[]) {
	const capturedSystemPrompts: string[] = [];
	const capturedToolNames = new Set<string>();
	const captureContext = (context: { readonly messages?: readonly unknown[] }) => {
		if (!Array.isArray(context.messages)) return;
		for (const msg of context.messages) {
			if (msg === null || typeof msg !== "object") continue;
			const rec = msg as {
				readonly role?: string;
				readonly content?: string | readonly { readonly type?: string; readonly text?: string }[];
				readonly toolsAdded?: readonly { readonly name?: string }[];
			};
			if (rec.role !== "system") continue;
			if (typeof rec.content === "string" && rec.content.length > 0) {
				capturedSystemPrompts.push(rec.content);
			} else if (Array.isArray(rec.content)) {
				const joined = rec.content
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join("\n");
				if (joined.length > 0) capturedSystemPrompts.push(joined);
			}
			if (Array.isArray(rec.toolsAdded)) {
				for (const tool of rec.toolsAdded) {
					if (typeof tool.name === "string") capturedToolNames.add(tool.name);
				}
			}
		}
	};
	const registration = registerFauxProvider({
		api: `faux-unified-${randomUUID()}`,
		models: [{ id: "unified-model", input: ["text"] }],
	});
	// Intercept every model call to capture the actual system prompt and tool declarations delivered to the LLM.
	const steps: FauxResponseStep[] = responses.map((step) =>
		typeof step === "function"
			? (context, opts, state, model) => {
					captureContext(context);
					return step(context, opts, state, model);
				}
			: (context) => {
					captureContext(context);
					return step;
				},
	);
	registration.setResponses(steps);
	disposers.push(() => registration.unregister());

	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const watchedDir = join(root, "watched");
	const workspaceDir = join(root, "workspace");
	const autoragHome = join(root, "autorag-home");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(watchedDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(autoragHome, { recursive: true });

	const model = registration.getModel();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }));

	const settings = makeMemorySettings();
	const findNode = () =>
		resolveNodeBinary({ resourcesPath: "", env: process.env, platform: process.platform });
	const envWithHome: NodeJS.ProcessEnv = { ...process.env, AUTORAG_HOME: autoragHome };
	const automationTracker = createAutomationVerificationTracker();
	const automationSandboxDeps = { env: envWithHome, platform: process.platform, findNode };

	const sandboxAutomationTool = createTestAutomationInSandboxTool({
		...automationSandboxDeps,
		tracker: automationTracker,
	});
	const magicKit = createMagicActionTools({
		settings,
		includeListTool: true,
		platform: process.platform,
		language: () => "ko",
		testMagicAction: (verifyInput) =>
			verifyMagicActionInSandbox(verifyInput, {
				resolveModel: async () => ({ model, apiKey: "test-key" }),
				agentDir,
				env: envWithHome,
				platform: process.platform,
				language: () => "ko",
			}),
	});

	const magicAgentTools = magicKit.tools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (id: string, params: never, signal?: AbortSignal, onUpdate?: never) =>
			tool.execute(id, params, signal, onUpdate, undefined as never),
	}));

	const prevHome = process.env.AUTORAG_HOME;
	process.env.AUTORAG_HOME = autoragHome;
	disposers.push(() => {
		if (prevHome === undefined) delete process.env.AUTORAG_HOME;
		else process.env.AUTORAG_HOME = prevHome;
	});

	const agent = new InteractiveSearchAgent(
		{
			model,
			apiKey: "test-key",
			searchPaths: [watchedDir],
			workspacePath: join(root, "workspace"),
			memoryPath: join(root, "memory.json"),
			minSync: { autoInstall: false },
			jikji: false,
			piAgentDir: agentDir,
			piSessionDir: sessionDir,
			jev: baselineJev(),
			filee: false,
			permissionMode: "full",
			tools: [sandboxAutomationTool, ...magicAgentTools],
		},
		createAgentInteraction(),
		{
			systemPromptAddendum: buildUnifiedWorkflowsPrompt(process.platform, { includeMagicActions: true }),
			routeToDirectAction: isMagicActionManagementQuery,
		},
	);
	runAutomationToolOnNode(agent, findNode, {
		tracker: automationTracker,
		verifyRule: (rule, originalPaths) => testAutomationInSandbox({ rule, originalPaths }, automationSandboxDeps),
	});
	agent.setApprovalMode("full");
	await agent.openSession();
	disposers.push(() => agent.closeSession());

	const trace: TraceEntry[] = [];
	agent.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		const content: unknown = event.result?.content;
		const text = Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
		trace.push({ toolName: event.toolName, isError: event.isError === true, text });
	});

	return {
		agent,
		settings,
		trace,
		watchedDir,
		autoragHome,
		getSystemPrompts: () => capturedSystemPrompts,
		getDeclaredToolNames: () => [...capturedToolNames],
	};
}

describe("main AI Agent unified workflows (Magic Actions + File Automations + trace verification)", () => {
	it.skipIf(process.platform === "win32")(
		"delivers unified workflow prompt, creates/verifies/customizes a Magic Action in AI Search, and records full JSONL trace",
		async () => {
			const ctx = await buildUnifiedAgent([
				// Turn 1 routes directly to the single-turn `extra` action route (no fast-answer phase!):
				// tests broken Magic Action -> fixes & re-tests -> saves verified action
				fauxAssistantMessage(
					[
						fauxToolCall("test_magic_action", {
							label: "Uppercase Copy",
							selection: "single",
							targetKind: "file",
							extensions: ["txt"],
							executionKind: "script",
							command: 'dazzi_missing_cmd_abc "$1"',
							fixtures: [{ path: "sample.txt", content: "hello\n" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("test_magic_action", {
							label: "Uppercase Copy",
							selection: "single",
							targetKind: "file",
							extensions: ["txt"],
							executionKind: "script",
							command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.upper.txt" && cat "$1.upper.txt"',
							fixtures: [{ path: "sample.txt", content: "hello\n" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("upsert_magic_action", {
							id: "uppercase-copy",
							label: "Uppercase Copy",
							selection: "single",
							targetKind: "file",
							extensions: ["txt"],
							executionKind: "script",
							command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.upper.txt" && cat "$1.upper.txt"',
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Created and verified Uppercase Copy.", { stopReason: "stop" }),
				// Turn 2 (conversational follow-up): list existing Magic Actions, then customize command (auto re-verified in sandbox)
				fauxAssistantMessage([fauxToolCall("list_magic_actions", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					[
						fauxToolCall("upsert_magic_action", {
							id: "uppercase-copy",
							label: "Uppercase Copy v2",
							selection: "single",
							targetKind: "file",
							extensions: ["txt"],
							executionKind: "script",
							command: 'tr "[:lower:]" "[:upper:]" < "$1" > "$1.v2.txt" && echo "V2_DONE"',
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Updated Uppercase Copy to v2 after sandbox verification.", { stopReason: "stop" }),
			]);

			await ctx.agent.searchDocuments("Create a right-click Magic Action that saves an uppercase copy of .txt files");
			await ctx.agent.searchDocuments("Update that Magic Action to write .v2.txt instead");

			// 1. Unified system prompt addendum and all shared workflow tools were delivered to the LLM
			const prompts = ctx.getSystemPrompts();
			expect(prompts.length).toBeGreaterThanOrEqual(2);
			expect(prompts.some((sysPrompt) => sysPrompt.includes("## Custom Workflows: File Automations & Right-Click Magic Actions"))).toBe(true);
			expect(prompts.some((sysPrompt) => sysPrompt.includes("test_magic_action"))).toBe(true);
			expect(prompts.some((sysPrompt) => sysPrompt.includes("test_automation_in_sandbox"))).toBe(true);
			const declaredTools = ctx.getDeclaredToolNames();
			expect(declaredTools).toEqual(
				expect.arrayContaining([
					"list_magic_actions",
					"test_magic_action",
					"upsert_magic_action",
					"delete_magic_action",
					"test_automation_in_sandbox",
					"manage_automations",
				]),
			);

			// 2. Live tool execution trace proves fail -> fix -> pass -> save -> list -> customize with auto re-verify
			expect(ctx.trace.map((e) => e.toolName)).toEqual([
				"test_magic_action",
				"test_magic_action",
				"upsert_magic_action",
				"list_magic_actions",
				"upsert_magic_action",
			]);
			const firstTest = JSON.parse(ctx.trace[0]!.text);
			const secondTest = JSON.parse(ctx.trace[1]!.text);
			const firstSave = JSON.parse(ctx.trace[2]!.text);
			const listed = JSON.parse(ctx.trace[3]!.text);
			const customized = JSON.parse(ctx.trace[4]!.text);

			expect(firstTest.ok).toBe(false);
			expect(secondTest.ok).toBe(true);
			expect(secondTest.output).toBe("HELLO");
			expect(secondTest.diff.created.map((f: { path: string }) => f.path)).toEqual(["sample.txt.upper.txt"]);
			expect(firstSave.saved).toBe(true);
			expect(firstSave.verified).toBe(true);
			expect(firstSave.autoVerified).toBe(false);
			expect(listed.magicActions).toHaveLength(1);
			expect(customized.saved).toBe(true);
			expect(customized.autoVerified).toBe(true);
			expect(customized.verification.output).toBe("V2_DONE");

			// 3. Settings persisted the customized Magic Action
			const savedActions = ctx.settings.peek().contextMenu.magicActions;
			expect(savedActions).toHaveLength(1);
			expect(savedActions[0]?.id).toBe("uppercase-copy");
			expect(savedActions[0]?.label).toBe("Uppercase Copy v2");

			// 4. Persisted pi session JSONL trace records every tool call and result
			expect(ctx.agent.sessionFile).toBeDefined();
			const jsonlTrace = parseSessionJsonlTrace(ctx.agent.sessionFile!);
			const calledTools = jsonlTrace.filter((e) => e.role === "assistant:toolCall").flatMap((e) => e.toolNames);
			expect(calledTools).toEqual([
				"test_magic_action",
				"test_magic_action",
				"upsert_magic_action",
				"list_magic_actions",
				"upsert_magic_action",
			]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"creates, verifies (fail -> fix -> pass), saves, and blocks broken customization of a File Automation in AI Search with full JSONL trace",
		async () => {
			const ctx = await buildUnifiedAgent([
				fauxAssistantMessage("Setting up and verifying your automation...", { stopReason: "stop" }),
				fauxAssistantMessage(
					[
						fauxToolCall("test_automation_in_sandbox", {
							id: "txt-done-log",
							events: ["create"],
							include: ["**/*.txt"],
							run: ["dazzi_missing_auto_xyz"],
							appendFiles: true,
							fixtures: [{ path: "sample.txt", content: "hello auto\n" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("test_automation_in_sandbox", {
							id: "txt-done-log",
							events: ["create"],
							include: ["**/*.txt"],
							run: ["sh", "-c", 'for f in "$@"; do tr "[:lower:]" "[:upper:]" < "$f" > "$f.done.log"; done', "sh"],
							appendFiles: true,
							fixtures: [{ path: "sample.txt", content: "hello auto\n" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("manage_automations", {
							action: "save",
							id: "txt-done-log",
							automation: {
								paths: [join(root, "watched")],
								events: ["create"],
								include: ["**/*.txt"],
								run: ["sh", "-c", 'for f in "$@"; do tr "[:lower:]" "[:upper:]" < "$f" > "$f.done.log"; done', "sh"],
								appendFiles: true,
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Automation created and verified.", { stopReason: "stop" }),
				// Turn 2: try to customize directly with a broken command -> blocked by shared save gate! Then fix and save -> succeeds!
				fauxAssistantMessage(
					[
						fauxToolCall("manage_automations", {
							action: "save",
							id: "txt-done-log",
							automation: {
								paths: [join(root, "watched")],
								events: ["create"],
								include: ["**/*.txt"],
								run: ["sh", "-c", 'echo "broken-v2" >&2; exit 5'],
								appendFiles: true,
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("manage_automations", {
							action: "save",
							id: "txt-done-log",
							automation: {
								paths: [join(root, "watched")],
								events: ["create"],
								include: ["**/*.txt"],
								run: ["sh", "-c", 'for f in "$@"; do tr "[:lower:]" "[:upper:]" < "$f" > "$f.v2.log"; done', "sh"],
								appendFiles: true,
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Customized automation to .v2.log after sandbox verification.", { stopReason: "stop" }),
			]);

			await ctx.agent.searchDocuments("Create a file automation for new .txt files");
			await ctx.agent.searchDocuments("Update that automation to output .v2.log");

			expect(ctx.trace.map((e) => e.toolName)).toEqual([
				"test_automation_in_sandbox",
				"test_automation_in_sandbox",
				"manage_automations",
				"manage_automations",
				"manage_automations",
			]);

			const failTest = JSON.parse(ctx.trace[0]!.text);
			const passTest = JSON.parse(ctx.trace[1]!.text);
			expect(failTest.ok).toBe(false);
			expect(passTest.ok).toBe(true);
			expect(passTest.diff.created.map((f: { path: string }) => f.path)).toEqual(["sample.txt.done.log"]);
			expect(passTest.retriggerWarnings).toEqual([]);

			expect(ctx.trace[2]!.text).toContain("Verified in temporary sandbox");
			expect(ctx.trace[3]!.text).toContain("NOT saved");
			expect(ctx.trace[3]!.text).toContain("broken-v2");
			expect(ctx.trace[4]!.text).toContain("Verified in temporary sandbox automatically");
			expect(ctx.trace[4]!.text).toContain("sample.txt.v2.log");

			// Real watched folder stayed completely clean (zero files created during sandbox verification)
			expect(existsSync(join(ctx.watchedDir, "sample.txt"))).toBe(false);
			expect(existsSync(join(ctx.watchedDir, "sample.txt.done.log"))).toBe(false);

			// Real automations.json holds the final verified customized rule
			const savedRules = JSON.parse(readFileSync(join(ctx.autoragHome, "automations.json"), "utf8")) as {
				automations: { id: string; run: string[] }[];
			};
			expect(savedRules.automations).toHaveLength(1);
			expect(savedRules.automations[0]?.id).toBe("txt-done-log");
			expect(savedRules.automations[0]?.run.join(" ")).toContain(".v2.log");

			// Real pi session JSONL trace matches
			expect(ctx.agent.sessionFile).toBeDefined();
			const jsonlTrace = parseSessionJsonlTrace(ctx.agent.sessionFile!);
			const calledTools = jsonlTrace.filter((e) => e.role === "assistant:toolCall").flatMap((e) => e.toolNames);
			expect(calledTools).toEqual([
				"test_automation_in_sandbox",
				"test_automation_in_sandbox",
				"manage_automations",
				"manage_automations",
				"manage_automations",
			]);
		},
	);
});
