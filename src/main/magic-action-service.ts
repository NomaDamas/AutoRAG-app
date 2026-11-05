import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ProfileModel } from "@autorag/librarian/profiles";
import { normalizeContextMenuSettings, type MagicAction } from "../shared/context-menu-contract";
import type { MagicActionEvent, MagicActionRunRequest } from "../shared/magic-actions-contract";
import type { SettingsBridge } from "../shared/settings-contract";
import { isSecretKey } from "./autorag-config-service";
import {
	buildMagicActionUserMessage,
	openMagicActionSession,
	type OpenedMagicActionSession,
} from "./agents/profiles/magic-action";
import { subscribeProfileProgress, type ReplyLanguage } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";

const MAX_CAPTURE_CHARS = 32 * 1024;
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
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

export interface MagicActionServiceDeps {
	readonly send: (event: MagicActionEvent) => void;
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly homeDir?: string;
	readonly platform?: NodeJS.Platform;
	readonly language: () => ReplyLanguage;
	readonly settings: Pick<SettingsBridge, "get">;
}

export interface MagicActionService {
	start(runId: string, request: MagicActionRunRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	dispose(): void;
}

interface ActiveRun {
	readonly abort: AbortController;
	cancelled: boolean;
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

function hasToolCall(message: unknown): boolean {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return false;
	return msg.content.some((entry) => recordOf(entry)?.type === "toolCall");
}

function latestAssistantReply(session: AgentSession): string {
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

function resolveWorkingDir(paths: readonly string[], fallbackHome: string): string {
	const first = paths[0];
	if (first !== undefined && existsSync(first)) {
		try {
			const st = statSync(first);
			if (st.isDirectory()) return first;
			const parent = dirname(first);
			if (existsSync(parent)) return parent;
		} catch {
			// Fall back below
		}
	}
	if (first !== undefined) {
		const parent = dirname(first);
		if (existsSync(parent)) return parent;
	}
	return fallbackHome;
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

export function createMagicActionService(deps: MagicActionServiceDeps): MagicActionService {
	const runs = new Map<string, ActiveRun>();
	const platform = deps.platform ?? process.platform;
	const home = deps.homeDir ?? homedir();

	async function executeScript(
		runId: string,
		run: ActiveRun,
		action: MagicAction,
		command: string,
		paths: readonly string[],
		startedAtMs: number,
	): Promise<void> {
		const cwd = resolveWorkingDir(paths, home);
		const childEnv: NodeJS.ProcessEnv = {
			...sanitizedEnv(deps.env),
			DAZZI_ACTION_ID: action.id,
			DAZZI_ACTION_LABEL: action.label,
			DAZZI_FILE_COUNT: String(paths.length),
			DAZZI_FILE: paths[0] ?? "",
			DAZZI_FILES_JSON: JSON.stringify(paths),
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
						args: ["-c", command, "dazzi-magic-action", ...paths],
					};

		const { promise, resolve } = Promise.withResolvers<void>();
		let stdout = "";
		let stderr = "";
		let settled = false;

		const child = spawn(shellCmd.bin, shellCmd.args, {
			cwd,
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
			detached: platform !== "win32",
			windowsHide: true,
		});

		child.stdin?.on("error", () => {
			// Ignore async EPIPE/EOF when command exits without reading stdin
		});
		try {
			child.stdin?.end(`${JSON.stringify(paths)}\n`);
		} catch {
			// Ignore synchronous stream errors when command does not read stdin
		}

		const timer = setTimeout(() => {
			if (settled) return;
			killProcessTree(child.pid, platform);
		}, SCRIPT_TIMEOUT_MS);
		timer.unref?.();

		const onAbort = (): void => {
			killProcessTree(child.pid, platform);
		};
		run.abort.signal.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			if (run.cancelled) return;
			stdout = bounded(stdout + chunk.toString("utf8"));
			deps.send({ type: "draft", runId, text: stdout });
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			if (run.cancelled) return;
			stderr = bounded(stderr + chunk.toString("utf8"));
		});

		const finish = (exitCode: number | null, spawnError?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			run.abort.signal.removeEventListener("abort", onAbort);

			if (run.cancelled) {
				deps.send({ type: "cancelled", runId, actionLabel: action.label });
				resolve();
				return;
			}
			if (spawnError !== undefined) {
				deps.send({
					type: "error",
					runId,
					actionLabel: action.label,
					message: spawnError.message,
					...(stderr.trim().length > 0 ? { stderr: stderr.trim() } : {}),
				});
				resolve();
				return;
			}
			if (exitCode !== 0) {
				const detail = stderr.trim() || stdout.trim() || `Exited with code ${exitCode ?? "unknown"}`;
				deps.send({
					type: "error",
					runId,
					actionLabel: action.label,
					message: detail,
					...(stderr.trim().length > 0 ? { stderr: stderr.trim() } : {}),
				});
				resolve();
				return;
			}
			deps.send({
				type: "done",
				runId,
				result: {
					actionId: action.id,
					actionLabel: action.label,
					executionKind: "script",
					paths,
					output: stdout.trim(),
					...(stderr.trim().length > 0 ? { stderr: stderr.trim() } : {}),
					exitCode,
					durationMs: Math.max(0, Date.now() - startedAtMs),
				},
			});
			resolve();
		};

		child.on("error", (err) => finish(null, err));
		child.on("close", (code) => finish(code));
		await promise;
	}

	async function executeAgent(
		runId: string,
		run: ActiveRun,
		action: MagicAction,
		mode: "read" | "organize",
		prompt: string,
		useSkills: boolean,
		useMcp: boolean,
		paths: readonly string[],
		startedAtMs: number,
	): Promise<void> {
		let opened: OpenedMagicActionSession | null = null;
		let unsubscribeProgress: (() => void) | null = null;
		let unsubscribeDraft: (() => void) | null = null;

		try {
			const model = await deps.resolveModel();
			if (run.cancelled) {
				deps.send({ type: "cancelled", runId, actionLabel: action.label });
				return;
			}
			const cwd = resolveWorkingDir(paths, home);
			opened = await openMagicActionSession({
				language: deps.language(),
				mode,
				actionLabel: action.label,
				prompt,
				cwd,
				agentDir: deps.agentDir,
				env: deps.env,
				useSkills,
				useMcp,
				cancelled: () => run.cancelled,
				model,
			});
			const session = opened.session;

			const onAbort = (): void => {
				void session.abort();
			};
			run.abort.signal.addEventListener("abort", onAbort, { once: true });

			unsubscribeProgress = subscribeProfileProgress(session, (text) => {
				if (!run.cancelled) deps.send({ type: "progress", runId, text });
			});

			let lastDraft = "";
			unsubscribeDraft = session.subscribe((event) => {
				if (run.cancelled) return;
				const ev = recordOf(event);
				if (ev?.type === "message_update") {
					if (hasToolCall(ev.message)) {
						if (lastDraft !== "") {
							lastDraft = "";
							deps.send({ type: "draft", runId, text: "" });
						}
						return;
					}
					const draft = assistantTextFromMessage(ev.message);
					if (draft !== lastDraft) {
						lastDraft = draft;
						deps.send({ type: "draft", runId, text: draft });
					}
				}
			});

			await session.prompt(buildMagicActionUserMessage(paths, prompt));

			if (run.cancelled) {
				deps.send({ type: "cancelled", runId, actionLabel: action.label });
				return;
			}

			const failure = modelFailure(session);
			if (failure !== null) throw new Error(failure);

			const reply = bounded(latestAssistantReply(session));
			deps.send({
				type: "done",
				runId,
				result: {
					actionId: action.id,
					actionLabel: action.label,
					executionKind: "agent",
					paths,
					output: reply,
					durationMs: Math.max(0, Date.now() - startedAtMs),
				},
			});
		} catch (error) {
			if (run.cancelled) {
				deps.send({ type: "cancelled", runId, actionLabel: action.label });
			} else {
				deps.send({
					type: "error",
					runId,
					actionLabel: action.label,
					message: errorText(error),
				});
			}
		} finally {
			unsubscribeDraft?.();
			unsubscribeProgress?.();
			await opened?.dispose().catch(() => undefined);
		}
	}

	return {
		start: async (runId, request) => {
			const run: ActiveRun = { abort: new AbortController(), cancelled: false };
			runs.set(runId, run);
			const startedAtMs = Date.now();
			try {
				const appSettings = await deps.settings.get();
				const contextMenu = normalizeContextMenuSettings(appSettings.contextMenu);
				const action = contextMenu.magicActions.find((item) => item.id === request.actionId);
				if (action === undefined) {
					deps.send({
						type: "error",
						runId,
						actionLabel: request.actionId,
						message: `Magic Action "${request.actionId}" was not found.`,
					});
					return;
				}
				deps.send({
					type: "started",
					runId,
					actionId: action.id,
					actionLabel: action.label,
					executionKind: action.execution.kind,
					paths: request.paths,
				});
				if (action.execution.kind === "script") {
					await executeScript(runId, run, action, action.execution.command, request.paths, startedAtMs);
				} else {
					await executeAgent(
						runId,
						run,
						action,
						action.execution.mode,
						action.execution.prompt,
						action.execution.useSkills !== false,
						action.execution.useMcp !== false,
						request.paths,
						startedAtMs,
					);
				}
			} finally {
				runs.delete(runId);
			}
		},
		cancel: async (runId) => {
			const run = runs.get(runId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.abort.abort();
		},
		dispose: () => {
			for (const run of runs.values()) {
				run.cancelled = true;
				run.abort.abort();
			}
			runs.clear();
		},
	};
}
