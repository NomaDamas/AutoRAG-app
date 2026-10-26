import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeynoteSlideCache, exportWithQuickLook, openKeynoteSlides, quickLookSlideOrder, type KeynoteExport, type KeynoteFileIdentity } from "../src/preview/node/keynote-render";
import type { OfficeRun } from "../src/preview/node/office-render";
import { isPreviewDocument, isQuickLookSlides, type QuickLookSlides } from "../src/preview/shared/contract";

const FILE: KeynoteFileIdentity = { path: "/decks/a.key", mtimeMs: 1000, size: 50 };

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

function cache(deps: { readonly export?: KeynoteExport | undefined; readonly supported?: boolean | undefined; readonly maxBytes?: number | undefined; readonly warn?: ((message: string) => void) | undefined } = {}) {
	return createKeynoteSlideCache({
		dir,
		supported: async () => deps.supported ?? true,
		export: deps.export ?? fakeExport(3),
		...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
		pollMs: 2,
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

	it("never runs Quick Look when the system cannot draw slides", async () => {
		const log: string[] = [];
		const slides = cache({ export: fakeExport(3, log), supported: false });
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


	it("numbers each slide by its file name, even when later slides are written before earlier ones", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let wrote: () => void = () => undefined;
		const lateWritten = new Promise<void>((resolve) => {
			wrote = resolve;
		});
		const slides = cache({
			export: async (job) => {
				// A parallel rasterizer finishes the second batch first: slide 3 exists, slides 1 and 2 do not yet.
				await writeFile(join(job.outDir, "slides.003.jpeg"), slide(3));
				wrote();
				await gate;
				await writeFile(join(job.outDir, "slides.001.jpeg"), slide(1));
				await writeFile(join(job.outDir, "slides.002.jpeg"), slide(2));
			},
		});
		const heard: Array<[number, number]> = [];
		let first: () => void = () => undefined;
		const watcherSawIt = new Promise<void>((resolve) => {
			first = resolve;
		});
		const running = slides.render(FILE, 3, (index, bytes) => {
			heard.push([index, bytes[2]!]);
			first();
		});
		await lateWritten;
		// Wait for the folder watcher to read slides.003 before the earlier slides appear.
		await watcherSawIt;
		release();
		expect(await running).not.toBeNull();
		// Every slide arrived at the position its file name gives it, whatever order the files appeared in.
		expect(heard.sort((a, b) => a[0] - b[0])).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
		]);
	});
	it("reports each finished slide to the caller, and replays them to a caller that joins a running render", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let wrote: () => void = () => undefined;
		const firstWritten = new Promise<void>((resolve) => {
			wrote = resolve;
		});
		const slides = cache({
			export: async (job) => {
				await writeFile(join(job.outDir, "out.001.jpeg"), slide(1));
				wrote();
				await gate;
				await writeFile(join(job.outDir, "out.002.jpeg"), slide(2));
				await writeFile(join(job.outDir, "out.003.jpeg"), slide(3));
			},
		});
		const first: Array<[number, number]> = [];
		const second: Array<[number, number]> = [];
		let firstHeard: () => void = () => undefined;
		const heard = new Promise<void>((resolve) => {
			firstHeard = resolve;
		});
		const running = slides.render(FILE, 3, (index, bytes) => {
			first.push([index, bytes[2]!]);
			firstHeard();
		});
		await firstWritten;
		await heard;
		const joined = slides.render(FILE, 3, (index, bytes) => second.push([index, bytes[2]!]));
		expect(second).toEqual([[0, 1]]);
		release();
		await Promise.all([running, joined]);
		expect(first).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		expect(second).toEqual(first);
	});
});

describe("openKeynoteSlides", () => {
	type Published = { slides: ReadonlyArray<{ index: number; bytes: Uint8Array }>; rendering: boolean };
	function harness(options: { readonly export?: KeynoteExport; readonly supported?: boolean; readonly current?: () => boolean } = {}) {
		const published: Published[] = [];
		let announce: () => void = () => undefined;
		/** Resolves when the last update (rendering false) is published. */
		const finished = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const slides = cache({ export: options.export, supported: options.supported });
		const open = () =>
			openKeynoteSlides(FILE, 3, {
				cache: slides,
				publish: (update) => {
					published.push(update);
					if (!update.rendering) announce();
				},
				current: options.current ?? (() => true),
			});
		/** Every slide delivered so far, by index. */
		const delivered = () => new Map(published.flatMap((update) => update.slides.map((entry) => [entry.index, entry.bytes[2]] as const)));
		return { published, slides, open, finished, delivered };
	}

	it("opens on the stored slides at once and upgrades every slide, ending with rendering false", async () => {
		const { published, open, finished, delivered } = harness();
		const state = await open();
		expect(state).toEqual({ pages: null, rendering: true });
		await finished;
		expect([...delivered()]).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		expect(published.at(-1)!.rendering).toBe(false);
		expect(published.slice(0, -1).every((update) => update.rendering)).toBe(true);
	});

	it("hands over each slide as Keynote writes it, before the export is over", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let seen: () => void = () => undefined;
		const firstSeen = new Promise<void>((resolve) => {
			seen = resolve;
		});
		const { published, open, finished, delivered } = harness({
			export: async (job) => {
				await writeFile(join(job.outDir, "out.001.jpeg"), slide(1));
				await gate;
				await writeFile(join(job.outDir, "out.002.jpeg"), slide(2));
				await writeFile(join(job.outDir, "out.003.jpeg"), slide(3));
			},
		});
		await open();
		const watcher = setInterval(() => {
			if (delivered().has(0)) seen();
		}, 1);
		await firstSeen;
		clearInterval(watcher);
		expect([...delivered()]).toEqual([[0, 1]]);
		expect(published.every((update) => update.rendering)).toBe(true);
		release();
		await finished;
		expect([...delivered()].map(([index]) => index)).toEqual([0, 1, 2]);
	});

	it("never hands over a slide whose file is still being written", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let partialWritten: () => void = () => undefined;
		const partial = new Promise<void>((resolve) => {
			partialWritten = resolve;
		});
		const { open, finished, delivered } = harness({
			export: async (job) => {
				await writeFile(join(job.outDir, "out.001.jpeg"), Uint8Array.from([0xff, 0xd8, 1, 2, 3]));
				partialWritten();
				await gate;
				await fakeExport(3)(job);
			},
		});
		await open();
		await partial;
		for (let turn = 0; turn < 20; turn += 1) await nextTurn();
		expect(delivered().size).toBe(0);
		release();
		await finished;
		expect([...delivered()].map(([index]) => index)).toEqual([0, 1, 2]);
	});

	it("opens already upgraded, without publishing, when the deck was rendered before", async () => {
		const { published, slides, open } = harness();
		await slides.render(FILE, 3);
		const state = await open();
		expect(state.rendering).toBe(false);
		expect(state.pages?.length).toBe(3);
		expect(published).toEqual([]);
	});

	it("changes nothing when Quick Look cannot draw slides on this system", async () => {
		const { published, open } = harness({ supported: false });
		expect(await open()).toEqual({ pages: null, rendering: false });
		await nextTurn();
		expect(published).toEqual([]);
	});

	it("ends the wait with the stored slides when Keynote cannot render the deck", async () => {
		const { published, open, finished } = harness({
			export: async () => {
				throw new Error("boom");
			},
		});
		expect((await open()).rendering).toBe(true);
		await finished;
		expect(published).toEqual([{ slides: [], rendering: false }]);
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

/** A fake `qlmanage` + `sips`: qlmanage writes the `.qlpreview` pack, sips rasterizes each PDF it is given into `--out`. */
function fakeQuickLook(options: { readonly html?: string | null; readonly pdfs?: readonly string[]; readonly fail?: "qlmanage" | "sips" } = {}) {
	const calls: string[][] = [];
	const pdfs = options.pdfs ?? ["Attachment6.pdf", "Attachment3.pdf", "Attachment16.pdf"];
	const html = options.html === undefined ? `<html><body>${pdfs.map((name) => `<div class=""><img src="${name}" width="100%"></div>`).join("\n")}</body></html>` : options.html;
	const run: OfficeRun = async (command, args) => {
		calls.push([command, ...args]);
		if (command.endsWith("qlmanage")) {
			if (options.fail === "qlmanage") throw new Error("qlmanage failed");
			const out = args[args.indexOf("-o") + 1]!;
			const pack = join(out, `${args[1]!.split("/").pop()}.qlpreview`);
			await mkdir(pack, { recursive: true });
			if (html !== null) await writeFile(join(pack, "Preview.html"), html);
			for (const name of pdfs) await writeFile(join(pack, name), `%PDF ${name}`);
			return;
		}
		if (options.fail === "sips") throw new Error("sips failed");
		const out = args[args.indexOf("--out") + 1]!;
		for (const input of args.slice(args.indexOf("formatOptions") + 2, args.indexOf("--out"))) {
			const stem = input.split("/").pop()!.replace(/\.pdf$/, "");
			// Like the real sips, the output keeps the input's name with a .jpg extension. The JPEG's tag byte is the attachment number, so the test can see which PDF became which slide.
			await writeFile(join(out, `${stem}.jpg`), slide(Number(stem.replace("Attachment", ""))));
		}
	};
	return { run, calls };
}

describe("Quick Look slide order", () => {
	it("lists the slide PDFs in the order the page draws them, not by attachment number", () => {
		const html = `<body><div><img src="Attachment6.pdf" width="100%"></div><div><img src="Attachment3.pdf" width="100%"></div><div><img src="Attachment16.pdf" width="100%"></div></body>`;
		expect(quickLookSlideOrder(html)).toEqual(["Attachment6.pdf", "Attachment3.pdf", "Attachment16.pdf"]);
	});

	it("keeps a slide that appears twice twice, and ignores pictures that are not attachment PDFs", () => {
		const html = `<img src="Attachment2.pdf"><img src="https://example.com/x.pdf"><img src="../Attachment9.pdf"><img src="Attachment2.pdf"><img src="Attachment4.png">`;
		expect(quickLookSlideOrder(html)).toEqual(["Attachment2.pdf", "Attachment2.pdf"]);
	});
});

describe("exportWithQuickLook", () => {
	const sortedTags = async (): Promise<number[]> => Promise.all((await readdir(dir)).sort().map(async (name) => (await readFile(join(dir, name)))[2]!));

	it("writes one numbered JPEG per slide in show order, without starting any app", async () => {
		const { run, calls } = fakeQuickLook();
		await exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run });
		expect((await readdir(dir)).sort()).toEqual(["slides.001.jpeg", "slides.002.jpeg", "slides.003.jpeg"]);
		expect(await sortedTags()).toEqual([6, 3, 16]);
		expect(new Set(calls.map((call) => call[0]))).toEqual(new Set(["/usr/bin/qlmanage", "/usr/bin/sips"]));
	});

	it("rasterizes a large deck in several runs and still numbers every slide by position", async () => {
		const pdfs = Array.from({ length: 30 }, (_, index) => `Attachment${index + 1}.pdf`).reverse();
		const { run, calls } = fakeQuickLook({ pdfs });
		await exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run });
		const tags = await sortedTags();
		expect(tags).toEqual(Array.from({ length: 30 }, (_, index) => 30 - index));
		expect(calls.filter((call) => call[0]?.endsWith("sips")).length).toBeGreaterThan(1);
	});

	it("writes a slide used twice twice", async () => {
		const { run } = fakeQuickLook({ pdfs: ["Attachment1.pdf", "Attachment2.pdf"], html: `<img src="Attachment1.pdf"><img src="Attachment2.pdf"><img src="Attachment1.pdf">` });
		await exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run });
		expect(await sortedTags()).toEqual([1, 2, 1]);
	});

	it("fails when Quick Look draws no page or no slides, and when a tool fails", async () => {
		await expect(exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook({ html: null }).run })).rejects.toThrow(/no page/i);
		await expect(exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook({ html: "<p>text only</p>" }).run })).rejects.toThrow(/no slides/i);
		await expect(exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook({ fail: "qlmanage" }).run })).rejects.toThrow("qlmanage failed");
		await expect(exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook({ fail: "sips" }).run })).rejects.toThrow("sips failed");
	});

	it("removes its scratch folder, success or failure", async () => {
		const scratch = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("autorag-keynote-") && name !== basename(dir));
		const before = await scratch();
		await exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook().run });
		await exportWithQuickLook({ path: "/decks/a.key", outDir: dir }, { run: fakeQuickLook({ fail: "sips" }).run }).catch(() => undefined);
		expect(await scratch()).toEqual(before);
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

	it("accepts an update only with a sequence, indexed slide bytes, and a rendering flag", () => {
		const good: QuickLookSlides = { seq: 1, slides: [{ index: 0, bytes: slide(1) }], rendering: true };
		expect(isQuickLookSlides(good)).toBe(true);
		expect(isQuickLookSlides({ seq: 1, slides: [], rendering: false })).toBe(true);
		expect(isQuickLookSlides({ seq: "1", slides: [], rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, slides: [{ index: 0, bytes: [1] }], rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, slides: [{ index: -1, bytes: slide(1) }], rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, slides: [{ index: 0.5, bytes: slide(1) }], rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, slides: null, rendering: false })).toBe(false);
		expect(isQuickLookSlides({ seq: 1, slides: [] })).toBe(false);
	});
});
