import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultRun, type OfficeRun } from "./office-render";

/** `qlmanage` lays a 140-slide deck out in about 9s; this bounds a hung generator. */
const QUICK_LOOK_TIMEOUT_MS = 120_000;
const SIPS_TIMEOUT_MS = 60_000;
/** Slides rasterized per `sips` run, and how many runs go at once: a run costs a process start, so slides are batched, and the first batch is the top of the deck. */
const SIPS_BATCH = 8;
const SIPS_PARALLEL = 4;
/** Every slide of a deck together may not exceed this, so a huge deck degrades instead of filling memory. */
const DECK_BYTE_CAP = 256 * 1024 * 1024;
/** The panel hears of a finished slide within this. */
const SLIDE_POLL_MS = 150;
/** Disk the exported slides may use; the least recently shown decks go first. */
const CACHE_BYTES = 1024 * 1024 * 1024;
/** A scratch folder this old belongs to a run that died. */
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
/** Slide files are named `slides.001.jpeg`, `slides.002.jpeg`, ... */
const SLIDE_FILE = /\.(\d+)\.jpe?g$/i;

/** What identifies one version of a deck: a changed deck must never be served stale slides. */
export interface KeynoteFileIdentity {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** One export: write every slide of `path` as `slides.NNN.jpeg` (show order) into the existing folder `outDir`. */
export interface KeynoteExport {
	(job: { readonly path: string; readonly outDir: string }): Promise<void>;
}

const SLIDE_PDF = /^Attachment[\w.-]*\.pdf$/;

/**
 * The slide PDFs of Quick Look's `Preview.html`, in the order the page draws
 * them (a slide used twice is listed twice). The generator names them by
 * creation order, not show order, so the page is the only source of the order.
 */
export function quickLookSlideOrder(html: string): string[] {
	const names: string[] = [];
	for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
		const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
		if (src !== undefined && SLIDE_PDF.test(src)) names.push(src);
	}
	return names;
}

/**
 * Draws every slide of a Keynote deck with macOS's own iWork Quick Look
 * generator, the one Finder's preview pane uses: `qlmanage -p` writes one
 * full-resolution vector PDF per slide (about 2s for 16 slides, 9s for 140) and
 * `sips` rasterizes them to JPEG at their native size (1920x1080 for a 16:9
 * deck). No application is launched and no document is opened. The scratch
 * folder is always removed.
 */
export async function exportWithQuickLook(job: { readonly path: string; readonly outDir: string }, deps: { readonly run?: OfficeRun } = {}): Promise<void> {
	const run = deps.run ?? defaultRun;
	const scratch = await mkdtemp(join(tmpdir(), "autorag-keynote-"));
	try {
		await run("/usr/bin/qlmanage", ["-p", job.path, "-o", scratch], { timeoutMs: QUICK_LOOK_TIMEOUT_MS });
		const pack = join(scratch, `${basename(job.path)}.qlpreview`);
		const html = await readFile(join(pack, "Preview.html"), "utf8").catch(() => null);
		if (html === null) throw new Error("Quick Look drew no page for this deck");
		const order = quickLookSlideOrder(html);
		if (order.length === 0) throw new Error("Quick Look drew no slides for this deck");
		const batches: number[] = [];
		for (let start = 0; start < order.length; start += SIPS_BATCH) batches.push(start);
		let next = 0;
		const worker = async (): Promise<void> => {
			for (let turn = next++; turn < batches.length; turn = next++) {
				const start = batches[turn]!;
				const names = order.slice(start, start + SIPS_BATCH);
				const raw = join(scratch, `raw-${turn}`);
				await mkdir(raw);
				await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", ...[...new Set(names)].map((name) => join(pack, name)), "--out", raw], { timeoutMs: SIPS_TIMEOUT_MS });
				for (const [offset, name] of names.entries()) {
					// Written under a name the watcher ignores, then renamed: a slide file is whole the moment it exists.
					const slide = join(job.outDir, `slides.${String(start + offset + 1).padStart(3, "0")}.jpeg`);
					await copyFile(join(raw, `${name.slice(0, -4)}.jpg`), `${slide}.part`);
					await rename(`${slide}.part`, slide);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(SIPS_PARALLEL, batches.length) }, worker));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** The slide JPEGs in `folder` in show order (numeric, not lexical), or null when they exceed the byte cap. */
async function readSlides(folder: string): Promise<Uint8Array[] | null> {
	const numbered = (await readdir(folder))
		.map((name) => ({ name, index: SLIDE_FILE.exec(name)?.[1] }))
		.filter((entry): entry is { name: string; index: string } => entry.index !== undefined)
		.sort((a, b) => Number(a.index) - Number(b.index));
	const slides: Uint8Array[] = [];
	let total = 0;
	for (const { name } of numbered) {
		const bytes = await readFile(join(folder, name));
		total += bytes.byteLength;
		if (total > DECK_BYTE_CAP) return null;
		slides.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	}
	return slides;
}

/** A JPEG whose end-of-image marker is on disk: Keynote is done writing it. */
function isWholeJpeg(bytes: Uint8Array): boolean {
	const end = bytes.byteLength;
	return end > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9;
}

/**
 * Reports each slide file in `folder` once it is whole, while Keynote is still
 * writing the rest. Returns the stop function, which waits for the scan in
 * progress. Files the scan misses are the caller's to read once the export ends.
 */
function watchSlides(folder: string, pollMs: number, emit: SlideListener): () => Promise<void> {
	let stopped = false;
	let wake: () => void = () => undefined;
	const done = new Set<string>();
	const scan = async (): Promise<void> => {
		const names = (await readdir(folder))
			.map((name) => ({ name, index: SLIDE_FILE.exec(name)?.[1] }))
			.filter((entry): entry is { name: string; index: string } => entry.index !== undefined)
			.sort((a, b) => Number(a.index) - Number(b.index));
		for (const { name, index } of names) {
			if (done.has(name)) continue;
			const bytes = await readFile(join(folder, name));
			if (!isWholeJpeg(bytes)) continue;
			done.add(name);
			// The slide's position is the number in its name, not its place among the files present: rasterizer runs finish in any order.
			emit(Number(index) - 1, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		}
	};
	const loop = (async () => {
		while (!stopped) {
			await scan().catch(() => undefined);
			if (!stopped) await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, pollMs);
			});
		}
	})();
	return async () => {
		stopped = true;
		wake();
		await loop;
	};
}

async function folderBytes(folder: string): Promise<number> {
	let total = 0;
	for (const name of await readdir(folder)) total += (await stat(join(folder, name))).size;
	return total;
}

export interface KeynoteSlideCacheDeps {
	/** Where the rendered decks live; created on first use. */
	readonly dir: string;
	/** Whether this system can draw slides. Defaults to macOS, whose Quick Look has the iWork generator. */
	readonly supported?: () => Promise<boolean>;
	readonly export?: KeynoteExport;
	/** Bytes of slides kept on disk. Defaults to 1GB. */
	readonly maxBytes?: number;
	/** How often the export folder is scanned for finished slides. Defaults to 150ms. */
	readonly pollMs?: number;
	readonly warn?: (message: string) => void;
}

/** Called once per slide, in the order Keynote finishes them: `index` is the slide's position in the deck. */
export type SlideListener = (index: number, bytes: Uint8Array) => void;

export interface KeynoteSlideCache {
	/** Whether {@link render} can produce slides for this deck: Keynote is installed and has not already failed on this version of it. */
	available(file: KeynoteFileIdentity): Promise<boolean>;
	/** The full-size slides already on disk for this version of the deck; never starts Keynote. */
	lookup(file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null>;
	/**
	 * {@link lookup}, else a Keynote export (one at a time; a run for the same
	 * deck is joined). `onSlide` hears each slide as Keynote finishes writing it
	 * (a joiner first hears those already finished). Null when Keynote cannot
	 * draw all `expected` slides. Never rejects.
	 */
	render(file: KeynoteFileIdentity, expected: number, onSlide?: SlideListener): Promise<Uint8Array[] | null>;
}

function identityKey(file: KeynoteFileIdentity): string {
	return createHash("sha256").update(`${file.path}\u0000${file.mtimeMs}\u0000${file.size}`).digest("hex").slice(0, 32);
}

/**
 * Slides drawn by Keynote itself, kept per deck version under `dir`. Launching
 * Keynote takes seconds, so a deck is exported at most once per version: the
 * folder is named by path + modification time + size and is moved into place
 * only when whole, which makes its presence the proof of a finished export.
 */
export function createKeynoteSlideCache(deps: KeynoteSlideCacheDeps): KeynoteSlideCache {
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const maxBytes = deps.maxBytes ?? CACHE_BYTES;
	const run = deps.export ?? exportWithQuickLook;
	let known: Promise<boolean> | null = null;
	const supported = (): Promise<boolean> => {
		known ??= (deps.supported ?? (async () => process.platform === "darwin"))();
		return known;
	};
	const pollMs = deps.pollMs ?? SLIDE_POLL_MS;
	const running = new Map<string, { readonly promise: Promise<Uint8Array[] | null>; readonly delivered: Map<number, Uint8Array>; readonly listeners: Set<SlideListener> }>();
	let queue: Promise<unknown> = Promise.resolve();

	const lookup = async (file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null> => {
		const folder = join(deps.dir, identityKey(file));
		const slides = await readSlides(folder).catch(() => null);
		if (slides === null) return null;
		if (slides.length !== expected) {
			await rm(folder, { recursive: true, force: true });
			return null;
		}
		const now = new Date();
		await utimes(folder, now, now).catch(() => undefined);
		return slides;
	};

	const prune = async (keep: string): Promise<void> => {
		const survivors: Array<{ readonly name: string; readonly bytes: number; readonly usedAt: number }> = [];
		for (const name of await readdir(deps.dir)) {
			const folder = join(deps.dir, name);
			const info = await stat(folder).catch(() => null);
			if (info === null || !info.isDirectory()) continue;
			if (name.startsWith(".tmp-")) {
				if (Date.now() - info.mtimeMs > SCRATCH_MAX_AGE_MS) await rm(folder, { recursive: true, force: true });
				continue;
			}
			survivors.push({ name, bytes: await folderBytes(folder).catch(() => 0), usedAt: info.mtimeMs });
		}
		let total = 0;
		for (const entry of survivors.sort((a, b) => b.usedAt - a.usedAt)) {
			total += entry.bytes;
			if (total > maxBytes && entry.name !== keep) await rm(join(deps.dir, entry.name), { recursive: true, force: true });
		}
	};

	/** Decks Quick Look failed on this session: asking again would only repeat the wait. */
	const failed = new Set<string>();
	const draw = async (file: KeynoteFileIdentity, expected: number, emit: SlideListener): Promise<Uint8Array[] | null> => {
		const cached = await lookup(file, expected);
		if (cached !== null) return cached;
		if (failed.has(identityKey(file))) return null;
		if (!(await supported())) return null;
		const key = identityKey(file);
		await mkdir(deps.dir, { recursive: true });
		const scratch = join(deps.dir, `.tmp-${randomBytes(6).toString("hex")}`);
		const outDir = join(scratch, "slides");
		let stopWatching: (() => Promise<void>) | null = null;
		try {
			await mkdir(outDir, { recursive: true });
			stopWatching = watchSlides(outDir, pollMs, emit);
			await run({ path: file.path, outDir });
			await stopWatching();
			stopWatching = null;
			const slides = await readSlides(outDir);
			if (slides === null || slides.length !== expected) {
				warn(`quick-look: Keynote drew ${slides === null ? "too much" : `${slides.length} slide(s)`} for ${file.path}, expected ${expected}; keeping the stored slides`);
				failed.add(key);
				return null;
			}
			slides.forEach((bytes, index) => emit(index, bytes));
			const folder = join(deps.dir, key);
			await rm(folder, { recursive: true, force: true });
			await rename(outDir, folder);
			await prune(key).catch(() => undefined);
			return slides;
		} catch (error) {
			warn(`quick-look: Keynote render of ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`);
			failed.add(key);
			return null;
		} finally {
			await stopWatching?.();
			await rm(scratch, { recursive: true, force: true });
		}
	};

	return {
		available: async (file) => (await supported()) && !failed.has(identityKey(file)),
		lookup,
		render(file, expected, onSlide) {
			const key = identityKey(file);
			const known = running.get(key);
			if (known !== undefined) {
				if (onSlide !== undefined) {
					known.listeners.add(onSlide);
					for (const [index, bytes] of known.delivered) onSlide(index, bytes);
				}
				return known.promise;
			}
			const delivered = new Map<number, Uint8Array>();
			const listeners = new Set<SlideListener>(onSlide === undefined ? [] : [onSlide]);
			const emit: SlideListener = (index, bytes) => {
				if (delivered.has(index)) return;
				delivered.set(index, bytes);
				for (const listener of listeners) listener(index, bytes);
			};
			const promise = queue.then(() => draw(file, expected, emit)).finally(() => running.delete(key));
			queue = promise.catch(() => undefined);
			running.set(key, { promise, delivered, listeners });
			return promise;
		},
	};
}

/** What the panel shows of a Keynote deck when it opens: the full-size slides if drawn before, and whether Keynote is drawing them now. */
export interface KeynoteSlidesState {
	readonly pages: readonly Uint8Array[] | null;
	readonly rendering: boolean;
}

/** A later state of an open: slides Keynote finished since the last update; `rendering` is false once nothing more will come. */
export interface KeynoteSlidesUpdate {
	readonly slides: readonly { readonly index: number; readonly bytes: Uint8Array }[];
	readonly rendering: boolean;
}

export interface OpenKeynoteDeps {
	readonly cache: Pick<KeynoteSlideCache, "available" | "lookup" | "render">;
	/** Sends a later state of this open to the preview window. */
	readonly publish: (update: KeynoteSlidesUpdate) => void;
	/** False once the preview has moved on to another file; nothing more is published then. */
	readonly current: () => boolean;
}

/**
 * The state to open a Keynote deck with. A deck drawn before opens with its
 * full-size slides. Otherwise, when Keynote is installed, the panel opens at
 * once on the stored 356px slides (`rendering`) and `publish` delivers each
 * full-size slide as Keynote finishes it, top to bottom, then a last update
 * that ends the wait (with whatever slides were not delivered yet). Without
 * Keynote nothing changes and nothing is published.
 */
export async function openKeynoteSlides(file: KeynoteFileIdentity, expected: number, deps: OpenKeynoteDeps): Promise<KeynoteSlidesState> {
	const cached = await deps.cache.lookup(file, expected);
	if (cached !== null) return { pages: cached, rendering: false };
	if (!(await deps.cache.available(file))) return { pages: null, rendering: false };
	const delivered = new Set<number>();
	void deps.cache
		.render(file, expected, (index, bytes) => {
			if (!deps.current()) return;
			delivered.add(index);
			deps.publish({ slides: [{ index, bytes }], rendering: true });
		})
		.then((pages) => {
			if (!deps.current()) return;
			const rest = pages === null ? [] : pages.flatMap((bytes, index) => (delivered.has(index) ? [] : [{ index, bytes }]));
			deps.publish({ slides: rest, rendering: false });
		});
	return { pages: null, rendering: true };
}
