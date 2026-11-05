/**
 * The phone shell's file data over the same `FinderSource` the desktop uses:
 * the places list, one folder listing at a time (watched live, re-read when the
 * worker reconnects), OS icons, tags, index status, and version families.
 *
 * The desktop controller is built around tabs, split panes and a keyboard; a
 * phone shows one folder per screen, so this hook keeps only that folder and
 * leaves navigation to the shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RECENTS_PATH, type FsLocation, type FsTagCatalog } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import type { FinderEntry } from "../data/entries";
import type { FinderSource } from "../data/source";
import { buildVersionFamilies, EMPTY_VERSION_FAMILIES, type VersionFamilies } from "../state/version-family";

export interface FolderState {
	readonly path: string;
	readonly entries: readonly FinderEntry[];
	readonly loading: boolean;
	readonly error: string | null;
}

export interface MobileFiles {
	readonly locations: readonly FsLocation[];
	readonly tagCatalog: FsTagCatalog;
	/** The folder on screen; null when no listing is shown. */
	readonly folder: FolderState | null;
	readonly indexStatus: ReadonlyMap<string, IndexStatus>;
	readonly families: VersionFamilies;
	/** Show `path` (null clears the listing): reads it and watches it, so changes from the desktop appear. */
	readonly open: (path: string | null) => void;
	/** Re-read the folder on screen after an operation. */
	readonly refresh: () => void;
	readonly setIndexed: (entries: readonly FinderEntry[], included: boolean) => Promise<void>;
	readonly reloadLocations: () => void;
}

const ICON_BATCH = 120;

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** OS icons for rows that have none yet, merged by path + mtime so a newer listing is never overwritten. */
async function withIcons(source: FinderSource, entries: readonly FinderEntry[]): Promise<readonly FinderEntry[]> {
	const targets = entries.filter((entry) => entry.kind === "file" && entry.iconUrl === undefined).slice(0, ICON_BATCH);
	if (targets.length === 0) return entries;
	const enriched = await source.enrich(targets);
	const byPath = new Map(enriched.map((item) => [item.path, item]));
	return entries.map((entry) => {
		const hit = byPath.get(entry.path);
		if (hit === undefined || hit.mtimeMs !== entry.mtimeMs) return entry;
		return { ...entry, ...(hit.iconUrl === null ? {} : { iconUrl: hit.iconUrl }), ...(hit.osKind === null ? {} : { osKind: hit.osKind }) };
	});
}

/** Finder tags (macOS) for rows on screen, so the tag dots and the menu's checked colours are real. */
async function withTags(source: FinderSource, entries: readonly FinderEntry[]): Promise<readonly FinderEntry[]> {
	const targets = entries.slice(0, ICON_BATCH);
	if (targets.length === 0) return entries;
	const meta = await source.finderMetadata(targets);
	if (meta.length === 0) return entries;
	const byPath = new Map(meta.map((item) => [item.path, item]));
	return entries.map((entry) => {
		const hit = byPath.get(entry.path);
		return hit === undefined || hit.mtimeMs !== entry.mtimeMs ? entry : { ...entry, finder: hit.finder };
	});
}

export function useMobileFiles(source: FinderSource, onError: (message: string) => void): MobileFiles {
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [tagCatalog, setTagCatalog] = useState<FsTagCatalog>({ supported: false, tags: [], colorNames: [], colorsDenied: false });
	const [folder, setFolder] = useState<FolderState | null>(null);
	const [indexStatus, setIndexStatus] = useState<ReadonlyMap<string, IndexStatus>>(new Map());
	const [families, setFamilies] = useState<VersionFamilies>(EMPTY_VERSION_FAMILIES);
	const current = useRef<string | null>(null);
	const errorRef = useRef(onError);
	errorRef.current = onError;

	const loadLocations = useCallback(() => {
		source.locations().then(setLocations, (cause: unknown) => errorRef.current(message(cause)));
		source.tags().then(setTagCatalog, () => undefined);
	}, [source]);
	useEffect(() => {
		loadLocations();
		return source.onLocationsChanged(loadLocations);
	}, [loadLocations, source]);

	useEffect(() => {
		source.versionFamilies().then((result) => setFamilies(buildVersionFamilies(result.families)), () => undefined);
	}, [source]);

	const loadIndex = useCallback(
		(entries: readonly FinderEntry[]) => {
			const paths = entries.slice(0, ICON_BATCH).map((entry) => entry.path);
			if (paths.length === 0) return;
			source.indexStatus(paths).then(
				(list) => setIndexStatus((prev) => {
					const next = new Map(prev);
					for (const status of list) next.set(status.path, status);
					return next;
				}),
				() => undefined,
			);
		},
		[source],
	);

	const read = useCallback(
		async (path: string, quiet: boolean) => {
			current.current = path;
			if (!quiet) setFolder({ path, entries: [], loading: true, error: null });
			try {
				const entries = await source.list(path);
				if (current.current !== path) return;
				setFolder({ path, entries, loading: false, error: null });
				loadIndex(entries);
				const iconed = await withIcons(source, entries);
				if (current.current !== path) return;
				setFolder({ path, entries: iconed, loading: false, error: null });
				const tagged = await withTags(source, iconed).catch(() => iconed);
				if (current.current === path && tagged !== iconed) setFolder({ path, entries: tagged, loading: false, error: null });
			} catch (cause) {
				if (current.current === path) setFolder({ path, entries: [], loading: false, error: message(cause) });
			}
		},
		[loadIndex, source],
	);

	/** Show `path` (null clears the listing): reads it and watches it, so changes from the desktop appear. */
	const open = useCallback(
		(path: string | null) => {
			if (path === null) {
				current.current = null;
				setFolder(null);
				void source.setWatchSet([]);
				return;
			}
			if (current.current === path) return;
			void read(path, false);
			void source.setWatchSet(path === RECENTS_PATH ? [] : [path]);
		},
		[read, source],
	);

	const refresh = useCallback(() => {
		if (current.current !== null) void read(current.current, true);
	}, [read]);

	useEffect(() => {
		const offLive = source.onLive((live) => {
			const path = current.current;
			if (path !== null && live.dirs.some((dir) => dir.dir === path)) void read(path, true);
		});
		const offReconnect = source.onReconnect(() => {
			const path = current.current;
			if (path === null) return;
			void source.setWatchSet(path === RECENTS_PATH ? [] : [path]);
			void read(path, true);
		});
		return () => {
			offLive();
			offReconnect();
		};
	}, [read, source]);

	const setIndexed = useCallback(
		async (entries: readonly FinderEntry[], included: boolean) => {
			const results = await Promise.all(entries.map((entry) => source.setIndexExcluded(entry.path, !included)));
			setIndexStatus((prev) => {
				const next = new Map(prev);
				for (const status of results) next.set(status.path, status);
				return next;
			});
		},
		[source],
	);

	return useMemo(
		() => ({ locations, tagCatalog, folder, indexStatus, families, open, refresh, setIndexed, reloadLocations: loadLocations }),
		[families, folder, indexStatus, loadLocations, locations, open, refresh, setIndexed, tagCatalog],
	);
}
