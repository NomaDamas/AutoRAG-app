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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isWindows, rmRetry } from "./platform.mjs";

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
	const tinyDoc = await PDFDocument.create();
	tinyDoc.addPage([200, 200]);
	writeFileSync(join(QA_ROOT, "tiny.pdf"), await tinyDoc.save({ useObjectStreams: true }));
	ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=90", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(QA_ROOT, "slow.mp4"));
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

	// Already-minimal PDF: clean localized message, no raw IPC wrapper.
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await selectFile(page, "tiny.pdf");
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await waitFor(async () => (await page.locator(".toast").count()) > 0, { timeoutMs: 30_000, label: "already-small toast" });
	const smallToast = (await page.locator(".toast").allInnerTexts()).join(" ");
	check("already-small toast has no raw IPC prefix", !smallToast.includes("Error invoking remote method"), true);
	check("already-small toast explains why", /smaller/i.test(smallToast), true);

	// Real folder view: live determinate progress bar + percentage + Cancel stops ffmpeg cleanly.
	if (!isWindows) {
		await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
		await page.getByRole("button", { name: "QA", exact: true }).click();
		const slowRow = page.locator('[role="row"]', { hasText: "slow.mp4" }).first();
		await slowRow.waitFor({ timeout: 15_000 });
		await slowRow.click();
		await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
		const progressCard = page.locator(".inspector-reduce-progress");
		await progressCard.waitFor({ state: "visible", timeout: 15_000 });
		await waitFor(
			async () => {
				const now = await progressCard.locator('[role="progressbar"]').getAttribute("aria-valuenow");
				return now !== null && Number(now) >= 1;
			},
			{ timeoutMs: 30_000, label: "determinate ffmpeg progress percent" },
		);
		const cardText = await progressCard.innerText();
		console.log(`progress card: ${cardText.replace(/\s+/g, " ")}`);
		check("progress card names the file and shows %", /Reducing.*slow\.mp4/.test(cardText) && /\d+%/.test(cardText), true);
		check("Reduce Size button disabled while running", await page.locator('button[data-action="reduceSize"]').isDisabled(), true);
		await page.screenshot({ path: join(EVIDENCE, "4-progress-running.png") });

		await progressCard.getByRole("button", { name: "Cancel", exact: true }).click();
		await progressCard.waitFor({ state: "detached", timeout: 15_000 });
		const slowPids = () =>
			spawnSync("pgrep", ["-f", "slow.mp4"], { encoding: "utf8" })
				.stdout.split("\n")
				.map((line) => Number(line.trim()))
				.filter((pid) => pid > 0 && pid !== process.pid);
		await waitFor(() => slowPids().length === 0, { timeoutMs: 15_000, label: "ffmpeg stopped after cancel" });
		const folderNames = readdirSync(QA_ROOT);
		check("cancel leaves no slow-reduced.mp4 or staging folder", !folderNames.includes("slow-reduced.mp4") && !folderNames.some((n) => n.startsWith(".dazzi-reduce-")), true);
		await page.screenshot({ path: join(EVIDENCE, "5-progress-cancelled.png") });

		// Completing in a folder selects and flashes the newly reduced file.
		const jpgRow = page
			.locator('[role="row"]')
			.filter({ has: page.locator(".row__label", { hasText: /^photo\.jpg$/ }) })
			.first();
		await jpgRow.click();
		await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
		await waitFor(() => existsSync(join(QA_ROOT, "photo-reduced 3.jpg")), { label: "photo-reduced 3.jpg" });
		await waitFor(
			async () => (await page.locator(".inspector-body .preview-title").innerText()).trim() === "photo-reduced 3.jpg",
			{ timeoutMs: 15_000, label: "Inspector focused new reduced file" },
		);
		check("folder reduction focuses the new -reduced file", (await page.locator(".inspector-body .preview-title").innerText()).trim(), "photo-reduced 3.jpg");
		await page.screenshot({ path: join(EVIDENCE, "6-focused-new-output.png") });
	}
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
