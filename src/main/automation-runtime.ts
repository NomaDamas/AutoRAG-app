import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { t } from "../shared/i18n/core";
import { pathKey } from "./bundled-tools";
import {
	TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
	type AutomationSandboxRuleInput,
	type AutomationSandboxTestResult,
	type AutomationVerificationTracker,
} from "./automation-sandbox";
import {
	formatVerificationFailureMessage,
	formatVerificationPassSummary,
	verifyBeforeSave,
} from "./workflow-sandbox";

/**
 * The librarian agent's `manage_automations` tool, kept off the app's own binary.
 *
 * Two of its actions start a program by asking for "this Node": `run` (a rule's command,
 * `autorag …` or `node …`, is spawned) and `install_service` (the login service is
 * written with the node that ran the install). The librarian answers with
 * `process.execPath`, and inside the app that is the Dazzi binary: a service defined that
 * way starts a second copy of the app, and a spawned `autorag search` opens another app
 * instance that never exits (observed: an edit request through AI Search hung while its
 * rule test ran). The CLI the app itself spawns has the same issue and avoids it by
 * choosing its own Node (`librarianCommand`); the agent's tool takes no such option, so
 * the app hands it one here.
 *
 * `process.execPath` is read synchronously, before the first `await`, in both actions.
 * The path is therefore swapped only for the synchronous start of that call and put back
 * before anything else can run: no other code in the app ever sees a different binary,
 * and overlapping tool calls cannot interleave. `ELECTRON_RUN_AS_NODE` is deliberately
 * not used; setting it on this process stops new windows from loading.
 */

/** The actions whose librarian code reads `process.execPath` to start something. */
const PROGRAM_ACTIONS: ReadonlySet<string> = new Set(["run", "install_service"]);

export interface NodeBinaryDeps {
	readonly resourcesPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
}

export interface AutomationSaveVerificationOptions {
	readonly tracker: AutomationVerificationTracker;
	readonly verifyRule: (
		rule: AutomationSandboxRuleInput,
		originalPaths: readonly string[],
	) => Promise<AutomationSandboxTestResult>;
}

function runnableFile(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * An absolute path to a real Node: the one the installer ships under `<tools>/node`, else the first
 * `node` on `PATH`. Never this process's own binary; undefined when there is none.
 */
export function resolveNodeBinary(deps: NodeBinaryDeps): string | undefined {
	const binary = deps.platform === "win32" ? "node.exe" : "node";
	const toolsRoot = deps.env.AUTORAG_TOOLS_DIR?.trim() || join(deps.resourcesPath, "tools");
	const bundled = deps.platform === "win32" ? join(toolsRoot, "node", binary) : join(toolsRoot, "node", "bin", binary);
	if (runnableFile(bundled, deps.platform)) return bundled;
	for (const directory of (deps.env[pathKey(deps.env, deps.platform)] ?? "").split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, binary);
		if (runnableFile(candidate, deps.platform)) return candidate;
	}
	return undefined;
}

/** Run `start` with `process.execPath` set to `nodePath`, and put the real path back before returning. */
export function startOnNode<T>(nodePath: string, start: () => T): T {
	const real = process.execPath;
	process.execPath = nodePath;
	try {
		return start();
	} finally {
		process.execPath = real;
	}
}

/** A tool's `execute`, wrapped so the actions that start a program do it on Node. */
export function runOnNode<P extends { readonly action: string }, A extends readonly unknown[], R>(
	execute: (toolCallId: string, params: P, ...rest: A) => Promise<R>,
	findNode: () => string | undefined,
): (toolCallId: string, params: P, ...rest: A) => Promise<R> {
	return async (toolCallId, params, ...rest) => {
		if (!PROGRAM_ACTIONS.has(params.action)) return execute(toolCallId, params, ...rest);
		const node = findNode();
		if (node === undefined) throw new Error(t("main.automations.errors.nodeMissing"));
		return startOnNode(node, () => execute(toolCallId, params, ...rest));
	};
}

interface ManageAutomationsParams {
	readonly action: string;
	readonly id?: string;
	readonly automation?: Record<string, unknown>;
}

interface PatchableTool {
	readonly name: string;
	description?: string;
	execute: (toolCallId: string, params: ManageAutomationsParams, ...rest: unknown[]) => Promise<unknown>;
}

const SANDBOX_VERIFY_GUIDANCE =
	" IMPORTANT: Before finalizing a new or edited automation rule, ALWAYS verify it works in an isolated temporary folder using `test_automation_in_sandbox` with realistic sample fixtures matching the user's goal. Inspect `ok`, `exitCode`, `stdout`, `stderr`, `error`, `retriggerWarnings`, and `diff` (`created`/`modified`/`deleted` files and previews). If verification fails or the result does not achieve the user's goal, fix the rule (command/script/agent task/globs/events) and re-test until it passes (up to 3 retries), then save the verified rule with `manage_automations`.";

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string");
	return items.length === value.length ? items : undefined;
}

function extractSandboxCandidate(
	id: string | undefined,
	rawAutomation: Record<string, unknown>,
): { readonly rule: AutomationSandboxRuleInput; readonly originalPaths: readonly string[] } | null {
	const run = stringArrayOf(rawAutomation.run);
	const rawAgent = recordOf(rawAutomation.agent);
	const agent =
		rawAgent !== undefined && typeof rawAgent.profile === "string" && typeof rawAgent.task === "string"
			? {
					profile: rawAgent.profile,
					task: rawAgent.task,
					...(recordOf(rawAgent.retrieval) !== undefined
						? {
								retrieval: {
									...(typeof recordOf(rawAgent.retrieval)?.searchAll === "boolean"
										? { searchAll: recordOf(rawAgent.retrieval)?.searchAll as boolean }
										: {}),
									...(stringArrayOf(recordOf(rawAgent.retrieval)?.datasources) !== undefined
										? { datasources: stringArrayOf(recordOf(rawAgent.retrieval)?.datasources) as string[] }
										: {}),
								},
							}
						: {}),
				}
			: undefined;

	// If neither or both are present, let the librarian's own schema/config validation report the config error.
	if ((run === undefined) === (agent === undefined)) return null;

	const rawEvents = stringArrayOf(rawAutomation.events)?.filter(
		(ev): ev is "create" | "update" | "delete" => ev === "create" || ev === "update" || ev === "delete",
	);
	const include = stringArrayOf(rawAutomation.include);
	const exclude = stringArrayOf(rawAutomation.exclude);
	const originalPaths = stringArrayOf(rawAutomation.paths) ?? [];
	const timeoutMs =
		typeof rawAutomation.timeoutMs === "number" && Number.isInteger(rawAutomation.timeoutMs) && rawAutomation.timeoutMs > 0
			? rawAutomation.timeoutMs
			: undefined;

	return {
		rule: {
			...(id !== undefined ? { id } : {}),
			...(rawEvents !== undefined && rawEvents.length > 0 ? { events: rawEvents } : {}),
			...(include !== undefined && include.length > 0 ? { include } : {}),
			...(exclude !== undefined && exclude.length > 0 ? { exclude } : {}),
			...(run !== undefined ? { run } : {}),
			...(agent !== undefined ? { agent } : {}),
			...(typeof rawAutomation.appendFiles === "boolean" ? { appendFiles: rawAutomation.appendFiles } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
		originalPaths,
	};
}

function appendTextNote(result: unknown, note: string): unknown {
	if (result === null || typeof result !== "object") return result;
	const rec = result as { readonly content?: readonly { readonly type?: string; readonly text?: string }[] };
	if (!Array.isArray(rec.content)) return result;
	return {
		...rec,
		content: rec.content.map((part, idx) =>
			idx === 0 && part.type === "text" && typeof part.text === "string"
				? { ...part, text: `${part.text}\n${note}` }
				: part,
		),
	};
}

function formatSandboxPassNote(verification: AutomationSandboxTestResult, autoVerified: boolean): string {
	return formatVerificationPassSummary({
		result: verification,
		autoVerified,
		testToolName: TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
	});
}

/**
 * Put the agent's `manage_automations` tool on Node and enforce temporary-sandbox verification
 * when saving new or edited automation rules. The tool object is shared by the agent's tool
 * list and every session it opens, so changing it once covers them all. Throws when the agent
 * has no such tool, so a librarian that changes where it keeps its tools fails loudly instead
 * of quietly leaving the tool on the app's own binary.
 */
export function runAutomationToolOnNode(
	agent: object,
	findNode: () => string | undefined,
	verification?: AutomationSaveVerificationOptions,
): void {
	const tools = (agent as { readonly tools?: readonly PatchableTool[] }).tools;
	const tool = Array.isArray(tools) ? tools.find((candidate) => candidate.name === "manage_automations") : undefined;
	if (tool === undefined) throw new Error("The librarian agent has no manage_automations tool to run on Node.");
	if (typeof tool.description === "string" && !tool.description.includes(TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME)) {
		tool.description = `${tool.description}${SANDBOX_VERIFY_GUIDANCE}`;
	}
	const onNode = runOnNode(tool.execute.bind(tool), findNode);
	tool.execute = async (toolCallId: string, params: ManageAutomationsParams, ...rest: unknown[]) => {
		if (params.action === "save" && verification !== undefined) {
			const rawAutomation = recordOf(params.automation);
			const candidate = rawAutomation === undefined ? null : extractSandboxCandidate(params.id, rawAutomation);
			if (candidate !== null) {
				const gate = await verifyBeforeSave({
					candidate: candidate.rule,
					tracker: verification.tracker,
					verify: (rule) => verification.verifyRule(rule, candidate.originalPaths),
				});
				if (!gate.ok) {
					const failureText = formatVerificationFailureMessage({
						kind: "automation",
						label: params.id ?? "",
						result: gate.verification,
						testToolName: TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME,
					});
					return {
						content: [{ type: "text", text: failureText }],
						details: { action: "save", id: params.id, saved: false, verified: false, verification: gate.verification },
					};
				}
				const savedRes = await onNode(toolCallId, params, ...rest);
				return appendTextNote(savedRes, formatSandboxPassNote(gate.verification, gate.autoVerified));
			}
		}

		const res = await onNode(toolCallId, params, ...rest);
		if (params.action === "save") {
			return appendTextNote(
				res,
				`[Verification required] If you have not yet verified this exact rule in a temporary sandbox, call \`${TEST_AUTOMATION_IN_SANDBOX_TOOL_NAME}\` with realistic sample fixtures now. If it fails or does not produce the intended result, fix and re-save the rule, then re-test until it passes.`,
			);
		}
		return res;
	};
}
