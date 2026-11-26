import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MagicAction } from "../shared/context-menu-contract";
import { isSecretKey } from "./autorag-config-service";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";
import {
	diffSnapshots,
	seedSandboxFixtures,
	snapshotDirectory,
	type SandboxDiff,
	type SandboxFixtureInput,
} from "./sandbox-fixtures";

export const DEFAULT_MAX_CAPTURE_CHARS = 32 * 1024;

export const WINDOWS_POWERSHELL_BOOTSTRAP = [
	`[Console]::InputEncoding = $OutputEncoding = ${POWERSHELL_UTF8_OUTPUT}`,
	"$dazziScript = $env:DAZZI_SCRIPT",
	"Remove-Item Env:\\DAZZI_SCRIPT -ErrorAction SilentlyContinue",
	"$dazziFiles = [System.Collections.Generic.List[string]]::new()",
	"if ($env:DAZZI_FILES_JSON) { foreach ($dazziItem in (ConvertFrom-Json -InputObject $env:DAZZI_FILES_JSON)) { [void]$dazziFiles.Add([string]$dazziItem) } }",
	"$dazziArgs = $dazziFiles.ToArray()",
	"try { $dazziSb = [ScriptBlock]::Create($dazziScript) } catch { [Console]::Error.WriteLine($_); exit 1 }",
	"$global:LASTEXITCODE = 0",
	"try { & $dazziSb @dazziArgs } catch { [Console]::Error.WriteLine($_); exit 1 }",
	"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
	"if (-not $?) { exit 1 }",
].join("; ");

/** Common shape shared by Magic Action and File Automation sandbox verification results. */
export interface WorkflowVerificationResult {
	readonly ok: boolean;
	readonly exitCode?: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly output: string;
	readonly stderr?: string;
	readonly error?: string;
	readonly diff: SandboxDiff;
	readonly warnings?: readonly string[];
}

export interface SubprocessOptions {
	readonly bin: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: string;
	readonly timeoutMs?: number;
	readonly maxCaptureChars?: number;
	readonly platform?: NodeJS.Platform;
	readonly signal?: AbortSignal;
	readonly onStdout?: (accumulatedStdout: string) => void;
	readonly onStderr?: (accumulatedStderr: string) => void;
	/** Whether to trim stdout/stderr in the returned result (default true). */
	readonly trim?: boolean;
}

export interface SubprocessResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly spawnError?: string;
}

export interface TempSandboxOptions {
	readonly prefix: string;
	/** Optional subdirectory inside the temp root where fixtures are seeded and diffed (e.g. "watched"). */
	readonly workSubdir?: string;
	readonly fixtures: readonly SandboxFixtureInput[];
}

export interface TempSandboxContext {
	readonly root: string;
	readonly workDir: string;
	readonly createdPaths: readonly string[];
}

export interface TempSandboxOutcome<T> {
	readonly result: T;
	readonly diff: SandboxDiff;
	readonly durationMs: number;
}

export interface VerificationTracker<TCandidate, TResult extends { readonly ok: boolean }> {
	markVerified(candidate: TCandidate, result: TResult): void;
	getVerified(candidate: TCandidate): TResult | undefined;
	clear(candidate: TCandidate): void;
}

export interface VerifyBeforeSaveResult<TResult extends { readonly ok: boolean }> {
	readonly ok: boolean;
	readonly autoVerified: boolean;
	readonly verification: TResult;
}

export type WorkflowKind = "magic-action" | "automation";

export function boundedText(text: string, maxChars = DEFAULT_MAX_CAPTURE_CHARS): string {
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));
}

export function killProcessTree(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
	if (pid === undefined || pid <= 0) return;
	if (platform === "win32") {
		try {
			spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} catch {
			// Best effort
		}
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already exited
		}
	}
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function extractAssistantText(message: unknown): string {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
	return msg.content
		.map((entry) => recordOf(entry))
		.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
		.map((entry) => (entry?.text as string).trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

export function extractLatestAssistantReply(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = recordOf(messages[i]);
		if (msg?.role !== "assistant") continue;
		const text = extractAssistantText(msg);
		if (text.length > 0) return text;
	}
	return "";
}

/** Build the platform-appropriate shell command + sanitized `DAZZI_*` env for a script Magic Action. */
export function buildMagicScriptCommand(
	action: MagicAction,
	targetPaths: readonly string[],
	baseEnv: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): { readonly bin: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } {
	const command = action.execution.kind === "script" ? action.execution.command : "";
	const env: NodeJS.ProcessEnv = {
		...sanitizedEnv(baseEnv),
		DAZZI_ACTION_ID: action.id,
		DAZZI_ACTION_LABEL: action.label,
		DAZZI_FILE_COUNT: String(targetPaths.length),
		DAZZI_FILE: targetPaths[0] ?? "",
		DAZZI_FILES_JSON: JSON.stringify(targetPaths),
		...(platform === "win32" ? { DAZZI_SCRIPT: command } : {}),
	};
	if (platform === "win32") {
		return {
			bin: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWERSHELL_BOOTSTRAP],
			env,
		};
	}
	return {
		bin: "/bin/sh",
		args: ["-c", command, "dazzi-magic-action", ...targetPaths],
		env,
	};
}

/** Execute a subprocess with bounded stdout/stderr capture, timeout, abort signal, and process-tree cleanup. */
export function runSubprocess(options: SubprocessOptions): Promise<SubprocessResult> {
	const platform = options.platform ?? process.platform;
	const maxCaptureChars = options.maxCaptureChars ?? DEFAULT_MAX_CAPTURE_CHARS;
	const shouldTrim = options.trim ?? true;
	const { promise, resolve } = Promise.withResolvers<SubprocessResult>();

	if (options.signal?.aborted) {
		resolve({
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: false,
			cancelled: true,
		});
		return promise;
	}

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let cancelled = false;
	let done = false;

	const child = spawn(options.bin, [...options.args], {
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
		stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		detached: platform !== "win32",
		windowsHide: true,
	});

	if (options.stdin !== undefined) {
		child.stdin?.on("error", () => {
			// Ignore async EPIPE/EOF when the process exits before reading stdin
		});
		try {
			child.stdin?.end(options.stdin);
		} catch {
			// Ignore synchronous stream errors
		}
	}

	const timer =
		options.timeoutMs !== undefined && options.timeoutMs > 0
			? setTimeout(() => {
					if (done) return;
					timedOut = true;
					killProcessTree(child.pid, platform);
				}, options.timeoutMs)
			: undefined;
	timer?.unref?.();

	const onAbort = (): void => {
		if (done) return;
		cancelled = true;
		killProcessTree(child.pid, platform);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	child.stdout?.on("data", (chunk: Buffer) => {
		if (cancelled) return;
		stdout = boundedText(stdout + chunk.toString("utf8"), maxCaptureChars);
		options.onStdout?.(stdout);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		if (cancelled) return;
		stderr = boundedText(stderr + chunk.toString("utf8"), maxCaptureChars);
		options.onStderr?.(stderr);
	});

	const finish = (exitCode: number | null, spawnError?: Error): void => {
		if (done) return;
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		resolve({
			exitCode: timedOut || cancelled ? null : exitCode,
			stdout: shouldTrim ? stdout.trim() : stdout,
			stderr: shouldTrim ? stderr.trim() : stderr,
			timedOut,
			cancelled,
			...(spawnError !== undefined ? { spawnError: spawnError.message } : {}),
		});
	};

	child.on("error", (err) => finish(null, err));
	child.on("close", (code) => finish(code));
	return promise;
}

/**
 * Create a fresh temporary sandbox directory, seed fixtures, snapshot before/after,
 * run `executor`, compute the filesystem diff, and unconditionally remove the temp directory.
 */
export async function runInTempSandbox<T>(
	options: TempSandboxOptions,
	executor: (ctx: TempSandboxContext) => Promise<T>,
): Promise<TempSandboxOutcome<T>> {
	const rawRoot = await mkdtemp(join(tmpdir(), options.prefix));
	const root = realpathSync(rawRoot);
	const workDir = options.workSubdir !== undefined ? join(root, options.workSubdir) : root;
	const startedAtMs = Date.now();
	try {
		await mkdir(workDir, { recursive: true });
		const createdPaths = await seedSandboxFixtures(workDir, options.fixtures);
		const before = await snapshotDirectory(workDir);
		const result = await executor({ root, workDir, createdPaths });
		const after = await snapshotDirectory(workDir);
		const diff = diffSnapshots(before, after);
		return {
			result,
			diff,
			durationMs: Math.max(0, Date.now() - startedAtMs),
		};
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Generic in-session cache for deduplicating sandbox verification of unchanged candidates. */
export function createVerificationTracker<TCandidate, TResult extends { readonly ok: boolean }>(
	keyOf: (candidate: TCandidate) => string,
): VerificationTracker<TCandidate, TResult> {
	const verified = new Map<string, TResult>();
	return {
		markVerified: (candidate, result) => {
			if (result.ok) verified.set(keyOf(candidate), result);
			else verified.delete(keyOf(candidate));
		},
		getVerified: (candidate) => verified.get(keyOf(candidate)),
		clear: (candidate) => {
			verified.delete(keyOf(candidate));
		},
	};
}

/**
 * Shared save gate used by both Magic Actions and File Automations:
 * - Reuses a passing sandbox verification for the exact same candidate logic.
 * - Otherwise runs verification in a temporary sandbox before allowing save.
 * - Refuses save (`ok: false`) if sandbox verification fails so the agent fixes and retries.
 */
export async function verifyBeforeSave<TCandidate, TResult extends { readonly ok: boolean }>(input: {
	readonly candidate: TCandidate;
	readonly tracker: VerificationTracker<TCandidate, TResult>;
	readonly verify: (candidate: TCandidate) => Promise<TResult>;
}): Promise<VerifyBeforeSaveResult<TResult>> {
	const prior = input.tracker.getVerified(input.candidate);
	if (prior !== undefined) {
		return { ok: true, autoVerified: false, verification: prior };
	}
	const result = await input.verify(input.candidate);
	if (!result.ok) {
		input.tracker.clear(input.candidate);
		return { ok: false, autoVerified: true, verification: result };
	}
	input.tracker.markVerified(input.candidate, result);
	return { ok: true, autoVerified: true, verification: result };
}

export function buildWorkflowVerificationGuidance(input: {
	readonly kind: WorkflowKind;
	readonly ok: boolean;
	readonly testToolName: string;
	readonly saveToolName: string;
	readonly warnings?: readonly string[];
}): string {
	const subject = input.kind === "magic-action" ? "right-click automation" : "automation rule";
	if (!input.ok) {
		return `Temp-folder sandbox verification FAILED. Do NOT save this broken ${subject} yet — diagnose \`error\`/\`stderr\`/\`output\`/\`stdout\`/\`diff\`, fix the ${subject}, and re-run \`${input.testToolName}\`.`;
	}
	if (input.warnings !== undefined && input.warnings.length > 0) {
		return `Temp-folder sandbox verification exited cleanly, but warnings were detected (such as potential self-retrigger loops). Address the warnings and re-run \`${input.testToolName}\` before saving.`;
	}
	return `Temp-folder sandbox verification passed. Inspect output and \`diff\` carefully against the user's goal: if the result does not achieve the goal, fix the ${subject} and re-run \`${input.testToolName}\`; otherwise save it with \`${input.saveToolName}\`.`;
}

export function formatVerificationFailureMessage(input: {
	readonly kind: WorkflowKind;
	readonly label: string;
	readonly result: WorkflowVerificationResult;
	readonly testToolName: string;
}): string {
	const subject = input.kind === "magic-action" ? "Right-click automation" : "Automation";
	const lines = [
		`${subject} "${input.label}" was NOT saved because automatic verification in a temporary sandbox folder failed.`,
		`Error: ${input.result.error ?? `exit ${input.result.exitCode ?? "unknown"}`}`,
		...(input.result.output.length > 0 ? [`output:\n${input.result.output}`] : []),
		...(input.result.stderr !== undefined && input.result.stderr.length > 0 ? [`stderr:\n${input.result.stderr}`] : []),
		`diff: ${JSON.stringify(input.result.diff)}`,
		...(input.result.warnings !== undefined && input.result.warnings.length > 0
			? [`warnings:\n- ${input.result.warnings.join("\n- ")}`]
			: []),
		`Fix the ${subject.toLowerCase()} (command/script/agent prompt/filters), test it in a temp folder with \`${input.testToolName}\`, and save once it works as intended.`,
	];
	return lines.join("\n");
}

export function formatVerificationPassSummary(input: {
	readonly result: WorkflowVerificationResult;
	readonly autoVerified: boolean;
	readonly testToolName: string;
}): string {
	const created = input.result.diff.created.map((f) => f.path);
	const modified = input.result.diff.modified.map((f) => f.path);
	const deleted = input.result.diff.deleted;
	const exitPart = input.result.exitCode !== undefined ? `exit=${input.result.exitCode ?? 0}, ` : "";
	const lines = [
		input.autoVerified
			? `[Verified in temporary sandbox automatically] ${exitPart}duration=${input.result.durationMs}ms`
			: `[Verified in temporary sandbox] ${exitPart}duration=${input.result.durationMs}ms`,
		...(input.result.output.length > 0 ? [`sandbox output:\n${input.result.output}`] : []),
		...(created.length > 0 ? [`sandbox created: ${created.join(", ")}`] : []),
		...(modified.length > 0 ? [`sandbox modified: ${modified.join(", ")}`] : []),
		...(deleted.length > 0 ? [`sandbox deleted: ${deleted.join(", ")}`] : []),
		...(input.result.warnings !== undefined && input.result.warnings.length > 0
			? [`warnings:\n- ${input.result.warnings.join("\n- ")}`]
			: []),
		...(input.autoVerified
			? [
					`Inspect the sandbox output and file changes above to confirm it achieved the user's exact goal. If not, fix it, test with \`${input.testToolName}\`, and save the corrected version.`,
				]
			: []),
	];
	return lines.join("\n");
}

const MAGIC_ACTION_TOPIC_RE =
	/(?:매직\s*액션|magic[\s_-]?actions?|우클릭\s*(?:메뉴|버튼|액션|자동화)|컨텍스트\s*메뉴|context[\s_-]?menu|right[\s-]?click\s*(?:menu|button|action|automation)|右クリック\s*(?:メニュー|アクション|自動化)|マジックアクション|魔法动作|右键\s*(?:菜单|自动化)|list_magic_actions|test_magic_action|upsert_magic_action|delete_magic_action)/iu;

const WORKFLOW_MANAGE_VERB_RE =
	/(?:만들|생성|추가|수정|편집|커스텀|변경|바꿔|바꾸|업데이트|삭제|제거|지워|테스트|검증|목록|조회|확인|보여|create|add|make|build|edit|update|customiz|modif|chang|delete|remov|test|verif|list|show|作成|追加|編集|変更|削除|テスト|検証|创建|添加|修改|更新|删除|测试|验证|list_magic_actions|test_magic_action|upsert_magic_action|delete_magic_action)/iu;

/**
 * Returns true when a user query in the main AI Agent directly asks to create, inspect,
 * test, customize, or delete a right-click automation. Used to route Turn 1 straight to
 * the librarian's single-turn action (`extra`) route instead of the 2-phase search/fast-answer
 * flow (which otherwise emits a premature unverified fast answer and has to strike it out via
 * `revise_answer`), while keeping every search and workflow tool available.
 */
export function isMagicActionManagementQuery(query: string): boolean {
	const trimmed = query.trim();
	if (trimmed.length === 0) return false;
	return MAGIC_ACTION_TOPIC_RE.test(trimmed) && WORKFLOW_MANAGE_VERB_RE.test(trimmed);
}

/**
 * Shared English system-prompt addendum for Dazzi's main AI Agent describing
 * Folder Automations and Right-Click Automations as one unified automation architecture
 * that differs only in trigger and shares the exact same script/agent execution and
 * mandatory temporary-sandbox verification loop.
 */
export function buildUnifiedWorkflowsPrompt(
	platform: NodeJS.Platform = process.platform,
	options: { readonly includeMagicActions?: boolean } = {},
): string {
	const includeMagic = options.includeMagicActions !== false;
	const scriptHint =
		platform === "win32"
			? "On Windows, script right-click automations run in `powershell.exe` receiving selected paths in `$args` and `$env:DAZZI_FILES_JSON` / `$env:DAZZI_FILE` / `$env:DAZZI_FILE_COUNT` (write valid PowerShell, never POSIX `\"$@\"`)."
			: "On macOS/Linux, script right-click automations run in `/bin/sh` receiving selected paths in `\"$@\"` and env vars `DAZZI_FILES_JSON` / `DAZZI_FILE` / `DAZZI_FILE_COUNT`.";

	const lines = [
		"## Automations: Folder Automations & Right-Click Automations",
		"Dazzi has one unified automation architecture with two triggers that share the same execution backends (shell script/command OR AI agent) and the same mandatory temporary-sandbox verification pipeline:",
		"1. **Folder Automations** (triggered automatically when files in watched folders are created, updated, or deleted): managed with `test_automation_in_sandbox` and `manage_automations`.",
	];

	if (includeMagic) {
		lines.push(
			"2. **Right-Click Automations** (triggered on demand when the user right-clicks selected file(s) or folder(s) in Dazzi Finder and clicks a custom menu item): managed with `list_magic_actions`, `test_magic_action`, `upsert_magic_action`, and `delete_magic_action`.",
			`- ${scriptHint}`,
			"- Agent right-click automations (`executionKind: 'agent'`) run either `agentMode: 'read'` (analysis/summary) or `agentMode: 'organize'` (creating/editing/converting/organizing files), sharing installed Skills (`useSkills: true`) and connected MCP servers (`useMcp: true`) by default.",
			"- You can directly create, inspect, customize/update, test, and delete right-click automations from this main AI Agent chat — even if a turn was routed as a configuration request. Right-click automations are stored in Dazzi's app settings via those dedicated tools (never edit `config.json` for them).",
			"- **User-facing terminology**: Always refer to these as **automations** or **right-click automations** in the user's language (never call them \"Magic Actions\" in replies — only the internal tool names keep the legacy `*_magic_action` identifier).",
		);
	}

	lines.push(
		"",
		"### Shared Mandatory Verification Loop (Applies to Both Folder and Right-Click Automations)",
		"- Before finalizing ANY new or modified automation (folder or right-click), ALWAYS verify it in an isolated temporary sandbox folder (`test_automation_in_sandbox` for folder automations, `test_magic_action` for right-click automations) with realistic sample fixtures matching the user's goal.",
		"- Inspect `ok`, `exitCode`, `output`/`stdout`, `stderr`, `error`, any loop/retrigger warnings, and `diff` (`created`, `modified`, `deleted` files and `contentPreview`) to verify the automation truly achieved the user's goal.",
		"- If verification fails OR the output/files do not match the user's goal, diagnose the issue, fix the command/script/prompt/filters, and re-test in the temporary sandbox until it passes (up to 3 retries).",
		"- Only finalize/save (`manage_automations` save / `upsert_magic_action`) once sandbox verification succeeds. Saving presents a confirmation card to the user so they can review and click Add before the automation is persisted; if the user cancels, do not retry saving unless they ask. When customizing an existing automation, inspect it first (`manage_automations` list / `list_magic_actions`), apply the changes, re-verify in the temp sandbox, and save the verified update.",
	);

	return lines.join("\n");
}
