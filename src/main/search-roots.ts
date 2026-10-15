import { opendir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { loadMirrorIndex } from "@autorag/librarian";

/**
 * A refresh deletes the parsed mirror (and, through MinSync, the vectors) of
 * every document that is no longer found under a search root. For a root that
 * still exists but cannot be listed, or reads as empty although it was full
 * (an unplugged drive whose mount point remains, a signed-out cloud folder, a
 * share that dropped, a revoked permission), "no longer found" means "not
 * reachable right now", and the deletion is hours of re-parsing and
 * re-embedding once the root returns. The librarian cannot tell the two apart
 * (see Marker-Inc-Korea/AutoRAG#1889), so the app checks before it refreshes.
 */

/** An empty root counts as unavailable only if at least this many documents were indexed from it. */
export const EMPTY_ROOT_MIN_INDEXED = 20;
/** A listing that takes longer than this is a hung mount, not a slow disk. */
export const ROOT_PROBE_TIMEOUT_MS = 10_000;

export interface RootProblem {
	readonly root: string;
	readonly reason: "unreadable" | "empty";
	/** Documents the previous refresh indexed from this root. */
	readonly indexed: number;
}

export type RootProbe = "entries" | "empty" | "unreadable";

export interface RootCheckDeps {
	readonly probe?: (root: string) => Promise<RootProbe>;
	/** Test seam: resolves a root's canonical path; production uses fs realpath. */
	readonly realpath?: (path: string) => Promise<string>;
	readonly timeoutMs?: number;
}

async function listRoot(root: string): Promise<RootProbe> {
	try {
		const directory = await opendir(root);
		try {
			return (await directory.read()) === null ? "empty" : "entries";
		} finally {
			await directory.close().catch(() => undefined);
		}
	} catch {
		return "unreadable";
	}
}

/** `work` gets the same bound as a root listing: a hung mount answers neither, and waiting on it would hang the refresh. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	const { promise: timeout, resolve } = Promise.withResolvers<T>();
	const timer = setTimeout(() => resolve(fallback), timeoutMs);
	timer.unref();
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function indexedEntries(workspacePath: string): readonly string[] {
	try {
		return Object.values(loadMirrorIndex(workspacePath).entries).map((entry) => entry.sourcePath);
	} catch {
		return [];
	}
}

/**
 * The search roots a refresh must not run against. A root with nothing indexed
 * from it is never a problem: there is nothing a refresh could delete.
 */
export async function findUnavailableRoots(searchPaths: readonly string[], workspacePath: string, deps: RootCheckDeps = {}): Promise<readonly RootProblem[]> {
	const probe = deps.probe ?? listRoot;
	const canonical = deps.realpath ?? realpath;
	const timeoutMs = deps.timeoutMs ?? ROOT_PROBE_TIMEOUT_MS;
	const sources = indexedEntries(workspacePath);
	const problems: RootProblem[] = [];
	for (const root of searchPaths) {
		const outcome = await withTimeout(probe(root), timeoutMs, "unreadable");
		if (outcome === "entries") continue;
		const resolved = resolve(root);
		const prefixes = new Set([resolved, await withTimeout(canonical(resolved).catch(() => resolved), timeoutMs, resolved)]);
		const indexed = sources.filter((source) => [...prefixes].some((prefix) => source === prefix || source.startsWith(`${prefix}${sep}`))).length;
		if (outcome === "unreadable" && indexed > 0) problems.push({ root, reason: "unreadable", indexed });
		if (outcome === "empty" && indexed >= EMPTY_ROOT_MIN_INDEXED) problems.push({ root, reason: "empty", indexed });
	}
	return problems;
}
