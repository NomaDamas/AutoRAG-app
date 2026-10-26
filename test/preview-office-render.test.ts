import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOfficeRenderCache, openOffice, type OfficeRun, renderOfficeHtml, standaloneOfficeHtml } from "../src/preview/node/office-render";
import { isPreviewDocument, isQuickLookOffice, type OfficePage } from "../src/preview/shared/contract";
import { officePageWidth } from "../src/preview/shared/legacy-office";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const DOC_HTML = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=595, maximum-scale=4.0"><title>t</title></head><body><p>Hello <a href="http://evil.test/x">link</a></p><img src="http://evil.test/p.png"><img src="Attachment1.png"></body></html>';
const DECK_HTML = '<html><head><meta name="viewport" content="width=720"></head><body><div class="slide"><img src="Attachment2.pdf" style="position:absolute; width:57; height:57;"></div></body></html>';

describe("page width of an OS-rendered Office page", () => {
	it("takes the viewport width and pads a text page but not a slide deck", () => {
		expect(officePageWidth(DOC_HTML)).toBe(595 + 80);
		expect(officePageWidth(DECK_HTML)).toBe(720);
		expect(officePageWidth("<html></html>")).toBe(816);
	});
});

describe("standaloneOfficeHtml", () => {
	const resolve = (name: string) => (name === "Attachment1.png" ? { kind: "data" as const, mime: "image/png", bytes: PNG } : name === "Attachment1.css" ? { kind: "css" as const, text: ".s0{color:red}" } : null);

	it("inlines pictures, drops remote references and link targets, and locks the page down", () => {
		const html = standaloneOfficeHtml(DOC_HTML, resolve);
		expect(html).toContain(`src="data:image/png;base64,${Buffer.from(PNG).toString("base64")}"`);
		expect(html).not.toContain("evil.test");
		expect(html).not.toMatch(/<a [^>]*href=/);
		expect(html).toContain("Hello");
		expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/);
		expect(html).not.toMatch(/<script/i);
	});

	it("inlines a linked style sheet and drops any other link", () => {
		const html = standaloneOfficeHtml('<html><head><link href="Attachment1.css" rel="stylesheet"><link href="http://x.test/a.css" rel="stylesheet"></head><body>x</body></html>', resolve);
		expect(html).toContain("<style>.s0{color:red}</style>");
		expect(html).not.toContain("x.test");
	});

	it("drops a picture it cannot resolve instead of leaving a dangling file reference", () => {
		const html = standaloneOfficeHtml('<html><body><img src="Attachment9.emf" style="width:10"></body></html>', resolve);
		expect(html).not.toContain("Attachment9");
	});

	it("strips scripts, frames, and event handlers even though the CSP and sandbox already stop them", () => {
		const html = standaloneOfficeHtml('<html><body onload="x()"><script>alert(1)</script><iframe src="a"></iframe><p onclick="y()">t</p></body></html>', resolve);
		expect(html).not.toMatch(/<script|<iframe|onload|onclick/i);
		expect(html).toContain("t</p>");
	});
});

/** A stand-in for qlmanage/sips: writes the `.qlpreview` package the real tool would. */
function fakeRun(options: { readonly html?: string; readonly attachments?: Readonly<Record<string, Uint8Array>>; readonly calls?: string[][]; readonly fail?: string } = {}): OfficeRun {
	return async (command, args) => {
		options.calls?.push([command, ...args]);
		if (options.fail !== undefined) throw new Error(options.fail);
		if (command.endsWith("qlmanage")) {
			const out = args[args.indexOf("-o") + 1] ?? "";
			const source = args[args.indexOf("-p") + 1] ?? "";
			const dir = join(out, `${basename(source)}.qlpreview`);
			await mkdir(dir, { recursive: true });
			if (options.html !== undefined) await writeFile(join(dir, "Preview.html"), options.html);
			for (const [name, bytes] of Object.entries(options.attachments ?? {})) await writeFile(join(dir, name), bytes);
			return;
		}
		// sips -s format png --resampleWidth N a.pdf ... --out DIR
		const out = args[args.indexOf("--out") + 1] ?? "";
		if (!(await stat(out).then(() => true, () => false))) throw new Error("no destination dir was specified");
		for (const arg of args) if (arg.endsWith(".pdf")) await writeFile(join(out, `${basename(arg, ".pdf")}.png`), PNG);
	};
}

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-office-test-"));
	try {
		return await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("renderOfficeHtml", () => {
	it("returns null off macOS without running anything", async () => {
		const calls: string[][] = [];
		expect(await renderOfficeHtml("/x/a.doc", { platform: "win32", run: fakeRun({ html: DOC_HTML, calls }) })).toBeNull();
		expect(calls).toEqual([]);
	});

	it("asks Quick Look for the preview, inlines attachments, rasterizes vector PDFs at 3x their drawn size, and removes its temp files", async () => {
		const calls: string[][] = [];
		const before = (await readdir(tmpdir())).filter((name) => name.startsWith("autorag-office-")).length;
		const html = await renderOfficeHtml("/x/deck.ppt", {
			platform: "darwin",
			run: fakeRun({ html: DECK_HTML, attachments: { "Attachment2.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }, calls }),
		});
		expect(html).not.toBeNull();
		expect(html).toContain('src="data:image/png;base64,');
		expect(html).not.toContain("Attachment2");
		const ql = calls.find((call) => call[0]?.endsWith("qlmanage"));
		expect(ql?.slice(1, 3)).toEqual(["-p", "/x/deck.ppt"]);
		const sips = calls.find((call) => call[0]?.endsWith("sips"));
		expect(sips).toContain("--resampleWidth");
		expect(Number(sips?.[sips.indexOf("--resampleWidth") + 1])).toBeGreaterThanOrEqual(57 * 3);
		expect((await readdir(tmpdir())).filter((name) => name.startsWith("autorag-office-")).length).toBe(before);
	});

	it("returns null, and warns, when Quick Look fails or writes no preview", async () => {
		const warnings: string[] = [];
		const warn = (message: string): void => void warnings.push(message);
		expect(await renderOfficeHtml("/x/a.doc", { platform: "darwin", run: fakeRun({ fail: "boom" }), warn })).toBeNull();
		expect(warnings.join("\n")).toContain("boom");
		expect(await renderOfficeHtml("/x/a.doc", { platform: "darwin", run: fakeRun({}), warn })).toBeNull();
	});

	it("gives up on a page that is larger than the whole-file cap", async () => {
		const html = `<html><body>${"x".repeat(2000)}</body></html>`;
		expect(await renderOfficeHtml("/x/a.doc", { platform: "darwin", run: fakeRun({ html }), maxBytes: 1000 })).toBeNull();
	});

	it.runIf(process.platform === "darwin")("renders a real Word 97 file through the real macOS Quick Look", async () => {
		await withTemp(async (dir) => {
			const path = join(dir, "sample.doc");
			const { readFile } = await import("node:fs/promises");
			await writeFile(path, await readFile(new URL("./fixtures/word97-textutil.doc", import.meta.url)));
			const html = await renderOfficeHtml(path);
			expect(html).toContain("Quarterly");
			expect(html).toContain("Content-Security-Policy");
		});
	});
});

describe("PreviewDocument.office", () => {
	const base = { name: "a.doc", path: "/a.doc", ext: "doc", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z", mime: "application/octet-stream", truncated: false, bytes: null, pages: null, thumbnail: null, slidesRendering: false };

	it("is an office state or null", () => {
		expect(isPreviewDocument({ ...base, office: null })).toBe(true);
		expect(isPreviewDocument({ ...base, office: { firstPage: null, html: "<p></p>", pending: false } })).toBe(true);
		expect(isPreviewDocument({ ...base, office: { firstPage: "autorag-thumb://x", html: null, pending: true } })).toBe(true);
		expect(isPreviewDocument({ ...base, office: { firstPage: 1, html: null, pending: true } })).toBe(false);
		expect(isPreviewDocument({ ...base, office: { firstPage: null, html: null } })).toBe(false);
		expect(isPreviewDocument(base)).toBe(false);
	});

	it("accepts an update only for a sequence with a well-formed state", () => {
		expect(isQuickLookOffice({ seq: 3, office: { firstPage: null, html: null, pending: false } })).toBe(true);
		expect(isQuickLookOffice({ seq: "3", office: { firstPage: null, html: null, pending: false } })).toBe(false);
		expect(isQuickLookOffice({ seq: 3, office: null })).toBe(false);
	});
});

describe("createOfficeRenderCache", () => {
	function counting(pages: Readonly<Record<string, string | null>>, gate?: Promise<void>): { readonly render: (path: string) => Promise<string | null>; readonly calls: string[] } {
		const calls: string[] = [];
		return {
			calls,
			render: async (path) => {
				calls.push(path);
				if (gate !== undefined) await gate;
				return pages[path] ?? null;
			},
		};
	}
	const identity = (path: string, mtimeMs = 1, size = 10) => ({ path, mtimeMs, size });

	it("renders a file once for a prefetch and the open that follows it", async () => {
		const { render, calls } = counting({ "/a.ppt": "<p>a</p>" });
		const cache = createOfficeRenderCache({ render });
		cache.prefetch(identity("/a.ppt"));
		expect(await cache.get(identity("/a.ppt"))).toBe("<p>a</p>");
		expect(await cache.get(identity("/a.ppt"))).toBe("<p>a</p>");
		expect(calls).toEqual(["/a.ppt"]);
	});

	it("lets an open join a render that is still running instead of starting a second one", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { render, calls } = counting({ "/a.ppt": "<p>a</p>" }, gate);
		const cache = createOfficeRenderCache({ render });
		cache.prefetch(identity("/a.ppt"));
		const opened = cache.get(identity("/a.ppt"));
		release();
		expect(await opened).toBe("<p>a</p>");
		expect(calls).toHaveLength(1);
	});

	it("renders again when the file changed, and remembers files the OS cannot draw", async () => {
		const { render, calls } = counting({ "/a.ppt": "<p>a</p>" });
		const cache = createOfficeRenderCache({ render });
		await cache.get(identity("/a.ppt", 1));
		await cache.get(identity("/a.ppt", 2));
		expect(calls).toHaveLength(2);
		expect(await cache.get(identity("/b.ppt"))).toBeNull();
		expect(await cache.get(identity("/b.ppt"))).toBeNull();
		expect(calls.filter((call) => call === "/b.ppt")).toHaveLength(1);
	});

	it("keeps at most the byte budget, dropping the least recently used page first", async () => {
		const { render, calls } = counting({ "/1": "x".repeat(40), "/2": "y".repeat(40), "/3": "z".repeat(40) });
		const cache = createOfficeRenderCache({ render, maxBytes: 100 });
		await cache.get(identity("/1"));
		await cache.get(identity("/2"));
		await cache.get(identity("/1"));
		await cache.get(identity("/3"));
		await cache.get(identity("/1"));
		await cache.get(identity("/2"));
		expect(calls).toEqual(["/1", "/2", "/3", "/2"]);
	});

	it("keeps only the newest queued prefetch, so a fast arrow-key walk renders what it stops on", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const calls: string[] = [];
		const cache = createOfficeRenderCache({
			render: async (path) => {
				calls.push(path);
				await gate;
				return path;
			},
		});
		for (const name of ["/1", "/2", "/3", "/4"]) cache.prefetch(identity(name));
		release();
		expect(await cache.get(identity("/4"))).toBe("/4");
		expect(calls).toEqual(["/1", "/4"]);
	});

	it("never lets a failed render break the open that asked for it", async () => {
		const cache = createOfficeRenderCache({ render: async () => Promise.reject(new Error("boom")), warn: () => undefined });
		expect(await cache.get(identity("/a.ppt"))).toBeNull();
	});
});

describe("createOfficeRenderCache.peek", () => {
	const identity = (path: string) => ({ path, mtimeMs: 1, size: 10 });

	it("answers undefined until a render settles, then the page, or null when the OS drew nothing", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const cache = createOfficeRenderCache({ render: async (path) => (await gate, path === "/a" ? "<p>a</p>" : null) });
		expect(cache.peek(identity("/a"))).toBeUndefined();
		const running = cache.get(identity("/a"));
		expect(cache.peek(identity("/a"))).toBeUndefined();
		release();
		await running;
		expect(cache.peek(identity("/a"))).toBe("<p>a</p>");
		await cache.get(identity("/b"));
		expect(cache.peek(identity("/b"))).toBeNull();
	});
});

describe("openOffice", () => {
	const file = { path: "/a.ppt", mtimeMs: 1, size: 10 };

	function setup(options: { readonly cached?: string | null | undefined; readonly thumbCached?: string | null; readonly page?: Promise<string | null>; readonly thumb?: Promise<string | null> } = {}) {
		const published: OfficePage[] = [];
		let live = true;
		const deps = {
			cache: { peek: () => options.cached, get: () => options.page ?? Promise.resolve("<p>page</p>") },
			firstPage: { peek: () => options.thumbCached ?? null, load: () => options.thumb ?? Promise.resolve("autorag-thumb://first") },
			publish: (office: OfficePage) => void published.push(office),
			current: () => live,
		};
		return { deps, published, stop: () => (live = false) };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("opens finished when the page is already cached, with nothing left to publish", async () => {
		const { deps, published } = setup({ cached: "<p>ready</p>" });
		expect(openOffice(file, deps)).toEqual({ firstPage: null, html: "<p>ready</p>", pending: false });
		await settle();
		expect(published).toEqual([]);
	});

	it("opens finished without a page when the OS is known to draw nothing for the file", () => {
		const { deps } = setup({ cached: null });
		expect(openOffice(file, deps)).toEqual({ firstPage: null, html: null, pending: false });
	});

	it("opens at once with the cached first-page image and publishes the page when it lands", async () => {
		const { deps, published } = setup({ thumbCached: "autorag-thumb://cached" });
		deps.firstPage.load = () => Promise.reject(new Error("a cached image is not loaded again"));
		const initial = openOffice(file, deps);
		expect(initial).toEqual({ firstPage: "autorag-thumb://cached", html: null, pending: true });
		await settle();
		expect(published.at(-1)).toEqual({ firstPage: "autorag-thumb://cached", html: "<p>page</p>", pending: false });
	});

	it("publishes the first-page image as soon as it exists, before the page", async () => {
		let release: (page: string | null) => void = () => undefined;
		const page = new Promise<string | null>((resolve) => (release = resolve));
		const { deps, published } = setup({ page });
		expect(openOffice(file, deps)).toEqual({ firstPage: null, html: null, pending: true });
		await settle();
		expect(published).toEqual([{ firstPage: "autorag-thumb://first", html: null, pending: true }]);
		release("<p>done</p>");
		await settle();
		expect(published.at(-1)).toEqual({ firstPage: "autorag-thumb://first", html: "<p>done</p>", pending: false });
	});

	it("never replaces a finished page with a first-page image that arrives late", async () => {
		let release: (url: string | null) => void = () => undefined;
		const thumb = new Promise<string | null>((resolve) => (release = resolve));
		const { deps, published } = setup({ thumb });
		openOffice(file, deps);
		await settle();
		release("autorag-thumb://late");
		await settle();
		expect(published.at(-1)?.html).toBe("<p>page</p>");
		expect(published.every((state, index) => index === 0 || state.pending === false || state.html === null)).toBe(true);
	});

	it("ends pending with no page when rendering fails, so the viewer can show the text", async () => {
		const { deps, published } = setup({ page: Promise.resolve(null), thumb: Promise.resolve(null) });
		openOffice(file, deps);
		await settle();
		expect(published.at(-1)).toEqual({ firstPage: null, html: null, pending: false });
	});

	it("stops publishing once the preview has moved on to another file", async () => {
		const { deps, published, stop } = setup();
		openOffice(file, deps);
		stop();
		await settle();
		expect(published).toEqual([]);
	});
});
