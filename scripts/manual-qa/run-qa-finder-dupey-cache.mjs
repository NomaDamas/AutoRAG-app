/**
 * Manual QA: dupey version-family persistence (SSOT) and the scan schedule.
 *
 * Proves, against the real app:
 *  1. the startup scan writes a snapshot to <userData>/dupey-cache/version-families.json
 *  2. the Finder renders stacks from that snapshot
 *  3. a restart serves stacks from the persisted snapshot and re-scans at startup
 *  4. the Settings scan interval persists into settings-state.json
 *
 * Evidence: .omo/evidence/ai-finder-app/dupey-cache/ (screenshots + logs).
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-dupey-cache.mjs
 */

import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { isWindows, rmRetry, scrollFinderList } from "./platform.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "dupey-cache");
mkdirSync(EVIDENCE, { recursive: true });

const USER_DATA = join(tmpdir(), "pw-electron-qa-dupey-cache");
rmRetry(USER_DATA);

/** Windows dupey reconciliation is slower (issue #59); give the badge more time there. */
const STACK_BADGE_TIMEOUT = isWindows ? 120_000 : 30_000;

/**
 * Deterministic stack fixtures in the real Downloads (the live-sync/trash-prune
 * convention): three exact copies dupey clusters into one family, so the badge
 * waits never depend on the operator's own files (a clean CI home has none).
 */
const DOWNLOADS = join(homedir(), "Downloads");
const FIXTURE_FILES = ["ulw-dupey-report.txt", "ulw-dupey-report-copy.txt", "ulw-dupey-report (1).txt"];
const DUPLICATE_BODY = `${"Dupey cache QA fixture. ".repeat(80)}\n`;
for (const name of FIXTURE_FILES) rmSync(join(DOWNLOADS, name), { force: true });
for (const name of FIXTURE_FILES) writeFileSync(join(DOWNLOADS, name), DUPLICATE_BODY, "utf8");

const SNAPSHOT = join(USER_DATA, "dupey-cache", "version-families.json");
const SETTINGS = join(USER_DATA, "settings", "settings-state.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

async function waitFor(predicate, { timeoutMs, label }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(1000);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function launch() {
	const app = await launchFinder({ userDataDir: USER_DATA });
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForSelector('[role="row"]');
	return { app, page };
}

const report = {};

// ---- run 1: cold start scans, persists, and renders from the snapshot ----
{
	const { app, page } = await launch();
	const snapshot = await waitFor(async () => readJson(SNAPSHOT), {
		timeoutMs: 300_000,
		label: "startup scan to persist version-families.json",
	});
	report.coldStart = {
		version: snapshot.version,
		scannedAt: snapshot.scannedAt,
		locations: snapshot.locations?.length ?? 0,
		families: snapshot.families?.length ?? 0,
	};
	console.log("COLD-START snapshot:", JSON.stringify(report.coldStart));

	await page.getByRole("button", { name: "Downloads" }).click();
	// v7: the stack count is the `.vcount` chip (`.row__stackbadge` was the v6
	// class). Downloads can be long and the list virtualizes its rows, so sweep
	// the listing until the scan's stack chip is mounted.
	await waitFor(async () => (await page.locator(".vcount").count()) > 0 || (await scrollFinderList(page), false), {
		timeoutMs: STACK_BADGE_TIMEOUT,
		label: "a version stack chip in Downloads",
	});
	report.coldStartBadges = await page.locator(".vcount").count();
	report.coldStartBanner = await page.locator(".list__error").count();
	console.log("COLD-START badges:", report.coldStartBadges, "banner:", report.coldStartBanner);
	await page.screenshot({ path: join(EVIDENCE, "1-cold-start.png") });
	await app.close();
}

// ---- run 2: restart serves the persisted snapshot, then re-scans ----
{
	const { app, page } = await launch();
	const started = Date.now();
	await page.getByRole("button", { name: "Downloads" }).click();
	await waitFor(async () => (await page.locator(".vcount").count()) > 0 || (await scrollFinderList(page), false), {
		timeoutMs: STACK_BADGE_TIMEOUT,
		label: "a version stack chip served from the persisted snapshot",
	});
	report.warmBadges = await page.locator(".vcount").count();
	report.warmBadgeMs = Date.now() - started;
	console.log("WARM badges:", report.warmBadges, "after", report.warmBadgeMs, "ms");
	await page.screenshot({ path: join(EVIDENCE, "2-warm-start.png") });

	const rescanned = await waitFor(
		async () => {
			const snapshot = readJson(SNAPSHOT);
			return snapshot !== null && snapshot.scannedAt !== report.coldStart.scannedAt ? snapshot : null;
		},
		{ timeoutMs: 300_000, label: "the startup re-scan to advance scannedAt" },
	);
	report.rescannedAt = rescanned.scannedAt;
	console.log("WARM re-scanned:", report.rescannedAt);

	// Settings: change the scan interval and confirm it persists. Settings
	// opens as a tab from the sidebar (the v7 Settings is not a button).
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	await page.waitForSelector(".settings-panel");
	const interval = page.locator('.settings-panel select[aria-label="Deduplication interval"]');
	await interval.waitFor({ timeout: 15_000 });
	await interval.selectOption("15");
	await sleep(1500);
	report.interval = readJson(SETTINGS)?.settings?.dupeyScanIntervalMinutes ?? null;
	console.log("SETTINGS interval:", report.interval);
	await page.screenshot({ path: join(EVIDENCE, "3-settings-interval.png") });
	await app.close();
}

for (const name of FIXTURE_FILES) rmSync(join(DOWNLOADS, name), { force: true });
console.log("REPORT:", JSON.stringify(report, null, 1));
