import { access, opendir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { minSyncDocumentPath, type ParsedMirrorEntry, type ParsedMirrorIndex } from "@autorag/librarian";
import {
	dominantIndexMapState,
	emptyIndexMapCounts,
	INDEX_MAP_STATES,
	type IndexMap,
	type IndexMapCounts,
	type IndexMapNode,
	type IndexMapState,
} from "../shared/index-map-contract";

type ParsedMirrorSkipEntry = NonNullable<ParsedMirrorIndex["skipped"]>[string];

/**
 * Builds the index map (`src/shared/index-map-contract.ts`): walks the search
 * roots the way a refresh walks them (librarian `mirror/sync.ts`
 * `collectFiles`: no symlinks, its skip-directory names, its depth limit),
 * classifies every file against the parsed mirror and the MinSync staging
 * tree, and folds the result into a graph small enough to draw.
 */

/** What the walk needs to know about the index; `index-status.ts` loads it from the shared config. */
export interface IndexScopeContext {
	/** Canonical search roots. */
	readonly roots: readonly string[];
	/** Canonical `excludePaths`, the code-folder rule's included. */
	readonly exclusions: readonly string[];
	readonly entries: ReadonlyMap<string, ParsedMirrorEntry>;
	readonly skips: ReadonlyMap<string, ParsedMirrorSkipEntry>;
	readonly minSyncRoot: string;
	/** True when a parser reads this file and it is not product output. */
	readonly indexable: (path: string, name: string) => boolean;
}

export interface ScanFile {
	readonly name: string;
	readonly path: string;
	readonly state: IndexMapState;
}

export interface ScanDir {
	readonly name: string;
	readonly path: string;
	readonly files: ScanFile[];
	readonly dirs: ScanDir[];
	/**
	 * Set for a folder the walk does not enter (excluded, or a name no refresh walks): its entry count as excluded,
	 * and the files the index still holds under it as stale.
	 */
	sealed: IndexMapCounts | null;
}

export interface ScanResult {
	readonly roots: ScanDir[];
	readonly truncated: boolean;
}

/** Folder names the librarian's walk never enters (`SKIP_DIR_NAMES` in `mirror/sync.ts`). */
const SKIP_DIR_NAMES = new Set([".autorag", ".git", ".jikji", ".cache", ".venv", "__pycache__", "node_modules", "dist", "build", "target", ".Trash"]);
/** Entries the map walk examines across all roots before it stops and reports `truncated`. */
export const INDEX_MAP_MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
/** Files classified at once; each may stat and probe the staging tree. */
const CLASSIFY_BATCH = 128;
/** Nodes the renderer draws comfortably (force layout + territory raster at 60 fps). */
export const INDEX_MAP_NODE_BUDGET = 2400;

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export async function scanIndexScope(context: IndexScopeContext, maxEntries = INDEX_MAP_MAX_ENTRIES): Promise<ScanResult> {
	let visited = 0;
	let truncated = false;
	const excludedBy = (path: string): boolean => context.exclusions.some((exclusion) => isUnder(path, exclusion));

	async function classify(path: string, name: string): Promise<IndexMapState> {
		const entry = context.entries.get(path);
		// An excluded file the index still holds leaves at the next refresh: until then it needs one.
		if (excludedBy(path)) return entry === undefined ? "excluded" : "stale";
		if (!context.indexable(path, name)) return "unindexable";
		if (entry !== undefined) {
			const staged = await access(minSyncDocumentPath(context.minSyncRoot, entry.virtualPath)).then(() => true, () => false);
			if (!staged) return "stale";
			const info = await stat(path, { bigint: true }).catch(() => null);
			// The mirror records `Number(stat.mtimeNs)` and the size; either moving means the next refresh re-reads the file.
			if (info !== null && (Number(info.mtimeNs) !== entry.sourceMtimeNs || Number(info.size) !== entry.sourceSizeBytes)) return "stale";
			return "indexed";
		}
		const skip = context.skips.get(path);
		if (skip !== undefined && skip.reason !== "user-excluded") return "unindexable";
		return "unindexed";
	}

	async function seal(dir: ScanDir): Promise<void> {
		const counts = emptyIndexMapCounts();
		try {
			const handle = await opendir(dir.path);
			for await (const _entry of handle) counts.excluded += 1;
		} catch {
			// Unreadable: the folder still shows, as one excluded plot.
		}
		counts.excluded = Math.max(1, counts.excluded);
		for (const source of context.entries.keys()) if (isUnder(source, dir.path)) counts.stale += 1;
		dir.sealed = counts;
	}

	async function walk(dir: ScanDir, depth: number): Promise<void> {
		let handle;
		try {
			handle = await opendir(dir.path);
		} catch {
			return;
		}
		const pending: { name: string; path: string }[] = [];
		const children: ScanDir[] = [];
		try {
			for await (const entry of handle) {
				if (visited >= maxEntries) {
					truncated = true;
					break;
				}
				visited += 1;
				const path = resolve(dir.path, entry.name);
				if (entry.isDirectory()) {
					if (depth + 1 > MAX_DEPTH) continue;
					children.push({ name: entry.name, path, files: [], dirs: [], sealed: null });
				} else if (entry.isFile()) {
					pending.push({ name: entry.name, path });
				}
			}
		} catch {
			// A directory that failed mid-listing keeps what was read.
		}
		for (let start = 0; start < pending.length; start += CLASSIFY_BATCH) {
			const batch = pending.slice(start, start + CLASSIFY_BATCH);
			const states = await Promise.all(batch.map((file) => classify(file.path, file.name)));
			batch.forEach((file, index) => dir.files.push({ name: file.name, path: file.path, state: states[index] ?? "unindexed" }));
		}
		dir.files.sort((a, b) => a.name.localeCompare(b.name));
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			dir.dirs.push(child);
			if (SKIP_DIR_NAMES.has(child.name) || excludedBy(child.path)) await seal(child);
			else if (!truncated) await walk(child, depth + 1);
		}
	}

	const roots: ScanDir[] = [];
	for (const root of context.roots) {
		const dir: ScanDir = { name: root, path: root, files: [], dirs: [], sealed: null };
		roots.push(dir);
		if (excludedBy(root)) await seal(dir);
		else await walk(dir, 0);
	}
	return { roots, truncated };
}

/** How much a graph is folded: files past `fileCap` in one folder, and folders below `depthCap`, become parcels. */
interface Detail {
	readonly fileCap: number;
	readonly depthCap: number;
}

function addCounts(into: Record<IndexMapState, number>, from: IndexMapCounts): void {
	for (const state of INDEX_MAP_STATES) into[state] += from[state];
}

function totalOf(counts: IndexMapCounts): number {
	let total = 0;
	for (const state of INDEX_MAP_STATES) total += counts[state];
	return total;
}

function parcelCount(counts: IndexMapCounts): number {
	return INDEX_MAP_STATES.filter((state) => counts[state] > 0).length;
}

/** Per-state counts of a folder's own files and of its whole subtree, memoized per folder. */
function measure(roots: readonly ScanDir[]): { files: Map<ScanDir, IndexMapCounts>; subtree: Map<ScanDir, IndexMapCounts>; maxDepth: number } {
	const files = new Map<ScanDir, IndexMapCounts>();
	const subtree = new Map<ScanDir, IndexMapCounts>();
	let maxDepth = 0;
	const visit = (dir: ScanDir, depth: number): IndexMapCounts => {
		maxDepth = Math.max(maxDepth, depth);
		const own = emptyIndexMapCounts();
		for (const file of dir.files) own[file.state] += 1;
		if (dir.sealed !== null) addCounts(own, dir.sealed);
		files.set(dir, own);
		const all = { ...own };
		for (const child of dir.dirs) addCounts(all, visit(child, depth + 1));
		subtree.set(dir, all);
		return all;
	};
	for (const root of roots) visit(root, 0);
	return { files, subtree, maxDepth };
}

/**
 * The graph of a scan inside `budget` nodes: the most detailed of a fixed ladder of fold levels that fits. Nodes come
 * parent-first (a node's parent always has a smaller id).
 */
export function buildIndexMap(scan: ScanResult, budget = INDEX_MAP_NODE_BUDGET): IndexMap {
	const { files, subtree, maxDepth } = measure(scan.roots);
	const size = (dir: ScanDir, depth: number, detail: Detail): number => {
		if (dir.sealed !== null) return 1;
		if (depth >= detail.depthCap) return 1 + parcelCount(subtree.get(dir) ?? emptyIndexMapCounts());
		let total = 1 + (dir.files.length <= detail.fileCap ? dir.files.length : parcelCount(files.get(dir) ?? emptyIndexMapCounts()));
		for (const child of dir.dirs) {
			total += size(child, depth + 1, detail);
			if (total > budget) return total;
		}
		return total;
	};
	const ladder: Detail[] = [
		...[Number.POSITIVE_INFINITY, 64, 24, 8, 0].map((fileCap) => ({ fileCap, depthCap: Number.POSITIVE_INFINITY })),
		...Array.from({ length: maxDepth }, (_, index) => ({ fileCap: 0, depthCap: maxDepth - 1 - index })),
	];
	const fits = (detail: Detail): boolean => {
		let total = 0;
		for (const root of scan.roots) {
			total += size(root, 0, detail);
			if (total > budget) return false;
		}
		return true;
	};
	const detail = ladder.find(fits) ?? { fileCap: 0, depthCap: 0 };

	const nodes: IndexMapNode[] = [];
	let folded = false;
	const push = (node: Omit<IndexMapNode, "id">): number => {
		const id = nodes.length;
		nodes.push({ id, ...node });
		return id;
	};
	const parcels = (parent: number, path: string, depth: number, counts: IndexMapCounts): void => {
		for (const state of INDEX_MAP_STATES) {
			const count = counts[state];
			if (count === 0) continue;
			folded = true;
			const one = emptyIndexMapCounts();
			one[state] = count;
			push({ parent, kind: "parcel", name: "", path, state, weight: count, counts: one, depth });
		}
	};
	const emit = (dir: ScanDir, parent: number | null, depth: number): void => {
		const counts = subtree.get(dir) ?? emptyIndexMapCounts();
		const id = push({
			parent,
			kind: parent === null ? "root" : "folder",
			name: dir.name,
			path: dir.path,
			state: dir.sealed !== null && dir.sealed.stale === 0 ? "excluded" : dominantIndexMapState(counts),
			weight: totalOf(counts),
			counts,
			depth,
		});
		if (dir.sealed !== null) return;
		if (depth >= detail.depthCap) {
			parcels(id, dir.path, depth + 1, counts);
			return;
		}
		if (dir.files.length <= detail.fileCap) {
			for (const file of dir.files) {
				const one = emptyIndexMapCounts();
				one[file.state] = 1;
				push({ parent: id, kind: "file", name: file.name, path: file.path, state: file.state, weight: 1, counts: one, depth: depth + 1 });
			}
		} else {
			parcels(id, dir.path, depth + 1, files.get(dir) ?? emptyIndexMapCounts());
		}
		for (const child of dir.dirs) emit(child, id, depth + 1);
	};
	for (const root of scan.roots) emit(root, null, 0);

	const totals = emptyIndexMapCounts();
	for (const root of scan.roots) addCounts(totals, subtree.get(root) ?? emptyIndexMapCounts());
	return { roots: scan.roots.map((root) => root.path), nodes, totals, truncated: scan.truncated, folded };
}
