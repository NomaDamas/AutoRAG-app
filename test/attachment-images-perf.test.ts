import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resize = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@earendil-works/pi-coding-agent", async (importActual) => {
	const actual = await importActual<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		resizeImage: (...args: Parameters<typeof actual.resizeImage>) => {
			resize.calls += 1;
			return actual.resizeImage(...args);
		},
	};
});

import { imageSize, loadAttachmentImages } from "../src/main/attachment-images";

let root: string;
beforeEach(() => {
	resize.calls = 0;
	root = mkdtempSync(join(tmpdir(), "dazzi-image-perf-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(name: string, size: string, codec: string[] = []): string {
	const path = join(root, name);
	execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `testsrc=s=${size}`, "-frames:v", "1", ...codec, path], { stdio: "ignore" });
	return path;
}
const file = (path: string) => ({ kind: "file" as const, id: path, name: path.split("/").at(-1) ?? path });

describe("imageSize", () => {
	it("reads the dimensions from the header of PNG, JPEG, GIF and WebP files", () => {
		expect(imageSize(readFileSync(make("a.png", "320x200")))).toEqual({ width: 320, height: 200 });
		expect(imageSize(readFileSync(make("a.jpg", "641x481")))).toEqual({ width: 641, height: 481 });
		expect(imageSize(readFileSync(make("a.gif", "100x50")))).toEqual({ width: 100, height: 50 });
		// Header-only WebP files (this ffmpeg has no WebP encoder): extended (VP8X) and lossless (VP8L) layouts.
		const riff = (chunk: string, body: Buffer): Buffer => {
			const header = Buffer.alloc(20);
			header.write("RIFF", 0, "ascii");
			header.writeUInt32LE(12 + body.length, 4);
			header.write("WEBP", 8, "ascii");
			header.write(chunk, 12, "ascii");
			header.writeUInt32LE(body.length, 16);
			return Buffer.concat([header, body]);
		};
		const vp8x = Buffer.alloc(10);
		vp8x.writeUIntLE(333 - 1, 4, 3);
		vp8x.writeUIntLE(222 - 1, 7, 3);
		expect(imageSize(riff("VP8X", vp8x))).toEqual({ width: 333, height: 222 });
		const vp8l = Buffer.alloc(16); // a real lossless chunk is longer than its 5-byte header
		vp8l[0] = 0x2f;
		vp8l.writeUInt32LE((333 - 1) | ((222 - 1) << 14), 1);
		expect(imageSize(riff("VP8L", vp8l))).toEqual({ width: 333, height: 222 });
	});

	it("answers null for bytes that are not an image it knows", () => {
		expect(imageSize(Buffer.from("not an image at all, just text"))).toBeNull();
		expect(imageSize(Buffer.alloc(0))).toBeNull();
	});
});

describe("loadAttachmentImages speed", () => {
	it("passes a picture that already fits through untouched, without starting the resizer", async () => {
		const path = make("small.png", "800x600");
		const [picture] = await loadAttachmentImages([file(path)]);
		expect(picture?.data).toBe(readFileSync(path).toString("base64"));
		expect(picture?.mimeType).toBe("image/png");
		expect(resize.calls).toBe(0);
	});

	it("still scales one that is too large", async () => {
		const [picture] = await loadAttachmentImages([file(make("huge.png", "3000x1500"))]);
		expect(resize.calls).toBe(1);
		expect(imageSize(Buffer.from(picture?.data ?? "", "base64"))?.width).toBeLessThanOrEqual(2000);
	});

	it("scales a picture only once however often the chat sends it", async () => {
		const path = make("again.png", "3000x1500");
		await loadAttachmentImages([file(path)]);
		await loadAttachmentImages([file(path)]);
		await loadAttachmentImages([file(path)]);
		expect(resize.calls).toBe(1);
	});

	it("scales it again when the file changed under the same path", async () => {
		const path = make("edit.png", "3000x1500");
		await loadAttachmentImages([file(path)]);
		writeFileSync(path, readFileSync(make("other.png", "3200x1600")));
		utimesSync(path, new Date(), new Date(Date.now() + 5000));
		await loadAttachmentImages([file(path)]);
		expect(resize.calls).toBe(2);
	});

	it("keeps the order of several pictures", async () => {
		const [a, b] = [make("o1.png", "100x100"), make("o2.jpg", "120x80")];
		const out = await loadAttachmentImages([file(a), file(b)]);
		expect(out.map((picture) => picture.mimeType)).toEqual(["image/png", "image/jpeg"]);
	});
});
