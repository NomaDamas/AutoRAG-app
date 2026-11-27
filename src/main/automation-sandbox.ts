import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, matchesGlob } from "node:path";
import type { AutoRAGAgentOptions } from "@autorag/librarian";
import { Type } from "typebox";
import {
	resolveSandboxPath,
	sampleFilenameForGlob,
	seedSandboxFixtures,
	type SandboxDiff,
	type SandboxFixtureInput,
} from "./sandbox-fixtures";
import { librarianCommand } from "./automation-service";
import { t } from "../shared/i18n/core";
import {
	buildWorkflowVerificationGuidance,
	createVerificationTracker,
	runInTempSandbox,
	runSubprocess,
	type VerificationTracker,
	type WorkflowVerificationResult,
} from "./workflow-sandbox";

export const TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME = "test_automation_in_sandbox";

type AgentTool = NonNullable<AutoRAGAgentOptions["tools"]>[number];
type AutomationEventType = "create" | "update" | "delete";

const MAX_CAPTURE_CHARS = 16 * 1024;
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;

const DEFAULT_AUTOMATION_EXCLUDES: readonly string[] = [
	"**/.git/**",
	"**/node_modules/**",
	"**/.autorag/**",
	"**/*.crdownload",
	"**/*.part",
	"**/*.tmp",
	"**/~$*",
	"**/.DS_Store",
];

export interface AutomationSandboxRuleInput {
	readonly id?: string;
	readonly events?: readonly AutomationEventType[];
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
	readonly run?: readonly string[];
	readonly agent?: {
		readonly profile: string;
		readonly task: string;
		readonly retrieval?: {
			readonly searchAll?: boolean;
			readonly datasources?: readonly string[];
		};
	};
	readonly appendFiles?: boolean;
	readonly timeoutMs?: number;
}

export interface AutomationSandboxTestInput {
	readonly rule: AutomationSandboxRuleInput;
	/** Original watched folder paths from the real rule; replaced with the temp folder in `run` / `agent.task` during sandbox execution. */
	readonly originalPaths?: readonly string[];
	readonly fixtures?: readonly SandboxFixtureInput[];
	/** Events relative to the sandbox watched folder (e.g. `{ type: "create", path: "sample.md" }`). */
	readonly events?: readonly { readonly type: AutomationEventType; readonly path: string }[];
	readonly timeoutMs?: number;
}

export interface AutomationSandboxTestResult extends WorkflowVerificationResult {
	readonly matchedEvents: readonly { readonly type: AutomationEventType; readonly path: string }[];
	readonly unmatchedEvents: readonly { readonly type: AutomationEventType; readonly path: string }[];
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly retriggerWarnings: readonly string[];
}

export interface AutomationSandboxDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly resourcesPath?: string;
	readonly findNode?: () => string | undefined;
	/** Test seam for running the librarian CLI against the temporary sandbox home. */
	readonly runCli?: (
		args: readonly string[],
		env: NodeJS.ProcessEnv,
		timeoutMs: number,
	) => Promise<{
		readonly exitCode: number | null;
		readonly stdout: string;
		readonly stderr: string;
		readonly timedOut: boolean;
		readonly error?: string;
	}>;
}

export type AutomationVerificationTracker = VerificationTracker<AutomationSandboxRuleInput, AutomationSandboxTestResult>;

/** Stable signature for deduplicating temp-folder sandbox verification of the same automation rule logic. */
export function automationVerificationKey(rule: AutomationSandboxRuleInput): string {
	return JSON.stringify({
		events: rule.events && rule.events.length > 0 ? [...rule.events] : ["create", "update", "delete"],
		include: rule.include && rule.include.length > 0 ? [...rule.include] : ["**/*"],
		exclude: rule.exclude ? [...rule.exclude] : [],
		run: rule.run ?? null,
		agent: rule.agent ?? null,
		appendFiles: rule.appendFiles === true,
	});
}

export function createAutomationVerificationTracker(): AutomationVerificationTracker {
	return createVerificationTracker<AutomationSandboxRuleInput, AutomationSandboxTestResult>(automationVerificationKey);
}

function expandTilde(rawPath: string, env: NodeJS.ProcessEnv): string {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
	if (rawPath === "~") return home;
	if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) return join(home, rawPath.slice(2));
	return rawPath;
}

function rewriteWatchedPaths(text: string, originals: readonly string[], sandboxWatchedDir: string, env: NodeJS.ProcessEnv): string {
	let out = text;
	const candidates = originals
		.flatMap((raw) => {
			const trimmed = raw.trim().replace(/[\\/]+$/u, "");
			const expanded = expandTilde(trimmed, env).replace(/[\\/]+$/u, "");
			return trimmed === expanded ? [trimmed] : [expanded, trimmed];
		})
		.filter((p) => p.length > 1)
		.sort((a, b) => b.length - a.length);
	for (const candidate of candidates) {
		if (out.includes(candidate)) {
			out = out.split(candidate).join(sandboxWatchedDir);
		}
	}
	return out;
}

function globMatches(relPosix: string, pattern: string): boolean {
	if (pattern === "**" || pattern === "**/*" || pattern === "*") return true;
	if (matchesGlob(relPosix, pattern)) return true;
	if (pattern.startsWith("**/") && matchesGlob(relPosix, pattern.slice(3))) return true;
	return false;
}

function matchesRuleFilters(
	relPosix: string,
	eventType: AutomationEventType,
	events: readonly AutomationEventType[],
	include: readonly string[],
	exclude: readonly string[],
): boolean {
	if (!events.includes(eventType)) return false;
	for (const pattern of DEFAULT_AUTOMATION_EXCLUDES) {
		if (globMatches(relPosix, pattern)) return false;
	}
	for (const pattern of exclude) {
		if (globMatches(relPosix, pattern)) return false;
	}
	return include.some((pattern) => globMatches(relPosix, pattern));
}

function detectRetriggerWarnings(
	diff: SandboxDiff,
	events: readonly AutomationEventType[],
	include: readonly string[],
	exclude: readonly string[],
): string[] {
	const warnings: string[] = [];
	for (const entry of diff.created) {
		if (entry.kind !== "file") continue;
		if (matchesRuleFilters(entry.path, "create", events, include, exclude)) {
			warnings.push(
				`Created file "${entry.path}" matches this rule's own create/include filter and could cause an infinite loop. Add an exclude glob (e.g. excluding that output pattern) or write the output elsewhere.`,
			);
		}
	}
	for (const entry of diff.modified) {
		if (entry.kind !== "file") continue;
		if (matchesRuleFilters(entry.path, "update", events, include, exclude)) {
			warnings.push(
				`Modified file "${entry.path}" matches this rule's own update/include filter and could re-trigger the rule unless the command/agent is strictly idempotent or excluded.`,
			);
		}
	}
	return warnings;
}

function defaultFixturesForRule(rule: AutomationSandboxRuleInput): readonly SandboxFixtureInput[] {
	const includes = rule.include && rule.include.length > 0 ? rule.include : ["**/*"];
	const exclude = rule.exclude ?? [];
	const events: readonly AutomationEventType[] =
		rule.events && rule.events.length > 0 ? rule.events : ["create", "update", "delete"];
	for (const pattern of includes) {
		const candidate = sampleFilenameForGlob(pattern, 1);
		if (matchesRuleFilters(candidate, events[0] ?? "create", events, includes, exclude)) {
			return [{ path: candidate, kind: "file" }];
		}
	}
	const fallback = sampleFilenameForGlob(includes[0] ?? "**/*", 1);
	return [{ path: fallback, kind: "file" }];
}

function defaultEventsForRule(
	rule: AutomationSandboxRuleInput,
	fixtures: readonly SandboxFixtureInput[],
): readonly { readonly type: AutomationEventType; readonly path: string }[] {
	const eventType: AutomationEventType = rule.events?.[0] ?? "create";
	const files = fixtures.filter((f) => f.kind !== "folder");
	if (files.length === 0) return [{ type: eventType, path: "sample.txt" }];
	return files.map((f) => ({ type: eventType, path: f.path }));
}

async function prepareSandboxConfig(
	root: string,
	watchedDir: string,
	sandboxHome: string,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	const realHome =
		env.AUTORAG_HOME?.trim() || join(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir(), ".autorag");
	const realConfigPath = env.AUTORAG_CONFIG?.trim() || join(realHome, "config.json");
	if (!existsSync(realConfigPath)) return undefined;

	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(realConfigPath, "utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch {
		return realConfigPath;
	}

	const rawMinSync =
		raw.minSync !== null && typeof raw.minSync === "object" && !Array.isArray(raw.minSync)
			? (raw.minSync as Record<string, unknown>)
			: {};
	const sandboxWorkspace = join(root, "workspace");
	await mkdir(sandboxWorkspace, { recursive: true });

	const sandboxConfig: Record<string, unknown> = {
		...(raw.model !== undefined ? { model: raw.model } : {}),
		...(raw.jev !== undefined ? { jev: raw.jev } : {}),
		...(raw.queryDecomposition !== undefined ? { queryDecomposition: raw.queryDecomposition } : {}),
		...(raw.thinking !== undefined ? { thinking: raw.thinking } : {}),
		...(raw.reranker !== undefined ? { reranker: raw.reranker } : {}),
		...(raw.languages !== undefined ? { languages: raw.languages } : {}),
		...(raw.filee !== undefined ? { filee: raw.filee } : {}),
		searchPaths: [watchedDir],
		workspacePath: sandboxWorkspace,
		memoryPath: join(root, "memory.json"),
		datasources: {},
		jikji: false,
		rankingLog: false,
		minSync: {
			...rawMinSync,
			autoInstall: false,
			embedder: { id: "none" },
		},
	};
	const sandboxConfigPath = join(sandboxHome, "config.json");
	await mkdir(sandboxHome, { recursive: true });
	await writeFile(sandboxConfigPath, `${JSON.stringify(sandboxConfig, null, 2)}\n`, "utf8");
	return sandboxConfigPath;
}

function defaultRunLibrarianCli(
	deps: AutomationSandboxDeps,
): NonNullable<AutomationSandboxDeps["runCli"]> {
	return async (args, env, timeoutMs) => {
		const platform = deps.platform ?? process.platform;
		const node = deps.findNode?.();
		const cli = librarianCommand({
			resourcesPath: deps.resourcesPath ?? process.resourcesPath ?? "",
			env,
			platform,
		});
		const command = node ?? cli.command;
		if (node === undefined && command === "node" && deps.findNode !== undefined) {
			return {
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				error: t("main.automations.errors.nodeMissing"),
			};
		}
		const ran = await runSubprocess({
			bin: command,
			args: [...cli.args, ...args],
			env,
			timeoutMs,
			maxCaptureChars: MAX_CAPTURE_CHARS,
			platform,
			trim: false,
		});
		return {
			exitCode: ran.exitCode,
			stdout: ran.stdout,
			stderr: ran.stderr,
			timedOut: ran.timedOut,
			...(ran.spawnError !== undefined ? { error: ran.spawnError } : {}),
		};
	};
}

interface ParsedRunRecord {
	readonly ok?: boolean;
	readonly exitCode?: number | null;
	readonly timedOut?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly error?: string;
	readonly eventCount?: number;
	readonly matchedEvents?: number;
	readonly ignoredEvents?: number;
}

function parseAutomateRunOutput(stdout: string): ParsedRunRecord | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			const parsed: unknown = JSON.parse(lines[i] as string);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				const rec = parsed as Record<string, unknown>;
				if ("exitCode" in rec || "timedOut" in rec || "stdout" in rec || "eventCount" in rec) {
					return rec as ParsedRunRecord;
				}
			}
		} catch {
			// Not JSON
		}
	}
	return null;
}

/**
 * Verify an automation rule (command or agent) in an isolated temporary folder and
 * throwaway `AUTORAG_HOME` / `AUTORAG_CONFIG` so real user folders, workspace indexes,
 * retrieval memory, and `~/.autorag/automations.json` are never modified during testing.
 */
export async function testAutomationInSandbox(
	input: AutomationSandboxTestInput,
	deps: AutomationSandboxDeps,
): Promise<AutomationSandboxTestResult> {
	const timeoutMs = input.timeoutMs ?? input.rule.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
	const events: readonly AutomationEventType[] =
		input.rule.events && input.rule.events.length > 0 ? [...input.rule.events] : ["create", "update", "delete"];
	const include = input.rule.include && input.rule.include.length > 0 ? [...input.rule.include] : ["**/*"];
	const exclude = input.rule.exclude && input.rule.exclude.length > 0 ? [...input.rule.exclude] : [];
	const originalPaths = input.originalPaths ?? [];
	const fixtures =
		input.fixtures !== undefined && input.fixtures.length > 0
			? input.fixtures
			: defaultFixturesForRule(input.rule);

	const { result: execOutcome, diff, durationMs } = await runInTempSandbox(
		{ prefix: "dazzi-automation-verify-", workSubdir: "watched", fixtures },
		async ({ root, workDir: watchedDir }) => {
			const sandboxHome = join(root, "autorag-home");
			const ruleId =
				(input.rule.id?.trim() || "sandbox-verify").replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) ||
				"sandbox-verify";
			const rewrittenRun =
				input.rule.run === undefined
					? undefined
					: input.rule.run.map((token) =>
							originalPaths.length > 0 ? rewriteWatchedPaths(token, originalPaths, watchedDir, deps.env) : token,
						);
			const rewrittenAgent =
				input.rule.agent === undefined
					? undefined
					: {
							...input.rule.agent,
							task:
								originalPaths.length > 0
									? rewriteWatchedPaths(input.rule.agent.task, originalPaths, watchedDir, deps.env)
									: input.rule.agent.task,
						};

			const ruleEntry: Record<string, unknown> = {
				id: ruleId,
				paths: [watchedDir],
				events,
				include,
				...(exclude.length > 0 ? { exclude } : {}),
				...(rewrittenRun !== undefined ? { run: rewrittenRun } : {}),
				...(rewrittenAgent !== undefined ? { agent: rewrittenAgent } : {}),
				...(input.rule.appendFiles !== undefined ? { appendFiles: input.rule.appendFiles } : {}),
				timeoutMs,
			};

			await seedSandboxFixtures(sandboxHome, [
				{
					path: "automations.json",
					kind: "file",
					content: `${JSON.stringify({ automations: [ruleEntry] }, null, 2)}\n`,
				},
			]);

			const sandboxConfigPath = await prepareSandboxConfig(root, watchedDir, sandboxHome, deps.env);

			const rawEvents =
				input.events !== undefined && input.events.length > 0
					? input.events
					: defaultEventsForRule(input.rule, fixtures);
			const resolvedEvents = rawEvents.map((ev) => ({
				type: ev.type,
				rel: ev.path,
				path: resolveSandboxPath(watchedDir, ev.path),
			}));

			const eventArgs: string[] = [];
			for (const ev of resolvedEvents) {
				eventArgs.push("--event", `${ev.type}:${ev.path}`);
			}

			const sandboxEnv: NodeJS.ProcessEnv = {
				...deps.env,
				AUTORAG_HOME: sandboxHome,
				...(sandboxConfigPath !== undefined ? { AUTORAG_CONFIG: sandboxConfigPath } : {}),
			};

			const runCli = deps.runCli ?? defaultRunLibrarianCli(deps);
			const cliResult = await runCli(["automate", "run", ruleId, "--json", ...eventArgs], sandboxEnv, timeoutMs + 5_000);
			return { cliResult, resolvedEvents };
		},
	);

	const { cliResult, resolvedEvents } = execOutcome;
	const retriggerWarnings = detectRetriggerWarnings(diff, events, include, exclude);
	const parsed = parseAutomateRunOutput(cliResult.stdout);

	if (parsed === null) {
		const errDetail =
			cliResult.error ??
			(cliResult.timedOut
				? `Timed out after ${timeoutMs}ms`
				: cliResult.stderr.trim() || cliResult.stdout.trim() || `CLI exited with code ${cliResult.exitCode ?? "unknown"}`);
		const stdout = cliResult.stdout.trim();
		return {
			ok: false,
			matchedEvents: [],
			unmatchedEvents: resolvedEvents.map((e) => ({ type: e.type, path: e.rel })),
			exitCode: cliResult.exitCode,
			timedOut: cliResult.timedOut,
			durationMs,
			output: stdout,
			stdout,
			stderr: cliResult.stderr.trim(),
			error: errDetail,
			diff,
			warnings: retriggerWarnings,
			retriggerWarnings,
		};
	}

	const exitCode = parsed.exitCode ?? cliResult.exitCode;
	const timedOut = parsed.timedOut === true || cliResult.timedOut;
	const matchedCount =
		typeof parsed.matchedEvents === "number"
			? parsed.matchedEvents
			: typeof parsed.eventCount === "number"
				? parsed.eventCount
				: resolvedEvents.length;
	const stdout = (parsed.stdout ?? "").trim();
	const stderr = (parsed.stderr ?? "").trim();
	const error =
		parsed.error ??
		(timedOut
			? `Timed out after ${timeoutMs}ms`
			: exitCode !== 0
				? stderr || stdout || `Exited with code ${exitCode ?? "unknown"}`
				: undefined);
	const ok = !timedOut && error === undefined && exitCode === 0 && matchedCount > 0;

	return {
		ok,
		matchedEvents: resolvedEvents.slice(0, matchedCount).map((e) => ({ type: e.type, path: e.rel })),
		unmatchedEvents: resolvedEvents.slice(matchedCount).map((e) => ({ type: e.type, path: e.rel })),
		exitCode,
		timedOut,
		durationMs,
		output: stdout,
		stdout,
		stderr,
		...(error !== undefined
			? { error }
			: matchedCount === 0
				? { error: "None of the test events matched the rule's include/exclude/events filters." }
				: {}),
		diff,
		warnings: retriggerWarnings,
		retriggerWarnings,
	};
}

const eventTypeSchema = Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]);

const fixtureSchema = Type.Object({
	path: Type.String({
		description: "Relative path inside the temporary watched folder (e.g. 'sample.md', 'IMG_0001.jpg', or 'sub/doc.pdf').",
	}),
	content: Type.Optional(
		Type.String({
			description: "UTF-8 text content of the sample file. Omit for binary formats (.pdf, .docx, .png, .jpg, .zip) to auto-generate a real valid file.",
		}),
	),
	kind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("folder")], { description: "Fixture kind (default 'file')." })),
});

const parameters = Type.Object({
	id: Type.Optional(Type.String({ description: "Rule id being tested (used for labeling the sandbox run)." })),
	events: Type.Optional(Type.Array(eventTypeSchema, { description: "File events the rule listens to (default: create, update, delete)." })),
	include: Type.Optional(Type.Array(Type.String(), { description: "Include globs relative to the watched folder (e.g. ['**/*.pdf'])." })),
	exclude: Type.Optional(Type.Array(Type.String(), { description: "Exclude globs to ignore." })),
	run: Type.Optional(
		Type.Array(Type.String(), {
			description: "Command argv to test (same format as `manage_automations` `automation.run`). Provide `run` or `agent`, never both.",
		}),
	),
	agent: Type.Optional(
		Type.Object({
			profile: Type.String({ description: "Automation agent profile (e.g. 'file-triage' or 'file-organizer')." }),
			task: Type.String({ description: "Agent task instruction to test." }),
			retrieval: Type.Optional(
				Type.Object({
					searchAll: Type.Optional(Type.Boolean()),
					datasources: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
	),
	appendFiles: Type.Optional(Type.Boolean({ description: "Whether changed file paths are appended to `run` argv." })),
	originalPaths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional real watched folder paths that should be mapped to the temp folder if referenced in the command/task.",
		}),
	),
	fixtures: Type.Optional(
		Type.Array(fixtureSchema, {
			description: "Sample files/folders to seed inside the temporary watched folder before running the rule.",
		}),
	),
	testEvents: Type.Optional(
		Type.Array(
			Type.Object({
				type: eventTypeSchema,
				path: Type.String({ description: "Relative path inside the temporary watched folder that triggered the event." }),
			}),
			{
				description: "Simulated file events to deliver to the rule (defaults to the seeded fixtures).",
			},
		),
	),
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 1000, maximum: 300_000, description: "Sandbox run timeout in milliseconds (default 120000)." }),
	),
});

/**
 * Agent tool that executes a candidate automation rule inside a temporary watched folder
 * and returns its exit status, stdout/stderr, event match status, loop-risk warnings, and
 * exact filesystem diff (created/modified/deleted files) before the rule is finalized.
 */
export function createTestAutomationInSandboxTool(
	deps: AutomationSandboxDeps & { readonly tracker?: AutomationVerificationTracker },
): AgentTool {
	return {
		name: TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
		label: "Test Automation in Sandbox",
		description:
			"Verify a file automation rule in an isolated temporary watched folder with real sample files before saving or finishing. Seeds sample fixtures (including real valid PDF/DOCX/PNG/JPG/ZIP files when omitted), runs the command or AI agent rule against them, reports exit code, stdout/stderr, matched events, loop-retrigger warnings, and every created/modified/deleted file with content previews, and cleans up the temp folder afterwards. Never touches the user's real folders or real automations.json.",
		parameters,
		execute: async (_toolCallId, rawParams) => {
			const params = rawParams as {
				readonly id?: string;
				readonly events?: readonly AutomationEventType[];
				readonly include?: readonly string[];
				readonly exclude?: readonly string[];
				readonly run?: readonly string[];
				readonly agent?: AutomationSandboxRuleInput["agent"];
				readonly appendFiles?: boolean;
				readonly originalPaths?: readonly string[];
				readonly fixtures?: readonly SandboxFixtureInput[];
				readonly testEvents?: readonly { readonly type: AutomationEventType; readonly path: string }[];
				readonly timeoutMs?: number;
			};
			if (params.run === undefined && params.agent === undefined) {
				throw new Error("test_automation_in_sandbox requires either `run` or `agent`.");
			}
			if (params.run !== undefined && params.agent !== undefined) {
				throw new Error("test_automation_in_sandbox accepts either `run` or `agent`, not both.");
			}
			const rule: AutomationSandboxRuleInput = {
				...(params.id !== undefined ? { id: params.id } : {}),
				...(params.events !== undefined ? { events: params.events } : {}),
				...(params.include !== undefined ? { include: params.include } : {}),
				...(params.exclude !== undefined ? { exclude: params.exclude } : {}),
				...(params.run !== undefined ? { run: params.run } : {}),
				...(params.agent !== undefined ? { agent: params.agent } : {}),
				...(params.appendFiles !== undefined ? { appendFiles: params.appendFiles } : {}),
			};
			const result = await testAutomationInSandbox(
				{
					rule,
					...(params.originalPaths !== undefined ? { originalPaths: params.originalPaths } : {}),
					...(params.fixtures !== undefined ? { fixtures: params.fixtures } : {}),
					...(params.testEvents !== undefined ? { events: params.testEvents } : {}),
					...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
				},
				deps,
			);
			if (result.ok) deps.tracker?.markVerified(rule, result);
			else deps.tracker?.clear(rule);

			const guidance = buildWorkflowVerificationGuidance({
				kind: "automation",
				ok: result.ok,
				testToolName: TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
				saveToolName: "manage_automations",
				warnings: result.retriggerWarnings,
			});

			const text = JSON.stringify({ ...result, verificationGuidance: guidance }, null, 2);
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	};
}
