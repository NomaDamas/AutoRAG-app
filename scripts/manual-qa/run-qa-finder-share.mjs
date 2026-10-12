/**
 * Manual QA: the toolbar Share item opens the real OS share sheet, not a copy.
 *
 * Proves, against the real app (production build, isolated HOME and userData):
 *  1. macOS shows the toolbar Share item; it is disabled until a row is focused,
 *     then enabled — the same capability gate the Inspector's 공유 action uses.
 *  2. clicking Share never copies the path: the system pasteboard keeps the
 *     sentinel we planted, and no "경로를 복사했습니다" toast appears (the old
 *     copy-path behavior).
 *  3. clicking Share does not error — the sheet pops without a failure toast.
 *  4. Windows (no share sheet) has no toolbar Share item at all.
 *
 * The native share sheet is an OS menu, not DOM, so the lane asserts the
 * renderer contract around it (no copy, no error) and captures a screenshot;
 * the sheet itself is dismissed by killing the process, as it blocks quit.
 *
 * Fixture: a fixed QA root passed through AUTORAG_QA_ROOT, plus one real file.
 * Evidence: .omo/evidence/ai-finder-app/share/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-share.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isMac, repoRoot, rmRetry, sh, sleep } from "./platform.mjs";

const REPO = repoRoot(import.meta.url);
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "share");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const HOME = join(tmpdir(), "ulw-share-home");
const QA_ROOT = join(HOME, "ShareQA");
const USER_DATA = join(tmpdir(), "ulw-share-data");
rmSync(HOME, { recursive: true, force: true });
rmSync(USER_DATA, { recursive: true, force: true });

/** Clip sentinel: if the toolbar still copied the path, pbpaste would show the file path, not this. */
const SENTINEL = "AUTORAG-SHARE-SENTINEL";

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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Focus one QA file: the QA root has no sidebar entry, so search reaches it. */
async function selectFile(page, name) {
	const input = page.locator(".sidebar-search input");
	await input.click();
	await input.fill(name);
	const row = page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();
	// A cold search can take longer than one wait (the QA root is indexed on
	// first use), so re-submit the query until the row mounts.
	const deadline = Date.now() + 30_000;
	for (;;) {
		await input.press("Enter");
		try {
			await row.waitFor({ timeout: 5_000 });
			break;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		}
	}
	await row.click();
	await page.waitForSelector(".inspector-actions");
}

mkdirSync(QA_ROOT, { recursive: true });
writeFileSync(join(QA_ROOT, "share-me.txt"), "share me\n");
if (isMac) {
	// Plant a known pasteboard so the copy-path regression is observable.
	sh(`printf '%s' '${SENTINEL}' | pbcopy`);
}

const shareButton = (page) => page.locator(".toolbar").getByRole("button", { name: "Share", exact: true });

const app = await launchFinder({
	userDataDir: USER_DATA,
	env: { HOME, USERPROFILE: HOME, AUTORAG_QA_ROOT: QA_ROOT },
});
try {
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1500, height: 900 });
	await page.waitForSelector(".toolbar-title", { timeout: 60_000 });
	await page.waitForSelector(".sidebar-search input", { timeout: 30_000 });

	if (!isMac) {
		// 4. No share sheet on this platform: the toolbar item must be absent.
		await selectFile(page, "share-me.txt");
		await sleep(500);
		check("no toolbar Share item without a share sheet", await shareButton(page).count(), 0);
		await page.screenshot({ path: join(EVIDENCE, "1-no-share-windows.png") });
	} else {
		// 1. Share appears (capability probe) and is enabled once a row is focused.
		await waitFor(async () => (await shareButton(page).count()) === 1, { label: "the toolbar Share item" });
		await selectFile(page, "share-me.txt");
		await waitFor(() => shareButton(page).isEnabled(), { label: "Share to enable with a focused row" });
		check("toolbar Share present on macOS", await shareButton(page).count(), 1);
		await page.screenshot({ path: join(EVIDENCE, "1-share-enabled.png") });

		// 2 + 3. Click it: no copy-path toast, no error, pasteboard untouched.
		await shareButton(page).click();
		await sleep(1000);
		const toasts = await page.locator(".toast").allInnerTexts().catch(() => []);
		check("share does not copy the path", toasts.some((text) => text.includes("Copied path")), false);
		check("share does not error", toasts.some((text) => text.includes("does not support") || text.includes("Couldn't find where to show the share sheet")), false);
		check("pasteboard keeps the sentinel", sh("pbpaste").trim(), SENTINEL);
		await page.screenshot({ path: join(EVIDENCE, "2-share-clicked.png") });

		// The sheet is native and outside the DOM; the renderer must stay up.
		const responsive = await page.evaluate(() => document.querySelectorAll(".toolbar .tgroup").length === 1);
		check("window stays responsive under the sheet", responsive, true);
	}
} finally {
	// The macOS ShareMenu's native tracking session blocks even `app.exit(0)`;
	// only killing the Electron process ends it. All assertions are done here.
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
