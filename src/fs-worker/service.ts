/**
 * Everything the filesystem worker answers, composed once per worker process:
 * folder listings, live watches and the change hub, Finder metadata, places,
 * the file-name index, AutoRAG index badges, and the dupey version families.
 *
 * Electron-only work stays in the main process and is reached through `host`:
 * thumbnails (`nativeImage`), the Trash / open / reveal (`shell`), and the
 * clipboard. Nothing here imports `electron`, so the module also runs under
 * plain Node (unit tests).
 */

import { join } from "node:path";
import type { FsClipboard, FsEnrichmentTarget, FsSearchOptions, FsTagChange } from "../shared/fs-contract";
import type { FsWorkerConfig, FsWorkerOp } from "../shared/fs-worker-contract";
import { setAppLanguage, t } from "../shared/i18n/core";
import { isAppLanguage } from "../shared/language-contract";
import { FS_WORKER_PUSH, type WorkerHandler } from "../shared/fs-worker-protocol";
import { DUPEY_LAYER_ID, type LiveMessage } from "../shared/live-contract";
import { isNewFileFormatId } from "../shared/new-file-contract";
import { createChangeHub, type ChangeHub } from "../main/change-hub";
import { createDupeyLayer } from "../main/dupey-layer";
import type { IconProvider } from "../main/file-icon";
import { createFileNameSearch, type FileNameSearchBackend } from "../main/file-name-search";
import { buildFsEntry } from "../main/fs-entry";
import { createFsService, type FsOsClipboard, type FsShell } from "../main/fs-service";
import { createFsWatchService } from "../main/fs-watch-service";
import { createIndexStatusService } from "../main/index-status";
import { createPlaces, type Places } from "../main/places";
import { createRecentsStore } from "../main/recents-store";
import { createTrashStore } from "../main/trash-store";
import { createVersionFamilyService, DEFAULT_SCAN_INTERVAL_MINUTES, type VersionFamilyService } from "../main/version-family-service";
import { createFileVersionFamilyStore } from "../main/version-family-store";
import type { WatchBackend } from "../main/watch-backend";
import { lookupDefaultApp } from "../preview/node/default-app";

/** The Electron-only operations the worker asks the main process for. */
export interface FsWorkerHost {
	readonly shell: FsShell;
	readonly clipboard: FsOsClipboard;
	readonly icons: IconProvider;
}

export interface FsWorkerServiceDeps {
	readonly config: FsWorkerConfig;
	readonly host: FsWorkerHost;
	/** Sends one push to every renderer client. */
	readonly broadcast: (name: string, payload: unknown) => void;
	/** Defaults to `@parcel/watcher`, loaded on the first watch; tests inject a fake. */
	readonly watchBackend?: WatchBackend;
	/** Defaults to the platform file-name index; tests inject a stub. */
	readonly fileNameSearch?: FileNameSearchBackend;
	/** Defaults to the OS places; tests inject a fixture. */
	readonly places?: Places;
	/** Defaults to the real dupey scanner; tests inject a stub. */
	readonly versionFamilies?: (deps: { readonly onChanged: () => void; readonly intervalMinutes: () => number }) => VersionFamilyService;
}

export interface FsWorkerService {
	readonly handlers: Readonly<Record<Exclude<FsWorkerOp, "diagnostics">, WorkerHandler>>;
	/** Release every native watch and stop the timers; resolves once the watcher has unsubscribed. */
	dispose(): Promise<void>;
	/** QA only: ingest an overflow batch for `dir`, as if the watcher had lost its events. */
	readonly qaOverflow: WorkerHandler;
	/**
	 * QA only: hold the named enrichment ops (`enrichEntries`,
	 * `finderMetadata`) for targets under `prefix`, so a lane can read a
	 * listing's heap without those passes racing it. Returns how many requests
	 * already wait.
	 */
	readonly qaHoldEnrichment: WorkerHandler;
	/** QA only: answer the held ops (all of them when none is named); returns how many were waiting. */
	readonly qaReleaseEnrichment: WorkerHandler;
}

function stringArg(args: readonly unknown[], index: number, label: string): string {
	const value = args[index];
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function numberArg(args: readonly unknown[], index: number, label: string): number {
	const value = args[index];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
	return value;
}

function stringsArg(args: readonly unknown[], index: number, label: string): readonly string[] {
	const value = args[index];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${label} must be an array of strings`);
	return value;
}

function isEnrichmentTarget(value: unknown): value is FsEnrichmentTarget {
	return (
		typeof value === "object" &&
		value !== null &&
		"path" in value &&
		typeof value.path === "string" &&
		"kind" in value &&
		(value.kind === "file" || value.kind === "folder") &&
		"ext" in value &&
		typeof value.ext === "string" &&
		"mtimeMs" in value &&
		typeof value.mtimeMs === "number" &&
		Number.isFinite(value.mtimeMs)
	);
}

function targetsArg(args: readonly unknown[]): readonly FsEnrichmentTarget[] {
	const value = args[0];
	if (!Array.isArray(value) || !value.every(isEnrichmentTarget)) throw new TypeError("targets must be enrichment targets");
	return value;
}

function searchOptionsArg(value: unknown): FsSearchOptions | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "object" && "scope" in value && typeof value.scope === "string") return { scope: value.scope };
	return {};
}

function clipboardArg(value: unknown): FsClipboard {
	if (
		typeof value === "object" &&
		value !== null &&
		"op" in value &&
		(value.op === "copy" || value.op === "cut") &&
		"paths" in value &&
		Array.isArray(value.paths) &&
		value.paths.every((path) => typeof path === "string")
	) {
		return { op: value.op, paths: value.paths };
	}
	throw new TypeError("clipboard must be { op, paths }");
}

function tagChangeArg(value: unknown): FsTagChange {
	if (
		typeof value === "object" &&
		value !== null &&
		"add" in value &&
		Array.isArray(value.add) &&
		value.add.every((name) => typeof name === "string") &&
		"remove" in value &&
		Array.isArray(value.remove) &&
		value.remove.every((name) => typeof name === "string")
	) {
		return { add: value.add, remove: value.remove };
	}
	throw new TypeError("tag change must be { add, remove }");
}

export function createFsWorkerService(deps: FsWorkerServiceDeps): FsWorkerService {
	const { config, host } = deps;
	const places =
		deps.places ??
		createPlaces(process.platform === "win32" && config.knownFolders !== undefined ? { knownFolders: config.knownFolders } : {});
	// Filename search rides the platform index (fsearch / Everything); the
	// disk walk stays as the fallback when no index answers.
	const fileNameSearch =
		deps.fileNameSearch ?? createFileNameSearch({ userDataDir: config.userDataDir, locations: () => fsService.locations() });
	const fsService = createFsService({
		shell: host.shell,
		clipboard: host.clipboard,
		icons: host.icons,
		places,
		fileNameSearch,
		recents: createRecentsStore({ directory: join(config.userDataDir, "recents") }),
		trashStore: createTrashStore({ directory: join(config.userDataDir, "trash") }),
		...(config.qaRoot === undefined ? {} : { qaRoot: config.qaRoot }),
	});
	let scanIntervalMinutes = DEFAULT_SCAN_INTERVAL_MINUTES;
	let hub: ChangeHub | null = null;
	const familyDeps = { onChanged: () => hub?.publish(DUPEY_LAYER_ID), intervalMinutes: () => scanIntervalMinutes };
	const versionFamilies =
		deps.versionFamilies?.(familyDeps) ??
		createVersionFamilyService({
			...familyDeps,
			locations: () => fsService.locations(),
			store: createFileVersionFamilyStore(join(config.userDataDir, "dupey-cache")),
			buildEntry: buildFsEntry,
		});
	const liveHub = createChangeHub({ send: (message: LiveMessage) => deps.broadcast(FS_WORKER_PUSH.live, message) });
	hub = liveHub;
	liveHub.register(createDupeyLayer(versionFamilies));
	const watch = createFsWatchService({
		backend: deps.watchBackend ?? lazyParcelBackend(),
		onBatch: (batch) => liveHub.ingest(batch),
	});
	const indexStatus = createIndexStatusService({
		env: process.env,
		cwd: process.cwd(),
		onRefreshed: (error) => deps.broadcast(FS_WORKER_PUSH.indexRefreshed, error),
	});
	// A volume mounting or a cloud account connecting re-renders the sidebar.
	const stopPlacesWatch = places.watch(() => deps.broadcast(FS_WORKER_PUSH.locationsChanged, null));
	void versionFamilies.start();
	// Warm the file-name index daemon (fsearch watch / Everything) so the first
	// search never pays the database cold-load. It is deliberately left running
	// across quits: restarting a watch over a whole-machine index re-scans every
	// monitored folder, which is exactly the cost this keep-alive avoids.
	void fileNameSearch.ensureDaemon();

	/**
	 * QA lanes only: the enrichment ops a lane is holding, the path prefix they
	 * are held for, and the requests already waiting. A held op that has not
	 * been released simply never answers (the lane quits first), which is how
	 * the 10k-file lane keeps the Finder metadata pass from spawning helpers
	 * for minutes.
	 */
	let heldPrefix: string | null = null;
	const heldOps = new Set<string>();
	const heldReleases: Array<{ readonly op: string; readonly release: () => void }> = [];
	const holdWhileTesting = (op: string, run: WorkerHandler): WorkerHandler => async (args, signal) => {
		if (heldPrefix !== null && heldOps.has(op)) {
			const prefix = heldPrefix;
			const targets = targetsArg(args);
			if (targets.some((target) => target.path.startsWith(prefix))) {
				await new Promise<void>((release) => heldReleases.push({ op, release }));
			}
		}
		return run(args, signal);
	};

	const handlers: Record<Exclude<FsWorkerOp, "diagnostics" | "qaOverflow">, WorkerHandler> = {
		listDir: (args, signal) => fsService.listDir(stringArg(args, 0, "path"), signal),
		readEntries: (args) => fsService.readEntries(stringArg(args, 0, "dir"), stringsArg(args, 1, "paths")),
		enrichEntries: holdWhileTesting("enrichEntries", (args) => fsService.enrichEntries(targetsArg(args), args[1] === true)),
		finderMetadata: holdWhileTesting("finderMetadata", (args) => fsService.finderMetadata(targetsArg(args))),
		stat: (args) => fsService.stat(stringArg(args, 0, "path")),
		details: (args) => fsService.details(stringArg(args, 0, "path")),
		previewIcon: (args) => fsService.previewIcon(stringArg(args, 0, "path"), numberArg(args, 1, "mtimeMs")),
		exists: (args) => fsService.exists(stringArg(args, 0, "path")),
		search: (args, signal) => fsService.search(stringArg(args, 0, "query"), searchOptionsArg(args[1]), signal),
		locations: () => fsService.locations(),
		tags: () => fsService.tags(),
		setTags: (args) => fsService.setTags(stringsArg(args, 0, "paths"), tagChangeArg(args[1])),
		ejectLocation: (args) => fsService.ejectLocation(stringArg(args, 0, "path")),
		copy: (args) => fsService.copy(stringsArg(args, 0, "paths"), stringArg(args, 1, "destDir")),
		move: (args) => fsService.move(stringsArg(args, 0, "paths"), stringArg(args, 1, "destDir")),
		duplicate: (args) => fsService.duplicate(stringsArg(args, 0, "paths")),
		rename: (args) => fsService.rename(stringArg(args, 0, "path"), stringArg(args, 1, "newName")),
		createFolder: (args) => fsService.createFolder(stringArg(args, 0, "directory")),
		createFile: (args) => {
			const format = args[1];
			if (typeof format !== "string" || !isNewFileFormatId(format)) throw new Error(t("main.worker.unknownFormat", { format: String(format) }));
			return fsService.createFile(stringArg(args, 0, "directory"), format);
		},
		createEvidenceFolder: (args) =>
			fsService.createEvidenceFolder(
				stringsArg(args, 0, "paths"),
				typeof args[1] === "string" ? args[1] : undefined,
			),
		removeEvidenceFolder: (args) => fsService.removeEvidenceFolder(stringArg(args, 0, "folderPath")),
		trash: async (args) => {
			const result = await fsService.trash(stringsArg(args, 0, "paths"));
			if (result.ok.length > 0) {
				// A deleted duplicate must leave the version-family snapshot at once.
				// The move to the Trash already happened; a stale snapshot must not
				// turn into a failed delete for the caller.
				await versionFamilies.removePaths(result.ok).catch((error: unknown) => console.error("trash follow-up failed", error));
			}
			return result;
		},
		restoreFromTrash: (args) => fsService.restoreFromTrash(stringsArg(args, 0, "paths")),
		emptyTrash: () => fsService.emptyTrash(),
		reveal: (args) => fsService.reveal(stringArg(args, 0, "path")),
		quickLook: (args) => fsService.quickLook(stringArg(args, 0, "path")),
		open: (args) => fsService.open(stringArg(args, 0, "path")),
		openUrl: (args) => {
			if (typeof args[0] !== "string") throw new Error(t("main.worker.invalidUrl"));
			return fsService.openUrl(args[0]);
		},
		clipboardSet: (args) => fsService.clipboardSet(clipboardArg(args[0])),
		clipboardGet: () => fsService.clipboardGet(),
		undo: () => fsService.undo(),
		redo: () => fsService.redo(),
		recordCreated: (args) => {
			const operation = args[1];
			if (operation !== "extract" && operation !== "compress") throw new TypeError("operation must be extract or compress");
			return fsService.recordCreated(stringArg(args, 0, "path"), operation);
		},
		copyPathsToClipboard: (args) => fsService.copyPathsToClipboard(stringsArg(args, 0, "paths")),
		versionFamilies: () => versionFamilies.result(),
		refreshVersionFamilies: () => versionFamilies.refresh(),
		setScanInterval: (args) => {
			if (typeof args[0] !== "number" || !Number.isFinite(args[0])) throw new TypeError("interval must be a number of minutes");
			scanIntervalMinutes = args[0];
			versionFamilies.reschedule();
		},
		setLanguage: async (args) => {
			if (!isAppLanguage(args[0])) throw new TypeError("language must be ko, en, ja, or zh");
			await setAppLanguage(args[0]);
		},
		indexStatus: (args) => indexStatus.indexStatus(stringsArg(args, 0, "paths")),
		setIndexExcluded: (args) => {
			if (typeof args[1] !== "boolean") throw new TypeError("excluded must be a boolean");
			return indexStatus.setIndexExcluded(stringArg(args, 0, "path"), args[1]);
		},
		setWatchSet: (args) => watch.setWatchSet(stringsArg(args, 0, "dirs")),
		layers: () => {
			if (process.env.AUTORAG_FS_WATCH_DIAG === "1") console.info("[live] layers requested");
			return liveHub.resync();
		},
		defaultApp: (args) => lookupDefaultApp(stringArg(args, 0, "path")),
	};

	return {
		handlers,
		qaOverflow: (args) => liveHub.ingest({ dir: stringArg(args, 0, "dir"), changes: [], overflow: true, dirGone: false }),
		qaHoldEnrichment: (args) => {
			heldPrefix = stringArg(args, 0, "prefix");
			const ops = Array.isArray(args[1]) ? args[1].filter((op): op is string => typeof op === "string") : [];
			heldOps.clear();
			for (const op of ops.length > 0 ? ops : ["enrichEntries", "finderMetadata"]) heldOps.add(op);
			return heldReleases.length;
		},
		qaReleaseEnrichment: (args) => {
			const named = Array.isArray(args[0]) ? new Set(args[0].filter((op): op is string => typeof op === "string")) : new Set<string>();
			const releasing = named.size > 0 ? named : new Set(heldOps);
			for (const op of releasing) heldOps.delete(op);
			// Keep the prefix while another op stays held; a later hold sets it again.
			if (heldOps.size === 0) heldPrefix = null;
			let released = 0;
			for (const waiting of [...heldReleases]) {
				if (!releasing.has(waiting.op)) continue;
				heldReleases.splice(heldReleases.indexOf(waiting), 1);
				waiting.release();
				released += 1;
			}
			return released;
		},
		async dispose() {
			stopPlacesWatch();
			versionFamilies.stop();
			// The index daemon (Everything / fsearch) is a separate OS process that
			// outlives the app unless asked to exit; left running it pins userData.
			// `stop()` reports its own failures, so it cannot block the watch release.
			await Promise.all([watch.dispose(), fileNameSearch.stop(), fsService.disposeEvidenceFolders?.() ?? Promise.resolve()]);
		},
	};
}

/**
 * `@parcel/watcher` is a native module: load it on the first watch, so a
 * worker that never watches (a test, a crash-looping start) never maps it.
 */
function lazyParcelBackend(): WatchBackend {
	let backend: Promise<WatchBackend> | null = null;
	return {
		async subscribe(dir, onEvents, onError) {
			backend ??= import("../main/watch-backend").then((module) => module.createParcelWatchBackend());
			return (await backend).subscribe(dir, onEvents, onError);
		},
	};
}
