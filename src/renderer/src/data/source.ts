/**
 * The Finder's data port.
 *
 * One narrow interface with two adapters: the real Electron fs bridge
 * (`window.autorag.fs`) and an in-memory fixture source used whenever that
 * bridge is absent — vitest, a plain browser, or a renderer opened before the
 * preload lands. Components never touch `window` directly.
 */

import { NO_CAPABILITIES, type ActionsBridge } from "../../../shared/actions-contract";
import { RECENTS_PATH, type FsBridge, type FsClipboard, type FsEnrichmentTarget, type FsLocation, type FsLocationIcon, type FsOpError, type FsUndoOutcome, type FsVersionFamiliesResult } from "../../../shared/fs-contract";
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
import { type FinderEntry, applyEntryEnrichment, entryFromFixture, entryFromFs, entryFromSearchHit } from "./entries";
import { FIXTURE_FAMILIES, FIXTURE_INITIAL_PATH, FIXTURE_TREE } from "./fixtures";
import type { FixtureItem } from "./entries";

/** A sidebar location; the shared contract shape, unchanged across the boundary. */
export type FinderLocation = FsLocation;

export interface SearchHits {
	readonly entries: readonly FinderEntry[];
}

/**
 * The action port when the real bridge is absent: nothing is capable and every
 * call refuses, so the UI can render but never pretends work happened.
 */
const UNAVAILABLE_ACTIONS: ActionsBridge = {
	capabilities: () => Promise.resolve(NO_CAPABILITIES),
	run: () => Promise.reject(new Error("이 환경에서는 파일 작업을 실행할 수 없습니다")),
	share: () => Promise.reject(new Error("이 환경에서는 공유를 실행할 수 없습니다")),
};

export interface FinderSource {
	/** True when the native OS surfaces (Reveal, Open) are real. */
	readonly native: boolean;
	readonly initialPath: string;
	/** Inspection actions (open with, archive, share, simple edits). */
	readonly actions: ActionsBridge;
	setWatchSet(dirs: readonly string[]): Promise<void>;
	onLive(listener: (message: LiveMessage) => void): () => void;
	liveLayers(): Promise<LiveResync>;
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<readonly FinderEntry[]>;
	/** Fill OS kind and icon URLs after the basic listing is visible. */
	enrich(path: string, entries: readonly FinderEntry[]): Promise<readonly FinderEntry[]>;
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
	/** Unmount a mounted volume (sidebar eject button); rejects with the OS reason. */
	ejectLocation(path: string): Promise<void>;
	/** Fires when a volume mounts/unmounts or a cloud account connects/disconnects. */
	onLocationsChanged(listener: () => void): () => void;
	quickLook(path: string): Promise<void>;
	/** Open the file with the OS default application (double-click behavior). */
	open(path: string): Promise<void>;
	/** Open an http(s) page (a web evidence source) in the OS default browser. */
	openUrl(url: string): Promise<void>;
	reveal(path: string): Promise<void>;
	trash(paths: readonly string[]): Promise<void>;
	rename(path: string, name: string): Promise<void>;
	/** Create a new folder (Finder-style "untitled folder" / "untitled folder 2"). */
	createFolder(dir: string): Promise<{ readonly path: string; readonly name: string }>;
	duplicate(paths: readonly string[]): Promise<void>;
	copyInto(paths: readonly string[], destDir: string): Promise<void>;
	moveInto(paths: readonly string[], destDir: string): Promise<void>;
	/** Undo the most recent recorded copy/move transfer (⌘Z); the record is consumed. */
	undo(): Promise<FsUndoOutcome>;
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

export function createBridgeSource(
	fs: FsBridge,
	initialPath: string,
	live?: LiveBridge,
	actions: ActionsBridge = UNAVAILABLE_ACTIONS,
): FinderSource {
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
		actions,
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
		async enrich(_path, entries) {
			const targets: FsEnrichmentTarget[] = entries
				.filter((entry) => entry.modifiedAt !== undefined)
				.map((entry) => ({
					path: entry.path,
					kind: entry.kind,
					ext: entry.kind === "folder" ? "" : entry.name.includes(".") ? entry.name.split(".").pop()?.toLowerCase() ?? "" : "",
					modifiedAt: entry.modifiedAt ?? "",
					...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
				}));
			const results = await fs.enrichEntries(targets, true);
			return applyEntryEnrichment(entries, results);
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
		locations: () => fs.locations(),
		ejectLocation: (path) => fs.ejectLocation(path),
		onLocationsChanged: (listener) => fs.onLocationsChanged?.(listener) ?? (() => {}),
		quickLook: (path) => fs.quickLook(path),
		open: (path) => fs.open(path),
		openUrl: (url) => fs.openUrl(url),
		reveal: (path) => fs.reveal(path),
		trash: async (paths) => {
			await fs.trash(paths);
		},
		rename: async (path, name) => {
			await fs.rename(path, name);
		},
		createFolder: (dir) => fs.createFolder(dir),
		duplicate: async (paths) => {
			await fs.duplicate(paths);
		},
		copyInto: async (paths, destDir) => {
			await fs.copy(paths, destDir);
		},
		moveInto: async (paths, destDir) => {
			await fs.move(paths, destDir);
		},
		undo: () => fs.undo(),
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
	/** Fixture volumes the sidebar eject button removed. */
	ejected: Set<string>;
}

/** Fixture sidebar rows: the FIXTURE_TREE roots plus two volumes to eject. */
const FIXTURE_PLACES: readonly (readonly [string, FsLocation["section"], FsLocationIcon])[] = [
	[RECENTS_PATH, "favorites", "recents"],
	["Desktop", "favorites", "desktop"],
	["Documents", "favorites", "documents"],
	["Downloads", "favorites", "downloads"],
	["iCloud Drive", "cloud", "icloud"],
	["Google Drive", "cloud", "google-drive"],
	["Dropbox", "cloud", "dropbox"],
	["Macintosh HD", "locations", "disk"],
	["Backup", "locations", "disk"],
];

function seedFixtureState(): FixtureState {
	const tree = new Map<string, FixtureItem[]>();
	for (const [path, items] of Object.entries(FIXTURE_TREE)) {
		tree.set(path, [...items]);
	}
	return { tree, clipboard: null, indexExcluded: new Set(), ejected: new Set() };
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

	/** One fixture undo step: the row the transfer created or moved, and its origin. */
	interface FixtureUndoStep {
		readonly kind: "copy" | "move";
		readonly path: string;
		readonly from: string;
	}
	let lastUndo: readonly FixtureUndoStep[] | null = null;
	const fixtureIndexStatus = (path: string): IndexStatus =>
		state.indexExcluded.has(path)
			? { path, kind: "excluded", excluded: true, toggleable: true, detail: "인덱싱에서 제외됨" }
			: { path, kind: "included", excluded: false, toggleable: true, detail: "MinSync 인덱스에 포함됨" };

	return {
		native: false,
		initialPath: FIXTURE_INITIAL_PATH,
		actions: UNAVAILABLE_ACTIONS,
		setWatchSet: resolve,
		onLive: () => () => {},
		liveLayers: () => Promise.resolve({ seq: 0, layers: [], reconciled: [] }),
		enrich: async (_path, entries) => entries,
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
				FIXTURE_PLACES.filter(([name]) => !state.ejected.has(name)).map(([name, section, icon]) => ({
					name,
					path: name,
					section,
					icon,
					available: section === "locations" || state.tree.has(name),
					scanned: false,
					ejectable: section === "locations" && name !== "Macintosh HD",
				})),
			),
		ejectLocation: (path) => {
			state.ejected.add(path);
			return Promise.resolve();
		},
		onLocationsChanged: () => () => {},
		quickLook: resolve,
		open: resolve,
		openUrl: resolve,
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
		createFolder: (dir) => {
			const taken = takenNames(state, dir);
			let name = "untitled folder";
			for (let attempt = 2; taken.includes(name); attempt += 1) {
				name = `untitled folder ${attempt}`;
			}
			// Match the seed rows' "Sep 22, 11:40" shape with the current time.
			const now = new Date();
			const month = now.toLocaleString("en-US", { month: "short" });
			const dateLabel = `${month} ${now.getDate()}, ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
			insertItem(state, dir, { name, fileKind: "folder", dateLabel, sizeLabel: "—" });
			return Promise.resolve({ path: joinPath(dir, name), name });
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
			const steps: FixtureUndoStep[] = [];
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null) {
					continue;
				}
				const name = copyName(item.name, takenNames(state, destDir));
				insertItem(state, destDir, { ...item, name });
				steps.push({ kind: "copy", path: joinPath(destDir, name), from: path });
			}
			if (steps.length > 0) lastUndo = steps;
			return resolve();
		},
		moveInto: (paths, destDir) => {
			const steps: FixtureUndoStep[] = [];
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null || dirname(path) === destDir) {
					continue;
				}
				const name = copyName(item.name, takenNames(state, destDir));
				removeItem(state, path);
				insertItem(state, destDir, { ...item, name });
				steps.push({ kind: "move", path: joinPath(destDir, name), from: path });
			}
			if (steps.length > 0) lastUndo = steps;
			return resolve();
		},
		undo: async () => {
			const steps = lastUndo;
			lastUndo = null;
			if (steps === null || steps.length === 0) {
				return { ok: false, empty: true, failed: [] };
			}
			const failed: FsOpError[] = [];
			for (const step of steps) {
				const item = findItem(state, step.path);
				if (item === null) {
					failed.push({ path: step.path, message: "되돌릴 항목이 없습니다" });
					continue;
				}
				if (step.kind === "copy") {
					removeItem(state, step.path);
					continue;
				}
				const restoreDir = dirname(step.from);
				const name = copyName(item.name, takenNames(state, restoreDir));
				removeItem(state, step.path);
				insertItem(state, restoreDir, { ...item, name });
			}
			return { ok: failed.length === 0, empty: false, failed };
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
