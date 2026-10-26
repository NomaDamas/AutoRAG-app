import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import { createErrorFixService, type ErrorFixService } from "../src/main/error-fix-service";
import type { ErrorFixEvent, ErrorFixRequest } from "../src/shared/error-fix-contract";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let configPath: string;
let events: ErrorFixEvent[];

const REQUEST: ErrorFixRequest = { message: "Search root " + "/Users/me/Docs does not exist", surface: "ai-search" };
const REFRESHED: ConfigRefreshResult = { ok: true, methods: ["parsed"], scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [], error: null };

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "fix-svc-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "fix-svc-agent-"));
	configPath = join(root, "config.json");
	events = [];
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
	await mkdir(join(root, "Docs"), { recursive: true });
	await mkdir(join(root, "Documents"), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [join(root, "OldDocs")], workspacePath: join(root, "ws"), memoryPath: join(root, "memory.json") }, null, 2)}\n`);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({ api: `faux-fix-${Math.random().toString(36).slice(2)}`, provider: "faux-fix", models: [{ id: "fix", reasoning: true }] });
	cleanups.push(() => registration.unregister());
	return registration;
}

interface Overrides {
	readonly timeoutMs?: number;
	readonly resolveModel?: () => Promise<never>;
	readonly refreshIndex?: () => Promise<ConfigRefreshResult>;
	readonly onConfigChanged?: () => void;
}

function serviceFor(registration: FauxProviderRegistration, overrides: Overrides = {}): ErrorFixService {
	return createErrorFixService({
		send: (event) => events.push(event),
		resolveModel: overrides.resolveModel ?? (async () => ({ model: registration.getModel() })),
		agentDir,
		env: {},
		cwd: root,
		language: () => "ko",
		config: createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root }),
		diagnostics: async () => ({ model: { provider: "faux-fix", id: "fix" } }),
		refreshIndex: overrides.refreshIndex ?? (async () => REFRESHED),
		...(overrides.onConfigChanged === undefined ? {} : { onConfigChanged: overrides.onConfigChanged }),
		...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
	});
}

function toolResultTexts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => (message.role === "toolResult" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])) : []));
}

function finalEvent(): ErrorFixEvent | undefined {
	return events.at(-1);
}

describe("error-fix service", () => {
	it("diagnoses, repairs the config and reports what it changed, announcing each step", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("diagnose", {})),
			fauxAssistantMessage(fauxToolCall("check_path", { path: join(root, "Documents") })),
			fauxAssistantMessage(fauxToolCall("update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] })),
			fauxAssistantMessage(fauxToolCall("report_result", { status: "fixed", summary: "검색 폴더를 Documents로 바꿨어요." })),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).start("run-1", REQUEST);

		expect(events.map((event) => (event.type === "step" ? `${event.step.tool}:${event.step.detail ?? ""}` : event.type))).toEqual([
			"diagnose:",
			`check_path:${join(root, "Documents")}`,
			"update_config:searchPaths",
			"result",
		]);
		expect(finalEvent()).toMatchObject({
			type: "result",
			runId: "run-1",
			result: { status: "fixed", summary: "검색 폴더를 Documents로 바꿨어요.", changes: [{ path: "searchPaths" }], backupPath: expect.stringContaining("-before-error-fix") },
		});
		expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ searchPaths: [join(root, "Documents")] });
	});

	it("gives the model the error as shown, the interface language and only the app's tools", async () => {
		const registration = register();
		const seen: { prompt: string; tools: string[] }[] = [];
		registration.setResponses([
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				const content = typeof system?.content === "string" ? system.content : (system?.content ?? []).map((block) => block.text).join("");
				const prompt = [content, ...Object.values(system?.sections ?? {})].join("\n");
				seen.push({ prompt, tools: (system?.toolsAdded ?? []).map((tool) => tool.name).sort() });
				return fauxAssistantMessage(fauxToolCall("report_result", { status: "cannot-fix", summary: "x" }));
			},
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).start("run-2", REQUEST);

		expect(seen[0]?.prompt).toContain(REQUEST.message);
		expect(seen[0]?.prompt).toContain("Korean");
		expect(seen[0]?.tools).toEqual(["check_path", "diagnose", "refresh_index", "report_result", "update_config"]);
	});

	it("tells the model its 'fixed' was refused when nothing changed, so it can answer truthfully", async () => {
		const registration = register();
		const fed: string[][] = [];
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("report_result", { status: "fixed", summary: "all good" })),
			(context) => {
				fed.push(toolResultTexts(context.messages));
				return fauxAssistantMessage(fauxToolCall("report_result", { status: "needs-user", summary: "Pick the new folder.", nextSteps: ["Choose the folder"], actions: [{ kind: "settings", target: "scope", label: "Pick the folder" }] }));
			},
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).start("run-3", REQUEST);

		expect(fed[0]?.join("\n")).toContain("Refused");
		expect(finalEvent()).toMatchObject({ type: "result", result: { status: "needs-user", actions: [{ kind: "settings", target: "scope", label: "Pick the folder" }], nextSteps: ["Choose the folder"], changes: [] } });
	});

	it("reports an error when no model can be resolved, in the model's own words", async () => {
		const resolveModel = vi.fn(async () => {
			throw new Error("No API key found for dazzi");
		});

		await serviceFor(register(), { resolveModel }).start("run-4", REQUEST);

		expect(events).toEqual([{ type: "error", runId: "run-4", message: "No API key found for dazzi", changes: [], backupPath: null }]);
	});

	it("reports the provider's error when the model request fails", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Incorrect API key provided" })]);

		await serviceFor(registration).start("run-5", REQUEST);

		expect(finalEvent()).toMatchObject({ type: "error", runId: "run-5", message: expect.stringContaining("401 Incorrect API key provided") });
		expect(events.some((event) => event.type === "result")).toBe(false);
	});

	it("reports an error when the agent ends without answering through the tool", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("It is probably fine now.")]);

		await serviceFor(registration).start("run-6", REQUEST);

		expect(finalEvent()).toMatchObject({ type: "error", runId: "run-6" });
	});

	it("stops on cancel and sends neither a result nor a change after it", async () => {
		const registration = register();
		const service = serviceFor(registration);
		registration.setResponses([
			async (): Promise<AssistantMessage> => {
				await service.cancel("run-7");
				return fauxAssistantMessage(fauxToolCall("update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] }));
			},
			fauxAssistantMessage("done"),
		]);

		await service.start("run-7", REQUEST);

		expect(events).toEqual([{ type: "cancelled", runId: "run-7", changes: [], backupPath: null }]);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ searchPaths: [join(root, "OldDocs")] });
	});

	it("tells what it had already changed when the run ends in an error afterwards, so no change is silent", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] })),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
		]);

		await serviceFor(registration).start("run-10", REQUEST);

		expect(finalEvent()).toMatchObject({
			type: "error",
			runId: "run-10",
			message: expect.stringContaining("provider exploded"),
			changes: [{ path: "searchPaths", after: JSON.stringify([join(root, "Documents")]) }],
			backupPath: expect.stringContaining("-before-error-fix"),
		});
	});

	it("tells the app when the config was changed, and not when a change was refused", async () => {
		const registration = register();
		const onConfigChanged = vi.fn();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("update_config", { updates: [{ path: ["searchPaths"], value: 5 }] })),
			fauxAssistantMessage(fauxToolCall("update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] })),
			fauxAssistantMessage(fauxToolCall("report_result", { status: "fixed", summary: "ok" })),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration, { onConfigChanged }).start("run-11", REQUEST);

		expect(onConfigChanged).toHaveBeenCalledTimes(1);
	});

	it("gives up after the time limit with an error rather than hanging", async () => {
		const registration = register();
		registration.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
				}),
		]);

		await serviceFor(registration, { timeoutMs: 200 }).start("run-8", REQUEST);

		expect(finalEvent()).toMatchObject({ type: "error", runId: "run-8", message: expect.stringMatching(/timed out/iu) });
	});

	it("shows a failing index run to the agent and still lets it explain", async () => {
		const registration = register();
		const fed: string[][] = [];
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("refresh_index", {})),
			(context) => {
				fed.push(toolResultTexts(context.messages));
				return fauxAssistantMessage(fauxToolCall("report_result", { status: "cannot-fix", summary: "The index cannot be rebuilt." }));
			},
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration, { refreshIndex: async () => ({ ...REFRESHED, ok: false, error: "disk is full" }) }).start("run-9", REQUEST);

		expect(fed[0]?.join("\n")).toContain("disk is full");
		expect(finalEvent()).toMatchObject({ type: "result", result: { status: "cannot-fix" } });
	});
});
