/**
 * The Finder's data port.
 *
 * One narrow interface with two adapters: the real Electron fs bridge
 * (`window.autorag.fs`) and an in-memory fixture source used whenever that
 * bridge is absent — vitest, a plain browser, or a renderer opened before the
 * preload lands. Components never touch `window` directly.
 */

import { RECENTS_PATH, type FsBridge, type FsClipboard, type FsVersionFamiliesResult } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import {
	DUPEY_LAYER_ID,
	type LayerPublication,
	type LiveBridge,
	type LiveMessage,
	type LiveResync,
} from "../../../shared/live-contract";
import { copyName } from "../state/collision";
import { basename, dirname, joinPath } from "../state/paths";
import {
	EMPTY_VERSION_FAMILIES_RESULT,
	type VersionFamiliesResult,
	type VersionRelation,
} from "../state/version-family";
import { type FinderEntry, entryFromFixture, entryFromFs, entryFromSearchHit } from "./entries";
import { FIXTURE_FAMILIES, FIXTURE_INITIAL_PATH, FIXTURE_ROOTS, FIXTURE_TREE } from "./fixtures";
import type { FixtureItem } from "./entries";

export interface FinderLocation {
	readonly name: string;
	readonly path: string;
	readonly section: "favorites" | "cloud";
	readonly available: boolean;
}

export interface SearchHits {
	readonly entries: readonly FinderEntry[];
}

export interface FinderSource {
	/** True when the native OS surfaces (Reveal, Open) are real. */
	readonly native: boolean;
	readonly initialPath: string;
	setWatchSet(dirs: readonly string[]): Promise<void>;
	onLive(listener: (message: LiveMessage) => void): () => void;
	liveLayers(): Promise<LiveResync>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<readonly FinderEntry[]>;
	/**
	 * Incremental refresh after a live change: resolve only the given direct
	 * children of `dir`, mapping the ones that exist as rows and naming the
	 * rest as removed. On an ordinary event the renderer asks `readEntries`
	 * for exactly the changed paths instead of relisting the whole directory.
	 */
	readEntries(
		dir: string,
		paths: readonly string[],
	): Promise<{ readonly entries: readonly FinderEntry[]; readonly removed: readonly string[] }>;
	search(query: string): Promise<readonly FinderEntry[]>;
	locations(): Promise<readonly FinderLocation[]>;
	quickLook(path: string): Promise<void>;
	/** Open the file with the OS default application (double-click behavior). */
	open(path: string): Promise<void>;
	reveal(path: string): Promise<void>;
	trash(paths: readonly string[]): Promise<void>;
	rename(path: string, name: string): Promise<void>;
	duplicate(paths: readonly string[]): Promise<void>;
	copyInto(paths: readonly string[], destDir: string): Promise<void>;
	moveInto(paths: readonly string[], destDir: string): Promise<void>;
	copyPaths(paths: readonly string[]): Promise<void>;
	clipboardSet(clipboard: FsClipboard): Promise<void>;
	clipboardGet(): Promise<FsClipboard | null>;
	/** Version families from the persisted snapshot (SSOT); never triggers a scan. */
	versionFamilies(): Promise<VersionFamiliesResult>;
	/** Forces a dupey scan now and returns the fresh snapshot. */
	refreshVersionFamilies(): Promise<VersionFamiliesResult>;
	/** Real AutoRAG local-index state and config-backed exclusion toggle. */
	indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
	setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
	/** Fires when the background refresh a toggle started has settled. */
	onIndexRefreshed(listener: (error: string | null) => void): () => void;
}

export async function isMissingPathFailure(
	source: Pick<FinderSource, "exists">,
	path: string,
): Promise<boolean> {
	return !(await source.exists(path));
}

/* -------------------------------------------------------------- real bridge */

export function createBridgeSource(fs: FsBridge, initialPath: string, live?: LiveBridge): FinderSource {
	const mapVersionFamiliesResult = (result: FsVersionFamiliesResult): VersionFamiliesResult => ({
		families: result.families.map((family) => ({
			head: family.head,
			members: family.members,
			entriesByPath: Object.fromEntries(
				family.entries.map((entry) => [entry.path, entryFromFs(entry)]),
			),
		})),
		scannedAt: result.scannedAt,
		error: result.error,
	});
	const mapLayerPublication = (publication: LayerPublication): LayerPublication => ({
		...publication,
		data: publication.layer === DUPEY_LAYER_ID
			? mapVersionFamiliesResult(publication.data as FsVersionFamiliesResult)
			: publication.data,
	});
	return {
		native: true,
		initialPath,
		setWatchSet: (dirs) => live?.setWatchSet(dirs) ?? Promise.resolve(),
		onLive: (listener) => {
			return live?.onMessage((message) => listener({
				...message,
				layers: message.layers.map(mapLayerPublication),
			})) ?? (() => {});
		},
		async liveLayers() {
			if (live === undefined) {
				return { seq: 0, layers: [], reconciled: [] };
			}
			const result = await live.layers();
			return { ...result, layers: result.layers.map(mapLayerPublication) };
		},
		exists: (path) => fs.exists(path),
		async list(path) {
			const listing = await fs.listDir(path);
			// Recents is virtual: a row's location is the real folder that holds the file.
			return listing.entries.map((entry) => entryFromFs(entry, path === RECENTS_PATH ? undefined : path));
		},
		async readEntries(dir, paths) {
			const patch = await fs.readEntries(dir, paths);
			// Rows belong to the requested dir, not the child's own parent lookup.
			return { entries: patch.entries.map((entry) => entryFromFs(entry, dir)), removed: patch.removed };
		},
		async search(query) {
			const hits = await fs.search(query);
			return hits.map(entryFromSearchHit);
		},
		async locations() {
			const locations = await fs.locations();
			return locations.map((location) => ({
				name: location.name,
				path: location.path,
				section: location.section,
				available: location.available,
			}));
		},
		quickLook: (path) => fs.quickLook(path),
		open: (path) => fs.open(path),
		reveal: (path) => fs.reveal(path),
		trash: async (paths) => {
			await fs.trash(paths);
		},
		rename: async (path, name) => {
			await fs.rename(path, name);
		},
		duplicate: async (paths) => {
			await fs.duplicate(paths);
		},
		copyInto: async (paths, destDir) => {
			await fs.copy(paths, destDir);
		},
		moveInto: async (paths, destDir) => {
			await fs.move(paths, destDir);
		},
		copyPaths: (paths) => fs.copyPathsToClipboard(paths),
		clipboardSet: (clipboard) => fs.clipboardSet(clipboard),
		clipboardGet: () => fs.clipboardGet(),
		versionFamilies: async () => {
			return mapVersionFamiliesResult(await fs.versionFamilies());
		},
		async refreshVersionFamilies() {
			return mapVersionFamiliesResult(await fs.refreshVersionFamilies());
		},
		indexStatus: (paths) => fs.indexStatus(paths),
		setIndexExcluded: (path, excluded) => fs.setIndexExcluded(path, excluded),
		onIndexRefreshed: (listener) => fs.onIndexRefreshed?.(listener) ?? (() => {}),
	};
}

/* ----------------------------------------------------------- fixture source */

interface FixtureState {
	tree: Map<string, FixtureItem[]>;
	clipboard: FsClipboard | null;
	/** Paths the fixture treats as excluded from indexing. */
	indexExcluded: Set<string>;
}

function seedFixtureState(): FixtureState {
	const tree = new Map<string, FixtureItem[]>();
	for (const [path, items] of Object.entries(FIXTURE_TREE)) {
		tree.set(path, [...items]);
	}
	return { tree, clipboard: null, indexExcluded: new Set() };
}

function takenNames(state: FixtureState, dir: string): string[] {
	return (state.tree.get(dir) ?? []).map((item) => item.name);
}

function removeItem(state: FixtureState, path: string): FixtureItem | null {
	const dir = dirname(path);
	const name = basename(path);
	const items = state.tree.get(dir);
	if (items === undefined) {
		return null;
	}
	const index = items.findIndex((item) => item.name === name);
	if (index < 0) {
		return null;
	}
	const [removed] = items.splice(index, 1);
	return removed ?? null;
}

function insertItem(state: FixtureState, dir: string, item: FixtureItem): void {
	const items = state.tree.get(dir);
	if (items === undefined) {
		state.tree.set(dir, [item]);
		return;
	}
	items.push(item);
}

function findItem(state: FixtureState, path: string): FixtureItem | null {
	const items = state.tree.get(dirname(path)) ?? [];
	return items.find((item) => item.name === basename(path)) ?? null;
}

export function createFixtureSource(): FinderSource {
	const state = seedFixtureState();
	const resolve = (): Promise<void> => Promise.resolve();
	const fixtureIndexStatus = (path: string): IndexStatus =>
		state.indexExcluded.has(path)
			? { path, kind: "excluded", excluded: true, toggleable: true, detail: "인덱싱에서 제외됨" }
			: { path, kind: "included", excluded: false, toggleable: true, detail: "MinSync 인덱스에 포함됨" };

	return {
		native: false,
		initialPath: FIXTURE_INITIAL_PATH,
		setWatchSet: resolve,
		onLive: () => () => {},
		liveLayers: () => Promise.resolve({ seq: 0, layers: [], reconciled: [] }),
		exists: (path) => Promise.resolve(state.tree.has(path) || findItem(state, path) !== null),
		list: (path) =>
			Promise.resolve((state.tree.get(path) ?? []).map((item) => entryFromFixture(item, path))),
		readEntries: async (dir, paths) => {
			const entries: FinderEntry[] = [];
			const removed: string[] = [];
			for (const path of new Set(paths)) {
				if (dirname(path) !== dir) {
					throw new Error(`Invalid path "${path}": expected a direct child of "${dir}"`);
				}
				const item = findItem(state, path);
				if (item === null) {
					removed.push(path);
				} else {
					entries.push(entryFromFixture(item, dir));
				}
			}
			return { entries, removed };
		},
		search: (query) => {
			const needle = query.trim().toLowerCase();
			if (needle === "") {
				return Promise.resolve([]);
			}
			const hits: FinderEntry[] = [];
			for (const [path, items] of state.tree) {
				if (path === RECENTS_PATH) {
					continue;
				}
				for (const item of items) {
					if (item.name.toLowerCase().includes(needle)) {
						hits.push(entryFromFixture(item, path));
					}
				}
			}
			return Promise.resolve(hits);
		},
		locations: () =>
			Promise.resolve(
				FIXTURE_ROOTS.map((name) => ({
					name,
					path: name,
					section: name === RECENTS_PATH || name === "Desktop" || name === "Downloads" || name === "Documents"
						? ("favorites" as const)
						: ("cloud" as const),
					available: state.tree.has(name),
				})),
			),
		quickLook: resolve,
		open: resolve,
		reveal: resolve,
		trash: (paths) => {
			for (const path of paths) {
				removeItem(state, path);
			}
			return resolve();
		},
		rename: (path, name) => {
			const item = findItem(state, path);
			if (item !== null) {
				removeItem(state, path);
				insertItem(state, dirname(path), { ...item, name });
			}
			return resolve();
		},
		duplicate: (paths) => {
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null) {
					continue;
				}
				const dir = dirname(path);
				insertItem(state, dir, { ...item, name: copyName(item.name, [...takenNames(state, dir), item.name]) });
			}
			return resolve();
		},
		copyInto: (paths, destDir) => {
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null) {
					continue;
				}
				insertItem(state, destDir, { ...item, name: copyName(item.name, takenNames(state, destDir)) });
			}
			return resolve();
		},
		moveInto: (paths, destDir) => {
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null || dirname(path) === destDir) {
					continue;
				}
				removeItem(state, path);
				insertItem(state, destDir, { ...item, name: copyName(item.name, takenNames(state, destDir)) });
			}
			return resolve();
		},
		copyPaths: resolve,
		clipboardSet: (clipboard) => {
			state.clipboard = clipboard;
			return resolve();
		},
		clipboardGet: () => Promise.resolve(state.clipboard),
		versionFamilies: () =>
			Promise.resolve({
				scannedAt: null,
				families: FIXTURE_FAMILIES.flatMap((family) => {
					const headItem = findItem(state, family.head);
					if (headItem === null) {
						return [];
					}
					const entriesByPath: Record<string, FinderEntry> = {
						[family.head]: entryFromFixture(headItem, dirname(family.head)),
					};
					const members = family.members.flatMap(([where, name, relation]) => {
						const item = (state.tree.get(where) ?? []).find((candidate) => candidate.name === name);
						if (item === undefined) {
							return [];
						}
						const path = joinPath(where, name);
						entriesByPath[path] = entryFromFixture(item, where);
						return [{ path, relation: relation as VersionRelation }];
					});
					return [{ head: family.head, members, entriesByPath }];
				}),
				error: null,
			}),
		refreshVersionFamilies: () => Promise.resolve(EMPTY_VERSION_FAMILIES_RESULT),
		indexStatus: (paths) => Promise.resolve(paths.map(fixtureIndexStatus)),
		setIndexExcluded: (path, excluded) => {
			if (excluded) state.indexExcluded.add(path);
			else state.indexExcluded.delete(path);
			return Promise.resolve(fixtureIndexStatus(path));
		},
		onIndexRefreshed: () => () => {},
	};
}

/* ------------------------------------------------------------- port picking */

/** Favorites order used to choose the tab the real app opens on. */
const PREFERRED_START = ["QA", "Documents", "Desktop", "Downloads"];

export function pickInitialPath(locations: readonly FinderLocation[]): string | null {
	for (const name of PREFERRED_START) {
		const match = locations.find((location) => location.name === name && location.available);
		if (match !== undefined) {
			return match.path;
		}
	}
	return locations.find((location) => location.available)?.path ?? null;
}
