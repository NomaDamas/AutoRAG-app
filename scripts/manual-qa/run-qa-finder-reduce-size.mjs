/**
 * Manual QA: "Reduce Size" in the Inspector's bottom-right action bar.
 *
 * Proves, against the real app (production build, isolated HOME and userData):
 *  1. a PDF, JPEG, PNG, MP4 and MP3 each show the Reduce Size button; a text file does not
 *  2. clicking it writes `<name>-reduced.<same extension>` next to the original, smaller,
 *     with the format's real magic bytes, and leaves the original untouched
 *  3. the toast reports before -> after sizes and the saving
 *  4. a second click numbers the result instead of overwriting it
 *
 * Fixtures are real files made with the tools the app drives (pdf-lib, ffmpeg).
 * Evidence: $QA_OUT, else .omo/evidence/ai-finder-app/reduce-size/.
 *   bun run qa script scripts/manual-qa/run-qa-finder-reduce-size.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = process.env.QA_OUT ?? join(REPO, ".omo", "evidence", "ai-finder-app", "reduce-size");
mkdirSync(EVIDENCE, { recursive: true });

const HOME = join(tmpdir(), "ulw-reduce-home");
const QA_ROOT = join(HOME, "ReduceQA");
const USER_DATA = join(tmpdir(), "ulw-reduce-data");
rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(QA_ROOT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });

function check(label, value, expected) {
	const ok = JSON.stringify(value) === JSON.stringify(expected);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

async function waitFor(predicate, { timeoutMs = 120_000, label } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(150);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function fixture() {
	writeFileSync(join(QA_ROOT, "notes.txt"), "plain text cannot shrink without changing format\n");
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=2400x3200", "-frames:v", "1", "-q:v", "1", join(QA_ROOT, "page.tmp.jpg"));
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const image = await doc.embedJpg(readFileSync(join(QA_ROOT, "page.tmp.jpg")));
	for (let page = 0; page < 3; page += 1) {
		const added = doc.addPage([595, 842]);
		added.drawText(`zebra-keyword page ${page}`, { x: 40, y: 800, size: 12, font });
		added.drawImage(image, { x: 40, y: 100, width: 400, height: 300 });
	}
	writeFileSync(join(QA_ROOT, "scan.pdf"), await doc.save());
	rmSync(join(QA_ROOT, "page.tmp.jpg"));
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1600x1200", "-frames:v", "1", "-q:v", "1", join(QA_ROOT, "photo.jpg"));
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=800x600", "-frames:v", "1", "-compression_level", "0", join(QA_ROOT, "shot.png"));
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=640x480:r=24", "-f", "lavfi", "-i", "sine=f=440:d=3", "-t", "3", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", join(QA_ROOT, "clip.mp4"));
	ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=5", "-c:a", "libmp3lame", "-b:a", "320k", join(QA_ROOT, "song.mp3"));
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actionLabels = (page) => page.locator(".inspector-actions .inspector-action span").allInnerTexts();

async function selectFile(page, name) {
	const input = page.locator(".sidebar-search input");
	await input.click();
	await input.fill(name);
	await input.press("Enter");
	const row = page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();
	await row.waitFor({ timeout: 15_000 });
	await row.click();
	await page.waitForSelector(".inspector-actions");
}

await fixture();
const originals = new Map();
for (const name of ["scan.pdf", "photo.jpg", "shot.png", "clip.mp4", "song.mp3"]) originals.set(name, readFileSync(join(QA_ROOT, name)));

const MAGIC = {
	pdf: (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
	jpg: (bytes) => bytes.subarray(0, 3).toString("hex") === "ffd8ff",
	png: (bytes) => bytes.subarray(1, 4).toString("latin1") === "PNG",
	mp4: (bytes) => bytes.subarray(4, 8).toString("latin1") === "ftyp",
	mp3: (bytes) => bytes.subarray(0, 3).toString("latin1") === "ID3" || bytes[0] === 0xff,
};

const app = await launchFinder({
	userDataDir: USER_DATA,
	env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT },
});
try {
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.waitForSelector(".sidebar-search input", { timeout: 30_000 });

	await selectFile(page, "notes.txt");
	check("text file has no Reduce Size", (await actionLabels(page)).includes("Reduce Size"), false);

	for (const name of ["scan.pdf", "photo.jpg", "shot.png", "clip.mp4", "song.mp3"]) {
		const extension = name.split(".").pop();
		const stem = name.slice(0, -(extension.length + 1));
		await selectFile(page, name);
		await waitFor(async () => (await actionLabels(page)).includes("Reduce Size"), { timeoutMs: 60_000, label: `Reduce Size on ${name}` });
		const labels = await actionLabels(page);
		check(`${name} offers Reduce Size before Compress`, labels.indexOf("Reduce Size") >= 0 && labels.indexOf("Reduce Size") < labels.indexOf("Compress"), true);
		if (name === "scan.pdf") await page.screenshot({ path: join(EVIDENCE, "1-pdf-actions.png") });

		await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
		const output = join(QA_ROOT, `${stem}-reduced.${extension}`);
		await waitFor(() => existsSync(output), { label: `${output}` });
		await sleep(400);
		const bytes = readFileSync(output);
		check(`${name} -> ${stem}-reduced.${extension} is smaller`, bytes.length < originals.get(name).length, true);
		check(`${name} result keeps the ${extension} format`, MAGIC[extension](bytes), true);
		check(`${name} original untouched`, readFileSync(join(QA_ROOT, name)).equals(originals.get(name)), true);
		const toast = (await page.locator(".toast").allInnerTexts()).join(" ");
		console.log(`toast for ${name}: ${toast.replace(/\s+/g, " ")}`);
		check(`${name} toast reports the saving`, /smaller/.test(toast) && toast.includes("→"), true);
		await page.screenshot({ path: join(EVIDENCE, `2-${stem}-reduced.png`) });
	}

	// A second run numbers the result.
	await selectFile(page, "photo.jpg");
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "photo-reduced 2.jpg")), { label: "photo-reduced 2.jpg" });
	check("second run numbers the result", existsSync(join(QA_ROOT, "photo-reduced 2.jpg")), true);
	check("first result untouched by the second run", statSync(join(QA_ROOT, "photo-reduced.jpg")).size > 0, true);
	await page.screenshot({ path: join(EVIDENCE, "3-final.png") });
} finally {
	try {
		process.kill(app.process().pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await app.close().catch(() => undefined);
}

rmRetry(HOME);
rmRetry(USER_DATA);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
