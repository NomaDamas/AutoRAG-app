import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readPreviewFile } from "../src/preview/node/read-file";
import { parseByteRange } from "../src/preview/shared/range";
import { claimedViewerExtensions, describeExtension, viewerForExtension, wantsBytes, VIEWER_KINDS } from "../src/preview/shared/registry";
import { rtfToText } from "../src/preview/shared/rtf";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";
import { fitQuickLook, placeQuickLook, QUICK_LOOK_MIN, QUICK_LOOK_TOOLBAR } from "../src/preview/shared/fit";


describe("preview registry", () => {
	it("resolves every claimed extension to its viewer", () => {
		const claimed = claimedViewerExtensions();
		expect(claimed.length).toBeGreaterThan(100);
		const seen = new Set<string>();
		for (const { ext, kind } of claimed) {
			expect(viewerForExtension(ext)).toBe(kind);
			expect(kind).not.toBe("fallback");
			seen.add(kind);
		}
		for (const kind of VIEWER_KINDS) {
			if (kind === "fallback") continue;
			expect(seen.has(kind)).toBe(true);
		}
		expect(viewerForExtension("nope")).toBe("fallback");
		expect(wantsBytes("video")).toBe(false);
		expect(wantsBytes("docx")).toBe(true);
		expect(describeExtension("png").length).toBeGreaterThan(0);
	});
});

describe("quick look sizing", () => {
	it("fits measured content inside the work area with toolbar chrome", () => {
		const size = fitQuickLook({ width: 1600, height: 900 }, { width: 1440, height: 900 });
		expect(size.width).toBeLessThanOrEqual(Math.ceil(1440 * 0.86));
		expect(size.height).toBeLessThanOrEqual(Math.ceil(900 * 0.86));
		expect(size.width / (size.height - QUICK_LOOK_TOOLBAR)).toBeCloseTo(1600 / 900, 1);
	});

	it("hugs a page-shaped document and never upscales past its natural size", () => {
		const page = fitQuickLook({ width: 595, height: 842 }, { width: 1440, height: 900 });
		expect(page.width / (page.height - QUICK_LOOK_TOOLBAR)).toBeCloseTo(595 / 842, 1);
		expect(page.height).toBeLessThanOrEqual(Math.ceil(900 * 0.86));
		const small = fitQuickLook({ width: 200, height: 150 }, { width: 1440, height: 900 });
		expect(small).toEqual(QUICK_LOOK_MIN);
	});

	it("falls back to a page shape when the content cannot measure itself", () => {
		const size = fitQuickLook({ width: 0, height: 0 }, { width: 1440, height: 900 });
		expect(size).toEqual({ width: Math.round(Math.min(880, 1440 * 0.86)), height: Math.round(Math.min(1040, 900 * 0.86)) });
	});

	it("centers and clamps the preview bounds", () => {
		const bounds = placeQuickLook({ width: 500, height: 400 }, { x: 1300, y: 700, width: 900, height: 700 }, { x: 0, y: 0, width: 1440, height: 900 });
		expect(bounds.x).toBe(940);
		expect(bounds.y).toBe(500);
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
