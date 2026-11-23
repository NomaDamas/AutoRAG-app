import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAttachmentImages, MAX_MESSAGE_IMAGES } from "../src/main/attachment-images";
import { createPastedImageStore, PASTED_IMAGE_MAX_BYTES } from "../src/main/pasted-images";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dazzi-pasted-images-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("createPastedImageStore", () => {
	it("keeps the pasted bytes as a file attachment named for the image type", async () => {
		const store = createPastedImageStore({ directory: join(root, "pasted") });
		const attachment = await store.save("image/png", PNG_1X1);
		expect(attachment).toMatchObject({ kind: "file" });
		expect(attachment.name).toMatch(/^pasted-image-[0-9a-f]{8}\.png$/u);
		expect(attachment.id).toBe(join(root, "pasted", attachment.name));
		expect(readFileSync(attachment.id).toString("base64")).toBe(PNG_1X1);
	});

	it("gives two pastes two files", async () => {
		const store = createPastedImageStore({ directory: root });
		const [a, b] = [await store.save("image/png", PNG_1X1), await store.save("image/png", PNG_1X1)];
		expect(a.id).not.toBe(b.id);
	});

	it("refuses what a model cannot take or that is empty or oversized", async () => {
		const store = createPastedImageStore({ directory: root });
		await expect(store.save("image/svg+xml", PNG_1X1)).rejects.toThrow();
		await expect(store.save("text/html", PNG_1X1)).rejects.toThrow();
		await expect(store.save("image/png", "")).rejects.toThrow();
		await expect(store.save("image/png", Buffer.alloc(PASTED_IMAGE_MAX_BYTES + 1).toString("base64"))).rejects.toThrow();
	});

	it("clear deletes every pasted file", async () => {
		const directory = join(root, "pasted");
		const store = createPastedImageStore({ directory });
		const { id } = await store.save("image/png", PNG_1X1);
		await store.clear();
		expect(existsSync(id)).toBe(false);
	});
});

describe("loadAttachmentImages", () => {
	function image(name: string): { kind: "file"; id: string; name: string } {
		const path = join(root, name);
		writeFileSync(path, Buffer.from(PNG_1X1, "base64"));
		return { kind: "file", id: path, name };
	}

	it("reads image files into model pictures and skips everything else", async () => {
		const note = join(root, "note.txt");
		writeFileSync(note, "hello");
		const images = await loadAttachmentImages([
			image("a.png"),
			{ kind: "file", id: note, name: "note.txt" },
			{ kind: "folder", id: root, name: "root" },
			{ kind: "url", id: "https://example.com/x.png", name: "x.png" },
			{ kind: "file", id: join(root, "missing.png"), name: "missing.png" },
		]);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(images[0]?.data.length).toBeGreaterThan(0);
	});

	it("skips a file whose bytes are not an image, instead of failing the question", async () => {
		const fake = join(root, "fake.png");
		writeFileSync(fake, "this is not a png");
		expect(await loadAttachmentImages([{ kind: "file", id: fake, name: "fake.png" }])).toEqual([]);
	});

	it("scales a large picture down before it goes to the model", async () => {
		const big = join(root, "big.png");
		execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=3000x1500", "-frames:v", "1", big], { stdio: "ignore" });
		const [picture] = await loadAttachmentImages([{ kind: "file", id: big, name: "big.png" }]);
		expect(picture).toBeDefined();
		expect(Buffer.from(picture?.data ?? "", "base64").readUInt32BE(16)).toBeLessThanOrEqual(2000);
	});

	it("sends at most MAX_MESSAGE_IMAGES pictures", async () => {
		const many = Array.from({ length: MAX_MESSAGE_IMAGES + 3 }, (_, index) => image(`p${index}.png`));
		expect(await loadAttachmentImages(many)).toHaveLength(MAX_MESSAGE_IMAGES);
	});
});
