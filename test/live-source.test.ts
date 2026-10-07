import { describe, expect, it, vi } from "vitest";
import type {
	FsBatchResult,
	FsBridge,
	FsClipboard,
	FsEntry,
	FsLocation,
	FsSearchResult,
	FsVersionFamiliesResult,
} from "../src/shared/fs-contract";
import type { LiveBridge, LiveMessage } from "../src/shared/live-contract";
import {
	createBridgeSource,
	createFixtureSource,
	isMissingPathFailure,
} from "../src/renderer/src/data/source";

function fsEntry(path: string): FsEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "txt",
		size: 1,
		modifiedAt: "2026-09-30T00:00:00.000Z",
		isSymlink: false,
		osKind: null,
		iconUrl: null,
	};
}

function familyResult(): FsVersionFamiliesResult {
	return {
		families: [{
			head: "/tmp/head.txt",
			members: [{ path: "/tmp/member.txt", relation: "exact" }],
			entries: [fsEntry("/tmp/head.txt"), fsEntry("/tmp/member.txt")],
		}],
		scannedAt: "2026-09-30T00:00:00.000Z",
		error: null,
	};
}

function fakeFs(result: FsVersionFamiliesResult): FsBridge {
	const noResult = async (): Promise<never> => {
		throw new Error("unused");
	};
	const batch = async (): Promise<FsBatchResult> => ({ ok: [], failed: [] });
	const clipboardGet = async (): Promise<FsClipboard | null> => null;
	const locations = async (): Promise<readonly FsLocation[]> => [];
	const search = async (): Promise<readonly FsSearchResult[]> => [];
	return {
		listDir: noResult,
		enrichEntries: async () => [],
		finderMetadata: async () => [],
		readEntries: async () => ({ entries: [], removed: [] }),
		stat: async (path) => fsEntry(path),
		details: noResult,
		previewIcon: async () => null,
		exists: async () => true,
		search,
		locations,
		ejectLocation: async () => {},
		copy: batch,
		move: batch,
		duplicate: async () => ({ ok: [], failed: [] }),
		rename: async (path, name) => fsEntry(`${path}/${name}`),
		createFolder: async (directory) => ({ path: `${directory}/untitled folder`, name: "untitled folder" }),
		createFile: async (directory, format) => ({ path: `${directory}/untitled.${format}`, name: `untitled.${format}` }),
		trash: batch,
		reveal: async () => {},
		quickLook: async () => {},
		open: async () => {},
		openUrl: async () => {},
		clipboardSet: async () => {},
		clipboardGet,
		undo: async () => ({ ok: false, empty: true, failed: [] }),
		copyPathsToClipboard: async () => {},
		startDrag: () => {},
		versionFamilies: async () => result,
		refreshVersionFamilies: async () => result,
		indexStatus: async (paths) =>
			paths.map((path) => ({ path, kind: "included" as const, excluded: false, toggleable: true, detail: "" })),
		setIndexExcluded: async (path, excluded) => ({
			path,
			kind: excluded ? ("excluded" as const) : ("included" as const),
			excluded,
			toggleable: true,
			detail: "",
		}),
	};
}

describe("live Finder source adapters", () => {
	it("forwards watch sets, relays live messages, unsubscribes, and maps dupey layers", async () => {
		const message: LiveMessage = { seq: 1, dirs: [], layers: [], reconciled: [] };
		const liveUnsubscribe = vi.fn();
		const live: LiveBridge = {
			setWatchSet: vi.fn(async () => {}),
			layers: vi.fn(async () => ({
				seq: 2,
				reconciled: ["dupey"],
				layers: [{ layer: "dupey", version: 3, data: familyResult() }],
			})),
			onMessage: vi.fn((listener) => {
				listener(message);
				return liveUnsubscribe;
			}),
			onReconnect: () => () => {},
		};
		const source = createBridgeSource(fakeFs(familyResult()), "", live);
		await source.setWatchSet(["/tmp"]);
		expect(live.setWatchSet).toHaveBeenCalledWith(["/tmp"]);

		const received: LiveMessage[] = [];
		const unsubscribe = source.onLive((next) => received.push(next));
		expect(received).toEqual([message]);
		expect(live.onMessage).toHaveBeenCalledOnce();
		unsubscribe();
		expect(liveUnsubscribe).toHaveBeenCalledOnce();

		const resync = await source.liveLayers();
		expect(resync.layers[0]?.data).toEqual({
			families: [{
				head: "/tmp/head.txt",
				members: [{ path: "/tmp/member.txt", relation: "exact" }],
				entriesByPath: expect.objectContaining({
					"/tmp/member.txt": expect.objectContaining({ path: "/tmp/member.txt" }),
				}),
			}],
			scannedAt: "2026-09-30T00:00:00.000Z",
			error: null,
		});
	});

	it("fixture exists reports directories and tree members", async () => {
		const source = createFixtureSource();
		await expect(source.exists("Desktop")).resolves.toBe(true);
		await expect(source.exists("Desktop/주간보고_0919.pptx")).resolves.toBe(true);
		await expect(source.exists("Desktop/missing.txt")).resolves.toBe(false);
	});

	it("forwards missing-path values and rethrows non-missing errors verbatim", async () => {
		const denied = new Error("EACCES: permission denied");
		const result = familyResult();
		const missingFs = fakeFs(result);
		missingFs.stat = async () => {
			throw new Error("Error invoking remote method 'fs:stat': ENOENT");
		};
		missingFs.exists = vi.fn(async () => false);
		const missingSource = createBridgeSource(missingFs, "");
		await expect(missingSource.exists("/tmp/gone")).resolves.toBe(false);
		await expect(missingFs.stat("/tmp/gone")).rejects.toThrow("ENOENT");
		await expect(isMissingPathFailure(missingSource, "/tmp/gone")).resolves.toBe(true);

		const deniedFs = fakeFs(result);
		deniedFs.exists = vi.fn(async () => {
			throw denied;
		});
		const deniedSource = createBridgeSource(deniedFs, "");
		await expect(deniedSource.exists("/tmp/denied")).rejects.toBe(denied);
	});

	it("detects a vanished folder after a plain Electron-style list error", async () => {
		const source = createBridgeSource(
			{
				...fakeFs(familyResult()),
				listDir: async () => {
					throw new Error("Error invoking remote method 'fs:listDir': ENOENT");
				},
				exists: async () => false,
			},
			"",
		);
		await expect(source.list("/tmp/gone")).rejects.toThrow("ENOENT");
		await expect(isMissingPathFailure(source, "/tmp/gone")).resolves.toBe(true);
	});

	it("bridge readEntries maps rows to the requested dir and passes removals through", async () => {
		const fs = {
			...fakeFs(familyResult()),
			readEntries: vi.fn(async () => ({ entries: [fsEntry("/tmp/dir/added.txt")], removed: ["/tmp/dir/gone.txt"] })),
		};
		const source = createBridgeSource(fs, "");

		const patch = await source.readEntries("/tmp/dir", ["/tmp/dir/added.txt", "/tmp/dir/gone.txt"]);

		expect(fs.readEntries).toHaveBeenCalledWith("/tmp/dir", ["/tmp/dir/added.txt", "/tmp/dir/gone.txt"]);
		expect(patch.entries.map((entry) => entry.path)).toEqual(["/tmp/dir/added.txt"]);
		expect(patch.entries[0]?.location).toBe("/tmp/dir");
		expect(patch.removed).toEqual(["/tmp/dir/gone.txt"]);
	});

	it("bridge readEntries surfaces real errors verbatim", async () => {
		const failure = new Error("EACCES: permission denied");
		const fs = {
			...fakeFs(familyResult()),
			readEntries: async () => {
				throw failure;
			},
		};
		const source = createBridgeSource(fs, "");

		await expect(source.readEntries("/tmp/dir", [])).rejects.toBe(failure);
	});

	it("fixture readEntries returns existing children and removes absent ones", async () => {
		const source = createFixtureSource();
		const dir = "Documents/Finance/2026 Q3";

		const patch = await source.readEntries(dir, [
			`${dir}/Q3_마케팅예산_v3.xlsx`,
			`${dir}/missing.xlsx`,
			`${dir}/Q3_마케팅예산_v3.xlsx`,
		]);

		expect(patch.entries.map((entry) => entry.name)).toEqual(["Q3_마케팅예산_v3.xlsx"]);
		expect(patch.entries[0]?.location).toBe(dir);
		expect(patch.removed).toEqual([`${dir}/missing.xlsx`]);
	});

	it("fixture readEntries rejects a path outside the requested dir", async () => {
		const source = createFixtureSource();

		await expect(source.readEntries("Desktop", ["Documents/x.txt"])).rejects.toThrow(/direct child/);
	});

	it("fixture undo reverses the most recent copy and the most recent move", async () => {
		const source = createFixtureSource();

		// Given a file copied from Desktop into Documents
		await source.copyInto(["Desktop/회의록_0922.md"], "Documents");
		expect(await source.exists("Documents/회의록_0922.md")).toBe(true);

		// When undoing the copy
		expect(await source.undo()).toEqual({ ok: true, empty: false, failed: [] });

		// Then the copy is gone and the original stays
		expect(await source.exists("Documents/회의록_0922.md")).toBe(false);
		expect(await source.exists("Desktop/회의록_0922.md")).toBe(true);

		// Given a file moved from Desktop into Documents
		await source.moveInto(["Desktop/Q3_캠페인_브리프_초안.docx"], "Documents");
		expect(await source.exists("Desktop/Q3_캠페인_브리프_초안.docx")).toBe(false);

		// When undoing the move
		expect(await source.undo()).toEqual({ ok: true, empty: false, failed: [] });

		// Then the file is back in its original folder
		expect(await source.exists("Desktop/Q3_캠페인_브리프_초안.docx")).toBe(true);
		expect(await source.exists("Documents/Q3_캠페인_브리프_초안.docx")).toBe(false);
	});

	it("fixture undo reports empty when nothing was transferred", async () => {
		const source = createFixtureSource();
		await expect(source.undo()).resolves.toEqual({ ok: false, empty: true, failed: [] });
	});

	it("bridge source undo forwards to the fs bridge", async () => {
		const undoCalls: number[] = [];
		const fs = {
			...fakeFs(familyResult()),
			undo: async () => {
				undoCalls.push(1);
				return { ok: true, empty: false, failed: [] };
			},
		};
		const source = createBridgeSource(fs, "");

		await expect(source.undo()).resolves.toEqual({ ok: true, empty: false, failed: [] });
		expect(undoCalls).toHaveLength(1);
	});
});
