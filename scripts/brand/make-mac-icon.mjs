/**
 * Build `build/icon.icon`, the Icon Composer bundle electron-builder compiles into the macOS app icon.
 *
 *   node scripts/brand/make-mac-icon.mjs
 *
 * macOS 26 draws a legacy `icon.icns` shrunk inside a grey rounded plate. An `.icon` bundle is drawn
 * full size, so the glass-tile logo has to fill the layer to the edges: the system's own rounded mask
 * then replaces the tile's outline instead of sitting inside a second one. The layer is cut from the
 * transparent master `build/icon.png`, trimmed to the tile and inset a few pixels so the system mask
 * never reveals the tile's transparent corners.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundle = join(root, "build", "icon.icon");
const SIZE = 1024;
// Pixels trimmed from each side of the tile's bounding box (its rounded corners are the transparent part).
const INSET = 14;

const master = sharp(join(root, "build", "icon.png"));
const { data, info } = await master.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let [left, top, right, bottom] = [info.width, info.height, 0, 0];
for (let y = 0; y < info.height; y++) {
	for (let x = 0; x < info.width; x++) {
		if (data[(y * info.width + x) * 4 + 3] <= 128) continue;
		left = Math.min(left, x);
		top = Math.min(top, y);
		right = Math.max(right, x);
		bottom = Math.max(bottom, y);
	}
}

const side = Math.min(right - left, bottom - top) + 1 - 2 * INSET;
const cx = Math.round((left + right) / 2);
const cy = Math.round((top + bottom) / 2);
const layer = await master
	.extract({ left: cx - Math.floor(side / 2), top: cy - Math.floor(side / 2), width: side, height: side })
	.resize(SIZE, SIZE)
	.png()
	.toBuffer();

mkdirSync(join(bundle, "Assets"), { recursive: true });
writeFileSync(join(bundle, "Assets", "dazzi.png"), layer);
writeFileSync(
	join(bundle, "icon.json"),
	`${JSON.stringify(
		{
			fill: "automatic",
			groups: [{ layers: [{ glass: false, "image-name": "dazzi.png", name: "dazzi" }], shadow: { kind: "neutral", opacity: 0.5 }, translucency: { enabled: false, value: 0 } }],
			"supported-platforms": { circles: ["watchOS"], squares: "shared" },
		},
		null,
		2,
	)}\n`,
);
