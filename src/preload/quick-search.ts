import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createPreviewBridge } from "../preview/node/bridge";
import type { ContentSearchResult } from "../shared/content-search-contract";
import { FS_CHANNELS, RECENTS_PATH, type DirListing, type FsEntryEnrichment, type FsSearchResult } from "../shared/fs-contract";
import { isAppLanguage, LANGUAGE_CHANNELS, languageFromArgv } from "../shared/language-contract";
import { QUICK_SEARCH_CHANNELS, type QuickSearchBridge } from "../shared/quick-search-contract";
import { installAppearancePreload } from "./appearance";
import { connectFsWorker } from "./worker-link";

/**
 * The launcher page's bridge. Searches and file operations go straight to the fs worker over its own port, like the
 * Finder's; only what needs the main process (hiding the window, handing off to the Finder, a native drag) rides IPC.
 */

installAppearancePreload(ipcRenderer);
const worker = connectFsWorker(ipcRenderer);

/** One search op at a time: a keystroke cancels the query still running for the previous one (in the worker and the thread). */
function latest<T>(op: string): (query: string) => Promise<T> {
	let running: AbortController | null = null;
	return (query) => {
		running?.abort();
		const controller = new AbortController();
		running = controller;
		return worker.call<T>(op, [query], { signal: controller.signal });
	};
}

function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
	const handler = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.off(channel, handler);
	};
}

const bridge: QuickSearchBridge = {
	platform: process.platform,
	language: languageFromArgv(process.argv),
	onLanguage: (listener) =>
		subscribe(LANGUAGE_CHANNELS.changed, (next) => {
			if (isAppLanguage(next)) listener(next);
		}),
	onShown: (listener) => subscribe(QUICK_SEARCH_CHANNELS.shown, () => listener()),
	hide: (mode) => ipcRenderer.send(QUICK_SEARCH_CHANNELS.hide, mode),
	revealInApp: (path) => ipcRenderer.invoke(QUICK_SEARCH_CHANNELS.revealInApp, path),
	ask: (query) => ipcRenderer.invoke(QUICK_SEARCH_CHANNELS.ask, query),
	attach: (paths) => ipcRenderer.invoke(QUICK_SEARCH_CHANNELS.attach, paths),
	startDrag: (paths) => ipcRenderer.send(FS_CHANNELS.startDrag, paths),
	searchNames: latest<readonly FsSearchResult[]>("search"),
	searchContent: latest<ContentSearchResult>("contentSearch"),
	icons: (targets) => worker.call<readonly FsEntryEnrichment[]>("enrichEntries", [targets, true]),
	recents: async () => (await worker.call<DirListing>("listDir", [RECENTS_PATH])).entries,
	open: (path) => worker.call<void>("open", [path]),
	reveal: (path) => worker.call<void>("reveal", [path]),
	copyFiles: (paths) => worker.call<void>("clipboardSet", [{ op: "copy", paths }]),
	copyPaths: (paths) => worker.call<void>("copyPathsToClipboard", [paths]),
	preview: createPreviewBridge(ipcRenderer),
};

contextBridge.exposeInMainWorld("launcher", bridge);
