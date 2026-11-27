import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { _electron } from "playwright";
import { cssAttr } from "./platform.mjs";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Seed the Interface language into a fresh profile, so lanes assert one known
 * copy instead of whatever the shared dev profile last chose. An existing
 * settings file is left alone: a lane that relaunches on the same profile must
 * see what the previous launch persisted.
 */
function seedLanguage(userDataDir, language) {
	const settings = join(userDataDir, "settings", "settings-state.json");
	if (existsSync(settings)) return;
	mkdirSync(join(userDataDir, "settings"), { recursive: true });
	writeFileSync(settings, `${JSON.stringify({ settings: { language }, permissions: {} }, null, 2)}\n`);
}

/**
 * Launch the built Finder app for QA. Requires `bun run build` from the repo
 * root first; userDataDir and env pass through to the Electron process, and
 * `args` appends Chromium switches (e.g. `--force-device-scale-factor=2`).
 * Without a `userDataDir` the lane gets a throwaway profile, never the
 * developer's own. Existing lanes start in a known Interface language; an
 * onboarding lane opts out of the Finder bypass. `language: null` seeds
 * nothing, so the profile starts the way a first run does (in the OS language).
 */
export async function launchFinder({
	userDataDir,
	env,
	args: extraArgs = [],
	language = "en",
	onboarding = false,
} = {}) {
	if (!existsSync(join(ROOT, "out/main/index.js"))) {
		throw new Error("out/main/index.js is missing — run `bun run build` first");
	}
	const profile = userDataDir ?? mkdtempSync(join(tmpdir(), "autorag-qa-profile-"));
	if (language !== null) seedLanguage(profile, language);
	// GitHub's Windows runners have no GPU, and Chromium's GPU process dies at
	// random there mid-session (observed as "Target page, context or browser
	// has been closed" with nothing in stderr). Software rendering is stable.
	const gpuArgs = process.platform === "win32" ? ["--disable-gpu"] : [];
	const args = [".", ...gpuArgs, `--user-data-dir=${profile}`, ...extraArgs];
	return _electron.launch({
		args,
		cwd: ROOT,
		env: {
			...process.env,
			...(onboarding ? {} : { AUTORAG_SKIP_ONBOARDING: "1" }),
			...env,
			// Windows resolves the home from USERPROFILE, not HOME: a lane that sets only HOME would
			// otherwise drive the real profile's folders.
			...(process.platform === "win32" && env?.HOME !== undefined && env.USERPROFILE === undefined ? { USERPROFILE: env.HOME } : {}),
		},
	});
}

/**
 * The app's renderer page — its one window. A first run no longer opens a second window beside the Finder: the
 * Finder window itself carries the first-run overlay, so on that launch `window.autorag.onboarding.pending` is
 * true and the same page is both "the Finder" and "the first-run screen". A lane that opts out of onboarding
 * (`launchFinder({ onboarding: false })`) gets the same one page. Quick Look and Quick Search windows never load
 * /index.html, so the URL filter alone picks the Finder; poll instead of trusting `firstWindow()`.
 */
export async function appWindow(app, timeoutMs = 6000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const page = (await app.windows()).find((candidate) => candidate.url().endsWith("/index.html"));
		if (page !== undefined) return page;
		if (Date.now() >= deadline) throw new Error("the Finder window did not open");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The Finder renderer page (during a first run its window also hosts the first-run overlay). */
export const finderWindow = (app, timeoutMs = 6000) => appWindow(app, timeoutMs);

/** The first-run renderer page — the same Finder window, which carries the pending flag on a first run. */
export const onboardingWindow = (app, timeoutMs = 6000) => appWindow(app, timeoutMs);

/** Every Quick Look panel page the app has created so far (0, 1, or 2; see {@link createFinderPreview}). */
export async function quickLookPages(app) {
	return (await app.windows()).filter((page) => page.url().includes("quick-look.html"));
}

/**
 * Wait until a Quick Look panel page exists (created lazily on the first Space / preview request).
 * Returns the first matching page, or throws when the timeout expires.
 */
export async function waitForQuickLookPage(app, { timeoutMs = 30_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const page = (await quickLookPages(app))[0];
		if (page !== undefined) return page;
		if (Date.now() >= deadline) throw new Error("Quick Look window did not appear");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** One reading of every existing Quick Look panel: its page, its window's signals, and whether its page has a file loaded. */
async function previewPanelFacts(app, main) {
	const mainHandle = main === undefined ? null : await app.browserWindow(main);
	const mainId = mainHandle === null ? null : await mainHandle.evaluate((window) => window.id);
	const facts = [];
	for (const page of await quickLookPages(app)) {
		const handle = await app.browserWindow(page);
		const window = await handle.evaluate((win) => ({
			id: win.id,
			parentId: win.getParentWindow()?.id ?? null,
			allWorkspaces: win.isVisibleOnAllWorkspaces(),
			visible: win.isVisible(),
			title: win.getTitle(),
		}));
		const ready = await page.evaluate(() => document.querySelector(".qlw")?.dataset.quicklookState === "ready").catch(() => false);
		const shownName = await page.evaluate(() => document.querySelector(".qlw__name")?.textContent ?? "").catch(() => "");
		facts.push({ page, handle, ready, shownName, ...window });
	}
	return { mainId, facts };
}

/** The signals a failed mapping reports, so the next reader does not have to reproduce the run to see them. */
function previewPanelDigest(facts) {
	return JSON.stringify(facts.map(({ id, parentId, allWorkspaces, visible, ready, title, shownName }) => ({ id, parentId, allWorkspaces, visible, ready, title, shownName })));
}

/**
 * The Quick Look panel that belongs to the Finder (`main`), and only that one.
 *
 * Quick Look panels are created lazily — 0 exist at startup, 1 once the Finder
 * previews a file, and up to 2 if the quick-search launcher has also opened a
 * preview. When both panels exist, either can register with Playwright first,
 * while `BrowserWindow.getAllWindows()` may return the launcher's hidden
 * 880×640 panel first. That panel never resizes with the Finder's preview, so
 * a lane that took "the first quick-look page" or "the first quick-look window"
 * could measure the wrong one (a constant 880×640 in every geometry check).
 *
 * Panels are told apart, in order, by:
 *   1. `getParentWindow()` being the Finder (Windows/Linux, where the panel is a
 *      child of its owner);
 *   2. not floating on every workspace: the launcher's panel is created with
 *      `level: "screen-saver"`, so `setVisibleOnAllWorkspaces(true, ...)` was
 *      called on it and `isVisibleOnAllWorkspaces()` is true, while the Finder's
 *      panel never gets that call;
 *   3. after the Finder has shown a file, the only panel whose page reached
 *      `data-quicklook-state="ready"` or whose window is visible.
 *
 * Resolved once and reused (works with 0, 1, or 2 existing panels; returns null
 * from `state()` until the Finder's panel has been created). `page()` throws
 * with the panel facts when no panel exists yet or the panels cannot be told
 * apart, rather than silently returning the launcher's. `state()` reads the
 * panel's own window through Playwright's `browserWindow(page)` handle, so a
 * bounds/visibility read can never hit the other panel.
 */
export function createFinderPreview(app, main) {
	let chosen = null;
	async function resolve() {
		if (chosen !== null) return chosen;
		const { mainId, facts } = await previewPanelFacts(app, main);
		if (facts.length === 0) return null;
		const byParent = mainId === null ? undefined : facts.find((fact) => fact.parentId === mainId);
		const finderPanels = facts.filter((fact) => fact.allWorkspaces === false);
		const shown = facts.filter((fact) => fact.visible || fact.ready);
		chosen = byParent ?? (finderPanels.length === 1 ? finderPanels[0] : undefined) ?? (shown.length === 1 ? shown[0] : undefined) ?? null;
		return chosen;
	}
	return {
		/** Every panel seen right now, for diagnostics. */
		async facts() {
			return (await previewPanelFacts(app, main)).facts;
		},
		/** The Finder's panel page; throws with the panel facts when they cannot be told apart. */
		async page() {
			const found = await resolve();
			if (found === null) {
				const { facts } = await previewPanelFacts(app, main);
				throw new Error(`cannot tell the Finder's Quick Look panel apart: ${previewPanelDigest(facts)}`);
			}
			return found.page;
		},
		/** The Finder panel window's live `{ visible, bounds }`, or null when no panel has appeared yet. */
		async state() {
			const found = await resolve();
			return found === null ? null : found.handle.evaluate((win) => ({ visible: win.isVisible(), bounds: win.getBounds() }));
		},
	};
}

/**
 * The fs worker's diagnostics (pid, restarts, per-op request counts, recent
 * requests), read in main through the handler the app registers for it.
 * Listings no longer pass through `ipcMain`, so lanes count them here.
 */
export function fsWorkerDiagnostics(app) {
	return app.evaluate(async ({ ipcMain }) => {
		const handler = ipcMain._invokeHandlers.get("fs-worker:diagnostics");
		if (handler === undefined) throw new Error("fs-worker:diagnostics is not registered");
		return handler({});
	});
}

/** The visible AI Chat panel (hidden AI tabs keep theirs mounted with aria-hidden). */
export const AI_PANEL = 'section[aria-label="AI Agent"]:not([aria-hidden="true"])';

/**
 * Show AI Chat in the focused tab through the sidebar's Favorites item, the
 * way a user does, and wait for its composer.
 */
export async function openAiSearch(page, timeoutMs = 30_000) {
	await page.locator(".sidebar__item", { hasText: "AI Agent" }).click({ timeout: timeoutMs });
	await page.waitForSelector(`${AI_PANEL} textarea[aria-label="Ask AI"]`, { timeout: timeoutMs });
}

/**
 * Once a row drag leaves the window it becomes the OS file drag (`fs:startDrag`
 * → `webContents.startDrag`), which would capture the real pointer. A lane that
 * drags a row out must neutralize it first. The contextBridge object is frozen,
 * so the stub lives in the main process — `startDrag` becomes a no-op and the
 * channel payloads are recorded. Returns a reader for the payloads sent.
 */
export async function stubNativeDrag(app) {
	await app.evaluate(({ BrowserWindow, ipcMain }) => {
		globalThis.__qaStartDrags = globalThis.__qaStartDrags ?? [];
		for (const window of BrowserWindow.getAllWindows()) window.webContents.startDrag = () => {};
		if (globalThis.__qaStartDragsHooked !== true) {
			globalThis.__qaStartDragsHooked = true;
			ipcMain.on("fs:startDrag", (_event, paths) => globalThis.__qaStartDrags.push(paths));
		}
	});
	return () => app.evaluate(() => globalThis.__qaStartDrags ?? []);
}

/**
 * Drag a row out of the window the way a user does: press, pass the drag
 * threshold, leave through the left edge, release. Playwright's mouse is
 * synthesized inside the renderer, so the real cursor never moves. Requires
 * {@link stubNativeDrag} first, and a selection when the drag should carry more
 * than the grabbed row.
 */
export async function dragRowOut(page, path) {
	const box = await page.locator(`[data-path="${cssAttr(path)}"]`).first().boundingBox();
	if (box === null) throw new Error(`no row for ${path}`);
	const y = box.y + box.height / 2;
	await page.mouse.move(box.x + 24, y);
	await page.mouse.down();
	await page.mouse.move(box.x + 40, y, { steps: 4 });
	await page.mouse.move(-20, y, { steps: 6 });
	await page.mouse.up();
}
