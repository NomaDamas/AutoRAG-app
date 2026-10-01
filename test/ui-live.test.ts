import { describe, expect, it } from "vitest";
import type { FsDirChange } from "../src/shared/live-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	applyOptimisticDeletes,
	createListingLoader,
	nearestExistingAncestor,
	pruneSelection,
	watchSetFor,
	type ListingLoadRequest,
} from "../src/renderer/src/state/live";

function entry(path: string): FinderEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		fileKind: "md",
		iconDataUrl: null,
		dateLabel: "Sep 30, 00:00",
		sizeLabel: "1 B",
		kindLabel: "Plain Text",
		location: path.slice(0, path.lastIndexOf("/")) || path,
		modifiedValue: 0,
		sizeValue: 1,
	};
}

function dirChange(changes: FsDirChange["changes"]): FsDirChange {
	return { dir: "/Users/me/Documents", changes, overflow: false, dirGone: false };
}

function request(
	path: string,
	generation: number,
	mode: "navigate" | "silent",
	previous: readonly string[] = [],
): ListingLoadRequest<string> {
	return { path, generation, mode, previous };
}

describe("live renderer state", () => {
	it("builds a unique watch set without virtual paths", () => {
		expect(
			watchSetFor([
				{ path: "" },
				{ path: "Recents" },
				{ path: "Contacts" },
				{ path: "/Users/me/Documents" },
				{ path: "/Users/me/Documents" },
				{ path: "/Users/me/Desktop" },
			]),
		).toEqual(["/Users/me/Documents", "/Users/me/Desktop"]);
	});

	it("applies only delete events to the optimistic listing", () => {
		const rows = [entry("/Users/me/Documents/a.txt"), entry("/Users/me/Documents/b.txt")];
		const next = applyOptimisticDeletes(
			rows,
			dirChange([
				{ path: "/Users/me/Documents/a.txt", type: "delete" },
				{ path: "/Users/me/Documents/new.txt", type: "create" },
				{ path: "/Users/me/Documents/b.txt", type: "update" },
			]),
		);
		expect(next.map((row) => row.path)).toEqual(["/Users/me/Documents/b.txt"]);
	});

	it("prunes vanished keys, anchor, and focus", () => {
		expect(
			pruneSelection(
				{ keys: ["a", "b"], anchor: "a", focus: "b" },
				new Set(["b"]),
			),
		).toEqual({ keys: ["b"], anchor: null, focus: "b" });
	});

	it("returns the deepest existing ancestor", async () => {
		const checked: string[] = [];
		const existing = new Set(["/Users", "/Users/me", "/Users/me/Documents"]);
		await expect(
			nearestExistingAncestor("/Users/me/Documents/Missing/child", async (path) => {
				checked.push(path);
				return existing.has(path);
			}),
		).resolves.toBe("/Users/me/Documents");
		expect(checked).toEqual([
			"/Users/me/Documents/Missing/child",
			"/Users/me/Documents/Missing",
			"/Users/me/Documents",
		]);
	});

	it("returns null when no ancestor exists", async () => {
		await expect(nearestExistingAncestor("/missing/deep", async () => false)).resolves.toBeNull();
	});

	it("drops a response whose generation is stale", async () => {
		let currentGeneration = 1;
		let resolveList: ((entries: readonly string[]) => void) | undefined;
		const loader = createListingLoader<string>(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
			(request) => request.generation === currentGeneration,
		);
		const pending = loader(request("/Users/me/Documents", 1, "navigate", ["old"]));
		currentGeneration = 2;
		resolveList?.(["new"]);
		await expect(pending).resolves.toMatchObject({ kind: "stale", entries: ["old"] });
	});

	it("keeps one in-flight silent load and one newest trailing load", async () => {
		const calls: string[] = [];
		const pending: Array<(entries: readonly string[]) => void> = [];
		const loader = createListingLoader<string>((path) => {
			calls.push(path);
			return new Promise((resolve) => pending.push(resolve));
		});
		const first = loader(request("/Users/me/Documents", 1, "silent", ["old"]));
		const superseded = loader(request("/Users/me/Documents", 2, "silent", ["first"]));
		const trailing = loader(request("/Users/me/Documents", 3, "silent", ["second"]));
		expect(calls).toEqual(["/Users/me/Documents"]);
		await expect(superseded).resolves.toMatchObject({ kind: "superseded", entries: ["first"] });

		pending[0]?.(["first"]);
		await first;
		await Promise.resolve();
		expect(calls).toEqual(["/Users/me/Documents", "/Users/me/Documents"]);

		pending[1]?.(["second"]);
		await expect(trailing).resolves.toMatchObject({ kind: "loaded", entries: ["second"] });
	});

	it("preserves the previous listing on a silent error", async () => {
		const failure = new Error("listing failed");
		const loader = createListingLoader<string>(async () => {
			throw failure;
		});
		await expect(loader(request("/Users/me/Documents", 1, "silent", ["old"]))).resolves.toMatchObject({
			kind: "error",
			entries: ["old"],
			error: failure,
		});
	});
});
