import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const bundle = join(__dirname, "..", "build", "icon.icon");

// macOS 26 draws a legacy .icns app icon shrunk inside a grey rounded plate. Only an Icon Composer
// bundle (`.icon`, compiled to Assets.car and named by CFBundleIconName) is drawn full size, so the
// installed app needs one whose layer fills the whole 1024 canvas: the system's rounded mask then
// replaces the tile's own outline instead of sitting inside a second one.
describe("macOS app icon bundle", () => {
	const manifest = (): { groups: { layers: { "image-name": string }[] }[] } => JSON.parse(readFileSync(join(bundle, "icon.json"), "utf8"));

	it("names only layer images that exist", () => {
		const layers = manifest().groups.flatMap((group) => group.layers);
		expect(layers.length).toBeGreaterThan(0);
		for (const layer of layers) expect(existsSync(join(bundle, "Assets", layer["image-name"])), layer["image-name"]).toBe(true);
	});

	it("draws each layer 1024x1024 and opaque at every edge midpoint", async () => {
		for (const { "image-name": name } of manifest().groups.flatMap((group) => group.layers)) {
			const { data, info } = await sharp(join(bundle, "Assets", name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			expect([info.width, info.height]).toEqual([1024, 1024]);
			const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
			for (const [x, y] of [[512, 0], [512, 1023], [0, 512], [1023, 512], [512, 512]] as const) expect(alpha(x, y), `${name} (${x},${y})`).toBeGreaterThan(200);
		}
	});
});
