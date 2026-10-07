import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import type { DirectorySnapshot, DirectoryStore } from "../data/directory-store";
import type { FinderEntry } from "../data/entries";
import type { EntrySidecar } from "../data/entry-sidecar";

/** The window's folder data: one store and one sidecar, shared by every pane. */
export interface DirectoryData {
	readonly store: DirectoryStore;
	readonly sidecar: EntrySidecar;
}

export const DirectoryDataContext = createContext<DirectoryData | null>(null);

export function useDirectoryData(): DirectoryData {
	const data = useContext(DirectoryDataContext);
	if (data === null) throw new Error("DirectoryDataContext is missing: render inside <DirectoryDataContext value={…}>");
	return data;
}

/**
 * The snapshots of `dirs`, retained while mounted. The array changes only when
 * one of its snapshots does, so it can key a memo; it is rebuilt from
 * `store.get` on change, so no snapshot outlives the render that shows it.
 */
export function useDirectories(store: DirectoryStore, dirs: readonly string[]): readonly (DirectorySnapshot | undefined)[] {
	const key = dirs.join("\u0000");
	useEffect(() => {
		if (key === "") return;
		const releases = key.split("\u0000").map((dir) => store.retain(dir));
		return () => {
			for (const release of releases) release();
		};
	}, [store, key]);
	const subscribe = useCallback(
		(listener: () => void) => {
			if (key === "") return () => {};
			const offs = key.split("\u0000").map((dir) => store.subscribe(dir, listener));
			return () => {
				for (const off of offs) off();
			};
		},
		[store, key],
	);
	// A string is stable between changes; snapshot versions are unique store-wide.
	const versions = useSyncExternalStore(subscribe, () =>
		key === "" ? "" : key.split("\u0000").map((dir) => store.get(dir)?.version ?? -1).join(","),
	);
	return useMemo(() => {
		void versions;
		return key === "" ? [] : key.split("\u0000").map((dir) => store.get(dir));
	}, [store, key, versions]);
}

/** One row's enriched entry and index state; re-renders only when that row's own data changes. */
export function useEntrySidecar(sidecar: EntrySidecar, entry: FinderEntry): { readonly entry: FinderEntry; readonly indexStatus: IndexStatus | null } {
	const path = entry.path;
	const subscribe = useCallback((listener: () => void) => sidecar.subscribe(path, listener), [sidecar, path]);
	useSyncExternalStore(subscribe, () => sidecar.revision(path));
	return { entry: sidecar.resolve(entry), indexStatus: sidecar.indexStatus(path) };
}

/** The sidecar's row-data version, for the one pipeline that orders or groups by enrichment. */
export function useSidecarVersion(sidecar: EntrySidecar, active: boolean): number {
	const subscribe = useCallback(
		(listener: () => void) => (active ? sidecar.subscribeAll(listener) : () => {}),
		[sidecar, active],
	);
	return useSyncExternalStore(subscribe, () => (active ? sidecar.version() : 0));
}
