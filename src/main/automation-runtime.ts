import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { t } from "../shared/i18n/core";
import { pathKey } from "./bundled-tools";

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

interface PatchableTool {
	readonly name: string;
	execute: (toolCallId: string, params: { readonly action: string }, ...rest: unknown[]) => Promise<unknown>;
}

/**
 * Put the agent's `manage_automations` tool on Node. The tool object is shared by the agent's tool
 * list and every session it opens, so changing it once covers them all. Throws when the agent has no
 * such tool, so a librarian that changes where it keeps its tools fails loudly instead of quietly
 * leaving the tool on the app's own binary.
 */
export function runAutomationToolOnNode(agent: object, findNode: () => string | undefined): void {
	const tools = (agent as { readonly tools?: readonly PatchableTool[] }).tools;
	const tool = Array.isArray(tools) ? tools.find((candidate) => candidate.name === "manage_automations") : undefined;
	if (tool === undefined) throw new Error("The librarian agent has no manage_automations tool to run on Node.");
	tool.execute = runOnNode(tool.execute.bind(tool), findNode);
}
