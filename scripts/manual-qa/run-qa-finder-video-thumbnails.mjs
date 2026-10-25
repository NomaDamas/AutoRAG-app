/**
 * Manual QA — mkv / webm (and ogv / avi) videos get a real picture: the row
 * tile and the Inspector's 640px preview paper show a decoded frame of the
 * video, not the OS's generic type icon. macOS Quick Look has no decoder for
 * these containers; the frame comes from ffmpeg (src/main/video-frame.ts).
 *
 * Fixtures are solid-colour clips (red / blue) in each container, plus an mp4
 * control that stays on the Quick Look path, so a tile is judged by its pixels
 * and not by whether some image arrived. Needs `ffmpeg` on PATH and a built app
 * (`bun run build`). Run through `bun run qa` (VM) or `bun scripts/manual-qa/…`.
 *
 * Evidence lands in `QA_OUT` (or .omo/evidence/ai-finder-app/qa-video-thumbnails):
 * a list screenshot, an Inspector screenshot per container, and result.json.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-video-thumbnails");
mkdirSync(EVIDENCE, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "ulw-video-thumb-home-"));
const folderName = "ulw-video-thumb-qa";
const folder = join(home, "Documents", folderName);
mkdirSync(folder, { recursive: true });
const userDataDir = mkdtempSync(join(tmpdir(), "ulw-video-thumb-data-"));

const CODECS = {
	webm: ["-c:v", "libvpx", "-b:v", "300k", "-pix_fmt", "yuv420p"],
	mkv: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
	ogv: ["-c:v", "libtheora", "-q:v", "5", "-pix_fmt", "yuv420p"],
	avi: ["-c:v", "mpeg4", "-pix_fmt", "yuv420p"],
	mp4: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
};
const fixtures = [];
for (const [ext, codec] of Object.entries(CODECS)) {
	for (const color of ["red", "blue"]) {
		// 192x108 (16:9): the tile and the paper must keep that shape. 3 s so the 1 s seek lands inside the clip.
		const name = `${color}-clip.${ext}`;
		try {
			execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=192x108:d=3:r=10`, ...codec, join(folder, name)]);
			fixtures.push({ name, ext, expect: color });
		} catch (error) {
			console.log(`SKIP  ${name}: this ffmpeg cannot encode ${ext} (${String(error.message).split("\n")[0]})`);
		}
	}
}

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass: Boolean(pass), detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
};

const dominant = (avg) => (avg[0] > avg[1] && avg[0] > avg[2] ? "red" : avg[2] > avg[1] ? "blue" : "other");

/** Average colour and shape of one decoded <img>, read from its live pixels. */
const samplePixels = (page, selector, scope) =>
	page.evaluate(
		async ({ selector: css, scope: rowName }) => {
			const root =
				rowName === null
					? document
					: [...document.querySelectorAll('[role="row"]')].find((row) => (row.textContent ?? "").includes(rowName));
			const image = root?.querySelector(css) ?? null;
			if (image === null) return { error: "no image" };
			if (!image.complete) await image.decode().catch(() => undefined);
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth || 1;
			canvas.height = image.naturalHeight || 1;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			let r = 0;
			let g = 0;
			let b = 0;
			for (let i = 0; i < data.length; i += 4) {
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
			}
			const pixels = data.length / 4;
			return {
				src: image.getAttribute("src") ?? "",
				size: [image.naturalWidth, image.naturalHeight],
				avg: [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)],
			};
		},
		{ selector, scope },
	);

/** Resample until the expected colour dominates: thumbnails land asynchronously. */
async function settle(page, selector, scope, expect) {
	const deadline = Date.now() + 45_000;
	let sample = await samplePixels(page, selector, scope);
	while ((sample.error !== undefined || dominant(sample.avg) !== expect) && Date.now() < deadline) {
		await page.waitForTimeout(300);
		sample = await samplePixels(page, selector, scope);
	}
	return sample;
}

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home } });
	const page = await finderWindow(app, 30000);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const fixtureRow = page.locator('[role="row"]').filter({ hasText: folderName }).first();
	await fixtureRow.waitFor({ timeout: 30000 });
	await fixtureRow.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, folderName);
	const rowNamed = (name) => page.locator('[role="row"]').filter({ hasText: name }).first();
	await rowNamed(fixtures[0].name).waitFor({ timeout: 30000 });
	await page.mouse.move(2, 2);

	// ------------------------------------------------------------- row tiles
	for (const fixture of fixtures) {
		const sample = await settle(page, "img.tile--image", fixture.name, fixture.expect);
		if (sample.error !== undefined) {
			check(`${fixture.name}: row tile is a picture`, false, sample.error);
			continue;
		}
		check(`${fixture.name}: tile is served by the thumbnail protocol`, sample.src.startsWith("autorag-thumb://"), sample.src.slice(0, 40));
		check(`${fixture.name}: tile shows the ${fixture.expect} frame, not a type icon`, dominant(sample.avg) === fixture.expect, JSON.stringify(sample.avg));
		if (fixture.ext !== "mp4") {
			// Decoded by ffmpeg, so the 16:9 shape survives (a type icon is square).
			const [w, h] = sample.size;
			check(`${fixture.name}: tile keeps the 16:9 shape`, Math.abs(w / h - 16 / 9) < 0.05, `${w}x${h}`);
		}
	}
	await page.screenshot({ path: join(EVIDENCE, "01-list.png") });

	// ------------------------------------------------------ Inspector paper
	for (const fixture of fixtures.filter((candidate) => candidate.ext !== "mp4")) {
		await rowNamed(fixture.name).click();
		await page.waitForFunction(
			(name) => {
				const img = document.querySelector(".preview-paper img");
				return img !== null && img.getAttribute("src")?.includes("size=640") && img.complete && img.naturalWidth > 0 && (document.body.textContent ?? "").includes(name);
			},
			fixture.name,
			{ timeout: 20000 },
		).catch(() => undefined);
		const sample = await settle(page, ".preview-paper img", null, fixture.expect);
		if (sample.error !== undefined) {
			check(`${fixture.name}: Inspector shows a preview paper`, false, sample.error);
			continue;
		}
		check(`${fixture.name}: Inspector preview is the 640px tier`, sample.src.includes("size=640"), sample.src.slice(0, 80));
		check(`${fixture.name}: Inspector shows the ${fixture.expect} frame`, dominant(sample.avg) === fixture.expect, JSON.stringify(sample.avg));
		// The clip is 192x108 and the extractor never enlarges it.
		check(`${fixture.name}: Inspector frame keeps the clip's own 192x108 size`, sample.size[0] === 192 && sample.size[1] === 108, sample.size.join("x"));
		await page.screenshot({ path: join(EVIDENCE, `02-inspector-${fixture.ext}-${fixture.expect}.png`) });
	}
	await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify(results, null, 2));
} finally {
	await app?.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
