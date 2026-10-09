import { describe, expect, it, vi } from "vitest";
import type { FsEntryEnrichment, FsFinderEnrichment } from "../src/shared/fs-contract";
import type { LiveMessage } from "../src/shared/live-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { createDirectoryStore, type DirectorySource } from "../src/renderer/src/data/directory-store";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { kindLabelOf, tagsTextOf } from "../src/renderer/src/state/entry-values";

const STAMP = Date.parse("2026-09-30T00:00:00.000Z");

function entry(path: string, mtimeMs: number = STAMP): FinderEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "md",
		size: 1,
		mtimeMs,
		birthtimeMs: 0,
	};
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

/** A source whose every call waits for the test to answer it. */
function harness() {
	const lists: { dir: string; answer: Deferred<readonly FinderEntry[]> }[] = [];
	const reads: { dir: string; paths: readonly string[]; answer: Deferred<{ entries: readonly FinderEntry[]; removed: readonly string[] }> }[] = [];
	const enrich: { entries: readonly FinderEntry[]; answer: Deferred<readonly FsEntryEnrichment[]> }[] = [];
	const metadata: { entries: readonly FinderEntry[]; answer: Deferred<readonly FsFinderEnrichment[]> }[] = [];
	let live: ((message: LiveMessage) => void) | null = null;
	let reconnect: (() => void) | null = null;
	const source: DirectorySource = {
		list: (dir) => {
			const answer = Promise.withResolvers<readonly FinderEntry[]>();
			lists.push({ dir, answer });
			return answer.promise;
		},
		readEntries: (dir, paths) => {
			const answer = Promise.withResolvers<{ entries: readonly FinderEntry[]; removed: readonly string[] }>();
			reads.push({ dir, paths, answer });
			return answer.promise;
		},
		enrich: (entries) => {
			const answer = Promise.withResolvers<readonly FsEntryEnrichment[]>();
			enrich.push({ entries, answer });
			return answer.promise;
		},
		finderMetadata: (entries) => {
			const answer = Promise.withResolvers<readonly FsFinderEnrichment[]>();
			metadata.push({ entries, answer });
			return answer.promise;
		},
		onLive: (listener) => {
			live = listener;
			return () => {
				live = null;
			};
		},
		onReconnect: (listener) => {
			reconnect = listener;
			return () => {
				reconnect = null;
			};
		},
	};
	const sidecar = createEntrySidecar();
	return {
		source,
		sidecar,
		lists,
		reads,
		enrich,
		metadata,
		emit: (message: LiveMessage) => live?.(message),
		reconnect: () => reconnect?.(),
	};
}

function dirMessage(dir: string, changes: LiveMessage["dirs"][number]["changes"], extra: Partial<LiveMessage["dirs"][number]> = {}): LiveMessage {
	return { seq: 1, dirs: [{ dir, changes, overflow: false, dirGone: false, ...extra }], layers: [], reconciled: [] };
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

describe("directory store", () => {
	it("publishes a folder's listing to its subscribers and keeps it for the next reader", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		const listener = vi.fn();
		store.subscribe("/d", listener);
		expect(store.get("/d")).toBeUndefined();

		const outcome = store.load("/d", "navigate");
		expect(store.get("/d")).toMatchObject({ dir: "/d", loaded: false, loading: true, entries: [] });
		const rows = [entry("/d/a.md"), entry("/d/b.md")];
		h.lists[0]?.answer.resolve(rows);
		await expect(outcome).resolves.toEqual({ kind: "loaded" });
		expect(store.get("/d")).toMatchObject({ loaded: true, loading: false, error: null, entries: rows });
		expect(listener).toHaveBeenCalled();
	});

	it("shares one in-flight silent listing between every reader of a folder", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		const first = store.load("/d", "silent");
		const second = store.load("/d", "silent");
		const third = store.load("/d", "silent");
		expect(h.lists).toHaveLength(1);
		h.lists[0]?.answer.resolve([entry("/d/a.md")]);
		await settle();
		// The trailing request re-reads once; the middle one is superseded.
		expect(h.lists).toHaveLength(2);
		h.lists[1]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md")]);
		const outcomes = await Promise.all([first, second, third]);
		expect(outcomes.map((outcome) => outcome.kind)).toEqual(["loaded", "stale", "loaded"]);
		expect(store.get("/d")?.entries.map((row) => row.path)).toEqual(["/d/a.md", "/d/b.md"]);
	});

	it("ignores a listing that lands after a newer one for the same folder", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		const older = store.load("/d", "navigate");
		const newer = store.load("/d", "navigate");
		h.lists[1]?.answer.resolve([entry("/d/new.md")]);
		await expect(newer).resolves.toEqual({ kind: "loaded" });
		h.lists[0]?.answer.resolve([entry("/d/old.md")]);
		await expect(older).resolves.toEqual({ kind: "stale" });
		expect(store.get("/d")?.entries.map((row) => row.path)).toEqual(["/d/new.md"]);
	});

	it("a revalidation that finds nothing new keeps the listing array and every row object", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md")]);
		await settle();
		const shown = store.get("/d");
		const listener = vi.fn();
		store.subscribe("/d", listener);

		void store.load("/d", "silent");
		h.lists[1]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md")]);
		await settle();
		expect(store.get("/d")).toBe(shown);
		expect(listener).not.toHaveBeenCalled();

		void store.load("/d", "silent");
		h.lists[2]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md", Date.parse("2026-10-01T00:00:00.000Z"))]);
		await settle();
		const next = store.get("/d")?.entries ?? [];
		expect(next[0]).toBe(shown?.entries[0]);
		expect(next[1]).not.toBe(shown?.entries[1]);
	});

	it("never rewrites the listing when icons or Finder metadata arrive", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		void store.load("/d", "navigate");
		const rows = [entry("/d/a.png"), entry("/d/b.png")];
		h.lists[0]?.answer.resolve(rows);
		await settle();
		const snapshot = store.get("/d");
		const listener = vi.fn();
		store.subscribe("/d", listener);

		expect(h.enrich).toHaveLength(1);
		expect(h.metadata).toHaveLength(1);
		h.enrich[0]?.answer.resolve(rows.map((row) => ({ path: row.path, mtimeMs: STAMP, osKind: "PNG image", iconUrl: `thumb://${row.name}` })));
		h.metadata[0]?.answer.resolve([{ path: "/d/a.png", mtimeMs: STAMP, finder: { createdAt: null, addedAt: null, lastOpenedAt: null, tags: ["Red"], comments: null, width: 4, height: 3, rating: null, application: null } }]);
		store.requestIcon(entry("/d/b.png"));
		await settle();

		expect(store.get("/d")).toBe(snapshot);
		expect(store.get("/d")?.entries).toBe(rows);
		expect(listener).not.toHaveBeenCalled();
		const resolved = h.sidecar.resolve(rows[0] as FinderEntry);
		expect(resolved).toMatchObject({ iconUrl: "thumb://a.png", osKind: "PNG image" });
		expect(kindLabelOf(resolved)).toBe("PNG image");
		expect(tagsTextOf(resolved)).toBe("Red");
	});

	it("does not ask again for rows whose kind and metadata it already has", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		const rows = [entry("/d/a.md"), entry("/d/b.md")];
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve(rows);
		await settle();
		h.enrich[0]?.answer.resolve(rows.map((row) => ({ path: row.path, mtimeMs: STAMP, osKind: "Markdown", iconUrl: null })));
		h.metadata[0]?.answer.resolve([]);
		await settle();

		const edited = entry("/d/b.md", Date.parse("2026-10-01T00:00:00.000Z"));
		void store.load("/d", "silent");
		h.lists[1]?.answer.resolve([rows[0] as FinderEntry, edited]);
		await settle();
		expect(h.enrich[1]?.entries).toEqual([edited]);
		expect(h.metadata[1]?.entries).toEqual([edited]);
	});

	it("coalesces viewport icon requests into one batch and asks for each file version once", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar, iconFlushMs: 60 });
			store.requestIcon(entry("/d/a.png"));
			store.requestIcon(entry("/d/b.png"));
			store.requestIcon(entry("/d/a.png"));
			expect(h.enrich).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(60);
			expect(h.enrich).toHaveLength(1);
			expect(h.enrich[0]?.entries.map((row) => row.path)).toEqual(["/d/a.png", "/d/b.png"]);
			h.enrich[0]?.answer.resolve([]);
			await vi.advanceTimersByTimeAsync(0);

			store.requestIcon(entry("/d/a.png"));
			store.requestIcon(entry("/d/a.png", Date.parse("2026-10-01T00:00:00.000Z")));
			await vi.advanceTimersByTimeAsync(60);
			expect(h.enrich[1]?.entries.map((row) => row.mtimeMs)).toEqual([Date.parse("2026-10-01T00:00:00.000Z")]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a navigate failure empties the folder; a silent failure keeps what is shown", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve([entry("/d/a.md")]);
		await settle();

		const silent = store.load("/d", "silent");
		const error = new Error("EACCES");
		h.lists[1]?.answer.reject(error);
		await expect(silent).resolves.toEqual({ kind: "error", error });
		expect(store.get("/d")?.entries.map((row) => row.path)).toEqual(["/d/a.md"]);

		const navigate = store.load("/d", "navigate");
		h.lists[2]?.answer.reject(error);
		await expect(navigate).resolves.toEqual({ kind: "error", error });
		expect(store.get("/d")).toMatchObject({ entries: [], loaded: true, error });
	});

	it("keeps retained folders and only the most recent released ones", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar, capacity: 2 });
		const releaseKept = store.retain("/kept");
		for (const dir of ["/kept", "/a", "/b", "/c"]) {
			void store.load(dir, "navigate");
			h.lists.at(-1)?.answer.resolve([entry(`${dir}/x.md`)]);
			await settle();
		}
		// "/a" is the least recently used unretained folder past the cap of 2.
		expect(store.get("/a")).toBeUndefined();
		expect(store.get("/b")?.loaded).toBe(true);
		expect(store.get("/c")?.loaded).toBe(true);
		expect(store.get("/kept")?.loaded).toBe(true);

		// Two readers of one folder: it stays until the last one lets go.
		const releaseOther = store.retain("/kept");
		releaseKept();
		releaseKept();
		void store.load("/d", "navigate");
		h.lists.at(-1)?.answer.resolve([]);
		await settle();
		expect(store.get("/kept")?.loaded).toBe(true);
		// Released last, it is the most recently used: the older folders go first.
		releaseOther();
		expect(store.get("/kept")?.loaded).toBe(true);
		expect(store.get("/d")?.loaded).toBe(true);
		expect(store.get("/b")).toBeUndefined();
		expect(store.get("/c")).toBeUndefined();
	});

	it("drops a listing that lands after its folder was evicted instead of resurrecting it", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar, capacity: 0 });
		const release = store.retain("/gone");
		const pending = store.load("/gone", "navigate");
		release();
		h.lists[0]?.answer.resolve([entry("/gone/a.md")]);
		await expect(pending).resolves.toEqual({ kind: "stale" });
		expect(store.get("/gone")).toBeUndefined();
	});

	it("live changes patch only the changed rows, after the baseline listing lands, in order", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		const disconnect = store.connect();
		store.retain("/d");
		void store.load("/d", "navigate");
		h.emit(dirMessage("/d", [{ type: "create", path: "/d/new.md" }]));
		await settle();
		// The baseline is still pending: the patch waits for it.
		expect(h.reads).toHaveLength(0);
		const a = entry("/d/a.md");
		h.lists[0]?.answer.resolve([a, entry("/d/old.md")]);
		await settle();
		expect(h.reads.map((read) => read.paths)).toEqual([["/d/new.md"]]);

		h.emit(dirMessage("/d", [{ type: "delete", path: "/d/old.md" }]));
		await settle();
		// One read in flight at a time: the delete waits for the create.
		expect(h.reads).toHaveLength(1);
		h.reads[0]?.answer.resolve({ entries: [entry("/d/new.md")], removed: [] });
		await settle();
		expect(h.reads[1]?.paths).toEqual(["/d/old.md"]);
		h.reads[1]?.answer.resolve({ entries: [], removed: ["/d/old.md"] });
		await settle();
		const rows = store.get("/d")?.entries ?? [];
		expect(rows.map((row) => row.path)).toEqual(["/d/a.md", "/d/new.md"]);
		expect(rows[0]).toBe(a);
		disconnect();
	});

	it("every published change carries a new version, so subscribers see it", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		store.connect();
		store.retain("/d");
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md")]);
		await settle();
		const versions = [store.get("/d")?.version];

		h.emit(dirMessage("/d", [{ type: "create", path: "/d/c.md" }]));
		await settle();
		h.reads[0]?.answer.resolve({ entries: [entry("/d/c.md")], removed: [] });
		await settle();
		versions.push(store.get("/d")?.version);

		h.emit(dirMessage("/d", [{ type: "delete", path: "/d/a.md" }], { overflow: true }));
		versions.push(store.get("/d")?.version);

		expect(new Set(versions).size).toBe(3);
	});

	it("an overflowing or vanished folder drops its deleted rows at once and relists", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		store.connect();
		store.retain("/d");
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve([entry("/d/a.md"), entry("/d/b.md")]);
		await settle();
		h.emit(dirMessage("/d", [{ type: "delete", path: "/d/a.md" }], { overflow: true }));
		expect(store.get("/d")?.entries.map((row) => row.path)).toEqual(["/d/b.md"]);
		expect(h.lists).toHaveLength(2);
	});

	it("drops trashed or moved rows from every folder that shows them at once, nested rows included", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		void store.load("/d", "navigate");
		h.lists[0]?.answer.resolve([entry("/d/a.md"), entry("/d/sub"), entry("/d/keep.md")]);
		void store.load("/d/sub", "navigate");
		h.lists[1]?.answer.resolve([entry("/d/sub/x.md")]);
		void store.load("/e", "navigate");
		const untouched = [entry("/e/b.md")];
		h.lists[2]?.answer.resolve(untouched);
		await settle();

		store.drop(["/d/a.md", "/d/sub"]);
		expect(store.get("/d")?.entries.map((row) => row.path)).toEqual(["/d/keep.md"]);
		expect(store.get("/d/sub")?.entries).toEqual([]);
		expect(store.get("/e")?.entries).toBe(untouched);
	});

	it("leaves folders nobody listed alone", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		store.connect();
		h.emit(dirMessage("/never", [{ type: "create", path: "/never/a.md" }], { overflow: true }));
		await settle();
		expect(h.lists).toHaveLength(0);
		expect(h.reads).toHaveLength(0);
		expect(store.get("/never")).toBeUndefined();
	});

	it("after the fs worker restarts, relists the folders on screen and keeps their rows until the answer lands", async () => {
		const h = harness();
		const store = createDirectoryStore({ source: h.source, sidecar: h.sidecar });
		store.connect();
		store.retain("/shown");
		const release = store.retain("/left");
		void store.load("/shown", "navigate");
		void store.load("/left", "navigate");
		const shown = [entry("/shown/a.md")];
		h.lists[0]?.answer.resolve(shown);
		h.lists[1]?.answer.resolve([entry("/left/b.md")]);
		await settle();
		release();

		h.reconnect();
		await settle();
		expect(h.lists.slice(2).map((call) => call.dir)).toEqual(["/shown"]);
		// The relist is silent: the folder keeps painting its rows meanwhile.
		expect(store.get("/shown")).toMatchObject({ loaded: true, loading: false, entries: shown });
		h.lists[2]?.answer.resolve([entry("/shown/a.md"), entry("/shown/c.md")]);
		await settle();
		expect(store.get("/shown")?.entries.map((row) => row.path)).toEqual(["/shown/a.md", "/shown/c.md"]);
	});
});
