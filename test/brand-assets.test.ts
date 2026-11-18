import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderBrandAssets } from "../scripts/brand/make-brand-assets.mjs";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path));

async function raw(file: Buffer) {
	const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, alpha: (x: number, y: number) => data[(y * info.width + x) * 4 + 3] };
}

// The logo exists as two transparent masters (build/icon.png: the glass tile, build/brand/dazzi-mark.png:
// the sunflower alone). Every other logo file is derived from them by scripts/brand/make-brand-assets.mjs, so a
// file that disagrees with the masters means somebody edited one in isolation (AGENTS.md: regenerate from one master).
describe("Dazzi logo files", () => {
	it("keeps the masters transparent at the corners and opaque at the centre", async () => {
		for (const path of ["build/icon.png", "build/brand/dazzi-mark.png"]) {
			const image = await raw(read(path));
			expect([image.width, image.height], path).toEqual([1024, 1024]);
			for (const [x, y] of [[0, 0], [1023, 0], [0, 1023], [1023, 1023]] as const) expect(image.alpha(x, y), `${path} (${x},${y})`).toBe(0);
			expect(image.alpha(512, 512), path).toBe(255);
		}
	});

	it("draws the tile on the Apple icon grid (body 824 of 1024)", async () => {
		const { data, width, height } = await raw(read("build/icon.png"));
		let [left, right] = [width, 0];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (data[(y * width + x) * 4 + 3] <= 128) continue;
				left = Math.min(left, x);
				right = Math.max(right, x);
			}
		}
		expect(right - left + 1).toBeGreaterThanOrEqual(820);
		expect(right - left + 1).toBeLessThanOrEqual(828);
	});

	it("derives every shipped raster from the masters", async () => {
		const { files } = await renderBrandAssets();
		expect(files.size).toBeGreaterThan(10);
		for (const [path, expected] of files as Map<string, Buffer>) {
			if (path.endsWith(".ico")) {
				expect(read(path).equals(expected), path).toBe(true);
				continue;
			}
			const [actual, wanted] = await Promise.all([raw(read(path)), raw(expected)]);
			expect([actual.width, actual.height], path).toEqual([wanted.width, wanted.height]);
			expect(Buffer.compare(actual.data, wanted.data), path).toBe(0);
		}
	});

	it("packs the Windows icon with every size from 16 to 256", () => {
		const data = read("build/icon.ico");
		const count = data.readUInt16LE(4);
		const sizes = Array.from({ length: count }, (_, i) => data[6 + i * 16] || 256);
		expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
	});

	it("lets the sunflower mark stand on any background (transparent edges, no tile)", async () => {
		const mark = await raw(read("src/renderer/src/assets/dazzi-mark.png"));
		for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]] as const) expect(mark.alpha(x, y)).toBe(0);
		expect(mark.alpha(128, 128)).toBe(255);
	});
});
