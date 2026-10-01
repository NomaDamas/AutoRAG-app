import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handlePreviewRequest } from "../src/preview/node/protocol";
import { readPreviewFile } from "../src/preview/node/read-file";
import { previewStreamUrl } from "../src/preview/shared/contract";
import { quickLookKeyAction } from "../src/preview/shared/keys";
import { parseByteRange } from "../src/preview/shared/range";
import { claimedViewerExtensions, describeExtension, viewerForExtension, wantsBytes, VIEWER_KINDS } from "../src/preview/shared/registry";
import { rtfToText } from "../src/preview/shared/rtf";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";
import { fitQuickLook, placeQuickLook, QUICK_LOOK_MIN, QUICK_LOOK_TOOLBAR } from "../src/preview/shared/fit";
import { fallbackOrigin, screenOrigin, zoomGeometry, zoomTransform } from "../src/preview/shared/zoom";
import { ZOOM_IN, ZOOM_OUT } from "../src/preview/ui/zoom-motion";


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

describe("quick look zoom", () => {
	const panel = { x: 400, y: 100, width: 800, height: 600 };

	it("covers the icon and the panel, anchoring the panel to the edges it shares with them", () => {
		const geometry = zoomGeometry({ x: 100, y: 800, width: 18, height: 18 }, panel);
		expect(geometry.union).toEqual({ x: 100, y: 100, width: 1100, height: 718 });
		expect(geometry.from).toEqual({ x: 0, y: 700, width: 18, height: 18 });
		expect(geometry.to).toEqual({ x: 300, y: 0, width: 800, height: 600 });
		expect(geometry.anchorX).toBe("right");
		expect(geometry.anchorY).toBe("top");
		const above = zoomGeometry({ x: 1300, y: 20, width: 18, height: 18 }, panel);
		expect(above.anchorX).toBe("left");
		expect(above.anchorY).toBe("bottom");
	});

	it("keeps the window on the panel when the icon is inside it", () => {
		const geometry = zoomGeometry(fallbackOrigin(panel), panel);
		expect(geometry.union).toEqual(panel);
		expect(geometry.to).toEqual({ ...panel, x: 0, y: 0 });
	});

	it("never zooms from a zero-sized icon", () => {
		const geometry = zoomGeometry({ x: 100, y: 100, width: 0, height: 0 }, panel);
		expect(geometry.from.width).toBe(1);
		expect(geometry.from.height).toBe(1);
	});

	it("poses the full-size panel exactly over the icon", () => {
		const from = { x: 0, y: 700, width: 18, height: 18 };
		const to = { x: 300, y: 0, width: 800, height: 600 };
		expect(zoomTransform(from, to)).toBe("translate(-300px, 700px) scale(0.0225, 0.03)");
	});

	it("zooms from the panel's center when the file has no visible icon", () => {
		const origin = fallbackOrigin(panel);
		expect(origin.x + origin.width / 2).toBe(panel.x + panel.width / 2);
		expect(origin.y + origin.height / 2).toBe(panel.y + panel.height / 2);
		expect(origin.width).toBeLessThan(panel.width / 2);
	});

	it("maps a Finder viewport rect to screen coordinates", () => {
		const content = { x: 50, y: 80, width: 1440, height: 900 };
		expect(screenOrigin(content, { x: 10, y: 20, width: 18, height: 18 }, 1)).toEqual({ x: 60, y: 100, width: 18, height: 18 });
		expect(screenOrigin(content, { x: 10, y: 20, width: 18, height: 18 }, 1.25)).toEqual({ x: 63, y: 105, width: 23, height: 23 });
	});
});

describe("quick look spring", () => {
	function stops(easing: string): readonly { readonly value: number; readonly percent: number }[] {
		const parsed = easing
			.slice("linear(".length, -1)
			.split(",")
			.map((stop) => {
				const [value = "0", percent] = stop.trim().split(/\s+/);
				return { value: Number(value), percent: percent === undefined ? null : Number(percent.replace("%", "")) };
			});
		const at: (number | null)[] = parsed.map((stop) => stop.percent);
		if (at.length === 0) return [];
		at[0] ??= 0;
		at[at.length - 1] ??= 100;
		// `linear()` spreads a run of position-less stops evenly between its neighbours.
		for (let index = 1; index < at.length - 1; index += 1) {
			if (at[index] !== null) continue;
			let next = index;
			while (at[next] === null) next += 1;
			let previous = index - 1;
			while (at[previous] === null) previous -= 1;
			const from = at[previous] ?? 0;
			const to = at[next] ?? 100;
			at[index] = from + ((to - from) / (next - previous)) * (index - previous);
		}
		return parsed.map((stop, index) => ({ value: stop.value, percent: at[index] ?? 0 }));
	}

	it("is a real spring curve, not a hand-tuned bezier", () => {
		const curve = stops(ZOOM_IN.easing);
		expect(ZOOM_IN.easing.startsWith("linear(")).toBe(true);
		expect(curve[0]?.value).toBe(0);
		expect(curve.at(-1)?.value).toBeGreaterThan(0.995);
		expect(Math.max(...curve.map((stop) => stop.value))).toBeLessThanOrEqual(1.005);
		// Apple's springs leave the icon fast: most of the travel is over early.
		const quarter = curve.find((stop) => stop.percent >= 25);
		expect(quarter?.value).toBeGreaterThan(0.6);
	});

	it("settles in about Apple's response time", () => {
		expect(ZOOM_IN.duration).toBeGreaterThanOrEqual(100);
		expect(ZOOM_IN.duration).toBeLessThanOrEqual(300);
		expect(ZOOM_OUT.duration).toBeGreaterThanOrEqual(100);
		expect(ZOOM_OUT.duration).toBeLessThanOrEqual(300);
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

describe("preview stream", () => {
	it("serves byte ranges so media can seek", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-preview-"));
		try {
			const filePath = join(dir, "clip.mp4");
			await writeFile(filePath, "0123456789");
			const whole = await handlePreviewRequest(new Request(previewStreamUrl(filePath)));
			expect(whole.status).toBe(200);
			expect(whole.headers.get("accept-ranges")).toBe("bytes");
			expect(whole.headers.get("content-length")).toBe("10");
			expect(whole.headers.get("content-type")).toBe("video/mp4");
			expect(await whole.text()).toBe("0123456789");

			const part = await handlePreviewRequest(new Request(previewStreamUrl(filePath), { headers: { Range: "bytes=7-" } }));
			expect(part.status).toBe(206);
			expect(part.headers.get("content-range")).toBe("bytes 7-9/10");
			expect(part.headers.get("content-length")).toBe("3");
			expect(await part.text()).toBe("789");

			const beyond = await handlePreviewRequest(new Request(previewStreamUrl(filePath), { headers: { Range: "bytes=10-" } }));
			expect(beyond.status).toBe(416);
			expect(beyond.headers.get("content-range")).toBe("bytes */10");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects folders and missing files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "autorag-preview-"));
		try {
			expect((await handlePreviewRequest(new Request(previewStreamUrl(dir)))).status).toBe(404);
			expect((await handlePreviewRequest(new Request(previewStreamUrl(join(dir, "gone.mp4"))))).status).toBe(404);
			expect((await handlePreviewRequest(new Request(previewStreamUrl("relative.mp4")))).status).toBe(400);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("quick look keys", () => {
	const input = (key: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({
		key,
		meta: mods.meta ?? false,
		control: mods.control ?? false,
		alt: mods.alt ?? false,
		shift: mods.shift ?? false,
	});

	it("closes on Space and Escape and walks the Finder selection with up and down", () => {
		expect(quickLookKeyAction(input(" "))).toBe("close");
		expect(quickLookKeyAction(input("Escape"))).toBe("close");
		expect(quickLookKeyAction(input("ArrowDown"))).toBe("next");
		expect(quickLookKeyAction(input("ArrowUp"))).toBe("previous");
	});

	it("leaves media keys and shortcuts to the page", () => {
		expect(quickLookKeyAction(input("ArrowLeft"))).toBeNull();
		expect(quickLookKeyAction(input("ArrowRight"))).toBeNull();
		expect(quickLookKeyAction(input("k"))).toBeNull();
		expect(quickLookKeyAction(input(" ", { meta: true }))).toBeNull();
		expect(quickLookKeyAction(input(" ", { control: true }))).toBeNull();
		expect(quickLookKeyAction(input("ArrowDown", { alt: true }))).toBeNull();
	});
});
