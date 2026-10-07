import { useEffect, useMemo, useRef, useState } from "react";
import type { DirectorySnapshot, DirectoryStore } from "../data/directory-store";
import { isMissingPathFailure, type FinderSource } from "../data/source";
import { isFilesystemPath, listingSurvivor } from "../state/live";
import { isVirtualTabPath } from "../state/tabs";
import { useDirectories } from "./useDirectoryData";

export interface FolderListingsInput {
	readonly store: DirectoryStore;
	readonly source: FinderSource;
	/** The active tab's folder. */
	readonly path: string;
	readonly tabId: number;
	/** Column panes, left to right (empty outside the column layout). */
	readonly panePaths: readonly string[];
	/** Folders the list shows expanded. */
	readonly openFolders: readonly string[];
	/** Bumped by every action that changed the filesystem; every folder on screen relists. */
	readonly revision: number;
	readonly searching: boolean;
	readonly reportError: (error: unknown) => void;
	/** The folder in view no longer exists: leave it for its nearest existing ancestor. */
	readonly onMissing: (path: string) => void;
	/** The folder in view relisted: drop the selection and rename targets it no longer holds. */
	readonly onRelisted: (survives: (path: string) => boolean) => void;
}

export interface FolderListings {
	/** The listing on screen: the folder in view, or the previous one while it loads. */
	readonly listing: DirectorySnapshot | undefined;
	/** The folder `listing` belongs to. */
	readonly listingDir: string;
	readonly panes: readonly (DirectorySnapshot | undefined)[];
	readonly children: ReadonlyMap<string, DirectorySnapshot | undefined>;
}

function listable(path: string): boolean {
	return isFilesystemPath(path) && !isVirtualTabPath(path);
}

/**
 * The data half of a Finder pane: which folders it shows, read from the
 * directory store and retained while on screen, and when each is (re)listed.
 * Nothing here holds a listing between renders; every array comes from the
 * store snapshot of the render that shows it.
 */
export function useFolderListings(input: FolderListingsInput): FolderListings {
	const { store, source, path, tabId, panePaths, openFolders, revision, searching, reportError, onMissing, onRelisted } = input;
	// While a folder's first listing is in flight the previous one stays on
	// screen, so navigating never flashes an empty folder.
	const [heldDir, setHeldDir] = useState("");
	const dirs = useMemo(
		() => [...new Set([path, heldDir, ...panePaths, ...openFolders].filter(listable))],
		[path, heldDir, panePaths, openFolders],
	);
	const snapshots = useDirectories(store, dirs);
	const byDir = useMemo(() => new Map(dirs.map((dir, index) => [dir, snapshots[index]])), [dirs, snapshots]);
	const current = byDir.get(path);
	if (current?.loaded === true && heldDir !== path) setHeldDir(path);
	const shownDir = current?.loaded === true || !listable(heldDir) ? path : heldDir;
	const listing = byDir.get(shownDir);

	const latest = useRef({ path, onMissing, onRelisted, reportError });
	latest.current = { path, onMissing, onRelisted, reportError };

	// Relisting the folder in view: the tab's folder, on navigation, tab switch,
	// refresh, a search ending, or a source change.
	const previous = useRef<{ path: string; tabId: number; revision: number } | null>(null);
	useEffect(() => {
		const before = previous.current;
		previous.current = { path, tabId, revision };
		if (!listable(path)) return;
		const pathChanged = before?.path !== path;
		const tabChanged = before?.tabId !== tabId;
		if (searching && !pathChanged && !tabChanged) return;
		// Opening a folder in place is a navigation (a failure empties it); a tab
		// switch or refresh revalidates what is already shown.
		const mode = (pathChanged && !tabChanged) || store.get(path)?.loaded !== true ? "navigate" : "silent";
		void store.load(path, mode).then(async (outcome) => {
			if (outcome.kind !== "error") return;
			if (mode === "navigate") {
				latest.current.reportError(outcome.error);
				return;
			}
			let missing = false;
			try {
				missing = await isMissingPathFailure(source, path);
			} catch (error: unknown) {
				console.error(error);
			}
			if (missing) latest.current.onMissing(path);
			else console.error(outcome.error);
		});
	}, [store, source, path, tabId, revision, searching]);

	// Every other folder on screen: column panes after the first, and expanded subfolders.
	const othersKey = useMemo(
		() => [...new Set([...panePaths, ...openFolders])].filter((dir) => dir !== path && listable(dir)).join("\u0000"),
		[path, panePaths, openFolders],
	);
	useEffect(() => {
		void revision;
		if (othersKey === "") return;
		for (const dir of othersKey.split("\u0000")) {
			const mode = store.get(dir)?.loaded === true ? "silent" : "navigate";
			void store.load(dir, mode).then((outcome) => {
				if (outcome.kind === "error") latest.current.reportError(outcome.error);
			});
		}
	}, [store, othersKey, revision]);

	// The folder in view relisted: rows it lost drop out of the selection. A
	// folder arriving from the cache is not a relist — its revalidation is.
	const seen = useRef<{ dir: string; entries: DirectorySnapshot["entries"] } | null>(null);
	const currentEntries = current?.loaded === true ? current.entries : null;
	useEffect(() => {
		const last = seen.current;
		const entries = currentEntries ?? [];
		seen.current = { dir: path, entries };
		if (currentEntries === null || last === null || last.dir !== path || last.entries === entries) return;
		latest.current.onRelisted(listingSurvivor(path, last.entries, entries));
	}, [path, currentEntries]);

	const panes = useMemo(() => panePaths.map((dir) => byDir.get(dir)), [panePaths, byDir]);
	const children = useMemo(() => new Map(openFolders.map((dir) => [dir, byDir.get(dir)])), [openFolders, byDir]);
	return { listing, listingDir: shownDir, panes, children };
}
