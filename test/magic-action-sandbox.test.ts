import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppCustomizerService } from "../src/main/app-customizer-service";
import { createAppCustomizerToolkit } from "../src/main/agents/profiles/app-customizer";
import {
	buildMagicActionCandidate,
	resolveSandboxPath,
	verifyMagicActionInSandbox,
} from "../src/main/magic-action-sandbox";
import { generateSampleFileBytes } from "../src/main/sandbox-fixtures";
import { createSettingsService } from "../src/main/settings-service";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-magic-sandbox-test-"));
	agentDir = await mkdtemp(join(tmpdir(), "dazzi-magic-sandbox-agent-"));
	settingsDir = join(root, "settings");
	await mkdir(settingsDir, { recursive: true });
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(name = "magic-sandbox"): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-${name}-${Math.random().toString(36).slice(2)}`,
		provider: `faux-${name}`,
		models: [{ id: name, reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function createStubSettings() {
	return createSettingsService({
		directory: settingsDir,
		dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
	});
}

describe("magic-action sandbox verification", () => {
	it("generates format-valid binary fixtures for PDF, DOCX, PNG, JPG, and ZIP", async () => {
		const pdfBytes = await generateSampleFileBytes("sample.pdf", 1);
		const pdf = await PDFDocument.load(pdfBytes);
		expect(pdf.getPageCount()).toBe(1);

		const docxBytes = await generateSampleFileBytes("sample.docx", 1);
		const docxEntries = unzipSync(new Uint8Array(docxBytes));
		expect(docxEntries["word/document.xml"]).toBeDefined();
		expect(Buffer.from(docxEntries["word/document.xml"]!).toString("utf8")).toContain("Sample Word Document 1");

		const pngBytes = await generateSampleFileBytes("photo.png", 1);
		expect([...pngBytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

		const jpgBytes = await generateSampleFileBytes("IMG_0001.jpg", 1);
		expect([...jpgBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

		const zipBytes = await generateSampleFileBytes("archive.zip", 1);
		const zipEntries = unzipSync(new Uint8Array(zipBytes));
		expect(zipEntries["note-1.txt"]).toBeDefined();
	});

	it("rejects fixture paths that escape the sandbox", () => {
		expect(() => resolveSandboxPath("/tmp/sandbox", "../etc/passwd")).toThrow(/escapes sandbox/i);
		expect(() => resolveSandboxPath("/tmp/sandbox", "/etc/passwd")).toThrow(/must be relative/i);
		expect(() => resolveSandboxPath("/tmp/sandbox", "")).toThrow(/must not be empty/i);
	});

	it.skipIf(process.platform === "win32")(
		"verifies a working script Magic Action in an isolated temp folder and reports created/modified files",
		async () => {
			const action = buildMagicActionCandidate({
				label: "Uppercase Copy",
				selection: "single",
				targetKind: "file",
				extensions: ["txt"],
				executionKind: "script",
				command: 'tr "a-z" "A-Z" < "$1" > "$(dirname "$1")/upper.txt" && echo "converted:$1"',
			})!;

			const result = await verifyMagicActionInSandbox(
				{
					action,
					fixtures: [{ path: "hello.txt", content: "hello world\n" }],
				},
				{
					resolveModel: () => Promise.reject(new Error("not used")),
					agentDir,
					env: process.env,
					language: () => "en",
				},
			);

			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.output).toContain("converted:");
			expect(result.diff.created.map((f) => f.path)).toEqual(["upper.txt"]);
			expect(result.diff.created[0]?.contentPreview).toBe("HELLO WORLD\n");
			expect(result.diff.unchanged).toEqual(["hello.txt"]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"captures failure exit code and stderr when a script Magic Action is broken",
		async () => {
			const action = buildMagicActionCandidate({
				label: "Broken Script",
				selection: "single",
				targetKind: "file",
				executionKind: "script",
				command: 'echo "missing flag" >&2; exit 2',
			})!;

			const result = await verifyMagicActionInSandbox(
				{
					action,
					fixtures: [{ path: "sample.txt", content: "hi\n" }],
				},
				{
					resolveModel: () => Promise.reject(new Error("not used")),
					agentDir,
					env: process.env,
					language: () => "en",
				},
			);

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("missing flag");
			expect(result.error).toContain("missing flag");
		},
	);

	it("verifies an organize-mode agent Magic Action inside a temp sandbox and captures created files without touching real directories", async () => {
		const reg = register("agent-magic");
		const realDocs = join(root, "real-docs");
		await mkdir(realDocs, { recursive: true });
		await writeFile(join(realDocs, "untouched.md"), "real user data\n", "utf8");

		reg.setResponses([
			(context) => {
				const userMsg = context.messages.find((m) => m.role === "user");
				const text =
					typeof userMsg?.content === "string"
						? userMsg.content
						: Array.isArray(userMsg?.content)
							? userMsg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
							: "";
				const pathMatch = /1\.\s+(.+)/.exec(text);
				const targetFile = pathMatch?.[1]?.trim() ?? "sample.md";
				return fauxAssistantMessage([fauxToolCall("read", { i: "Read fixture", path: targetFile })]);
			},
			fauxAssistantMessage([
				fauxToolCall("write", {
					i: "Write summary file",
					path: "summary.md",
					content: "# Summary\n- Checked sample\n",
				}),
			]),
			fauxAssistantMessage("Created summary.md in the folder.", { stopReason: "stop" }),
		]);

		const action = buildMagicActionCandidate({
			label: "Summarize MD",
			selection: "single",
			targetKind: "file",
			extensions: ["md"],
			executionKind: "agent",
			agentMode: "organize",
			prompt: "Read the markdown file and write summary.md next to it.",
		})!;

		const result = await verifyMagicActionInSandbox(
			{
				action,
				fixtures: [{ path: "notes.md", content: "# Notes\n- Item A\n" }],
			},
			{
				resolveModel: async () => ({ model: reg.getModel() as never, apiKey: "faux-key" }),
				agentDir,
				env: process.env,
				language: () => "en",
			},
		);

		expect(result.ok).toBe(true);
		expect(result.executionKind).toBe("agent");
		expect(result.output).toContain("summary.md");
		expect(result.diff.created.map((f) => f.path)).toEqual(["summary.md"]);
		expect(result.diff.created[0]?.contentPreview).toContain("# Summary");
		expect(await readFile(join(realDocs, "untouched.md"), "utf8")).toBe("real user data\n");
		expect(existsSync(join(realDocs, "summary.md"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"blocks upsert_magic_action when an untested script fails automatic temp-folder verification, and saves once fixed",
		async () => {
			const reg = register("customizer-auto-gate");
			const settings = createStubSettings();
			const events: AppCustomizerEvent[] = [];
			const toolResults: string[] = [];

			reg.setResponses([
				// Model tries to skip test_magic_action and save a broken script directly!
				fauxAssistantMessage([
					fauxToolCall("upsert_magic_action", {
						i: "Saving candidate script",
						label: "Word Count",
						executionKind: "script",
						command: 'nonexistent_binary_404 "$1"',
					}),
				]),
				// Automatic gate refuses to save; model reads the error, fixes the script, tests it, and saves.
				(ctx) => {
					for (const msg of ctx.messages) {
						if (msg.role === "toolResult" && Array.isArray(msg.content)) {
							for (const block of msg.content) {
								if (block.type === "text") toolResults.push(block.text);
							}
						}
					}
					return fauxAssistantMessage([
						fauxToolCall("test_magic_action", {
							i: "Testing fixed script in temp sandbox",
							label: "Word Count",
							executionKind: "script",
							command: 'wc -w < "$1" | tr -d " "',
							fixtures: [{ path: "doc.txt", content: "one two three\n" }],
						}),
					]);
				},
				(ctx) => {
					const lastTool = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
					if (lastTool && Array.isArray(lastTool.content)) {
						for (const block of lastTool.content) {
							if (block.type === "text") toolResults.push(block.text);
						}
					}
					return fauxAssistantMessage([
						fauxToolCall("upsert_magic_action", {
							i: "Saving verified script",
							label: "Word Count",
							executionKind: "script",
							command: 'wc -w < "$1" | tr -d " "',
						}),
					]);
				},
				fauxAssistantMessage("Fixed the script after sandbox testing failed, verified it returns 3 words, and saved it.", {
					stopReason: "stop",
				}),
			]);

			const service = createAppCustomizerService({
				send: (ev) => events.push(ev),
				resolveModel: async () => ({ model: reg.getModel() as never, apiKey: "faux-key" }),
				agentDir,
				env: process.env,
				cwd: root,
				homeDir: root,
				language: () => "en",
				settings,
				listLocations: async () => [],
				listTags: async () => [],
			});

			await service.send("run-gate", {
				sessionId: "sess-gate",
				surface: "contextMenu",
				message: "Create a Word Count script Magic Action.",
			});

			const gateResult = JSON.parse(toolResults[0] ?? "{}");
			expect(gateResult.ok).toBe(false);
			expect(gateResult.saved).toBe(false);
			expect(gateResult.verified).toBe(false);

			const retestResult = JSON.parse(toolResults[1] ?? "{}");
			expect(retestResult.ok).toBe(true);
			expect(retestResult.output).toBe("3");

			const saved = await settings.get();
			expect(saved.contextMenu.magicActions).toHaveLength(1);
			expect(saved.contextMenu.magicActions[0]?.execution).toEqual({
				kind: "script",
				command: 'wc -w < "$1" | tr -d " "',
			});
			expect(events.some((e) => e.type === "turn-done")).toBe(true);
		},
	);

	it("skips redundant auto-verification in upsert_magic_action when test_magic_action already passed for the same action", async () => {
		const settings = createStubSettings();
		const testSpy = vi.fn().mockResolvedValue({
			ok: true,
			executionKind: "script",
			exitCode: 0,
			timedOut: false,
			durationMs: 12,
			output: "ok",
			targetPaths: ["sample.txt"],
			diff: { created: [], modified: [], deleted: [], unchanged: ["sample.txt"] },
		});
		const kit = createAppCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
			testMagicAction: testSpy,
		});
		const testTool = kit.tools.find((t) => t.name === "test_magic_action")!;
		const upsert = kit.tools.find((t) => t.name === "upsert_magic_action")!;

		await testTool.execute(
			"c1",
			{ label: "Echo Test", executionKind: "script", command: "echo ok", targetKind: "file", selection: "any" },
			undefined,
			undefined,
			undefined as never,
		);
		const saveRes = await upsert.execute(
			"c2",
			{ label: "Echo Test", executionKind: "script", command: "echo ok", targetKind: "file", selection: "any" },
			undefined,
			undefined,
			undefined as never,
		);
		const payload = JSON.parse(saveRes.content[0]?.type === "text" ? saveRes.content[0].text : "{}");
		expect(payload.ok).toBe(true);
		expect(payload.verified).toBe(true);
		expect(payload.autoVerified).toBe(false);
		expect(testSpy).toHaveBeenCalledTimes(1);
	});
});
