import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeynoteSlideCache, findInstalledKeynote, openKeynoteSlides, type KeynoteExport, type KeynoteFileIdentity } from "../src/preview/node/keynote-render";
import { isPreviewDocument, isQuickLookSlides, type QuickLookSlides } from "../src/preview/shared/contract";

const FILE: KeynoteFileIdentity = { path: "/decks/a.key", mtimeMs: 1000, size: 50 };
const BUNDLE = "com.apple.iWork.Keynote";

/** JPEG-looking bytes whose first byte after the SOI tells slides apart. */
function slide(tag: number): Uint8Array {
	return Uint8Array.from([0xff, 0xd8, tag, 0xff, 0xd9]);
}

/** Keynote names the files `<folder>.NNN.jpeg`; this fake writes `count` of them, slide `n` tagged `n`. */
function fakeExport(count: number, log: string[] = []): KeynoteExport {
	return async (job) => {
		log.push(job.path);
		for (let n = 1; n <= count; n += 1) await writeFile(join(job.outDir, `out.${String(n).padStart(3, "0")}.jpeg`), slide(n));
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "autorag-keynote-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function cache(deps: { readonly export?: KeynoteExport | undefined; readonly installed?: string | null | undefined; readonly maxBytes?: number | undefined; readonly warn?: ((message: string) => void) | undefined } = {}) {
	return createKeynoteSlideCache({
		dir,
		installed: async () => (deps.installed === undefined ? BUNDLE : deps.installed),
		export: deps.export ?? fakeExport(3),
		...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
		warn: deps.warn ?? (() => undefined),
	});
}

describe("Keynote slide rendering", () => {
	it("returns every exported slide in show order, numerically not lexically", async () => {
		const names = ["out.001.jpeg", "out.002.jpeg", "out.010.jpeg", "out.1000.jpeg"];
		const slides = cache({
			export: async (job) => {
				for (const [index, name] of names.entries()) await writeFile(join(job.outDir, name), slide(index));
			},
		});
		const result = await slides.render(FILE, 4);
		expect(result?.map((bytes) => bytes[2])).toEqual([0, 1, 2, 3]);
	});

	it("refuses an export whose slide count differs from the deck's (skipped or missing slides)", async () => {
		const warnings: string[] = [];
		const slides = cache({ export: fakeExport(2), warn: (message) => warnings.push(message) });
		expect(await slides.render(FILE, 3)).toBeNull();
		expect(warnings.join("\n")).toMatch(/2/);
		expect(await slides.lookup(FILE, 3)).toBeNull();
	});

	it("answers null and leaves no scratch files when Keynote fails", async () => {
		const warnings: string[] = [];
		const slides = cache({
			export: async () => {
				throw new Error("Keynote got an error");
			},
			warn: (message) => warnings.push(message),
		});
		expect(await slides.render(FILE, 3)).toBeNull();
		expect(warnings.join("\n")).toContain("Keynote got an error");
		expect(await readdir(dir)).toEqual([]);
	});

	it("does not launch Keynote again for an unchanged deck, even from a new cache instance", async () => {
		const log: string[] = [];
		const first = cache({ export: fakeExport(3, log) });
		expect((await first.render(FILE, 3))?.length).toBe(3);
		expect((await first.render(FILE, 3))?.length).toBe(3);
		const reopened = cache({ export: fakeExport(3, log) });
		const found = await reopened.lookup(FILE, 3);
		expect(found?.map((bytes) => bytes[2])).toEqual([1, 2, 3]);
		expect((await reopened.render(FILE, 3))?.length).toBe(3);
		expect(log).toEqual([FILE.path]);
	});

	it("renders again when the deck's modification time or size changed", async () => {
		const log: string[] = [];
		const slides = cache({ export: fakeExport(3, log) });
		await slides.render(FILE, 3);
		expect(await slides.lookup({ ...FILE, mtimeMs: 2000 }, 3)).toBeNull();
		await slides.render({ ...FILE, mtimeMs: 2000 }, 3);
		await slides.render({ ...FILE, size: 51 }, 3);
		expect(log.length).toBe(3);
	});

	it("joins a render already running for the same deck and runs different decks one at a time", async () => {
		let running = 0;
		let peak = 0;
		let started = 0;
		const slides = cache({
			export: async (job) => {
				started += 1;
				running += 1;
				peak = Math.max(peak, running);
				await nextTurn();
				await fakeExport(3)(job);
				running -= 1;
			},
		});
		const other: KeynoteFileIdentity = { path: "/decks/b.key", mtimeMs: 1, size: 1 };
		const results = await Promise.all([slides.render(FILE, 3), slides.render(FILE, 3), slides.render(other, 3)]);
		expect(results.every((slidesOut) => slidesOut?.length === 3)).toBe(true);
		expect(started).toBe(2);
		expect(peak).toBe(1);
	});

	it("never starts Keynote when it is not installed", async () => {
		const log: string[] = [];
		const slides = cache({ export: fakeExport(3, log), installed: null });
		expect(await slides.available(FILE)).toBe(false);
		expect(await slides.render(FILE, 3)).toBeNull();
		expect(log).toEqual([]);
	});

	it("does not launch Keynote a second time for a deck it already failed on", async () => {
		const log: string[] = [];
		const slides = cache({
			export: async (job) => {
				log.push(job.path);
				throw new Error("The document could not be opened");
			},
		});
		expect(await slides.available(FILE)).toBe(true);
		expect(await slides.render(FILE, 3)).toBeNull();
		expect(await slides.available(FILE)).toBe(false);
		expect(await slides.render(FILE, 3)).toBeNull();
		expect(log.length).toBe(1);
		// A new version of the deck is a new chance.
		expect(await slides.available({ ...FILE, mtimeMs: FILE.mtimeMs + 1 })).toBe(true);
	});

	it("drops the least recently used decks once the cache is over its byte budget", async () => {
		const slides = cache({ export: fakeExport(3), maxBytes: 12 });
		const a = { ...FILE, path: "/decks/a.key" };
		const b = { ...FILE, path: "/decks/b.key" };
		await slides.render(a, 3);
		// Age a: its three 5-byte slides (15 bytes) already exceed the budget on their own, so b evicts a.
		const old = new Date(Date.now() - 60_000);
		for (const name of await readdir(dir)) await utimes(join(dir, name), old, old);
		await slides.render(b, 3);
		expect(await slides.lookup(a, 3)).toBeNull();
		expect((await slides.lookup(b, 3))?.length).toBe(3);
		expect((await readdir(dir)).length).toBe(1);
	});

	it("sweeps scratch folders a crashed run left behind", async () => {
		const stale = join(dir, ".tmp-dead");
		await mkdir(stale, { recursive: true });
		const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
		await utimes(stale, old, old);
		await cache().render(FILE, 3);
		expect((await readdir(dir)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
		expect((await stat(dir)).isDirectory()).toBe(true);
	});
});

describe("openKeynoteSlides", () => {
	function harness(options: { readonly export?: KeynoteExport; readonly installed?: string | null; readonly current?: () => boolean } = {}) {
		const published: Array<{ pages: readonly Uint8Array[] | null; rendering: boolean }> = [];
		let announce: () => void = () => undefined;
		/** Resolves when the first update is published. */
		const firstPublish = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const slides = cache({ export: options.export, installed: options.installed });
		const open = () =>
			openKeynoteSlides(FILE, 3, {
				cache: slides,
				publish: (update) => {
					published.push(update);
					announce();
				},
				current: options.current ?? (() => true),
			});
		return { published, slides, open, firstPublish };
	}

	it("opens on the stored slides at once and upgrades them when Keynote is done", async () => {
		const { published, open, firstPublish } = harness();
		const state = await open();
		expect(state).toEqual({ pages: null, rendering: true });
		await firstPublish;
		expect(published.length).toBe(1);
		expect(published[0]!.rendering).toBe(false);
		expect(published[0]!.pages?.map((bytes) => bytes[2])).toEqual([1, 2, 3]);
	});

	it("opens already upgraded, without publishing, when the deck was rendered before", async () => {
		const { published, slides, open } = harness();
		await slides.render(FILE, 3);
		const state = await open();
		expect(state.rendering).toBe(false);
		expect(state.pages?.length).toBe(3);
		expect(published).toEqual([]);
	});

	it("changes nothing when Keynote is not installed", async () => {
		const { published, open } = harness({ installed: null });
		expect(await open()).toEqual({ pages: null, rendering: false });
		await nextTurn();
		expect(published).toEqual([]);
	});

	it("ends the wait with the stored slides when Keynote cannot render the deck", async () => {
		const { published, open, firstPublish } = harness({
			export: async () => {
				throw new Error("boom");
			},
		});
		expect((await open()).rendering).toBe(true);
		await firstPublish;
		expect(published).toEqual([{ pages: null, rendering: false }]);
	});

	it("publishes nothing once the preview moved on to another file", async () => {
		let live = true;
		const { published, open, slides } = harness({ current: () => live });
		await open();
		live = false;
		await slides.render(FILE, 3);
		await nextTurn();
		expect(published).toEqual([]);
	});
});

describe("finding Keynote", () => {
	it("is only looked for on macOS", async () => {
		let asked = 0;
		const mdfind = async () => {
			asked += 1;
			return "/Applications/Keynote.app\n";
		};
		expect(await findInstalledKeynote("win32", mdfind)).toBeNull();
		expect(await findInstalledKeynote("linux", mdfind)).toBeNull();
		expect(asked).toBe(0);
	});

	it("takes the first known Keynote Spotlight lists, iWork before the Creator Studio one", async () => {
		const asked: string[] = [];
		const both = async (bundleId: string) => {
			asked.push(bundleId);
			return "/Applications/X.app\n";
		};
		expect(await findInstalledKeynote("darwin", both)).toBe("com.apple.iWork.Keynote");
		const onlyStudio = async (bundleId: string) => (bundleId === "com.apple.Keynote" ? "/Applications/Keynote Creator Studio.app\n" : "");
		expect(await findInstalledKeynote("darwin", onlyStudio)).toBe("com.apple.Keynote");
		expect(await findInstalledKeynote("darwin", async () => "")).toBeNull();
		expect(await findInstalledKeynote("darwin", async () => Promise.reject(new Error("no mdfind")))).toBeNull();
	});
});

describe("slide upgrade contract", () => {
	const base = { name: "a.key", path: "/a.key", ext: "key", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z", mime: "application/octet-stream", truncated: false, bytes: null, pages: null, office: null, thumbnail: null, slidesRendering: false };

	it("requires a boolean slidesRendering on every document", () => {
		expect(isPreviewDocument({ ...base, slidesRendering: false })).toBe(true);
		expect(isPreviewDocument({ ...base, slidesRendering: true })).toBe(true);
		expect(isPreviewDocument({ ...base, slidesRendering: "yes" })).toBe(false);
		const { slidesRendering: _omitted, ...without } = base;
		expect(isPreviewDocument(without)).toBe(false);
	});

	it("accepts an update only with a sequence, slide bytes or null, and a rendering flag", () => {
		const good: QuickLookSlides = { seq: 1, pages: [slide(1)], rendering: false };
		expect(isQuickLookSlides(good)).toBe(true);
		expect(isQuickLookSlides({ seq: 1, pages: null, rendering: false })).toBe(true);
		expect(isQuickLookSlides({ seq: "1", pages: null, rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, pages: [1], rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, pages: null })).toBe(false);
	});
});
