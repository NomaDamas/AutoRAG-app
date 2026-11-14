/**
 * Regenerate every Dazzi logo file from the two transparent masters.
 *
 *   node scripts/brand/make-brand-assets.mjs        (macOS: also rebuilds build/icon.icns)
 *   node scripts/brand/make-mac-icon.mjs            (the Icon Composer bundle, from build/icon.png)
 *
 * Masters (1024x1024, transparent background, never edited by hand):
 *   build/icon.png              the glass tile, body 824 px on the Apple icon grid
 *   build/brand/dazzi-mark.png  the sunflower alone, cut out of the tile
 *
 * Derived: build/icons/<size>.png, build/icon.ico, build/icon.icns, the renderer logo
 * (src/renderer/src/assets/dazzi-logo.png: tile, trimmed), the renderer mark (dazzi-mark.png:
 * flower), and the Raycast extension icon (tile with a small margin).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const RENDERER_SIZE = 256;
export const RAYCAST_SIZE = 512;
/** Margin, in output pixels per 512, that the Raycast icon keeps around the tile. */
const RAYCAST_MARGIN = 5;
/** Margin per 256 px around the sunflower mark. */
const MARK_MARGIN = 2;

async function square(buffer, size, margin = 0) {
	const inner = size - 2 * margin;
	const body = await sharp(buffer).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" }).png().toBuffer();
	return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
		.composite([{ input: body, left: margin, top: margin }])
		.png({ compressionLevel: 9 })
		.toBuffer();
}

function ico(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = 6 + 16 * images.length;
	const entries = images.map(({ size, data }) => {
		const entry = Buffer.alloc(16);
		entry[0] = size >= 256 ? 0 : size;
		entry[1] = size >= 256 ? 0 : size;
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(data.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += data.length;
		return entry;
	});
	return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

/** Render every derived file as `{ path (relative to root), data }` without touching the disk. */
export async function renderBrandAssets(base = root) {
	const trim = { background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 };
	const tile = await sharp(join(base, "build", "icon.png")).ensureAlpha().trim(trim).png().toBuffer();
	const mark = await sharp(join(base, "build", "brand", "dazzi-mark.png")).ensureAlpha().trim(trim).png().toBuffer();
	const files = new Map();
	const sizes = new Map();
	for (const size of new Set([...PNG_SIZES, ...ICO_SIZES, 1024])) sizes.set(size, await square(tile, size));
	for (const size of PNG_SIZES) files.set(`build/icons/${size}x${size}.png`, sizes.get(size));
	files.set("build/icon.ico", ico(ICO_SIZES.map((size) => ({ size, data: sizes.get(size) }))));
	files.set("src/renderer/src/assets/dazzi-logo.png", await square(tile, RENDERER_SIZE));
	files.set("src/renderer/src/assets/dazzi-mark.png", await square(mark, RENDERER_SIZE, MARK_MARGIN));
	files.set("integrations/raycast/assets/extension-icon.png", await square(tile, RAYCAST_SIZE, RAYCAST_MARGIN));
	return { files, tile: sizes.get(1024) };
}

/** Build `build/icon.icns` with macOS's iconutil from the 1024 tile. */
async function renderIcns(tile, out) {
	const dir = mkdtempSync(join(tmpdir(), "dazzi-iconset-"));
	try {
		const set = join(dir, "icon.iconset");
		mkdirSync(set);
		for (const [name, size] of [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024]]) {
			writeFileSync(join(set, `icon_${name}.png`), await sharp(tile).resize(size, size, { kernel: "lanczos3" }).png().toBuffer());
		}
		execFileSync("iconutil", ["-c", "icns", set, "-o", out]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { files, tile } = await renderBrandAssets();
	for (const [path, data] of files) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), data);
		console.log(`wrote ${path}`);
	}
	if (process.platform === "darwin") {
		await renderIcns(tile, join(root, "build", "icon.icns"));
		console.log("wrote build/icon.icns");
	} else {
		console.log("skipped build/icon.icns (needs macOS iconutil)");
	}
}
