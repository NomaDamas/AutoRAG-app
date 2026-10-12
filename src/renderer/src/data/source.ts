/**
 * The Finder's data port.
 *
 * One narrow interface with two adapters: the real Electron fs bridge
 * (`window.autorag.fs`) and an in-memory fixture source used whenever that
 * bridge is absent — vitest, a plain browser, or a renderer opened before the
 * preload lands. Components never touch `window` directly.
 */

import { NO_CAPABILITIES, type ActionsBridge } from "../../../shared/actions-contract";
import { NO_SERVICES, type ServicesBridge } from "../../../shared/services-contract";
import { RECENTS_PATH, type FsBatchResult, type FsBridge, type FsClipboard, type FsEnrichmentTarget, type FsEntryEnrichment, type FsFinderEnrichment, type FsHistoryOperation, type FsLocation, type FsLocationIcon, type FsOpError, type FsRecordedOperation, type FsSearchOptions, type FsTagCatalog, type FsTagChange, type FsUndoOutcome, type FsVersionFamiliesResult } from "../../../shared/fs-contract";
import { newFileFormat, type NewFileFormatId } from "../../../shared/new-file-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import {
	DUPEY_LAYER_ID,
	type LayerPublication,
	type LiveBridge,
	type LiveMessage,
	type LiveResync,
} from "../../../shared/live-contract";
import { copyName } from "../state/collision";
import { kindFromExtension } from "../state/kinds";
import { basename, dirname, joinPath } from "../state/paths";
import {
	EMPTY_VERSION_FAMILIES_RESULT,
	type VersionFamiliesResult,
	type VersionRelation,
} from "../state/version-family";
import { type FinderEntry, entryFromFixture, entryFromFs, entryFromSearchHit, hasFileVersion } from "./entries";
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
	openWithApplications: () => Promise.resolve([]),
	share: () => Promise.reject(new Error("이 환경에서는 공유를 실행할 수 없습니다")),
};

export interface FinderSource {
	/** True when the native OS surfaces (Reveal, Open) are real. */
	readonly native: boolean;
	readonly initialPath: string;
	/** Inspection actions (open with, archive, share, simple edits). */
	readonly actions: ActionsBridge;
	/** The OS services (macOS right-click → 서비스) for a selection; empty off macOS and in fixtures. */
	readonly services: ServicesBridge;
	setWatchSet(dirs: readonly string[]): Promise<void>;
	onLive(listener: (message: LiveMessage) => void): () => void;
	/**
	 * The filesystem worker restarted and kept nothing: re-send the watch set
	 * and re-read every folder on screen. Never fires in the fixture source.
	 */
	onReconnect(listener: () => void): () => void;
	liveLayers(): Promise<LiveResync>;
	exists(path: string): Promise<boolean>;
	/** The row for one path (folder or file); rejects when it is missing. */
	stat(path: string): Promise<FinderEntry>;
	list(path: string): Promise<readonly FinderEntry[]>;
	/**
	 * OS kind and icon URLs for rows already on screen. The results go to the
	 * entry sidecar keyed by file version, never into a listing, so an icon
	 * another pass filled in meanwhile is never overwritten.
	 */
	enrich(entries: readonly FinderEntry[]): Promise<readonly FsEntryEnrichment[]>;
	/**
	 * Finder metadata (tags, dates, dimensions, default app) for the same rows,
	 * also kept in the sidecar. Separate from `enrich` because it is far slower
	 * on a slow disk, and icons must never wait for it.
	 */
	finderMetadata(entries: readonly FinderEntry[]): Promise<readonly FsFinderEnrichment[]>;
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
	search(query: string, options?: FsSearchOptions): Promise<readonly FinderEntry[]>;
	locations(): Promise<readonly FinderLocation[]>;
	/** Finder's tag registry; `supported` is false off macOS and in fixtures. */
	tags(): Promise<FsTagCatalog>;
	/** Add and remove Finder tags on every path; per-path outcome. */
	setTags(paths: readonly string[], change: FsTagChange): Promise<FsBatchResult>;
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
	/** Move to the Trash; per-path outcome, so a partial batch is never silent. */
	trash(paths: readonly string[]): Promise<FsBatchResult>;
	/** Restore trashed payloads back to the folders they came from (Trash view "Put Back"). */
	restoreFromTrash(paths: readonly string[]): Promise<FsBatchResult>;
	/** Permanently delete everything in the Trash. */
	emptyTrash(): Promise<FsBatchResult>;
	rename(path: string, name: string): Promise<void>;
	/** Create a new folder (Finder-style "untitled folder" / "untitled folder 2"). */
	createFolder(dir: string): Promise<{ readonly path: string; readonly name: string }>;
	/** Create a new file from a format template (Finder-style "untitled.<ext>" / "untitled 2.<ext>"). */
	createFile(dir: string, format: NewFileFormatId): Promise<{ readonly path: string; readonly name: string }>;
	duplicate(paths: readonly string[]): Promise<FsBatchResult>;
	copyInto(paths: readonly string[], destDir: string): Promise<FsBatchResult>;
	moveInto(paths: readonly string[], destDir: string): Promise<FsBatchResult>;
	/** Undo the newest operation of the history (⌘Z); the record is consumed and can be redone. */
	undo(): Promise<FsUndoOutcome>;
	/** Redo the operation the last undo took back (⇧⌘Z). */
	redo(): Promise<FsUndoOutcome>;
	/** Remember an output an Action (extract, compress) created, so ⌘Z can move it to the Trash. */
	recordCreated(path: string, operation: FsRecordedOperation): Promise<void>;
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

/** Main-process identity for each row backed by a file version; the mtime gates every patch. */
function enrichmentTargets(entries: readonly FinderEntry[]): FsEnrichmentTarget[] {
	return entries.flatMap((entry) =>
		hasFileVersion(entry) ? [{ path: entry.path, kind: entry.kind, ext: entry.ext, mtimeMs: entry.mtimeMs }] : [],
	);
}

/* -------------------------------------------------------------- real bridge */

export function createBridgeSource(
	fs: FsBridge,
	initialPath: string,
	live?: LiveBridge,
	actions: ActionsBridge = UNAVAILABLE_ACTIONS,
	services: ServicesBridge = NO_SERVICES,
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
		services,
		setWatchSet: (dirs) => live?.setWatchSet(dirs) ?? Promise.resolve(),
		onLive: (listener) => {
			return live?.onMessage((message) => listener({
				...message,
				layers: message.layers.map(mapLayerPublication),
			})) ?? (() => {});
		},
		onReconnect: (listener) => live?.onReconnect(listener) ?? (() => {}),
		async liveLayers() {
			if (live === undefined) {
				return { seq: 0, layers: [], reconciled: [] };
			}
			const result = await live.layers();
			return { ...result, layers: result.layers.map(mapLayerPublication) };
		},
		exists: (path) => fs.exists(path),
		stat: async (path) => entryFromFs(await fs.stat(path)),
		async list(path) {
			const listing = await fs.listDir(path);
			// A row's folder is derived from its path, so Recents rows point at the real folder.
			return listing.entries.map(entryFromFs);
		},
		enrich: (entries) => fs.enrichEntries(enrichmentTargets(entries), true),
		finderMetadata: (entries) => fs.finderMetadata(enrichmentTargets(entries)),
		async readEntries(dir, paths) {
			const patch = await fs.readEntries(dir, paths);
			return { entries: patch.entries.map(entryFromFs), removed: patch.removed };
		},
		async search(query, options) {
			const hits = await fs.search(query, options);
			return hits.map(entryFromSearchHit);
		},
		locations: () => fs.locations(),
		tags: () => fs.tags(),
		setTags: (paths, change) => fs.setTags(paths, change),
		ejectLocation: (path) => fs.ejectLocation(path),
		onLocationsChanged: (listener) => fs.onLocationsChanged?.(listener) ?? (() => {}),
		quickLook: (path) => fs.quickLook(path),
		open: (path) => fs.open(path),
		openUrl: (url) => fs.openUrl(url),
		reveal: (path) => fs.reveal(path),
		trash: (paths) => fs.trash(paths),
		restoreFromTrash: (paths) => fs.restoreFromTrash(paths),
		emptyTrash: () => fs.emptyTrash(),
		rename: async (path, name) => {
			await fs.rename(path, name);
		},
		createFolder: (dir) => fs.createFolder(dir),
		createFile: (dir, format) => fs.createFile(dir, format),
		duplicate: (paths) => fs.duplicate(paths),
		copyInto: (paths, destDir) => fs.copy(paths, destDir),
		moveInto: (paths, destDir) => fs.move(paths, destDir),
		undo: () => fs.undo(),
		redo: () => fs.redo(),
		recordCreated: (path, operation) => fs.recordCreated(path, operation),
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
	/** Fixture Trash origins: payload path → the folder the item came from. */
	trash: Map<string, string>;
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
	return { tree, clipboard: null, indexExcluded: new Set(), ejected: new Set(), trash: new Map() };
}

function takenNames(state: FixtureState, dir: string): string[] {
	return (state.tree.get(dir) ?? []).map((item) => item.name);
}

/** The seed rows' "Sep 22, 11:40" shape, stamped with the current time. */
function fixtureNowLabel(): string {
	const now = new Date();
	const month = now.toLocaleString("en-US", { month: "short" });
	return `${month} ${now.getDate()}, ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
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

	/**
	 * One reversible fixture step. `apply` performs it and returns its inverse,
	 * so undo and redo are the same walk over two stacks (the real service
	 * works the same way); a step that cannot apply throws its verbatim reason.
	 */
	interface FixtureStep {
		readonly path: string;
		/** True when applying takes the item out of the Trash (it has nothing to act on once the Trash is emptied). */
		readonly fromTrash?: true;
		apply(): FixtureStep;
	}
	interface FixtureRecord {
		readonly operation: FsHistoryOperation;
		steps: FixtureStep[];
	}
	const undoStack: FixtureRecord[] = [];
	const redoStack: FixtureRecord[] = [];
	const record = (operation: FsHistoryOperation, steps: readonly FixtureStep[]): FixtureRecord => {
		const entry: FixtureRecord = { operation, steps: [...steps] };
		undoStack.push(entry);
		redoStack.length = 0;
		return entry;
	};
	const replay = (from: FixtureRecord[], to: FixtureRecord[]): FsUndoOutcome => {
		const entry = from.pop();
		if (entry === undefined) return { ok: false, empty: true, failed: [] };
		const inverse: FixtureStep[] = [];
		const failed: FsOpError[] = [];
		for (const step of entry.steps) {
			try {
				inverse.push(step.apply());
			} catch (error) {
				failed.push({ path: step.path, message: error instanceof Error ? error.message : String(error) });
			}
		}
		if (inverse.length > 0) to.push({ operation: entry.operation, steps: inverse });
		return { ok: failed.length === 0, empty: false, failed, operation: entry.operation };
	};
	/** The row at `path` exists because of the operation; applying removes it. */
	const createdStep = (path: string, item: FixtureItem): FixtureStep => ({
		path,
		apply: () => {
			if (removeItem(state, path) === null) throw new Error("되돌릴 항목이 없습니다");
			return removedStep(path, item);
		},
	});
	/** The row at `path` was removed by an undo; applying makes it again. */
	const removedStep = (path: string, item: FixtureItem): FixtureStep => ({
		path,
		apply: () => {
			if (findItem(state, path) !== null) throw new Error(`A file or folder named "${basename(path)}" already exists`);
			insertItem(state, dirname(path), item);
			return createdStep(path, item);
		},
	});
	/** The row at `path` goes back into `restoreDir`, Finder-style collision naming included. */
	const moveStep = (path: string, restoreDir: string): FixtureStep => ({
		path,
		apply: () => {
			const item = removeItem(state, path);
			if (item === null) throw new Error("되돌릴 항목이 없습니다");
			const name = copyName(item.name, takenNames(state, restoreDir));
			insertItem(state, restoreDir, { ...item, name });
			return moveStep(joinPath(restoreDir, name), dirname(path));
		},
	});
	/** The row at `path` takes `name` back unless somebody retook it. */
	const renameStep = (path: string, name: string): FixtureStep => ({
		path,
		apply: () => {
			const item = findItem(state, path);
			if (item === null) throw new Error("되돌릴 항목이 없습니다");
			if (name.toLowerCase() !== basename(path).toLowerCase() && takenNames(state, dirname(path)).includes(name)) {
				throw new Error(`A file or folder named "${name}" already exists`);
			}
			removeItem(state, path);
			insertItem(state, dirname(path), { ...item, name });
			return renameStep(joinPath(dirname(path), name), basename(path));
		},
	});
	/** The item sits in the fixture Trash; applying moves it straight back to `path`'s folder. */
	const trashedStep = (path: string): FixtureStep => ({
		path,
		fromTrash: true,
		apply: () => {
			const trashItems = state.tree.get("Trash") ?? [];
			const index = trashItems.findIndex((item) => item.name === basename(path));
			const [moved] = index < 0 ? [] : trashItems.splice(index, 1);
			if (moved === undefined) throw new Error("휴지통에서 항목을 찾을 수 없습니다");
			state.trash.delete(joinPath("Trash", moved.name));
			const dir = dirname(path);
			const name = copyName(moved.name, takenNames(state, dir));
			insertItem(state, dir, { ...moved, name });
			return restoredStep(joinPath(dir, name));
		},
	});
	/** The item sits at `path`; applying moves it into the fixture Trash. */
	const restoredStep = (path: string): FixtureStep => ({
		path,
		apply: () => {
			const item = removeItem(state, path);
			if (item === null) throw new Error("되돌릴 항목이 없습니다");
			const name = copyName(item.name, takenNames(state, "Trash"));
			insertItem(state, "Trash", { ...item, name });
			state.trash.set(joinPath("Trash", name), dirname(path));
			return trashedStep(path);
		},
	});
	const fixtureIndexStatus = (path: string): IndexStatus =>
		state.indexExcluded.has(path)
			? { path, kind: "excluded", excluded: true, toggleable: true, detail: "인덱싱에서 제외됨" }
			: { path, kind: "included", excluded: false, toggleable: true, detail: "MinSync 인덱스에 포함됨" };

	return {
		native: false,
		initialPath: FIXTURE_INITIAL_PATH,
		actions: UNAVAILABLE_ACTIONS,
		services: NO_SERVICES,
		setWatchSet: resolve,
		onLive: () => () => {},
		onReconnect: () => () => {},
		liveLayers: () => Promise.resolve({ seq: 0, layers: [], reconciled: [] }),
		enrich: async () => [],
		finderMetadata: async () => [],
		exists: (path) => Promise.resolve(state.tree.has(path) || findItem(state, path) !== null),
		stat: (path) => {
			const item = findItem(state, path);
			if (item !== null) return Promise.resolve(entryFromFixture(item, dirname(path)));
			if (state.tree.has(path)) {
				return Promise.resolve(entryFromFixture({ name: basename(path), fileKind: "folder", dateLabel: "", sizeLabel: "" }, dirname(path)));
			}
			return Promise.reject(new Error(`No such file or folder: ${path}`));
		},
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
		search: (query, options) => {
			const needle = query.trim().toLowerCase();
			if (needle === "") {
				return Promise.resolve([]);
			}
			const scope = options?.scope;
			const hits: FinderEntry[] = [];
			for (const [path, items] of state.tree) {
				if (path === RECENTS_PATH) {
					continue;
				}
				for (const item of items) {
					if (!item.name.toLowerCase().includes(needle)) continue;
					const entry = entryFromFixture(item, path);
					if (scope !== undefined && entry.path !== scope && !entry.path.startsWith(`${scope}/`)) continue;
					hits.push(entry);
				}
			}
			return Promise.resolve(hits);
		},
		tags: () => Promise.resolve({ supported: false, tags: [], colorNames: [] }),
		setTags: (paths) => Promise.resolve({ ok: [], failed: paths.map((path) => ({ path, message: "이 환경에서는 태그를 바꿀 수 없습니다" })) }),
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
			const steps: FixtureStep[] = [];
			const ok: string[] = [];
			const failed: FsOpError[] = [];
			for (const path of paths) {
				const item = removeItem(state, path);
				if (item === null) {
					failed.push({ path, message: "항목을 찾을 수 없습니다" });
					continue;
				}
				// The fixture Trash is a plain folder: the item moves there and its origin is remembered.
				const name = copyName(item.name, takenNames(state, "Trash"));
				insertItem(state, "Trash", { ...item, name });
				state.trash.set(joinPath("Trash", name), dirname(path));
				ok.push(path);
				steps.push(trashedStep(path));
			}
			if (steps.length > 0) record("trash", steps);
			return Promise.resolve({ ok, failed });
		},
		restoreFromTrash: (paths) => {
			const steps: FixtureStep[] = [];
			const ok: string[] = [];
			const failed: FsOpError[] = [];
			for (const trashPath of paths) {
				const originalDir = state.trash.get(trashPath);
				const item = originalDir === undefined ? null : removeItem(state, trashPath);
				if (originalDir === undefined || item === null) {
					failed.push({ path: trashPath, message: "원래 위치를 알 수 없습니다" });
					continue;
				}
				state.trash.delete(trashPath);
				const name = copyName(item.name, takenNames(state, originalDir));
				insertItem(state, originalDir, { ...item, name });
				ok.push(trashPath);
				steps.push(restoredStep(joinPath(originalDir, name)));
			}
			if (steps.length > 0) record("restore", steps);
			return Promise.resolve({ ok, failed });
		},
		emptyTrash: () => {
			const ok = (state.tree.get("Trash") ?? []).map((item) => joinPath("Trash", item.name));
			state.tree.set("Trash", []);
			state.trash.clear();
			// Steps that act on a Trash payload have nothing left to act on.
			for (const stack of [undoStack, redoStack]) {
				for (let index = stack.length - 1; index >= 0; index -= 1) {
					const entry = stack[index];
					if (entry === undefined) continue;
					entry.steps = entry.steps.filter((step) => step.fromTrash !== true);
					if (entry.steps.length === 0) stack.splice(index, 1);
				}
			}
			return Promise.resolve({ ok, failed: [] });
		},
		rename: (path, name) => {
			const item = findItem(state, path);
			if (item !== null) {
				removeItem(state, path);
				insertItem(state, dirname(path), { ...item, name });
				record("rename", [renameStep(joinPath(dirname(path), name), basename(path))]);
			}
			return resolve();
		},
		createFolder: (dir) => {
			const taken = takenNames(state, dir);
			let name = "untitled folder";
			for (let attempt = 2; taken.includes(name); attempt += 1) {
				name = `untitled folder ${attempt}`;
			}
			const path = joinPath(dir, name);
			const item: FixtureItem = { name, fileKind: "folder", dateLabel: fixtureNowLabel(), sizeLabel: "—" };
			insertItem(state, dir, item);
			record("createFolder", [createdStep(path, item)]);
			return Promise.resolve({ path, name });
		},
		createFile: (dir, format) => {
			const { extension } = newFileFormat(format);
			const taken = takenNames(state, dir);
			let name = `untitled.${extension}`;
			for (let attempt = 2; taken.includes(name); attempt += 1) {
				name = `untitled ${attempt}.${extension}`;
			}
			const path = joinPath(dir, name);
			const item: FixtureItem = {
				name,
				fileKind: kindFromExtension(extension),
				dateLabel: fixtureNowLabel(),
				sizeLabel: "—",
			};
			insertItem(state, dir, item);
			record("createFile", [createdStep(path, item)]);
			return Promise.resolve({ path, name });
		},
		duplicate: (paths) => {
			const ok: string[] = [];
			const steps: FixtureStep[] = [];
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null) {
					continue;
				}
				const dir = dirname(path);
				const copy = { ...item, name: copyName(item.name, [...takenNames(state, dir), item.name]) };
				insertItem(state, dir, copy);
				steps.push(createdStep(joinPath(dir, copy.name), copy));
				ok.push(path);
			}
			if (steps.length > 0) record("duplicate", steps);
			return Promise.resolve({ ok, failed: [] });
		},
		copyInto: (paths, destDir) => {
			const steps: FixtureStep[] = [];
			const ok: string[] = [];
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null) {
					continue;
				}
				const copy = { ...item, name: copyName(item.name, takenNames(state, destDir)) };
				insertItem(state, destDir, copy);
				steps.push(createdStep(joinPath(destDir, copy.name), copy));
				ok.push(path);
			}
			if (steps.length > 0) record("copy", steps);
			return Promise.resolve({ ok, failed: [] });
		},
		moveInto: (paths, destDir) => {
			const steps: FixtureStep[] = [];
			const ok: string[] = [];
			for (const path of paths) {
				const item = findItem(state, path);
				if (item === null || dirname(path) === destDir) {
					continue;
				}
				const name = copyName(item.name, takenNames(state, destDir));
				removeItem(state, path);
				insertItem(state, destDir, { ...item, name });
				steps.push(moveStep(joinPath(destDir, name), dirname(path)));
				ok.push(path);
			}
			if (steps.length > 0) record("move", steps);
			return Promise.resolve({ ok, failed: [] });
		},
		undo: () => Promise.resolve(replay(undoStack, redoStack)),
		redo: () => Promise.resolve(replay(redoStack, undoStack)),
		recordCreated: (path, operation) => {
			if (findItem(state, path) === null) return Promise.reject(new Error("항목을 찾을 수 없습니다"));
			record(operation, [restoredStep(path)]);
			return Promise.resolve();
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
