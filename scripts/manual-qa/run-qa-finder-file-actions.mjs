/**
 * Manual QA: the Inspector action bar follows the file's own type.
 *
 * Proves, against the real app (production build, isolated HOME and userData):
 *  1. a text file offers 열기 / 다른 앱으로 열기 / 압축 / 공유 / AI 요약 — and no
 *     Quick Look, copy-path, or trash button (those live elsewhere)
 *  2. 압축 really writes a zip next to the source
 *  3. a zip offers 압축 해제, which restores the folder
 *  4. a PNG offers 이미지 편집 -> JPEG로 변환, which writes a JPEG (real sips)
 *  5. a MOV offers 동영상 변환 -> MP4로 변환, which writes an MP4 (real ffmpeg)
 *  6. 공유 opens the sheet without erroring (macOS only; button hidden elsewhere)
 *
 * Fixture: a fixed QA root passed through AUTORAG_QA_ROOT, plus tiny real files
 * (a base64 PNG, a folder, a zip built with the app's own fflate, and — when
 * ffmpeg exists — a one-second test clip).
 * Evidence: .omo/evidence/ai-finder-app/file-actions/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-file-actions.mjs
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isMac, rmRetry } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "file-actions");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const HOME = join(tmpdir(), "ulw-actions-home");
const QA_ROOT = join(HOME, "ActionsQA");
const USER_DATA = join(tmpdir(), "ulw-actions-data");
rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real (tiny) PNG, so sips has something to decode. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function hasFfmpeg() {
	try {
		execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function fixture() {
	mkdirSync(join(QA_ROOT, "docs"), { recursive: true });
	writeFileSync(join(QA_ROOT, "notes.txt"), "hello action\n");
	writeFileSync(join(QA_ROOT, "photo.png"), PNG_1X1);
	writeFileSync(join(QA_ROOT, "docs", "readme.md"), "# docs\n");
	writeFileSync(
		join(QA_ROOT, "bundle.zip"),
		zipSync({
			"bundle/": new Uint8Array(0),
			"bundle/inside.txt": new Uint8Array(Buffer.from("inside")),
		}),
	);
	if (hasFfmpeg()) {
		execFileSync(
			"ffmpeg",
			["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", "-pix_fmt", "yuv420p", join(QA_ROOT, "clip.mov")],
			{ stdio: "ignore" },
		);
	}
}

function check(label, value, expected) {
	const ok = value === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

async function waitFor(predicate, { timeoutMs = 20000, label, stepMs = 100 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(stepMs);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** The action-button labels the Inspector currently shows, in order. */
const actionLabels = (page) => page.locator(".inspector-actions .inspector-action span").allInnerTexts();

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Focus one QA file: the QA root has no sidebar entry, so search reaches it —
 * every location is searched and each hit is an absolute path the Inspector
 * actions operate on.
 */
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

fixture();
const ffmpeg = hasFfmpeg();
/** The share sheet is macOS-only; the Windows button is hidden by capability. */
const canShare = isMac;
/** PNG conversion/resize needs sips (macOS) or the ffmpeg image backend (Windows). */
const expectsImage = isMac || ffmpeg;
console.log(`INFO ffmpeg ${ffmpeg ? "present" : "missing"}`);

const app = await launchFinder({
	userDataDir: USER_DATA,
	env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT },
});
try {
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.waitForSelector(".sidebar-search input", { timeout: 30_000 });

	// 1. Text file: the base set. 공유 only appears where the OS has a share sheet.
	await selectFile(page, "notes.txt");
	const textActions = await actionLabels(page);
	const expectedTextActions = canShare
		? ["Open", "Open With", "Compress", "Share", "AI Summary"]
		: ["Open", "Open With", "Compress", "AI Summary"];
	check("text actions", JSON.stringify(textActions), JSON.stringify(expectedTextActions));
	check("no Quick Look button", textActions.includes("Quick Look"), false);
	await page.screenshot({ path: join(EVIDENCE, "1-text-actions.png") });

	// 2. 압축 writes a real zip.
	await page.getByRole("button", { name: "Compress", exact: true }).click();
	const zipPath = join(QA_ROOT, "notes.txt.zip");
	await waitFor(() => existsSync(zipPath), { label: "notes.txt.zip to appear" });
	check("compress wrote a zip", existsSync(zipPath), true);
	await page.waitForSelector(".toast", { timeout: 5000 }).catch(() => {});
	await page.screenshot({ path: join(EVIDENCE, "2-compressed.png") });

	// 3. A zip extracts in place.
	await selectFile(page, "bundle.zip");
	check("zip offers extraction", (await actionLabels(page)).includes("Extract"), true);
	await page.getByRole("button", { name: "Extract", exact: true }).click();
	await waitFor(() => existsSync(join(QA_ROOT, "bundle", "inside.txt")), { label: "the extracted folder" });
	check("extract restored the folder", existsSync(join(QA_ROOT, "bundle", "inside.txt")), true);

	// 4. PNG -> image menu -> JPEG (sips on macOS, ffmpeg on Windows).
	if (expectsImage) {
		await selectFile(page, "photo.png");
		check("png offers the image menu", (await actionLabels(page)).includes("Edit Image"), true);
		await page.getByRole("button", { name: "Edit Image", exact: true }).click();
		const imageItems = await page.locator('[role="menu"][aria-label="세부 작업"] [role="menuitem"] span').allInnerTexts();
		check("image menu has a JPEG target", imageItems.includes("JPEG로 변환"), true);
		check("image menu resizes", imageItems.some((label) => label.startsWith("최대 ")), true);
		// The menu rises in over `--dur-menu`; shoot it settled, not mid-animation.
		await sleep(400);
		await page.screenshot({ path: join(EVIDENCE, "3-image-menu.png") });
		await page.getByRole("menuitem", { name: "JPEG로 변환", exact: true }).click();
		await waitFor(() => existsSync(join(QA_ROOT, "photo.jpg")), { label: "photo.jpg" });
		check("convert wrote a JPEG", existsSync(join(QA_ROOT, "photo.jpg")), true);
	} else {
		check("png hides the image menu without an image engine", (await actionLabels(page)).includes("Edit Image"), false);
		console.log("SKIP image convert checks: no sips or ffmpeg image engine");
	}

	// 5. MOV -> MP4 through ffmpeg.
	if (ffmpeg) {
		await selectFile(page, "clip.mov");
		check("mov offers container conversion", (await actionLabels(page)).includes("Convert Video"), true);
		await page.getByRole("button", { name: "Convert Video", exact: true }).click();
		const videoItems = await page.locator('[role="menu"][aria-label="세부 작업"] [role="menuitem"] span').allInnerTexts();
		check("video menu drops the current container", videoItems.includes("MP4로 변환") && !videoItems.includes("MOV로 변환"), true);
		await page.getByRole("menuitem", { name: "MP4로 변환", exact: true }).click();
		await waitFor(() => existsSync(join(QA_ROOT, "clip.mp4")), { label: "clip.mp4", timeoutMs: 60_000 });
		check("remux wrote an MP4", existsSync(join(QA_ROOT, "clip.mp4")), true);
		await page.screenshot({ path: join(EVIDENCE, "4-video-actions.png") });
	} else {
		console.log("SKIP video checks: ffmpeg is not installed");
	}

	// 6. 공유 opens the sheet on macOS; elsewhere the capability hides the button.
	await selectFile(page, "notes.txt");
	if (canShare) {
		await page.locator(".inspector-actions").getByRole("button", { name: "Share", exact: true }).click();
		await sleep(800);
		const toast = await page.locator(".toast").allInnerTexts();
		check("share did not error", toast.some((text) => text.includes("지원하지 않") || text.includes("Error")), false);
		await page.screenshot({ path: join(EVIDENCE, "5-share.png") });
	} else {
		check("share button is absent without a share sheet", (await actionLabels(page)).includes("Share"), false);
	}

	// 7. 다른 앱으로 열기 opens an in-app menu of the applications the OS
	// registers for the file's type, with 기타… last. Only 기타… reaches the
	// native chooser — a native modal, so the assertion is that the renderer
	// survives it; the sheet goes away with the process when the run ends.
	await selectFile(page, "photo.png");
	await page.getByRole("button", { name: "Open With", exact: true }).click();
	const menu = page.getByRole("menu", { name: "세부 작업" });
	await menu.waitFor({ state: "visible", timeout: 10_000 });
	const labels = await menu.getByRole("menuitem").allInnerTexts();
	console.log(`open-with menu: ${labels.join(" | ")}`);
	check("open-with menu ends with 기타…", labels.at(-1)?.trim(), "기타…");
	if (process.platform === "darwin") {
		check("open-with menu suggests the OS's applications before 기타…", labels.length > 1, true);
	}
	check("open-with 기타… is visible without scrolling", await menu.getByRole("menuitem", { name: "기타…" }).isVisible() && (await menu.getByRole("menuitem", { name: "기타…" }).evaluate((node) => { const box = node.getBoundingClientRect(); return box.bottom <= window.innerHeight && box.top >= 0; })), true);
	await sleep(600);
	await page.screenshot({ path: join(EVIDENCE, "6-open-with-menu.png") });
	await menu.getByRole("menuitem", { name: "기타…" }).click();
	await sleep(1500);
	const responsive = await page.evaluate(() => document.querySelectorAll(".inspector-actions").length === 1);
	check("open-with chooser leaves the window responsive", responsive, true);
	await page.screenshot({ path: join(EVIDENCE, "6-open-with.png") });

	await page.screenshot({ path: join(EVIDENCE, "7-final.png") });
} finally {
	// The macOS ShareMenu's native tracking session (and the open-with sheet)
	// outlives the checks and blocks even `app.exit(0)` — only killing the
	// Electron process ends it. All assertions and screenshots are done here.
	try {
		process.kill(app.process().pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await app.close().catch(() => undefined);
}

// Cleanup: only this run's own artifacts.
rmRetry(HOME);
rmRetry(USER_DATA);
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
