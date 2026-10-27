import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirListing, FsLocation } from "../src/shared/fs-contract";
import type { Places } from "../src/main/places";
import type { VersionFamilyService } from "../src/main/version-family-service";

// The fs worker answers folder listings, and loading the librarian (~1.9 s on Windows, ~0.5 s on a Mac, all of it on the
// event loop) before the first listing is what put the first row 3.5 s behind the window. These stand-ins throw on
// load, so the worker's own module graph cannot reach the librarian or its heaviest dependencies again.
vi.mock("@autorag/librarian", () => {
	throw new Error("@autorag/librarian must not load in the fs worker thread");
});
vi.mock("@autorag/librarian/core", () => {
	throw new Error("@autorag/librarian/core must not load in the fs worker thread");
});
vi.mock("@earendil-works/pi-coding-agent", () => {
	throw new Error("@earendil-works/pi-coding-agent must not load in the fs worker thread");
});
vi.mock("kordoc", () => {
	throw new Error("kordoc must not load in the fs worker thread");
});

const places: Places = {
	list: async (): Promise<readonly FsLocation[]> => [],
	eject: async () => {},
	signature: async () => "",
	watch: () => () => {},
	trashDir: async () => null,
};

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

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "autorag-fs-worker-graph-")));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("the fs worker's module graph", () => {
	it("imports and lists a folder without loading the librarian", async () => {
		// Given the worker service, loaded while the librarian refuses to load
		const { createFsWorkerService } = await import("../src/fs-worker/service");
		const dir = join(root, "folder");
		await mkdir(dir);
		await writeFile(join(dir, "a.txt"), "a");
		const worker = createFsWorkerService({
			config: { userDataDir: join(root, "user-data") },
			host: {
				shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => "", openExternal: async () => {} },
				clipboard: { writeText: () => {} },
				icons: { icons: async () => new Map(), preview: async () => null },
			},
			broadcast: () => {},
			watchBackend: { subscribe: async () => async () => {} },
			places,
			fileNameSearch: { search: async () => null, ensureDaemon: async () => {}, stop: async () => {} },
			versionFamilies: () => noFamilies,
		});

		// When a folder is listed
		const listing = (await worker.handlers.listDir([dir], new AbortController().signal)) as DirListing;

		// Then it answered, and nothing in the graph tried to load the librarian
		expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
		await worker.dispose();
	});
});
