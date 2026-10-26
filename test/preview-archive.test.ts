import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readIworkPreview } from "../src/preview/node/iwork";
import { summarizeArchive } from "../src/preview/shared/archive-items";
import { isPreviewDocument } from "../src/preview/shared/contract";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";
import { buildIwa, concat, pbBytes, pbVarint } from "./iwa-fixture";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

/** A minimal `Index/Document.iwa`: a show object listing these slide nodes in order. */
function keyDocument(slides: readonly { readonly nodeId: number; readonly dataId: number }[]): Uint8Array {
	const nodes = slides.map(({ nodeId, dataId }) => ({ identifier: nodeId, type: 4, payload: pbBytes(16, pbVarint(1, dataId)) }));
	const references = slides.map(({ nodeId }) => pbBytes(2, pbVarint(1, nodeId)));
	return buildIwa([{ identifier: 1, type: 2, payload: pbBytes(3, concat(references)) }, ...nodes]);
}

async function packageFile(name: string, files: Parameters<typeof zipSync>[0], level: 0 | 6 = 0): Promise<{ readonly dir: string; readonly path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-iwork-"));
	const path = join(dir, name);
	await writeFile(path, zipSync(files, { level }));
	return { dir, path };
}

describe("iWork packages", () => {
	it("sends Numbers, Pages, and Keynote files to the page-image viewer", () => {
		for (const ext of ["numbers", "pages", "key"]) {
			expect(viewerForExtension(ext)).toBe("iwork");
			expect(byteNeed("iwork")).toBe("extract");
		}
		expect(describeExtension("key")).toBe("Keynote presentation");
	});

	it("reads the stored first-page image without the rest of the package", async () => {
		const { dir, path } = await packageFile("deck.key", { "Index/Document.iwa": new Uint8Array(70_000), "preview.jpg": JPEG, "preview-web.jpg": new Uint8Array([9]) });
		try {
			expect(await readIworkPreview(path)).toEqual({ firstPage: JPEG, pages: null });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("inflates a deflated preview and falls back to the web-sized one", async () => {
		const big = new Uint8Array(4096).fill(7);
		const { dir, path } = await packageFile("sheet.numbers", { "Index/x.iwa": strToU8("x"), "preview-web.jpg": big }, 6);
		try {
			expect(await readIworkPreview(path)).toEqual({ firstPage: big, pages: null });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads every Keynote slide in show order, the quality first page first", async () => {
		const quality = Uint8Array.from([0xff, 0xd8, 9, 0xff, 0xd9]);
		const slideA = Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9]);
		const slideB = Uint8Array.from([0xff, 0xd8, 2, 0xff, 0xd9]);
		const slideC = Uint8Array.from([0xff, 0xd8, 3, 0xff, 0xd9]);
		const { dir, path } = await packageFile("show.key", {
			"preview.jpg": quality,
			"Data/st-AAA-100.jpg": slideA,
			"Data/st-BBB-300.jpg": slideB,
			"Data/st-CCC-200.jpg": slideC,
			"Data/st-ZZZ-999.jpg": new Uint8Array([0]),
			"Index/Document.iwa": keyDocument([
				{ nodeId: 11, dataId: 200 },
				{ nodeId: 12, dataId: 300 },
				{ nodeId: 13, dataId: 100 },
			]),
		});
		try {
			const preview = await readIworkPreview(path);
			expect(preview).toEqual({ firstPage: quality, pages: [quality, slideB, slideA] });
			expect(preview?.pages).not.toContain(slideC);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("degrades to the first page when the slide tree is unreadable", async () => {
		const { dir, path } = await packageFile("broken.key", { "preview.jpg": JPEG, "Data/st-AAA-100.jpg": new Uint8Array([1]), "Index/Document.iwa": new Uint8Array(64) });
		try {
			expect(await readIworkPreview(path)).toEqual({ firstPage: JPEG, pages: null });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps Numbers and Pages single-page even with slide renders present", async () => {
		const { dir, path } = await packageFile("book.pages", {
			"preview.jpg": JPEG,
			"Data/st-AAA-100.jpg": new Uint8Array([1]),
			"Index/Document.iwa": keyDocument([{ nodeId: 11, dataId: 100 }]),
		});
		try {
			expect(await readIworkPreview(path)).toEqual({ firstPage: JPEG, pages: null });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("caps a Keynote deck at 500 slides", async () => {
		const files: Record<string, Uint8Array> = { "preview.jpg": JPEG, "Index/Document.iwa": keyDocument(Array.from({ length: 501 }, (_, index) => ({ nodeId: 1000 + index, dataId: 2000 + index }))) };
		for (let index = 0; index < 501; index += 1) files[`Data/st-S-${2000 + index}.jpg`] = new Uint8Array([index & 0xff]);
		const over = await packageFile("long.key", files);
		try {
			expect(await readIworkPreview(over.path)).toEqual({ firstPage: JPEG, pages: null });
		} finally {
			await rm(over.dir, { recursive: true, force: true });
		}
		const exact = await packageFile("max.key", { ...files, "Index/Document.iwa": keyDocument(Array.from({ length: 500 }, (_, index) => ({ nodeId: 1000 + index, dataId: 2000 + index }))) });
		try {
			const preview = await readIworkPreview(exact.path);
			expect(preview?.pages?.length).toBe(500);
		} finally {
			await rm(exact.dir, { recursive: true, force: true });
		}
	});

	it("answers null for a package with no image or no ZIP at all", async () => {
		const empty = await packageFile("none.pages", { "Index/Document.iwa": strToU8("x") });
		const plain = await mkdtemp(join(tmpdir(), "autorag-iwork-"));
		try {
			expect(await readIworkPreview(empty.path)).toBeNull();
			await writeFile(join(plain, "old.pages"), "not a zip");
			expect(await readIworkPreview(join(plain, "old.pages"))).toBeNull();
		} finally {
			await rm(empty.dir, { recursive: true, force: true });
			await rm(plain, { recursive: true, force: true });
		}
	});
});

describe("PreviewDocument with pages", () => {
	function documentWith(pages: unknown): Record<string, unknown> {
		return { name: "a.key", path: "/tmp/a.key", ext: "key", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z", mime: "application/octet-stream", truncated: false, bytes: JPEG, pages, office: null, thumbnail: null };
	}

	it("accepts null pages and an array of byte arrays", () => {
		expect(isPreviewDocument(documentWith(null))).toBe(true);
		expect(isPreviewDocument(documentWith([JPEG, new Uint8Array([1])]))).toBe(true);
	});

	it("rejects non-arrays and non-byte elements", () => {
		expect(isPreviewDocument(documentWith("slides"))).toBe(false);
		expect(isPreviewDocument(documentWith([1, 2]))).toBe(false);
		expect(isPreviewDocument(documentWith(undefined))).toBe(false);
	});
});

describe("archive top level", () => {
	const at = (day: number): number => Date.UTC(2026, 0, day);

	it("groups entries under their first path segment, newest child first", () => {
		const summary = summarizeArchive(
			[
				{ name: "docs/", size: 0, modified: at(1) },
				{ name: "docs/a.txt", size: 1, modified: at(5) },
				{ name: "docs/b/c.pdf", size: 1, modified: at(2) },
				{ name: "readme.md", size: 1, modified: at(9) },
				{ name: "old.png", size: 1, modified: at(3) },
			],
			2,
		);
		expect(summary.itemCount).toBe(3);
		expect(summary.items).toEqual([
			{ name: "readme.md", folder: false, ext: "md" },
			{ name: "docs", folder: true, ext: "" },
		]);
	});

	it("hides dot entries and macOS resource forks like a folder preview does", () => {
		const summary = summarizeArchive(
			[
				{ name: "__MACOSX/._a.txt", size: 1, modified: null },
				{ name: ".DS_Store", size: 1, modified: null },
				{ name: "a.txt", size: 1, modified: null },
			],
			6,
		);
		expect(summary.itemCount).toBe(1);
		expect(summary.items.map((item) => item.name)).toEqual(["a.txt"]);
	});

	it("reads ZIP dates and keeps directory entries", () => {
		const zipped = zipSync({ "dir/a.txt": [strToU8("hi"), { mtime: new Date(2026, 2, 4, 5, 6, 8) }] });
		const entries = listZipEntries(zipped) ?? [];
		expect(entries.map((entry) => entry.name)).toEqual(["dir/a.txt"]);
		expect(entries[0]?.modified).toBe(new Date(2026, 2, 4, 5, 6, 8).getTime());
	});
});

describe("tar extended headers", () => {
	function header(name: string, size: number, flag: string): Uint8Array {
		const block = new Uint8Array(512);
		block.set(new TextEncoder().encode(name), 0);
		block.set(new TextEncoder().encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
		block.set(new TextEncoder().encode(flag), 156);
		return block;
	}
	function padded(bytes: Uint8Array): Uint8Array {
		const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
		out.set(bytes);
		return out;
	}
	function concat(parts: readonly Uint8Array[]): Uint8Array {
		const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0) + 1024);
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	}

	it("does not list macOS pax headers as entries and takes their path and date for the next file", () => {
		const pax = new TextEncoder().encode("30 path=docs/long-name.txt\n20 mtime=1700000000\n");
		const tar = concat([
			header("PaxHeader/long", pax.length, "x"),
			padded(pax),
			header("docs/long", 5, "0"),
			padded(new TextEncoder().encode("hello")),
		]);
		const entries = listTarEntries(tar) ?? [];
		expect(entries.map((entry) => entry.name)).toEqual(["docs/long-name.txt"]);
		expect(entries[0]?.modified).toBe(1_700_000_000_000);
	});

	it("applies a GNU long name to the next entry", () => {
		const long = new TextEncoder().encode(`${"d/".repeat(60)}file.txt\0`);
		const tar = concat([header("././@LongLink", long.length, "L"), padded(long), header("truncated", 1, "0"), padded(new Uint8Array([1]))]);
		expect((listTarEntries(tar) ?? []).map((entry) => entry.name)).toEqual([`${"d/".repeat(60)}file.txt`]);
	});
});
