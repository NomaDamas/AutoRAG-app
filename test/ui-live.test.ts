import { describe, expect, it } from "vitest";
import type { FsDirChange } from "../src/shared/live-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import type { ListingLoadRequest } from "../src/renderer/src/state/live";
import {
	applyEntryPatch,
	applyOptimisticDeletes,
	createIncrementalListing,
	createListingLoader,
	nearestExistingAncestor,
	listingSurvivor,
	pruneSelection,
	reconcileListing,
	watchSetFor,
	type EntryPatch,
	type IncrementalListing,
	type ListingScope,
} from "../src/renderer/src/state/live";

function entry(path: string): FinderEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		fileKind: "md",
		iconUrl: null,
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

interface PatchRead {
	readonly dir: string;
	readonly paths: readonly string[];
	resolve(patch: EntryPatch): void;
}

interface PatchHarness {
	listing(): readonly FinderEntry[];
	seed(entries: readonly FinderEntry[]): void;
	readonly reads: PatchRead[];
	readonly stack: IncrementalListing;
}

function patchHarness(): PatchHarness {
	let current: readonly FinderEntry[] = [];
	const reads: PatchRead[] = [];
	const stack = createIncrementalListing({
		read: (dir, paths) => {
			const { promise, resolve } = Promise.withResolvers<EntryPatch>();
			reads.push({ dir, paths: [...paths], resolve });
			return promise;
		},
		apply: (_dir, patch) => {
			current = applyEntryPatch(current, patch);
		},
		isCurrent: () => true,
		onError: () => {},
	});
	return {
		listing: () => current,
		seed: (entries) => {
			current = entries;
		},
		reads,
		stack,
	};
}

function scope(generation: number, path: string): ListingScope {
	return { generation, path, tabId: 1 };
}

/** Let the coordinator's read→apply→drain microtask chain run to completion. */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 6; tick += 1) {
		await Promise.resolve();
	}
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

	it("patches only changed rows and appends newly created rows", () => {
		const rows = [entry("/d/a"), entry("/d/b")];
		const updated = { ...entry("/d/b"), sizeLabel: "2 B", sizeValue: 2 };
		const next = applyEntryPatch(rows, { entries: [updated, entry("/d/c")], removed: ["/d/a"] });
		expect(next.map((row) => [row.path, row.sizeLabel])).toEqual([
			["/d/b", "2 B"],
			["/d/c", "1 B"],
		]);
	});

	it("keeps the previous listing during a pending navigate load", async () => {
		let resolveList!: (entries: readonly string[]) => void;
		const loader = createListingLoader<string>(
			() => new Promise((resolve) => { resolveList = resolve; }),
		);
		let listing: readonly string[] = ["previous"];
		const pending = loader(request("Recents", 1, "navigate", listing)).then((result) => {
			listing = result.entries;
		});
		await Promise.resolve();
		expect(listing).toEqual(["previous"]);
		resolveList(["recent"]);
		await pending;
		expect(listing).toEqual(["recent"]);
	});

	it("prunes vanished keys, anchor, and focus", () => {
		const survives = listingSurvivor("/d", [entry("/d/a"), entry("/d/b")], [entry("/d/b")]);
		expect(pruneSelection({ keys: ["/d/a", "/d/b"], anchor: "/d/a", focus: "/d/b" }, survives)).toEqual({
			keys: ["/d/b"],
			anchor: null,
			focus: "/d/b",
		});
	});

	it("keeps selections outside the relisted folder", () => {
		const survives = listingSurvivor("/d", [entry("/d/sub")], [entry("/d/sub")]);
		expect(survives("/d/sub/nested.txt")).toBe(true);
		expect(survives("/d/gone.txt")).toBe(false);
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

	it("waits for a delayed baseline then applies overlapping create/delete patches", async () => {
		const harness = patchHarness();
		const s = scope(1, "/d");
		harness.stack.begin(s);
		// Events arrive while the baseline full listing is still in flight.
		harness.stack.changed(["/d/b", "/d/c"]);
		expect(harness.reads).toHaveLength(0);

		// The baseline lands with the pre-event rows, then the queued paths drain.
		harness.seed([entry("/d/a"), entry("/d/b")]);
		harness.stack.fullAdopted(s);
		expect(harness.reads.map((read) => read.paths)).toEqual([["/d/b", "/d/c"]]);

		// A newer overlapping event must not drop the in-flight batch.
		harness.stack.changed(["/d/a", "/d/b"]);
		expect(harness.reads).toHaveLength(1);
		harness.reads[0]?.resolve({ entries: [entry("/d/c")], removed: ["/d/b"] });
		await settle();
		expect(harness.listing().map((row) => row.path)).toEqual(["/d/a", "/d/c"]);

		// The trailing batch drains against the freshest disk state.
		expect(harness.reads.map((read) => read.paths)).toEqual([["/d/b", "/d/c"], ["/d/a", "/d/b"]]);
		harness.reads[1]?.resolve({ entries: [entry("/d/b")], removed: ["/d/a"] });
		await settle();
		expect(harness.listing().map((row) => row.path)).toEqual(["/d/c", "/d/b"]);
	});

	it("coalesces sustained events so every touched path eventually lands", async () => {
		const harness = patchHarness();
		const s = scope(1, "/d");
		harness.seed([entry("/d/keep")]);
		harness.stack.begin(s);
		harness.stack.fullAdopted(s);

		harness.stack.changed(["/d/one"]);
		harness.stack.changed(["/d/two"]);
		harness.stack.changed(["/d/three"]);
		expect(harness.reads.map((read) => read.paths)).toEqual([["/d/one"]]);

		harness.reads[0]?.resolve({ entries: [entry("/d/one")], removed: [] });
		await settle();
		expect(harness.reads.map((read) => read.paths)).toEqual([["/d/one"], ["/d/two", "/d/three"]]);

		harness.reads[1]?.resolve({ entries: [entry("/d/two"), entry("/d/three")], removed: [] });
		await settle();
		expect(harness.listing().map((row) => row.path)).toEqual([
			"/d/keep",
			"/d/one",
			"/d/two",
			"/d/three",
		]);
	});

	it("skips the watched directory itself and nested paths for the direct-child API", async () => {
		const harness = patchHarness();
		const s = scope(1, "/d");
		harness.stack.begin(s);
		harness.stack.fullAdopted(s);

		harness.stack.changed(["/d", "/d/nested/deep"]);
		expect(harness.reads).toHaveLength(0);

		harness.stack.changed(["/d/child"]);
		expect(harness.reads.map((read) => read.paths)).toEqual([["/d/child"]]);
	});

	it("drops a stale completion after navigating away and back", async () => {
		const harness = patchHarness();
		const first = scope(1, "/d");
		harness.seed([entry("/d/a")]);
		harness.stack.begin(first);
		harness.stack.fullAdopted(first);
		harness.stack.changed(["/d/stale"]);
		expect(harness.reads).toHaveLength(1);

		// Navigate away, then back to the very same path at a newer generation.
		const away = scope(2, "/e");
		harness.stack.begin(away);
		const back: ListingScope = { generation: 3, path: "/d", tabId: 1 };
		harness.seed([entry("/d/a")]);
		harness.stack.begin(back);
		harness.stack.fullAdopted(back);
		harness.stack.changed(["/d/fresh"]);
		const stale = harness.reads[0];
		const fresh = harness.reads[1];
		expect(stale?.paths).toEqual(["/d/stale"]);
		expect(fresh?.paths).toEqual(["/d/fresh"]);

		fresh?.resolve({ entries: [entry("/d/fresh")], removed: [] });
		await settle();
		// The old navigation's completion must not corrupt the returned listing.
		stale?.resolve({ entries: [entry("/d/stale")], removed: [] });
		await settle();
		expect(harness.listing().map((row) => row.path)).toEqual(["/d/a", "/d/fresh"]);
	});

	it("keeps row identities and the array when a patch changes nothing", () => {
		const rows = [entry("/d/a"), entry("/d/b")];
		expect(applyEntryPatch(rows, { entries: [], removed: [] })).toBe(rows);
		const same = applyEntryPatch(rows, { entries: [entry("/d/a")], removed: [] });
		expect(same).toBe(rows);
		expect(same[0]).toBe(rows[0]);

		const changed = applyEntryPatch(rows, { entries: [{ ...entry("/d/a"), sizeLabel: "2 B", sizeValue: 2 }], removed: [] });
		expect(changed).not.toBe(rows);
		expect(changed[0]).not.toBe(rows[0]);
		expect(changed[1]).toBe(rows[1]);
		expect(changed[0]?.sizeLabel).toBe("2 B");
	});

	it("revalidating an unchanged folder keeps the enriched listing itself", () => {
		const stamp = "2026-09-30T00:00:00.000Z";
		const bare = (path: string): FinderEntry => ({ ...entry(path), modifiedAt: stamp });
		const shown = [
			{ ...bare("/d/a.md"), iconUrl: "thumb://a", kindLabel: "Markdown Document" },
			{ ...bare("/d/b.md"), iconUrl: null, kindLabel: "Markdown Document" },
		];
		expect(reconcileListing(shown, [bare("/d/a.md"), bare("/d/b.md")])).toBe(shown);
	});

	it("a relist carries enrichment only for rows unchanged on disk", () => {
		const stamp = "2026-09-30T00:00:00.000Z";
		const bare = (path: string, modifiedAt = stamp): FinderEntry => ({ ...entry(path), modifiedAt });
		const shown = [
			{ ...bare("/d/keep.md"), iconUrl: "thumb://keep", kindLabel: "Markdown Document" },
			{ ...bare("/d/edited.md"), iconUrl: "thumb://edited-old", kindLabel: "Markdown Document" },
			{ ...bare("/d/gone.md"), iconUrl: "thumb://gone", kindLabel: "Markdown Document" },
		];
		const edited = bare("/d/edited.md", "2026-10-01T00:00:00.000Z");
		const created = bare("/d/new.md");
		const next = reconcileListing(shown, [bare("/d/keep.md"), edited, created]);
		expect(next.map((row) => row.path)).toEqual(["/d/keep.md", "/d/edited.md", "/d/new.md"]);
		expect(next[0]).toBe(shown[0]);
		// A newer mtime means the old thumbnail and OS kind may be wrong: bare until re-enriched.
		expect(next[1]).toBe(edited);
		expect(next[2]).toBe(created);
	});

	it("returns the same selection object when nothing is pruned", () => {
		const selection = { keys: ["/d/a", "/d/b"], anchor: "/d/a", focus: "/d/b" };
		expect(pruneSelection(selection, () => true)).toBe(selection);
	});
});
