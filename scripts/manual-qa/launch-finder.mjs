import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { _electron } from "playwright";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Launch the built Finder app for QA. Requires `bun run build` from the repo
 * root first; userDataDir and env pass through to the Electron process, and
 * `args` appends Chromium switches (e.g. `--force-device-scale-factor=2`).
 */
export async function launchFinder({ userDataDir, env, args: extraArgs = [] } = {}) {
	if (!existsSync(join(ROOT, "out/main/index.js"))) {
		throw new Error("out/main/index.js is missing — run `bun run build` first");
	}
	// GitHub's Windows runners have no GPU, and Chromium's GPU process dies at
	// random there mid-session (observed as "Target page, context or browser
	// has been closed" with nothing in stderr). Software rendering is stable.
	const gpuArgs = process.platform === "win32" ? ["--disable-gpu"] : [];
	const args = [".", ...gpuArgs, ...(userDataDir === undefined ? [] : [`--user-data-dir=${userDataDir}`]), ...extraArgs];
	return _electron.launch({
		args,
		cwd: ROOT,
		env: env === undefined ? undefined : { ...process.env, ...env },
	});
}

/**
 * The Finder renderer page. The pre-warmed Quick Look window can register
 * with Playwright before the main window, so poll for the /index.html page
 * instead of trusting `firstWindow()`.
 */
export async function finderWindow(app, timeoutMs = 6000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const page = (await app.windows()).find((candidate) => candidate.url().endsWith("/index.html"));
		if (page !== undefined) return page;
		if (Date.now() >= deadline) throw new Error("Finder index window did not open");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The visible AI Search panel (hidden AI tabs keep theirs mounted with aria-hidden). */
export const AI_PANEL = 'section[aria-label="AI Search"]:not([aria-hidden="true"])';

/**
 * Show AI Search in the focused tab through the sidebar's Favorites item, the
 * way a user does, and wait for its composer.
 */
export async function openAiSearch(page, timeoutMs = 30_000) {
	await page.locator(".sidebar__item", { hasText: "AI Search" }).click({ timeout: timeoutMs });
	await page.waitForSelector(`${AI_PANEL} input[aria-label="Ask Dazzi"]`, { timeout: timeoutMs });
}
