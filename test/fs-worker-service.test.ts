import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsWorkerService, type FsWorkerService } from "../src/fs-worker/service";
import type { DirListing, FsBatchResult, FsLocation } from "../src/shared/fs-contract";
import { FS_WORKER_PUSH } from "../src/shared/fs-worker-protocol";
import type { FsChange, LiveMessage } from "../src/shared/live-contract";
import type { Places } from "../src/main/places";
import type { VersionFamilyService } from "../src/main/version-family-service";
import type { WatchBackend } from "../src/main/watch-backend";

const places: Places = {
	list: async (): Promise<readonly FsLocation[]> => [],
	eject: async () => {},
	signature: async () => "",
	watch: () => () => {},
	trashDir: async () => null,
};

/** A dupey service that never scans: the worker only wires it into the hub here. */
const noFamilies: VersionFamilyService = {
	result: async () => ({ families: [], scannedAt: null, error: null }),
	refresh: async () => ({ families: [], scannedAt: null, error: null }),
	start: async () => ({ families: [], scannedAt: null, error: null }),
	stop: () => {},
	reschedule: () => {},
	removePaths: async () => ({ families: [], scannedAt: null, error: null }),
	reverify: async () => false,
	applyDirChanges: async () => false,
};

/** A watch backend the test drives by hand, recording live subscriptions. */
function fakeWatcher(): WatchBackend & { readonly live: Set<string>; emit(dir: string, events: readonly FsChange[]): void } {
	const listeners = new Map<string, (events: readonly FsChange[]) => void>();
	const live = new Set<string>();
	return {
		live,
		emit: (dir, events) => listeners.get(dir)?.(events),
		async subscribe(dir, onEvents) {
			listeners.set(dir, onEvents);
			live.add(dir);
			return async () => {
				listeners.delete(dir);
				live.delete(dir);
			};
		},
	};
}

let root: string;
let service: FsWorkerService | null = null;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "autorag-fs-worker-")));
});

afterEach(async () => {
	await service?.dispose();
	service = null;
	await rm(root, { recursive: true, force: true });
});

function start(watcher: WatchBackend, onPush: (name: string, payload: unknown) => void = () => {}, trashDir?: string): FsWorkerService {
	service = createFsWorkerService({
		config: { userDataDir: join(root, "user-data") },
		host: {
			shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => "", openExternal: async () => {} },
			clipboard: { writeText: () => {}, writeFiles: async () => {} },
			icons: { icons: async () => new Map(), preview: async () => null },
		},
		broadcast: onPush,
		watchBackend: watcher,
		places: trashDir === undefined ? places : { ...places, trashDir: async () => trashDir },
		fileNameSearch: { search: async () => null, ensureDaemon: async () => {}, stop: async () => {} },
		versionFamilies: () => noFamilies,
	});
	return service;
}

describe("fs worker service", () => {
	it("lists a folder, pushes its live change, and releases the watch on dispose", async () => {
		const dir = join(root, "folder");
		await mkdir(dir);
		await writeFile(join(dir, "a.txt"), "a");
		const watcher = fakeWatcher();
		const delivered = Promise.withResolvers<LiveMessage>();
		const worker = start(watcher, (name, payload) => {
			// The worker only pushes LiveMessages on this name.
			if (name === FS_WORKER_PUSH.live) delivered.resolve(payload as LiveMessage);
		});
		const signal = new AbortController().signal;

		const listing = (await worker.handlers.listDir([dir], signal)) as DirListing;
		expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt"]);

		await worker.handlers.setWatchSet([[dir]], signal);
		expect([...watcher.live]).toEqual([dir]);
		watcher.emit(dir, [{ path: join(dir, "b.txt"), type: "create" }]);
		const message = await delivered.promise;
		expect(message.dirs).toEqual([{ dir, changes: [{ path: join(dir, "b.txt"), type: "create" }], overflow: false, dirGone: false }]);

		await worker.dispose();
		service = null;
		expect(watcher.live.size).toBe(0);
	});

	it("answers the remote upload and download ops through the worker's own handler table", async () => {
		// Given a worker and a destination folder.
		const dir = join(root, "remote-ops");
		await mkdir(dir, { recursive: true });
		const worker = start(fakeWatcher());
		const signal = new AbortController().signal;

		// When a browser upload writes bytes and a download reads them back.
		const created = (await worker.handlers.uploadFile([dir, "up.txt", new Uint8Array([104, 105])], signal)) as { path: string; name: string };
		const bytes = (await worker.handlers.readFile([created.path], signal)) as Uint8Array | null;

		// Then the file is on disk under its name and the bytes come back.
		expect(created.name).toBe("up.txt");
		expect(await readFile(created.path, "utf8")).toBe("hi");
		expect(Buffer.from(bytes ?? []).toString("utf8")).toBe("hi");
		await worker.dispose();
		service = null;
	});

	it("rejects an upload whose bytes did not arrive as bytes", async () => {
		// Given a worker and a folder.
		const dir = join(root, "remote-ops-bad");
		await mkdir(dir, { recursive: true });
		const worker = start(fakeWatcher());
		const signal = new AbortController().signal;

		// When a caller passes something that is not a byte array.
		// Then the handler refuses it instead of writing a corrupt file.
		expect(() => worker.handlers.uploadFile([dir, "up.txt", "hi"], signal)).toThrow(TypeError);
		await worker.dispose();
		service = null;
	});

	it("stops a listing whose caller went away instead of reading the rest of the folder", async () => {
		const dir = join(root, "big");
		await mkdir(dir);
		await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(dir, `f-${index}.txt`), "x")));
		const worker = start(fakeWatcher());
		const controller = new AbortController();
		controller.abort();
		await expect(worker.handlers.listDir([dir], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});

	it("refuses malformed arguments at the boundary", async () => {
		const worker = start(fakeWatcher());
		const signal = new AbortController().signal;
		expect(() => worker.handlers.listDir([42], signal)).toThrow("path must be a string");
		expect(() => worker.handlers.setWatchSet([["/ok", 3]], signal)).toThrow("dirs must be an array of strings");
		expect(() => worker.handlers.createFile(["/d", "exe"], signal)).toThrow("알 수 없는 파일 형식입니다: exe");
	});

	it("restores from and empties the Trash through the trash location's folder", async () => {
		// Given a Trash folder holding one payload (Windows only treats `$R…`/`$I…` names as payloads)
		const payload = process.platform === "win32" ? "$Ra.txt" : "a.txt";
		const trashDir = join(root, "trash");
		await mkdir(trashDir);
		await writeFile(join(trashDir, payload), "x");
		const worker = start(fakeWatcher(), undefined, trashDir);
		const signal = new AbortController().signal;

		// When emptying
		const emptied = (await worker.handlers.emptyTrash([], signal)) as FsBatchResult;

		// Then the payload was deleted for good, and restoring a payload with no origin reports why
		expect(emptied.ok).toEqual([join(trashDir, payload)]);
		expect(emptied.failed).toEqual([]);
		await expect(worker.handlers.restoreFromTrash([[join(trashDir, payload)]], signal)).resolves.toMatchObject({
			ok: [],
			failed: [{ message: expect.stringContaining("원래 위치를 알 수 없습니다") }],
		});
	});

	it("stops the filename-index daemon on dispose so it cannot outlive the app", async () => {
		// Given a worker whose index daemon is running
		let stops = 0;
		const worker = createFsWorkerService({
			config: { userDataDir: join(root, "user-data") },
			host: {
				shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => "", openExternal: async () => {} },
				clipboard: { writeText: () => {}, writeFiles: async () => {} },
				icons: { icons: async () => new Map(), preview: async () => null },
			},
			broadcast: () => {},
			watchBackend: fakeWatcher(),
			places,
			fileNameSearch: {
				search: async () => null,
				ensureDaemon: async () => {},
				stop: async () => {
					stops += 1;
				},
			},
			versionFamilies: () => noFamilies,
		});

		// When the app quits
		await worker.dispose();

		// Then the daemon was asked to exit
		expect(stops).toBe(1);
	});

	it("creates an Evidence Folder via worker handler and removes any remaining ones on dispose", async () => {
		const src = join(root, "doc.md");
		await writeFile(src, "evidence text");
		const worker = start(fakeWatcher());
		const signal = new AbortController().signal;

		const folderPath = (await worker.handlers.createEvidenceFolder([[src], "Evidence Folder"], signal)) as string;
		const listing = (await worker.handlers.listDir([folderPath], signal)) as DirListing;
		expect(listing.entries.map((e) => e.name)).toEqual(["doc.md"]);

		await worker.dispose();
		service = null;
		await expect(access(folderPath)).rejects.toThrow();
	});
});
