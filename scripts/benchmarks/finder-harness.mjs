/**
 * Playwright Electron harness for the Finder performance benchmark.
 *
 * Drives the real built app (or a dev Vite renderer) and waits on the actual
 * target folder, never a generic row: the previous folder's rows can survive a
 * navigation commit, so a bare `[role=row]` wait would time the wrong paint.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright";

/** Splits a POSIX or Windows path and returns its final segment. */
export function basenameOf(path) {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index < 0 ? path : path.slice(index + 1);
}

/**
 * Launches the app. `repoRoot` must already contain a build (out/main/index.js);
 * this harness never builds. `userDataDir` isolates settings and Recents.
 */
export async function launchFinder({ repoRoot, userDataDir, qaRoot, rendererUrl, extraEnv = {} }) {
	if (!existsSync(join(repoRoot, "out/main/index.js"))) {
		throw new Error(`out/main/index.js is missing under ${repoRoot} — build the surface first`);
	}
	const env = {
		...process.env,
		AUTORAG_QA_ROOT: qaRoot,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		...extraEnv,
	};
	if (rendererUrl !== undefined) env.ELECTRON_RENDERER_URL = rendererUrl;
	const args = userDataDir === undefined ? ["."] : [".", `--user-data-dir=${userDataDir}`];
	return electron.launch({ args, cwd: repoRoot, env });
}

/** Waits for a window whose URL matches, checking already-open windows first. */
export async function waitForWindow(app, predicate, timeout = 30000) {
	const existing = app.windows().find(predicate);
	if (existing !== undefined) return existing;
	return app.waitForEvent("window", { predicate, timeout });
}

/** The Finder renderer. Quick Look may also be an Electron window, so match index.html exactly. */
export function finderWindow(app, timeout = 30000) {
	return waitForWindow(app, (page) => page.url().endsWith("/index.html") || page.url().includes("/index.html?"), timeout);
}

/** The pre-created (hidden) Quick Look renderer. */
export function quickLookWindow(app, timeout = 30000) {
	return waitForWindow(app, (page) => page.url().includes("quick-look.html"), timeout);
}

/**
 * Closes the open Quick Look panel through Electron's native input path (the
 * Escape handling lives in `before-input-event`, which CDP key events skip),
 * then waits until the panel has left its ready state.
 */
export async function closeQuickLook(app, timeout = 15000) {
	const preview = await quickLookWindow(app);
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
		if (window === undefined) return;
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
	});
	await preview.waitForFunction(
		() => document.querySelector(".qlw")?.getAttribute("data-quicklook-state") !== "ready",
		null,
		{ polling: "raf", timeout },
	);
}

/**
 * Records the in-page start time, then runs `act`. Whatever follows measures
 * from just before the user action to the first paint of the target DOM.
 */
export async function markAndAct(page, act) {
	await page.evaluate(() => {
		globalThis.__finderBench = { startedAt: performance.now() };
	});
	await act();
}

/**
 * Resolves to the in-page elapsed ms once the descriptor's target DOM is on
 * screen. The predicate is a single self-contained function (no eval), so a
 * strict `script-src 'self'` CSP on the renderer cannot block it.
 */
export function elapsedSinceReady(page, descriptor, timeout = 30000) {
	return page
		.waitForFunction(
			(descriptor) => {
				let mark = globalThis.__finderBench;
				if (mark === undefined) {
					mark = { startedAt: performance.now() };
					globalThis.__finderBench = mark;
				}
				if (descriptor.kind === "row") {
					const rows = document.querySelectorAll('[role="row"][data-path], [role="option"][data-path]');
					for (const row of rows) {
						if (row.getAttribute("data-path") === descriptor.path) {
							return { ms: performance.now() - mark.startedAt };
						}
					}
					return null;
				}
				const title = document.querySelector(".toolbar-title");
				if (title === null || title.textContent !== descriptor.label) return null;
				const rows = document.querySelectorAll('[role="row"][data-path], [role="option"][data-path]');
				if (rows.length === 0) return null;
				for (const row of rows) {
					const path = row.getAttribute("data-path");
					if (path === null) continue;
					if (descriptor.recents !== null) {
						if (descriptor.recents.includes(path)) return { ms: performance.now() - mark.startedAt };
					} else if (path.startsWith(`${descriptor.target}/`) || path.startsWith(`${descriptor.target}\\`)) {
						return { ms: performance.now() - mark.startedAt };
					}
				}
				return null;
			},
			descriptor,
			{ polling: "raf", timeout },
		)
		.then((handle) => handle.jsonValue())
		.then((value) => Math.round(value.ms * 100) / 100);
}

/** Waits for the target folder (toolbar title + a direct child row), timing from the click. */
export function waitForFolder(page, { target, label, recents = null }, timeout = 30000) {
	return elapsedSinceReady(page, { kind: "folder", target, label, recents }, timeout);
}

/** Waits until a row with the exact data-path is mounted (inline disclosure). */
export function waitForRowPath(page, path, timeout = 30000) {
	return elapsedSinceReady(page, { kind: "row", path }, timeout);
}

/** Clicks a sidebar place by its visible label. */
export async function clickSidebar(page, label) {
	await page.getByLabel("Places").getByRole("button", { name: label, exact: true }).click();
}

/**
 * Returns to the QA root by clicking its breadcrumb. Falls back to the Back
 * button when the crumb is not on screen (e.g. after visiting a private place).
 */
export async function resetToRoot(page, rootLabel) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const crumb = page.locator(`.crumb[title="${rootLabel}"]`);
		if ((await crumb.count()) > 0) {
			await crumb.first().click();
			return;
		}
		const back = page.getByRole("button", { name: "Back" });
		if (await back.isDisabled()) break;
		await back.click();
		await page.waitForTimeout(40);
	}
	throw new Error(`Could not return to QA root (${rootLabel})`);
}

/** Double-clicks the row owning `path`; returns false when it never mounts. */
export async function openRowPath(page, path) {
	const row = page.locator(`[role="row"][data-path="${path}"], [role="option"][data-path="${path}"]`).first();
	await row.waitFor({ timeout: 30000 });
	await row.dblclick();
}

/** Ensures a row is mounted by scrolling the virtual list from the top. */
export async function ensureRowMounted(page, path) {
	await page.locator(".list").evaluate((node) => {
		node.scrollTop = 0;
	});
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const row = page.locator(`[role="row"][data-path="${path}"], [role="option"][data-path="${path}"]`).first();
		if ((await row.count()) > 0) return row;
		const atEnd = await page.locator(".list").evaluate((node) => {
			node.scrollTop = node.scrollTop + node.clientHeight * 0.9;
			return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
		});
		await page.waitForTimeout(25);
		if (atEnd) break;
	}
	throw new Error(`Row never mounted: ${path}`);
}
