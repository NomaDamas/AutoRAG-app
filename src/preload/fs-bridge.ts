import type { IpcRenderer } from "electron";
import type { DirListing, FsBatchResult, FsBridge, FsClipboard, FsEntriesPatch, FsEntry, FsEntryEnrichment, FsFileDetails, FsFinderEnrichment, FsLocation, FsSearchResult, FsUndoOutcome, FsVersionFamiliesResult } from "../shared/fs-contract";
import { FS_CHANNELS } from "../shared/fs-contract";
import type { FsWorkerOp } from "../shared/fs-worker-contract";
import { FS_WORKER_PUSH, type WorkerClient } from "../shared/fs-worker-protocol";
import type { IndexStatus } from "../shared/index-contract";

/**
 * Typed `window.autorag.fs`. Every filesystem call goes straight to the fs
 * worker over its MessagePort; only the row drag-out (a main-process
 * `webContents.startDrag`) still rides IPC.
 */
export function createFsBridge(ipcRenderer: IpcRenderer, worker: WorkerClient): FsBridge {
	const call = <T>(op: FsWorkerOp, ...args: unknown[]): Promise<T> => worker.call<T>(op, args);
	return {

		listDir: (path) => call<DirListing>("listDir", path),
		enrichEntries: (targets, thumbnails) => call<readonly FsEntryEnrichment[]>("enrichEntries", targets, thumbnails),
		finderMetadata: (targets) => call<readonly FsFinderEnrichment[]>("finderMetadata", targets),
		readEntries: (dir, paths) => call<FsEntriesPatch>("readEntries", dir, paths),
		stat: (path) => call<FsEntry>("stat", path),
		details: (path) => call<FsFileDetails>("details", path),
		previewIcon: (path, mtimeMs) => call<string | null>("previewIcon", path, mtimeMs),
		exists: (path) => call<boolean>("exists", path),
		search: (query, options) => call<readonly FsSearchResult[]>("search", query, options),
		locations: () => call<readonly FsLocation[]>("locations"),
		ejectLocation: (path) => call<void>("ejectLocation", path),
		onLocationsChanged: (listener) => worker.onPush(FS_WORKER_PUSH.locationsChanged, () => listener()),
		copy: (paths, destDir) => call<FsBatchResult>("copy", paths, destDir),
		move: (paths, destDir) => call<FsBatchResult>("move", paths, destDir),
		duplicate: (paths) => call<FsBatchResult>("duplicate", paths),
		rename: (path, newName) => call<FsEntry>("rename", path, newName),
		createFolder: (directory) => call<{ readonly path: string; readonly name: string }>("createFolder", directory),
		createFile: (directory, format) => call<{ readonly path: string; readonly name: string }>("createFile", directory, format),
		trash: (paths) => call<FsBatchResult>("trash", paths),
		restoreFromTrash: (paths) => call<FsBatchResult>("restoreFromTrash", paths),
		emptyTrash: () => call<FsBatchResult>("emptyTrash"),
		reveal: (path) => call<void>("reveal", path),
		quickLook: (path) => call<void>("quickLook", path),
		open: (path) => call<void>("open", path),
		openUrl: (url) => call<void>("openUrl", url),
		clipboardSet: (clipboard) => call<void>("clipboardSet", clipboard),
		undo: () => call<FsUndoOutcome>("undo"),
		clipboardGet: () => call<FsClipboard | null>("clipboardGet"),
		copyPathsToClipboard: (paths) => call<void>("copyPathsToClipboard", paths),
		startDrag: (paths) => ipcRenderer.send(FS_CHANNELS.startDrag, paths),
		versionFamilies: () => call<FsVersionFamiliesResult>("versionFamilies"),
		indexStatus: (paths) => call<readonly IndexStatus[]>("indexStatus", paths),
		setIndexExcluded: (path, excluded) => call<IndexStatus>("setIndexExcluded", path, excluded),
		onIndexRefreshed: (listener) =>
			worker.onPush(FS_WORKER_PUSH.indexRefreshed, (error) => listener(typeof error === "string" ? error : null)),
		refreshVersionFamilies: () => call<FsVersionFamiliesResult>("refreshVersionFamilies"),
	};
}
