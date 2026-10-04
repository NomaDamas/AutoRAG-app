import type { IpcRenderer } from "electron";
import type { IndexStatus } from "../shared/index-contract";
import { FS_CHANNELS, type FsBridge } from "../shared/fs-contract";

/** Typed window.autorag.fs wrappers over ipcRenderer.invoke on the contract channels. */
export function createFsBridge(ipcRenderer: IpcRenderer): FsBridge {
	return {
		listDir: (path) => ipcRenderer.invoke(FS_CHANNELS.listDir, path),
		enrichEntries: (targets, thumbnails) => ipcRenderer.invoke(FS_CHANNELS.enrichEntries, targets, thumbnails),
		readEntries: (dir, paths) => ipcRenderer.invoke(FS_CHANNELS.readEntries, dir, paths),
		stat: (path) => ipcRenderer.invoke(FS_CHANNELS.stat, path),
		details: (path) => ipcRenderer.invoke(FS_CHANNELS.details, path),
		previewIcon: (path, modifiedAt) => ipcRenderer.invoke(FS_CHANNELS.previewIcon, path, modifiedAt),
		exists: (path) => ipcRenderer.invoke(FS_CHANNELS.exists, path),
		search: (query) => ipcRenderer.invoke(FS_CHANNELS.search, query),
		locations: () => ipcRenderer.invoke(FS_CHANNELS.locations),
		copy: (paths, destDir) => ipcRenderer.invoke(FS_CHANNELS.copy, paths, destDir),
		move: (paths, destDir) => ipcRenderer.invoke(FS_CHANNELS.move, paths, destDir),
		duplicate: (paths) => ipcRenderer.invoke(FS_CHANNELS.duplicate, paths),
		rename: (path, newName) => ipcRenderer.invoke(FS_CHANNELS.rename, path, newName),
		createFolder: (directory) => ipcRenderer.invoke(FS_CHANNELS.createFolder, directory),
		trash: (paths) => ipcRenderer.invoke(FS_CHANNELS.trash, paths),
		reveal: (path) => ipcRenderer.invoke(FS_CHANNELS.reveal, path),
		quickLook: (path) => ipcRenderer.invoke(FS_CHANNELS.quickLook, path),
		open: (path) => ipcRenderer.invoke(FS_CHANNELS.open, path),
		clipboardSet: (clipboard) => ipcRenderer.invoke(FS_CHANNELS.clipboardSet, clipboard),
		undo: () => ipcRenderer.invoke(FS_CHANNELS.undo),
		clipboardGet: () => ipcRenderer.invoke(FS_CHANNELS.clipboardGet),
		copyPathsToClipboard: (paths) => ipcRenderer.invoke(FS_CHANNELS.copyPathsToClipboard, paths),
		versionFamilies: () => ipcRenderer.invoke(FS_CHANNELS.versionFamilies),
		indexStatus: (paths) => ipcRenderer.invoke(FS_CHANNELS.indexStatus, paths) as Promise<readonly IndexStatus[]>,
		setIndexExcluded: (path, excluded) => ipcRenderer.invoke(FS_CHANNELS.indexSetExcluded, path, excluded) as Promise<IndexStatus>,
		onIndexRefreshed: (listener) => {
			const handler = (_event: unknown, error: string | null): void => listener(error);
			ipcRenderer.on(FS_CHANNELS.indexRefreshed, handler);
			return () => {
				ipcRenderer.removeListener(FS_CHANNELS.indexRefreshed, handler);
			};
		},
		refreshVersionFamilies: () => ipcRenderer.invoke(FS_CHANNELS.versionFamiliesRefresh),
	};
}
