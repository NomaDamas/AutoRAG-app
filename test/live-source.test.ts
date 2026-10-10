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
import { locationOf } from "../src/renderer/src/state/entry-values";

function fsEntry(path: string): FsEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "txt",
		size: 1,
		mtimeMs: Date.parse("2026-09-30T00:00:00.000Z"),
		flags: 0,
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
		tags: async () => ({ supported: false, tags: [], colorNames: [] }),
		setTags: batch,
		ejectLocation: async () => {},
		copy: batch,
		move: batch,
		duplicate: async () => ({ ok: [], failed: [] }),
		rename: async (path, name) => fsEntry(`${path}/${name}`),
		createFolder: async (directory) => ({ path: `${directory}/untitled folder`, name: "untitled folder" }),
		createFile: async (directory, format) => ({ path: `${directory}/untitled.${format}`, name: `untitled.${format}` }),
		trash: batch,
		restoreFromTrash: batch,
		emptyTrash: batch,
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
		expect(locationOf(patch.entries[0]!)).toBe("/tmp/dir");
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
		expect(locationOf(patch.entries[0]!)).toBe(dir);
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

	it("fixture trash keeps a row restorable: ⌘Z moves it straight back", async () => {
		// Given a Desktop file trashed through the source
		const source = createFixtureSource();
		await source.trash(["Desktop/회의록_0922.md"]);
		expect(await source.exists("Desktop/회의록_0922.md")).toBe(false);

		// When undoing the trash
		expect(await source.undo()).toEqual({ ok: true, empty: false, failed: [] });

		// Then the row is back in its folder
		expect(await source.exists("Desktop/회의록_0922.md")).toBe(true);
	});

	it("fixture restores from the Trash view, and undo moves the row back in", async () => {
		// Given a trashed file the Trash view lists
		const source = createFixtureSource();
		await source.trash(["Desktop/회의록_0922.md"]);
		const listing = await source.list("Trash");
		const trashPath = listing.find((entry) => entry.name === "회의록_0922.md")?.path;
		expect(trashPath).toBe("Trash/회의록_0922.md");

		// When putting the payload back
		const result = await source.restoreFromTrash([trashPath ?? ""]);

		// Then it returns to the original folder under its own name
		expect(result).toEqual({ ok: [trashPath], failed: [] });
		expect(await source.exists("Desktop/회의록_0922.md")).toBe(true);
		expect(await source.exists("Trash/회의록_0922.md")).toBe(false);

		// When undoing the restore
		expect(await source.undo()).toEqual({ ok: true, empty: false, failed: [] });

		// Then the payload is back in the Trash and restorable again
		expect(await source.exists("Desktop/회의록_0922.md")).toBe(false);
		expect(await source.exists("Trash/회의록_0922.md")).toBe(true);
	});

	it("fixture emptyTrash clears the Trash and consumes the trash undo record", async () => {
		// Given two trashed files
		const source = createFixtureSource();
		await source.trash(["Desktop/회의록_0922.md", "Desktop/주간보고_0919.pptx"]);

		// When emptying
		const result = await source.emptyTrash();

		// Then both payloads went, the Trash view is empty, and ⌘Z has nothing left
		expect([...result.ok].sort()).toEqual(["Trash/회의록_0922.md", "Trash/주간보고_0919.pptx"].sort());
		expect(result.failed).toEqual([]);
		expect(await source.list("Trash")).toEqual([]);
		expect(await source.exists("Trash/회의록_0922.md")).toBe(false);
		expect(await source.undo()).toEqual({ ok: false, empty: true, failed: [] });
	});

	it("fixture refuses restoring a payload the app never trashed", async () => {
		// Given a Trash path with no record
		const source = createFixtureSource();

		// When restoring it, Then the failure names the reason
		expect(await source.restoreFromTrash(["Trash/never-trashed.txt"])).toEqual({
			ok: [],
			failed: [{ path: "Trash/never-trashed.txt", message: expect.stringContaining("원래 위치를 알 수 없습니다") }],
		});
	});

	it("bridge source restore and empty forward to the fs bridge", async () => {
		// Given a bridge whose trash ops record their calls
		const restorePaths: string[][] = [];
		const emptied: number[] = [];
		const fs = {
			...fakeFs(familyResult()),
			restoreFromTrash: async (paths: readonly string[]) => {
				restorePaths.push([...paths]);
				return { ok: [...paths], failed: [] };
			},
			emptyTrash: async () => {
				emptied.push(1);
				return { ok: ["/.Trash/a.md"], failed: [] };
			},
		};
		const source = createBridgeSource(fs, "");

		// When restoring and emptying
		await expect(source.restoreFromTrash(["/.Trash/a.md"])).resolves.toEqual({ ok: ["/.Trash/a.md"], failed: [] });
		await expect(source.emptyTrash()).resolves.toEqual({ ok: ["/.Trash/a.md"], failed: [] });

		// Then both reached the bridge with their arguments
		expect(restorePaths).toEqual([["/.Trash/a.md"]]);
		expect(emptied).toHaveLength(1);
	});
});
