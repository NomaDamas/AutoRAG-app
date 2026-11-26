import { existsSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import type { ProfileModel } from "@autorag/librarian/profiles";
import { normalizeMagicAction, type MagicAction } from "../shared/context-menu-contract";
import {
	buildMagicActionUserMessage,
	openMagicActionSession,
	type OpenedMagicActionSession,
} from "./agents/profiles/magic-action";
import { type ReplyLanguage } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import {
	diffSnapshots,
	resolveSandboxPath,
	seedSandboxFixtures,
	snapshotDirectory,
	type SandboxDiff,
	type SandboxFileSnapshot,
	type SandboxFixtureInput,
} from "./sandbox-fixtures";
import {
	boundedText,
	buildMagicScriptCommand,
	extractLatestAssistantReply,
	runInTempSandbox,
	runSubprocess,
	type WorkflowVerificationResult,
} from "./workflow-sandbox";

export {
	diffSnapshots,
	resolveSandboxPath,
	seedSandboxFixtures,
	snapshotDirectory,
	type SandboxDiff,
	type SandboxFileSnapshot,
	type SandboxFixtureInput,
};

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

export interface MagicActionVerificationResult extends WorkflowVerificationResult {
	readonly executionKind: "script" | "agent";
	readonly targetPaths: readonly string[];
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
	const isCancelled = (): boolean => deps.cancelled?.() === true;
	const fixtures =
		input.fixtures !== undefined && input.fixtures.length > 0
			? input.fixtures
			: defaultFixturesForMagicAction(input.action);

	const { result: runOutcome, diff, durationMs } = await runInTempSandbox(
		{ prefix: "dazzi-magic-verify-", fixtures },
		async ({ workDir: sandboxRoot }) => {
			const targetPaths =
				input.targets !== undefined && input.targets.length > 0
					? input.targets.map((rel) => resolveSandboxPath(sandboxRoot, rel))
					: defaultTargetsFromFixtures(sandboxRoot, input.action, fixtures);
			const relTargets = targetPaths.map((p) => relative(sandboxRoot, p).replaceAll("\\", "/") || basename(p));
			const cwd = resolveWorkingDir(targetPaths, sandboxRoot);

			if (input.action.execution.kind === "script") {
				const cmd = buildMagicScriptCommand(input.action, targetPaths, deps.env, platform);
				const run = await runSubprocess({
					bin: cmd.bin,
					args: cmd.args,
					cwd,
					env: cmd.env,
					stdin: `${JSON.stringify(targetPaths)}\n`,
					timeoutMs,
					platform,
				});
				const ok = !run.timedOut && !run.cancelled && run.spawnError === undefined && run.exitCode === 0;
				const error = run.timedOut
					? `Timed out after ${timeoutMs}ms`
					: run.spawnError !== undefined
						? run.spawnError
						: run.exitCode !== 0
							? run.stderr || run.stdout || `Exited with code ${run.exitCode ?? "unknown"}`
							: undefined;
				return {
					ok,
					executionKind: "script" as const,
					exitCode: run.exitCode,
					timedOut: run.timedOut,
					output: run.stdout,
					...(run.stderr.length > 0 ? { stderr: run.stderr } : {}),
					...(error !== undefined ? { error } : {}),
					targetPaths: relTargets,
				};
			}

			// Agent Magic Action verification inside the temp sandbox
			let opened: OpenedMagicActionSession | null = null;
			let timedOut = false;
			let timer: NodeJS.Timeout | undefined;
			try {
				const model = await deps.resolveModel();
				if (isCancelled()) throw new Error("Verification was cancelled.");
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
				const reply = boundedText(extractLatestAssistantReply(session.messages));
				return {
					ok: !timedOut && failure === null,
					executionKind: "agent" as const,
					timedOut,
					output: reply,
					...(failure !== null ? { error: failure } : {}),
					targetPaths: relTargets,
				};
			} catch (cause) {
				return {
					ok: false,
					executionKind: "agent" as const,
					timedOut,
					output: "",
					error: errorText(cause),
					targetPaths: relTargets,
				};
			} finally {
				clearTimeout(timer);
				await opened?.dispose().catch(() => undefined);
			}
		},
	);

	return {
		...runOutcome,
		durationMs,
		diff,
	};
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
