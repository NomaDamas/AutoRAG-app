import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type OfficeRun, renderOfficeHtml, standaloneOfficeHtml } from "../src/preview/node/office-render";
import { isPreviewDocument } from "../src/preview/shared/contract";
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
			const dir = join(out, `${source.slice(source.lastIndexOf("/") + 1)}.qlpreview`);
			await mkdir(dir, { recursive: true });
			if (options.html !== undefined) await writeFile(join(dir, "Preview.html"), options.html);
			for (const [name, bytes] of Object.entries(options.attachments ?? {})) await writeFile(join(dir, name), bytes);
			return;
		}
		// sips -s format png --resampleWidth N a.pdf ... --out DIR
		const out = args[args.indexOf("--out") + 1] ?? "";
		if (!(await stat(out).then(() => true, () => false))) throw new Error("no destination dir was specified");
		for (const arg of args) if (arg.endsWith(".pdf")) await writeFile(join(out, `${arg.slice(arg.lastIndexOf("/") + 1, -4)}.png`), PNG);
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

describe("PreviewDocument.rendered", () => {
	const base = { name: "a.doc", path: "/a.doc", ext: "doc", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z", mime: "application/octet-stream", truncated: false, bytes: null, pages: null };

	it("is a string or null", () => {
		expect(isPreviewDocument({ ...base, rendered: null })).toBe(true);
		expect(isPreviewDocument({ ...base, rendered: "<html></html>" })).toBe(true);
		expect(isPreviewDocument({ ...base, rendered: 5 })).toBe(false);
		expect(isPreviewDocument(base)).toBe(false);
	});
});
