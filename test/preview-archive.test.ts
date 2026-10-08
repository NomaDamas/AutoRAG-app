import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readIworkPreview } from "../src/preview/node/iwork";
import { summarizeArchive } from "../src/preview/shared/archive-items";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

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
			expect(await readIworkPreview(path)).toEqual(JPEG);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("inflates a deflated preview and falls back to the web-sized one", async () => {
		const big = new Uint8Array(4096).fill(7);
		const { dir, path } = await packageFile("sheet.numbers", { "Index/x.iwa": strToU8("x"), "preview-web.jpg": big }, 6);
		try {
			expect(await readIworkPreview(path)).toEqual(big);
		} finally {
			await rm(dir, { recursive: true, force: true });
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
