import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readPreviewFile } from "../src/preview/node/read-file";
import { parseByteRange } from "../src/preview/shared/range";
import { describeExtension, viewerForExtension, wantsBytes } from "../src/preview/shared/registry";
import { rtfToText } from "../src/preview/shared/rtf";
import { stepQuickLook, type QuickLookRequest } from "../src/preview/shared/session";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";
import { zoomFromAnchor } from "../src/preview/shared/zoom";

const sample: QuickLookRequest = { path: "/tmp/a.png", name: "a.png", anchor: null };

describe("preview registry", () => {
	it("routes the families the in-app viewer claims", () => {
		expect(viewerForExtension("png")).toBe("image");
		expect(viewerForExtension(".PDF")).toBe("pdf");
		expect(viewerForExtension("mp4")).toBe("video");
		expect(viewerForExtension("docx")).toBe("docx");
		expect(viewerForExtension("xlsx")).toBe("sheet");
		expect(viewerForExtension("csv")).toBe("sheet");
		expect(viewerForExtension("pptx")).toBe("pptx");
		expect(viewerForExtension("md")).toBe("markdown");
		expect(viewerForExtension("zip")).toBe("archive");
		expect(viewerForExtension("epub")).toBe("epub");
		expect(viewerForExtension("hwpx")).toBe("hwpx");
		expect(viewerForExtension("woff2")).toBe("font");
		expect(viewerForExtension("heic")).toBe("heic");
		expect(viewerForExtension("tif")).toBe("tiff");
		expect(viewerForExtension("nope")).toBe("fallback");
		expect(wantsBytes("video")).toBe(false);
		expect(wantsBytes("docx")).toBe(true);
		expect(describeExtension("png").length).toBeGreaterThan(0);
	});
});

describe("quick look motion", () => {
	it("parks the panel center on the row and keeps a uniform scale", () => {
		const anchor = { x: 100, y: 200, width: 400, height: 32 };
		const dest = { x: 300, y: 80, width: 760, height: 600 };
		const zoom = zoomFromAnchor(anchor, dest);
		expect(zoom.scale).toBeGreaterThanOrEqual(0.12);
		expect(zoom.scale).toBeLessThanOrEqual(0.22);
		expect(dest.x + dest.width / 2 + zoom.x).toBeCloseTo(anchor.x + anchor.width / 2);
		expect(dest.y + dest.height / 2 + zoom.y).toBeCloseTo(anchor.y + anchor.height / 2);
	});

	it("opens, swaps, and closes without reopening a closed preview", () => {
		const opened = stepQuickLook(sample, null, "closed");
		expect(opened.phase).toBe("opening");
		expect(opened.shown?.path).toBe(sample.path);
		const settled = stepQuickLook(sample, opened.shown, "open");
		expect(settled.phase).toBe("open");
		expect(settled.shown).toBe(opened.shown);
		const swapped = stepQuickLook({ ...sample, path: "/tmp/b.pdf", name: "b.pdf" }, opened.shown, "open");
		expect(swapped.phase).toBe("open");
		expect(swapped.shown?.path).toBe("/tmp/b.pdf");
		const closing = stepQuickLook(null, swapped.shown, "open");
		expect(closing.phase).toBe("closing");
		const closed = stepQuickLook(null, closing.shown, "closed");
		expect(closed.shown).toBeNull();
		expect(closed.phase).toBe("closed");
	});
});

describe("preview bytes", () => {
	it("parses http ranges", () => {
		expect(parseByteRange("bytes=0-10", 100)).toEqual({ start: 0, end: 10 });
		expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
		expect(parseByteRange("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
		expect(parseByteRange("bytes=100-200", 100)).toBeNull();
	});

	it("lists zip and tar entries without unpacking them", () => {
		const zipped = zipSync({ "a.txt": strToU8("hi"), "dir/b.txt": strToU8("yo") });
		expect(listZipEntries(zipped)?.map((entry) => entry.name).sort()).toEqual(["a.txt", "dir/b.txt"]);
		const header = new Uint8Array(512);
		header.set(new TextEncoder().encode("hello.txt"), 0);
		header.set(new TextEncoder().encode("00000000005"), 124);
		const bytes = new Uint8Array(1024);
		bytes.set(header, 0);
		expect(listTarEntries(bytes)?.map((entry) => entry.name)).toEqual(["hello.txt"]);
	});

	it("keeps the readable words in rtf", () => {
		expect(rtfToText("{\\rtf1\\ansi Hello\\par World}")).toBe("Hello\nWorld");
	});

	it("reads a real file and rejects a folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-preview-"));
		try {
			const filePath = join(dir, "note.txt");
			await writeFile(filePath, "hello");
			const document = await readPreviewFile(filePath, true);
			expect(document.ext).toBe("txt");
			expect(document.truncated).toBe(false);
			expect(new TextDecoder().decode(document.bytes ?? new Uint8Array())).toBe("hello");
			await expect(readPreviewFile(dir, true)).rejects.toThrow("폴더는 미리볼 수 없습니다");
			await expect(readPreviewFile("relative.txt", true)).rejects.toThrow("미리보기 경로가 올바르지 않습니다");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
