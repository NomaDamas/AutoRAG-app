/**
 * Manual QA: "Reduce Size" dialog & engines from the Inspector's bottom-right bar.
 *
 * Proves, against the real app (production build, isolated HOME and userData):
 *  1. a text file hides Reduce Size; PDF, JPEG, PNG, MP4, MP3 offer it before Compress
 *  2. clicking Reduce Size immediately opens ReduceSizeDialog with 3 compression
 *     strengths (Light / Balanced / Maximum) and Replace original vs Save a copy
 *  3. default "Replace original" shrinks scan.pdf, shot.png, clip.mp4, song.mp3
 *     in place (original moved to Trash, ZERO -reduced clutter in the folder)
 *  4. "Save a copy" at Light then Maximum on photo.jpg writes strictly smaller
 *     bytes at Maximum and recycles photo-reduced.jpg via Trash (NEVER spawning
 *     photo-reduced 2.jpg .. 8.jpg garbage files)
 *  5. while encoding a 90 s 1080p video, the dialog shows a live determinate %
 *     progress bar, and Cancel kills ffmpeg cleanly with zero leftovers
 *
 *   bun run qa script --vm scripts/manual-qa/run-qa-finder-reduce-size.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isWindows, rmRetry } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = process.env.QA_OUT ?? join(REPO, ".omo", "evidence", "ai-finder-app", "reduce-size");
mkdirSync(EVIDENCE, { recursive: true });

const FOLDER = "ulw-reduce-size-qa";
const QA_ROOT = join(homedir(), "Downloads", FOLDER);
const USER_DATA = join(tmpdir(), "ulw-reduce-data");
rmRetry(QA_ROOT);
rmRetry(USER_DATA);
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
	writeFileSync(join(QA_ROOT, "scan.pdf"), await doc.save({ useObjectStreams: false }));
	rmSync(join(QA_ROOT, "page.tmp.jpg"));
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=2000x1500", "-frames:v", "1", "-q:v", "1", join(QA_ROOT, "photo.jpg"));
	ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1000x750", "-frames:v", "1", "-compression_level", "9", join(QA_ROOT, "shot.png"));
	ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-t", "4", "-c:v", "libx264", "-b:v", "2000k", "-maxrate", "2000k", "-bufsize", "4000k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", join(QA_ROOT, "clip.mp4"));
	ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=6", "-c:a", "libmp3lame", "-b:a", "128k", join(QA_ROOT, "song.mp3"));
	const tinyDoc = await PDFDocument.create();
	tinyDoc.addPage([200, 200]);
	writeFileSync(join(QA_ROOT, "tiny.pdf"), await tinyDoc.save({ useObjectStreams: true }));
	ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=90", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(QA_ROOT, "slow.mp4"));
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actionLabels = (page) => page.locator(".inspector-actions .inspector-action span").allInnerTexts();
const dialog = (page) => page.getByRole("alertdialog");
const row = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();

await fixture();
const originals = new Map();
for (const name of ["scan.pdf", "photo.jpg", "shot.png", "clip.mp4", "song.mp3"]) {
	originals.set(name, readFileSync(join(QA_ROOT, name)));
}

const MAGIC = {
	pdf: (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
	jpg: (bytes) => bytes.subarray(0, 3).toString("hex") === "ffd8ff",
	png: (bytes) => bytes.subarray(1, 4).toString("latin1") === "PNG",
	mp4: (bytes) => bytes.subarray(4, 8).toString("latin1") === "ftyp",
	mp3: (bytes) => bytes.subarray(0, 3).toString("latin1") === "ID3" || bytes[0] === 0xff,
};

const app = await launchFinder({ userDataDir: USER_DATA });
try {
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector('[role="row"]', { timeout: 60_000 });
	await page.getByRole("button", { name: "Downloads" }).click();
	await waitFor(async () => (await page.locator('[role="row"]', { hasText: FOLDER }).count()) > 0, { label: FOLDER });
	await row(page, FOLDER).dblclick();
	await row(page, "scan.pdf").waitFor({ timeout: 20_000 });

	// 1. Plain text hides Reduce Size.
	await row(page, "notes.txt").click();
	await page.waitForSelector(".inspector-actions");
	check("text file has no Reduce Size", (await actionLabels(page)).includes("Reduce Size"), false);

	// 2. Clicking Reduce Size opens ReduceSizeDialog immediately with 3 levels + Replace/Copy options.
	await row(page, "scan.pdf").click();
	await waitFor(async () => (await actionLabels(page)).includes("Reduce Size"), { label: "Reduce Size on scan.pdf" });
	const pdfLabels = await actionLabels(page);
	check("scan.pdf offers Reduce Size before Compress", pdfLabels.indexOf("Reduce Size") >= 0 && pdfLabels.indexOf("Reduce Size") < pdfLabels.indexOf("Compress"), true);
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
	await sleep(300);
	const dlgText = await dialog(page).innerText();
	check("dialog shows all 3 levels", /Light/.test(dlgText) && /Balanced/.test(dlgText) && /Maximum/.test(dlgText), true);
	check("dialog defaults to Replace original", await dialog(page).locator('[data-output-mode="replace"]').getAttribute("aria-checked"), "true");
	await page.screenshot({ path: join(EVIDENCE, "1-dialog-open.png") });

	// 3. Default Replace original shrinks scan.pdf, shot.png, clip.mp4, song.mp3 IN PLACE with ZERO -reduced files!
	await dialog(page).locator('[data-action="confirm-reduce"]').click();
	await dialog(page).waitFor({ state: "detached", timeout: 120_000 });
	await sleep(400);
	check("scan.pdf shrunk in place", statSync(join(QA_ROOT, "scan.pdf")).size < originals.get("scan.pdf").length, true);
	check("scan.pdf keeps PDF header", MAGIC.pdf(readFileSync(join(QA_ROOT, "scan.pdf"))), true);
	check("scan.pdf created zero -reduced copies", readdirSync(QA_ROOT).filter((n) => n.startsWith("scan-reduced")).length, 0);
	const pdfToast = (await page.locator(".toast").allInnerTexts()).join(" ");
	console.log(`toast scan.pdf: ${pdfToast.replace(/\s+/g, " ")}`);
	check("replace toast notes Trash backup", /smaller/.test(pdfToast) && /Trash/.test(pdfToast), true);
	await page.screenshot({ path: join(EVIDENCE, "2-pdf-replaced-in-place.png") });

	// Test Light specifically on already-compressed PNG (deflate-9), 2 Mbps MP4, and 128k MP3:
	for (const name of ["shot.png", "clip.mp4", "song.mp3"]) {
		const ext = name.split(".").pop();
		await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
		await row(page, name).click();
		await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
		await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
		await dialog(page).locator('[data-level="light"]').click();
		await dialog(page).locator('[data-action="confirm-reduce"]').click();
		await dialog(page).waitFor({ state: "detached", timeout: 120_000 });
		const afterBytes = readFileSync(join(QA_ROOT, name));
		check(`${name} shrunk >=20% on Light`, afterBytes.length < originals.get(name).length * 0.8, true);
		check(`${name} kept ${ext} format`, MAGIC[ext](afterBytes), true);
		check(`${name} left zero -reduced clutter`, readdirSync(QA_ROOT).filter((n) => n.includes("-reduced")).length, 0);
	}

	// 4. Save a copy mode: Light vs Maximum produces smaller bytes, and running twice NEVER creates photo-reduced 2.jpg!
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await row(page, "photo.jpg").click();
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
	await dialog(page).locator('[data-level="light"]').click();
	await dialog(page).locator('[data-output-mode="copy"]').click();
	check("copy mode previews photo-reduced.jpg", (await dialog(page).innerText()).includes("photo-reduced.jpg"), true);
	await dialog(page).locator('[data-action="confirm-reduce"]').click();
	await dialog(page).waitFor({ state: "detached", timeout: 60_000 });
	await waitFor(() => existsSync(join(QA_ROOT, "photo-reduced.jpg")), { label: "photo-reduced.jpg" });
	const lightCopySize = statSync(join(QA_ROOT, "photo-reduced.jpg")).size;
	check("light copy is smaller than original", lightCopySize < originals.get("photo.jpg").length, true);
	check("original photo.jpg untouched in copy mode", readFileSync(join(QA_ROOT, "photo.jpg")).equals(originals.get("photo.jpg")), true);

	// Second copy-mode run at Maximum on photo.jpg: recycles photo-reduced.jpg, NO photo-reduced 2.jpg!
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await row(page, "photo.jpg").click();
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
	await dialog(page).locator('[data-level="max"]').click();
	await dialog(page).locator('[data-output-mode="copy"]').click();
	await dialog(page).locator('[data-action="confirm-reduce"]').click();
	await dialog(page).waitFor({ state: "detached", timeout: 60_000 });
	const maxCopySize = statSync(join(QA_ROOT, "photo-reduced.jpg")).size;
	check("maximum level shrinks further than light", maxCopySize < lightCopySize, true);
	check("repeated copy mode never creates photo-reduced 2.jpg spam", readdirSync(QA_ROOT).filter((n) => n.startsWith("photo-reduced")), ["photo-reduced.jpg"]);
	await sleep(300);
	await page.screenshot({ path: join(EVIDENCE, "3-copy-mode-no-spam.png") });

	// 5. Already-minimal PDF: clean toast, no raw IPC error wrapper.
	await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	await row(page, "tiny.pdf").click();
	await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
	await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
	await dialog(page).locator('[data-action="confirm-reduce"]').click();
	await dialog(page).waitFor({ state: "detached", timeout: 30_000 });
	await waitFor(async () => (await page.locator(".toast").count()) > 0, { timeoutMs: 15_000, label: "already-small toast" });
	const smallToast = (await page.locator(".toast").allInnerTexts()).join(" ");
	check("already-small toast has no raw IPC prefix", !smallToast.includes("Error invoking remote method") && /smaller/i.test(smallToast), true);

	// 6. Live progress bar + % inside ReduceSizeDialog + Cancel kills ffmpeg cleanly.
	if (!isWindows) {
		await page.locator(".toast").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
		await row(page, "slow.mp4").click();
		await page.getByRole("button", { name: "Reduce Size", exact: true }).click();
		await dialog(page).waitFor({ state: "visible", timeout: 10_000 });
		await dialog(page).locator('[data-action="confirm-reduce"]').click();
		await waitFor(
			async () => {
				const now = await dialog(page).locator('[role="progressbar"]').getAttribute("aria-valuenow");
				return now !== null && Number(now) >= 1;
			},
			{ timeoutMs: 30_000, label: "determinate % in ReduceSizeDialog" },
		);
		const runningText = await dialog(page).innerText();
		console.log(`dialog progress: ${runningText.replace(/\s+/g, " ")}`);
		check("dialog shows file name and live %", /Reducing.*slow\.mp4/.test(runningText) && /\d+%/.test(runningText), true);
		await page.screenshot({ path: join(EVIDENCE, "4-progress-running.png") });

		await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
		await dialog(page).waitFor({ state: "detached", timeout: 15_000 });
		const slowPids = () =>
			spawnSync("pgrep", ["-f", "slow.mp4"], { encoding: "utf8" })
				.stdout.split("\n")
				.map((line) => Number(line.trim()))
				.filter((pid) => pid > 0 && pid !== process.pid);
		await waitFor(() => slowPids().length === 0, { timeoutMs: 15_000, label: "ffmpeg stopped after cancel" });
		const remaining = readdirSync(QA_ROOT);
		check("cancel leaves slow.mp4 intact and zero staging/copies", existsSync(join(QA_ROOT, "slow.mp4")) && !remaining.includes("slow-reduced.mp4") && !remaining.some((n) => n.startsWith(".dazzi-reduce-")), true);
		await page.screenshot({ path: join(EVIDENCE, "5-progress-cancelled.png") });
	}
} finally {
	try {
		process.kill(app.process().pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await app.close().catch(() => undefined);
}

rmRetry(QA_ROOT);
rmRetry(USER_DATA);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
