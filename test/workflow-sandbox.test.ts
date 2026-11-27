import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MagicAction } from "../src/shared/context-menu-contract";
import {
	boundedText,
	buildMagicScriptCommand,
	buildUnifiedWorkflowsPrompt,
	buildWorkflowVerificationGuidance,
	createVerificationTracker,
	extractLatestAssistantReply,
	isMagicActionManagementQuery,
	runInTempSandbox,
	runSubprocess,
	sanitizedEnv,
	verifyBeforeSave,
	type WorkflowVerificationResult,
} from "../src/main/workflow-sandbox";

const NOT_ENGLISH =
	/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;

describe("workflow-sandbox shared core", () => {
	it("bounds captured output tail and strips secret env keys", () => {
		expect(boundedText("abcdefghij", 5)).toBe("fghij");
		expect(boundedText("abc", 5)).toBe("abc");

		const cleaned = sanitizedEnv({
			PATH: "/usr/bin",
			OPENAI_API_KEY: "sk-secret",
			ANTHROPIC_API_KEY: "sk-ant-secret",
			DAZZI_SAFE: "yes",
		});
		expect(cleaned.PATH).toBe("/usr/bin");
		expect(cleaned.DAZZI_SAFE).toBe("yes");
		expect(cleaned.OPENAI_API_KEY).toBeUndefined();
		expect(cleaned.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("extracts the latest non-empty assistant text reply from pi messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "first reply" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "final line 1" },
					{ type: "text", text: "final line 2" },
				],
			},
		];
		expect(extractLatestAssistantReply(messages)).toBe("final line 1\n\nfinal line 2");
	});

	it("builds platform-specific Magic Action script commands for POSIX and Windows", () => {
		const action: MagicAction = {
			id: "hash-file",
			label: "Hash File",
			enabled: true,
			selection: "single",
			targetKind: "file",
			extensions: ["txt"],
			execution: { kind: "script", command: 'echo "$1"' },
		};
		const posix = buildMagicScriptCommand(action, ["/tmp/a.txt"], { PATH: "/usr/bin", OPENAI_API_KEY: "secret" }, "darwin");
		expect(posix.bin).toBe("/bin/sh");
		expect(posix.args).toEqual(["-c", 'echo "$1"', "dazzi-magic-action", "/tmp/a.txt"]);
		expect(posix.env.DAZZI_FILE).toBe("/tmp/a.txt");
		expect(posix.env.DAZZI_FILE_COUNT).toBe("1");
		expect(posix.env.OPENAI_API_KEY).toBeUndefined();

		const win = buildMagicScriptCommand(action, ["C:\\tmp\\a.txt"], { PATH: "C:\\Windows" }, "win32");
		expect(win.bin).toBe("powershell.exe");
		expect(win.env.DAZZI_SCRIPT).toBe('echo "$1"');
		expect(win.env.DAZZI_FILES_JSON).toBe(JSON.stringify(["C:\\tmp\\a.txt"]));
	});

	it.skipIf(process.platform === "win32")(
		"runs subprocesses with stdin, bounded capture, non-zero exit codes, and timeout termination",
		async () => {
			const ok = await runSubprocess({
				bin: "/bin/sh",
				args: ["-c", "cat; echo err-line >&2"],
				stdin: "hello-stdin\n",
				timeoutMs: 10_000,
			});
			expect(ok.exitCode).toBe(0);
			expect(ok.timedOut).toBe(false);
			expect(ok.stdout).toBe("hello-stdin");
			expect(ok.stderr).toBe("err-line");

			const fail = await runSubprocess({
				bin: "/bin/sh",
				args: ["-c", "echo bad >&2; exit 7"],
				timeoutMs: 10_000,
			});
			expect(fail.exitCode).toBe(7);
			expect(fail.stderr).toBe("bad");

			const timedOut = await runSubprocess({
				bin: "/bin/sh",
				args: ["-c", "sleep 5"],
				timeoutMs: 120,
			});
			expect(timedOut.timedOut).toBe(true);
			expect(timedOut.exitCode).toBeNull();
		},
	);

	it("runs executors in a throwaway temp sandbox, captures filesystem diff, and cleans up even on throw", async () => {
		let capturedRoot = "";
		let capturedWorkDir = "";

		const ran = await runInTempSandbox(
			{
				prefix: "dazzi-wf-test-",
				workSubdir: "watched",
				fixtures: [{ path: "input.txt", content: "hello\n" }],
			},
			async (ctx) => {
				capturedRoot = ctx.root;
				capturedWorkDir = ctx.workDir;
				expect(existsSync(join(ctx.workDir, "input.txt"))).toBe(true);
				await writeFile(join(ctx.workDir, "output.txt"), "WORLD\n", "utf8");
				return { status: "done" };
			},
		);

		expect(ran.result).toEqual({ status: "done" });
		expect(ran.diff.created.map((f) => f.path)).toEqual(["output.txt"]);
		expect(ran.diff.created[0]?.contentPreview).toBe("WORLD\n");
		expect(ran.diff.unchanged).toEqual(["input.txt"]);
		expect(existsSync(capturedRoot)).toBe(false);
		expect(existsSync(capturedWorkDir)).toBe(false);

		let failedRoot = "";
		await expect(
			runInTempSandbox(
				{ prefix: "dazzi-wf-fail-", fixtures: [{ path: "a.txt", content: "a" }] },
				async (ctx) => {
					failedRoot = ctx.root;
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");
		expect(existsSync(failedRoot)).toBe(false);
	});

	it("deduplicates verified candidates, blocks failed auto-verification, and re-verifies when candidate changes", async () => {
		interface Candidate {
			readonly id: string;
			readonly cmd: string;
		}
		const tracker = createVerificationTracker<Candidate, WorkflowVerificationResult>((c) => c.cmd);
		const verify = vi.fn(async (c: Candidate): Promise<WorkflowVerificationResult> => ({
			ok: c.cmd !== "bad",
			exitCode: c.cmd === "bad" ? 1 : 0,
			timedOut: false,
			durationMs: 12,
			output: c.cmd === "bad" ? "" : "ok",
			...(c.cmd === "bad" ? { error: "failed" } : {}),
			diff: { created: [], modified: [], deleted: [], unchanged: [] },
			warnings: [],
		}));

		// 1. Failing candidate is rejected before save
		const blocked = await verifyBeforeSave({ candidate: { id: "a", cmd: "bad" }, tracker, verify });
		expect(blocked.ok).toBe(false);
		expect(blocked.autoVerified).toBe(true);
		expect(verify).toHaveBeenCalledTimes(1);

		// 2. Passing candidate succeeds and caches verification
		const passed = await verifyBeforeSave({ candidate: { id: "a", cmd: "good" }, tracker, verify });
		expect(passed.ok).toBe(true);
		expect(passed.autoVerified).toBe(true);
		expect(verify).toHaveBeenCalledTimes(2);

		// 3. Re-saving the same verified logic skips redundant sandbox run
		const cached = await verifyBeforeSave({ candidate: { id: "a-renamed", cmd: "good" }, tracker, verify });
		expect(cached.ok).toBe(true);
		expect(cached.autoVerified).toBe(false);
		expect(verify).toHaveBeenCalledTimes(2);

		// 4. Editing the logic invalidates the cache key and triggers fresh verification
		const edited = await verifyBeforeSave({ candidate: { id: "a", cmd: "good --v2" }, tracker, verify });
		expect(edited.ok).toBe(true);
		expect(edited.autoVerified).toBe(true);
		expect(verify).toHaveBeenCalledTimes(3);
	});

	it("generates English-only unified workflow prompt covering both triggers and shared sandbox verification", () => {
		const guidanceFail = buildWorkflowVerificationGuidance({
			kind: "magic-action",
			ok: false,
			testToolName: "test_magic_action",
			saveToolName: "upsert_magic_action",
		});
		expect(guidanceFail).toContain("FAILED");
		expect(guidanceFail).toContain("test_magic_action");

		const guidanceWarn = buildWorkflowVerificationGuidance({
			kind: "automation",
			ok: true,
			testToolName: "test_automation_in_sandbox",
			saveToolName: "manage_automations",
			warnings: ["loop risk"],
		});
		expect(guidanceWarn).toContain("warning");

		const prompt = buildUnifiedWorkflowsPrompt("darwin", { includeMagicActions: true });
		expect(NOT_ENGLISH.test(prompt)).toBe(false);
		expect(prompt).toContain("manage_automations");
		expect(prompt).toContain("test_automation_in_sandbox");
		expect(prompt).toContain("list_magic_actions");
		expect(prompt).toContain("test_magic_action");
		expect(prompt).toContain("upsert_magic_action");
		expect(prompt).toContain("delete_magic_action");
		expect(prompt).toContain("temporary sandbox");
		expect(prompt).toContain("Right-Click Automations");
		expect(prompt).toContain('never call them "Magic Actions"');
		expect(prompt).toContain("Script vs. AI Agent Execution Rule");
		expect(prompt).toContain("deterministic script");

		const winPrompt = buildUnifiedWorkflowsPrompt("win32", { includeMagicActions: true });
		expect(winPrompt).toContain("powershell.exe");
		expect(NOT_ENGLISH.test(winPrompt)).toBe(false);
	});

	it("detects right-click automation management requests across languages without matching ordinary document questions", () => {
		expect(isMagicActionManagementQuery("단일 .txt 파일을 우클릭했을 때 실행되는 매직 액션 만들어줘")).toBe(true);
		expect(isMagicActionManagementQuery("PDF 우클릭 자동화 만들어줘")).toBe(true);
		expect(isMagicActionManagementQuery("Create a right-click automation to summarize PDFs")).toBe(true);
		expect(isMagicActionManagementQuery("Create a right-click Magic Action to summarize PDFs")).toBe(true);
		expect(isMagicActionManagementQuery("기존 매직 액션 목록 보여줘")).toBe(true);
		expect(isMagicActionManagementQuery("Edit my context menu button for images")).toBe(true);
		expect(isMagicActionManagementQuery("右クリック自動化を作成して")).toBe(true);
		expect(isMagicActionManagementQuery("マジックアクションを作成して")).toBe(true);
		expect(isMagicActionManagementQuery("创建一个右键自动化")).toBe(true);
		expect(isMagicActionManagementQuery("创建一个右键菜单魔法动作")).toBe(true);
		expect(isMagicActionManagementQuery("2026년 1분기 매출 보고서 요약해줘")).toBe(false);
		expect(isMagicActionManagementQuery("What is in quarterly-report.pdf?")).toBe(false);
		expect(isMagicActionManagementQuery("")).toBe(false);
	});
});
