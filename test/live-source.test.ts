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
import { createBridgeSource, createFixtureSource } from "../src/renderer/src/data/source";

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
		iconDataUrl: null,
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
		stat: async (path) => fsEntry(path),
		search,
		locations,
		copy: batch,
		move: batch,
		duplicate: async () => ({ ok: [], failed: [] }),
		rename: async (path, name) => fsEntry(`${path}/${name}`),
		trash: batch,
		reveal: async () => {},
		quickLook: async () => {},
		open: async () => {},
		clipboardSet: async () => {},
		clipboardGet,
		copyPathsToClipboard: async () => {},
		versionFamilies: async () => result,
		refreshVersionFamilies: async () => result,
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
});
