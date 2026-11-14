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
 * One of the app's two renderer pages: the first-run onboarding window (`onboarding: true`) or the Finder
 * (`false`). Both load /index.html, so the preload's launch argument tells them apart. The pre-warmed Quick
 * Look window can register with Playwright before either, so poll instead of trusting `firstWindow()`.
 */
export async function appWindow(app, onboarding, timeoutMs = 6000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		for (const page of (await app.windows()).filter((candidate) => candidate.url().endsWith("/index.html"))) {
			const pending = await page.evaluate(() => window.autorag?.onboarding?.pending === true).catch(() => null);
			if (pending === onboarding) return page;
		}
		if (Date.now() >= deadline) throw new Error(`${onboarding ? "Onboarding" : "Finder"} index window did not open`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The Finder renderer page (never the onboarding window that opens beside it on a first run). */
export const finderWindow = (app, timeoutMs = 6000) => appWindow(app, false, timeoutMs);

/** The first-run onboarding renderer page. */
export const onboardingWindow = (app, timeoutMs = 6000) => appWindow(app, true, timeoutMs);

/** Every pre-warmed Quick Look panel page the app has right now (see {@link createFinderPreview}). */
export async function quickLookPages(app) {
	return (await app.windows()).filter((page) => page.url().includes("quick-look.html"));
}

/** One reading of every pre-warmed panel: its page, its window's signals, and whether its page has a file loaded. */
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
 * The app always pre-warms TWO panels — the Finder's and the quick-search
 * launcher's (`createQuickSearchWindow` attaches its own at startup) — and either
 * can register with Playwright first, while `BrowserWindow.getAllWindows()`
 * returns the launcher's hidden 880×640 panel first. That panel never resizes
 * with the Finder's preview, so a lane that took "the first quick-look page" or
 * "the first quick-look window" measured the wrong one (a constant 880×640 in
 * every geometry check).
 *
 * Panels are told apart, in order, by:
 *   1. `getParentWindow()` being the Finder (Windows/Linux, where the panel is a
 *      child of its owner);
 *   2. not floating on every workspace: the launcher's panel is created with
 *      `level: "screen-saver"`, so `setVisibleOnAllWorkspaces(true, ...)` was
 *      called on it and `isVisibleOnAllWorkspaces()` is true, while the Finder's
 *      panel never gets that call — this resolves before any file is shown;
 *   3. after the Finder has shown a file, the only panel whose page reached
 *      `data-quicklook-state="ready"` or whose window is visible.
 *
 * Resolved once and reused. `page()` throws with the panel facts when the panels
 * cannot be told apart, rather than silently returning the launcher's. `state()`
 * reads the panel's own window through Playwright's `browserWindow(page)` handle,
 * so a bounds/visibility read can never hit the other panel.
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

/** The visible AI Search panel (hidden AI tabs keep theirs mounted with aria-hidden). */
export const AI_PANEL = 'section[aria-label="AI Search"]:not([aria-hidden="true"])';

/**
 * Show AI Search in the focused tab through the sidebar's Favorites item, the
 * way a user does, and wait for its composer.
 */
export async function openAiSearch(page, timeoutMs = 30_000) {
	await page.locator(".sidebar__item", { hasText: "AI Search" }).click({ timeout: timeoutMs });
	await page.waitForSelector(`${AI_PANEL} textarea[aria-label="Ask Dazzi"]`, { timeout: timeoutMs });
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
