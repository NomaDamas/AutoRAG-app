import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ProfileModel } from "@autorag/librarian/profiles";
import { normalizeContextMenuSettings, normalizeMagicAction, type MagicAction } from "../shared/context-menu-contract";
import type {
	MagicActionEvent,
	MagicActionRunRequest,
	MagicActionVerifyRequest,
	MagicActionVerifyResult,
} from "../shared/magic-actions-contract";
import type { SettingsBridge } from "../shared/settings-contract";
import {
	buildMagicActionUserMessage,
	openMagicActionSession,
	type OpenedMagicActionSession,
} from "./agents/profiles/magic-action";
import { subscribeProfileProgress, type ReplyLanguage } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import { verifyMagicActionInSandbox } from "./magic-action-sandbox";
import {
	boundedText,
	buildMagicScriptCommand,
	extractAssistantText,
	extractLatestAssistantReply,
	runSubprocess,
} from "./workflow-sandbox";

const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

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
	verify(request: MagicActionVerifyRequest): Promise<MagicActionVerifyResult>;
	dispose(): void;
}

interface ActiveRun {
	readonly abort: AbortController;
	cancelled: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasToolCall(message: unknown): boolean {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return false;
	return msg.content.some((entry) => recordOf(entry)?.type === "toolCall");
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

export function createMagicActionService(deps: MagicActionServiceDeps): MagicActionService {
	const runs = new Map<string, ActiveRun>();
	const platform = deps.platform ?? process.platform;
	const home = deps.homeDir ?? homedir();

	async function executeScript(
		runId: string,
		run: ActiveRun,
		action: MagicAction,
		paths: readonly string[],
		startedAtMs: number,
	): Promise<void> {
		const cwd = resolveWorkingDir(paths, home);
		const cmd = buildMagicScriptCommand(action, paths, deps.env, platform);
		const result = await runSubprocess({
			bin: cmd.bin,
			args: cmd.args,
			cwd,
			env: cmd.env,
			stdin: `${JSON.stringify(paths)}\n`,
			timeoutMs: SCRIPT_TIMEOUT_MS,
			platform,
			signal: run.abort.signal,
			onStdout: (text) => {
				if (!run.cancelled) deps.send({ type: "draft", runId, text });
			},
		});

		if (run.cancelled || result.cancelled) {
			deps.send({ type: "cancelled", runId, actionLabel: action.label });
			return;
		}
		if (result.spawnError !== undefined) {
			deps.send({
				type: "error",
				runId,
				actionLabel: action.label,
				message: result.spawnError,
				...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
			});
			return;
		}
		if (result.timedOut || result.exitCode !== 0) {
			const detail = result.timedOut
				? `Timed out after ${SCRIPT_TIMEOUT_MS}ms`
				: result.stderr || result.stdout || `Exited with code ${result.exitCode ?? "unknown"}`;
			deps.send({
				type: "error",
				runId,
				actionLabel: action.label,
				message: detail,
				...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
			});
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
				output: result.stdout,
				...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
				exitCode: result.exitCode,
				durationMs: Math.max(0, Date.now() - startedAtMs),
			},
		});
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
				platform,
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
					const draft = extractAssistantText(ev.message);
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

			const reply = boundedText(extractLatestAssistantReply(session.messages));
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
					await executeScript(runId, run, action, request.paths, startedAtMs);
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
		verify: async (request) => {
			const normalized = normalizeMagicAction(request.action);
			if (normalized === null) {
				return {
					ok: false,
					executionKind: request.action.execution.kind,
					timedOut: false,
					durationMs: 0,
					output: "",
					error: "Invalid Magic Action.",
					targetPaths: [],
					diff: { created: [], modified: [], deleted: [], unchanged: [] },
				};
			}
			return verifyMagicActionInSandbox(
				{ action: normalized },
				{
					resolveModel: deps.resolveModel,
					agentDir: deps.agentDir,
					env: deps.env,
					platform,
					language: deps.language,
				},
			);
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
