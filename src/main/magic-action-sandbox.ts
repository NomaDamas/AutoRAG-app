import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ProfileModel } from "@autorag/librarian/profiles";
import { normalizeMagicAction, type MagicAction } from "../shared/context-menu-contract";
import { isSecretKey } from "./autorag-config-service";
import {
	buildMagicActionUserMessage,
	openMagicActionSession,
	type OpenedMagicActionSession,
} from "./agents/profiles/magic-action";
import { type ReplyLanguage } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";
import {
	diffSnapshots,
	resolveSandboxPath,
	seedSandboxFixtures,
	snapshotDirectory,
	type SandboxDiff,
	type SandboxFileSnapshot,
	type SandboxFixtureInput,
} from "./sandbox-fixtures";

export {
	diffSnapshots,
	resolveSandboxPath,
	seedSandboxFixtures,
	snapshotDirectory,
	type SandboxDiff,
	type SandboxFileSnapshot,
	type SandboxFixtureInput,
};

const MAX_CAPTURE_CHARS = 32 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const WINDOWS_POWERSHELL_BOOTSTRAP = [
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

export interface MagicActionVerificationResult {
	readonly ok: boolean;
	readonly executionKind: "script" | "agent";
	readonly exitCode?: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly output: string;
	readonly stderr?: string;
	readonly error?: string;
	readonly targetPaths: readonly string[];
	readonly diff: SandboxDiff;
}

export interface VerifyMagicActionInput {
	readonly action: MagicAction;
	readonly fixtures?: readonly SandboxFixtureInput[];
	/** Relative paths inside the sandbox to pass as target selection; defaults to top-level created fixtures. */
	readonly targets?: readonly string[];
	readonly timeoutMs?: number;
}

export interface VerifyMagicActionDeps {
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly language: () => ReplyLanguage;
	readonly cancelled?: () => boolean;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function assistantTextFromMessage(message: unknown): string {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
	return msg.content
		.map((entry) => recordOf(entry))
		.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
		.map((entry) => (entry?.text as string).trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function latestAssistantReply(session: { readonly messages: readonly unknown[] }): string {
	for (let i = session.messages.length - 1; i >= 0; i -= 1) {
		const msg = recordOf(session.messages[i]);
		if (msg?.role !== "assistant") continue;
		const text = assistantTextFromMessage(msg);
		if (text.length > 0) return text;
	}
	return "";
}

function bounded(text: string): string {
	return text.length <= MAX_CAPTURE_CHARS ? text : text.slice(text.length - MAX_CAPTURE_CHARS);
}

function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));
}

function killProcessTree(pid: number | undefined, platform: NodeJS.Platform): void {
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

/** Stable signature for deduplicating sandbox verification of the same Magic Action logic. */
export function magicActionVerificationKey(action: MagicAction): string {
	return JSON.stringify({
		selection: action.selection,
		targetKind: action.targetKind,
		extensions: action.extensions,
		execution: action.execution,
	});
}

function defaultFixturesForMagicAction(action: MagicAction): readonly SandboxFixtureInput[] {
	if (action.targetKind === "folder") {
		if (action.selection === "multiple") {
			return [
				{ path: "sample-folder-1", kind: "folder" },
				{ path: "sample-folder-1/note.txt", kind: "file" },
				{ path: "sample-folder-2", kind: "folder" },
				{ path: "sample-folder-2/note.txt", kind: "file" },
			];
		}
		return [
			{ path: "sample-folder", kind: "folder" },
			{ path: "sample-folder/note.txt", kind: "file" },
		];
	}
	const ext = action.extensions[0] ?? "txt";
	if (action.selection === "multiple") {
		return [
			{ path: `sample-1.${ext}`, kind: "file" },
			{ path: `sample-2.${ext}`, kind: "file" },
		];
	}
	return [{ path: `sample.${ext}`, kind: "file" }];
}

function defaultTargetsFromFixtures(
	sandboxRoot: string,
	action: MagicAction,
	fixtures: readonly SandboxFixtureInput[],
): string[] {
	if (action.targetKind === "folder") {
		const folders = fixtures.filter((f) => f.kind === "folder").map((f) => resolveSandboxPath(sandboxRoot, f.path));
		if (folders.length > 0) return folders;
		return [sandboxRoot];
	}
	const files = fixtures.filter((f) => f.kind !== "folder").map((f) => resolveSandboxPath(sandboxRoot, f.path));
	if (files.length > 0) return files;
	return [sandboxRoot];
}

function resolveWorkingDir(paths: readonly string[], fallback: string): string {
	const first = paths[0];
	if (first !== undefined && existsSync(first)) {
		try {
			const parent = dirname(first);
			if (existsSync(parent)) return parent;
		} catch {
			// Fall back below
		}
	}
	return fallback;
}

/**
 * Execute a Magic Action (script or agent) inside a fresh temporary sandbox folder,
 * capture its output, exit status, and filesystem diff, then clean up the sandbox.
 *
 * The action is never run against real user files during verification.
 */
export async function verifyMagicActionInSandbox(
	input: VerifyMagicActionInput,
	deps: VerifyMagicActionDeps,
): Promise<MagicActionVerificationResult> {
	const platform = deps.platform ?? process.platform;
	const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
	const rawRoot = await mkdtemp(join(tmpdir(), "dazzi-magic-verify-"));
	const sandboxRoot = realpathSync(rawRoot);
	const startedAtMs = Date.now();
	const isCancelled = (): boolean => deps.cancelled?.() === true;

	try {
		const fixtures =
			input.fixtures !== undefined && input.fixtures.length > 0
				? input.fixtures
				: defaultFixturesForMagicAction(input.action);
		await seedSandboxFixtures(sandboxRoot, fixtures);

		const targetPaths =
			input.targets !== undefined && input.targets.length > 0
				? input.targets.map((rel) => resolveSandboxPath(sandboxRoot, rel))
				: defaultTargetsFromFixtures(sandboxRoot, input.action, fixtures);

		const before = await snapshotDirectory(sandboxRoot);

		if (input.action.execution.kind === "script") {
			const command = input.action.execution.command;
			const cwd = resolveWorkingDir(targetPaths, sandboxRoot);
			const childEnv: NodeJS.ProcessEnv = {
				...sanitizedEnv(deps.env),
				DAZZI_ACTION_ID: input.action.id,
				DAZZI_ACTION_LABEL: input.action.label,
				DAZZI_FILE_COUNT: String(targetPaths.length),
				DAZZI_FILE: targetPaths[0] ?? "",
				DAZZI_FILES_JSON: JSON.stringify(targetPaths),
				...(platform === "win32" ? { DAZZI_SCRIPT: command } : {}),
			};
			const shellCmd =
				platform === "win32"
					? {
							bin: "powershell.exe",
							args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_POWERSHELL_BOOTSTRAP],
						}
					: {
							bin: "/bin/sh",
							args: ["-c", command, "dazzi-magic-action", ...targetPaths],
						};

			const { promise, resolve: settle } = Promise.withResolvers<{
				readonly exitCode: number | null;
				readonly stdout: string;
				readonly stderr: string;
				readonly timedOut: boolean;
				readonly spawnError?: string;
			}>();

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let done = false;

			const child = spawn(shellCmd.bin, shellCmd.args, {
				cwd,
				env: childEnv,
				stdio: ["pipe", "pipe", "pipe"],
				detached: platform !== "win32",
				windowsHide: true,
			});

			child.stdin?.on("error", () => undefined);
			try {
				child.stdin?.end(`${JSON.stringify(targetPaths)}\n`);
			} catch {
				// Ignore synchronous stream errors
			}

			const timer = setTimeout(() => {
				if (done) return;
				timedOut = true;
				killProcessTree(child.pid, platform);
			}, timeoutMs);
			timer.unref?.();

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout = bounded(stdout + chunk.toString("utf8"));
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = bounded(stderr + chunk.toString("utf8"));
			});

			const finish = (exitCode: number | null, spawnError?: Error): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				settle({
					exitCode: timedOut ? null : exitCode,
					stdout: stdout.trim(),
					stderr: stderr.trim(),
					timedOut,
					...(spawnError !== undefined ? { spawnError: spawnError.message } : {}),
				});
			};

			child.on("error", (err) => finish(null, err));
			child.on("close", (code) => finish(code));
			const run = await promise;
			const after = await snapshotDirectory(sandboxRoot);
			const diff = diffSnapshots(before, after);
			const ok = !run.timedOut && run.spawnError === undefined && run.exitCode === 0;
			const error = run.timedOut
				? `Timed out after ${timeoutMs}ms`
				: run.spawnError !== undefined
					? run.spawnError
					: run.exitCode !== 0
						? run.stderr || run.stdout || `Exited with code ${run.exitCode ?? "unknown"}`
						: undefined;

			return {
				ok,
				executionKind: "script",
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				durationMs: Math.max(0, Date.now() - startedAtMs),
				output: run.stdout,
				...(run.stderr.length > 0 ? { stderr: run.stderr } : {}),
				...(error !== undefined ? { error } : {}),
				targetPaths: targetPaths.map((p) => relative(sandboxRoot, p).replaceAll("\\", "/") || basename(p)),
				diff,
			};
		}

		// Agent Magic Action verification inside the temp sandbox
		let opened: OpenedMagicActionSession | null = null;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		try {
			const model = await deps.resolveModel();
			if (isCancelled()) throw new Error("Verification was cancelled.");
			const cwd = resolveWorkingDir(targetPaths, sandboxRoot);
			opened = await openMagicActionSession({
				language: deps.language(),
				mode: input.action.execution.mode,
				actionLabel: input.action.label,
				prompt: input.action.execution.prompt,
				cwd,
				agentDir: deps.agentDir,
				env: deps.env,
				platform,
				useSkills: input.action.execution.useSkills !== false,
				useMcp: input.action.execution.useMcp !== false,
				cancelled: () => isCancelled() || timedOut,
				model,
			});
			const session = opened.session;
			timer = setTimeout(() => {
				timedOut = true;
				void session.abort();
			}, timeoutMs);
			timer.unref?.();

			await session.prompt(buildMagicActionUserMessage(targetPaths, input.action.execution.prompt));
			const failure = timedOut ? `Timed out after ${timeoutMs}ms` : modelFailure(session);
			const reply = bounded(latestAssistantReply(session));
			const after = await snapshotDirectory(sandboxRoot);
			const diff = diffSnapshots(before, after);
			const ok = !timedOut && failure === null;
			return {
				ok,
				executionKind: "agent",
				timedOut,
				durationMs: Math.max(0, Date.now() - startedAtMs),
				output: reply,
				...(failure !== null ? { error: failure } : {}),
				targetPaths: targetPaths.map((p) => relative(sandboxRoot, p).replaceAll("\\", "/") || basename(p)),
				diff,
			};
		} catch (cause) {
			const after = await snapshotDirectory(sandboxRoot);
			const diff = diffSnapshots(before, after);
			return {
				ok: false,
				executionKind: "agent",
				timedOut,
				durationMs: Math.max(0, Date.now() - startedAtMs),
				output: "",
				error: errorText(cause),
				targetPaths: targetPaths.map((p) => relative(sandboxRoot, p).replaceAll("\\", "/") || basename(p)),
				diff,
			};
		} finally {
			clearTimeout(timer);
			await opened?.dispose().catch(() => undefined);
		}
	} finally {
		await rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Build a validated candidate Magic Action from tool parameters for pre-save or post-save verification. */
export function buildMagicActionCandidate(params: {
	readonly id?: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled?: boolean;
	readonly selection?: string;
	readonly targetKind?: string;
	readonly extensions?: readonly string[];
	readonly executionKind: "script" | "agent";
	readonly command?: string;
	readonly agentMode?: string;
	readonly prompt?: string;
	readonly useSkills?: boolean;
	readonly useMcp?: boolean;
}): MagicAction | null {
	const execution =
		params.executionKind === "script"
			? { kind: "script" as const, command: params.command ?? "" }
			: {
					kind: "agent" as const,
					mode: params.agentMode === "organize" ? ("organize" as const) : ("read" as const),
					prompt: params.prompt ?? "",
					useSkills: params.useSkills ?? true,
					useMcp: params.useMcp ?? true,
				};
	return normalizeMagicAction({
		id: params.id,
		label: params.label,
		description: params.description,
		enabled: params.enabled ?? true,
		selection: params.selection ?? "any",
		targetKind: params.targetKind ?? "file",
		extensions: params.extensions ?? [],
		execution,
	});
}
