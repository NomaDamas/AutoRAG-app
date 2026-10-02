/**
 * Finder performance benchmark for issues #15, #16, and #17.
 *
 * Drives the real Electron surface through Playwright and measures three
 * distinct layers per folder:
 *
 *   1. IPC   — `fs.listDir` / `fs.enrichEntries` latency, payload JSON bytes,
 *              and a renderer `structuredClone` proxy for clone cost.
 *   2. UI    — time from the folder-opening user action to the first painted
 *              row *of that folder* (crumb title + a row genuinely inside the
 *              target), never a generic stale row from the previous folder.
 *   3. DOM   — mounted row count vs virtualized scroll height, plus rAF frame
 *              intervals while scrolling the list and the icon grid.
 *
 * Quick Look image and PDF ready-paint are timed from the Space keypress to the
 * preview window's own ready DOM. Fixtures and userData are throwaway; private
 * directories are only read.
 *
 * Usage:
 *   bun scripts/benchmarks/finder-performance.mjs
 *   bun scripts/benchmarks/finder-performance.mjs --renderer-url http://localhost:5173 --output .omo/evidence/finder-performance/dev.json
 *   bun scripts/benchmarks/finder-performance.mjs --app-root /tmp/autorag-baseline --baseline
 *
 * Flags:
 *   --renderer-url <url>  Point Electron at a dev Vite server (ELECTRON_RENDERER_URL).
 *   --output <path>       Evidence JSON path (default .omo/evidence/finder-performance/<stamp>.json).
 *   --app-root <dir>      Repo/build root to launch (default: this repo).
 *   --user-data-dir <dir> Persist the throwaway userData for inspection (default: temp).
 *   --baseline            Force baseline semantics (skip ship-time enrichment).
 *   --dir <path>          Extra directory to read (repeatable). Defaults to $HOME/Downloads and $HOME/Desktop.
 *   --quick-look          Include Quick Look image/PDF timings (default: on).
 *   --no-quick-look       Skip Quick Look timings.
 *   --keep-fixture        Do not delete the temp fixture/userData at the end.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createFixture, removeFixture, seedRecents } from "./finder-fixtures.mjs";
import {
	basenameOf,
	clickSidebar,
	closeQuickLook,
	ensureRowMounted,
	finderWindow,
	launchFinder,
	markAndAct,
	openRowPath,
	quickLookWindow,
	resetToRoot,
	waitForFolder,
	waitForRowPath,
} from "./finder-harness.mjs";

const SCROLL_STEPS = 90;

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
	const flags = { dirs: [], quickLook: true, baseline: false, keepFixture: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--renderer-url") flags.rendererUrl = argv[++index];
		else if (value === "--output") flags.output = argv[++index];
		else if (value === "--app-root") flags.appRoot = argv[++index];
		else if (value === "--user-data-dir") flags.userDataDir = argv[++index];
		else if (value === "--dir") flags.dirs.push(argv[++index]);
		else if (value === "--baseline") flags.baseline = true;
		else if (value === "--quick-look") flags.quickLook = true;
		else if (value === "--no-quick-look") flags.quickLook = false;
		else if (value === "--keep-fixture") flags.keepFixture = true;
		else if (!value.startsWith("--")) flags.dirs.push(value);
	}
	return flags;
}

const flags = parseArgs(process.argv.slice(2));
const repoRoot = flags.appRoot ?? join(import.meta.dirname, "..", "..");
const stamp = `${Date.now()}-${process.pid}`;

/* ------------------------------------------------- page-side measurements */

/** IPC latency, payload bytes, and structuredClone cost for listDir / enrichEntries. */
function ipcMeasurement({ target, enrich }) {
	const round = (value) => Math.round(value * 100) / 100;
	const bytesOf = (value) => {
		try {
			return new TextEncoder().encode(JSON.stringify(value)).length;
		} catch {
			return -1;
		}
	};
	const cloneMsOf = (value) => {
		const startedAt = performance.now();
		try {
			structuredClone(value);
		} catch {
			return -1;
		}
		return round(performance.now() - startedAt);
	};
	const fs = globalThis.autorag?.fs;
	if (fs === undefined) return { error: "window.autorag.fs is unavailable" };
	return (async () => {
		const startedAt = performance.now();
		const listing = await fs.listDir(target);
		const baseMs = round(performance.now() - startedAt);
		const base = {
			ms: baseMs,
			entries: listing.entries.length,
			bytes: bytesOf(listing),
			cloneMs: cloneMsOf(listing),
			iconUrls: listing.entries.filter((entry) => entry.iconUrl !== null && entry.iconUrl !== undefined).length,
			iconDataUrls: listing.entries.filter((entry) => entry.iconDataUrl !== null && entry.iconDataUrl !== undefined).length,
		};
		const hasEnrich = typeof fs.enrichEntries === "function";
		if (!enrich || !hasEnrich) return { base, enrichment: null, hasEnrich };
		const targets = listing.entries
			.filter((entry) => entry.kind === "file" && typeof entry.modifiedAt === "string")
			.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				ext: typeof entry.name === "string" && entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "",
				modifiedAt: entry.modifiedAt,
			}));
		const enrichStartedAt = performance.now();
		const enriched = await fs.enrichEntries(targets, true);
		const enrichment = {
			ms: round(performance.now() - enrichStartedAt),
			count: enriched.length,
			icons: enriched.filter((entry) => entry.iconUrl !== null && entry.iconUrl !== undefined).length,
			bytes: bytesOf(enriched),
			cloneMs: cloneMsOf(enriched),
		};
		return { base, enrichment, hasEnrich };
	})();
}

/** Mounted rows, total virtualized height, and viewport for the current view. */
function domSnapshot() {
	const list = document.querySelector(".list");
	const rows = document.querySelectorAll('[role="row"][data-path], [role="option"][data-path]');
	return {
		mountedRows: rows.length,
		scrollHeight: list === null ? 0 : list.scrollHeight,
		viewport: list === null ? 0 : list.clientHeight,
		view: document.querySelector(".list--icons") !== null ? "icons" : "list",
		crumb: document.querySelector(".crumb--last")?.getAttribute("title") ?? null,
	};
}

/** rAF frame intervals while scrolling the container that matches `selector`. */
function scrollFrames({ selector, steps }) {
	const round = (value) => Math.round(value * 100) / 100;
	const node = document.querySelector(selector);
	if (node === null) return { error: `no ${selector}` };
	node.scrollTop = 0;
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			const frames = [];
			let count = 0;
			let last = performance.now();
			const step = () => {
				const now = performance.now();
				if (count > 0) frames.push(now - last);
				last = now;
				node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + node.clientHeight * 0.8);
				count += 1;
				const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
				if (count < steps && !atEnd) requestAnimationFrame(step);
				else {
					const sorted = [...frames].sort((a, b) => a - b);
					const pick = (p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
					resolve({
						frames: frames.length,
						meanMs: frames.length === 0 ? 0 : round(frames.reduce((a, b) => a + b, 0) / frames.length),
						p50Ms: round(pick(0.5)),
						p95Ms: round(pick(0.95)),
						maxMs: round(sorted.at(-1) ?? 0),
						over33ms: frames.filter((frame) => frame > 33).length,
					});
				}
			};
			requestAnimationFrame(step);
		});
	});
}

/* --------------------------------------------------------- orchestration */

async function measureIpc(page, target, { enrich }) {
	const first = await page.evaluate(ipcMeasurement, { target, enrich });
	const warm = await page.evaluate(ipcMeasurement, { target, enrich });
	return { first, warm };
}

async function measureDom(page) {
	return page.evaluate(domSnapshot);
}

async function setView(page, mode) {
	await page.locator(`.view-toggle__button[aria-label="${mode === "icons" ? "Icons" : "List"}"]`).click();
	await page.waitForTimeout(40);
}

async function measureScroll(page) {
	await setView(page, "list");
	const list = await page.evaluate(scrollFrames, { selector: ".list", steps: SCROLL_STEPS });
	const listDom = await measureDom(page);
	await setView(page, "icons");
	const icons = await page.evaluate(scrollFrames, { selector: ".list", steps: SCROLL_STEPS });
	const iconsDom = await measureDom(page);
	await setView(page, "list");
	return { list, icons, listDom, iconsDom };
}

/** Walks from the QA root through `segments`, timing only the final folder open. */
async function navigateFixture(finder, segments) {
	await resetToRoot(finder, basename(fixture.root));
	let path = fixture.root;
	for (let index = 0; index < segments.length; index += 1) {
		path = join(path, segments[index]);
		if (index < segments.length - 1) {
			await openRowPath(finder, path);
			await finder.waitForTimeout(60);
		} else {
			await markAndAct(finder, () => openRowPath(finder, path));
		}
	}
	return waitForFolder(finder, { target: path, label: basenameOf(path) });
}

/** Runs the IPC + DOM + scroll suite for one already-open scenario. */
async function collectScenario(finder, { id, target, enrich, scroll = true }) {
	const ipc = await measureIpc(finder, target, { enrich });
	const dom = await measureDom(finder);
	const frames = scroll ? await measureScroll(finder) : null;
	return { id, ipc, dom, frames };
}

async function measureQuickLook(app, finder, kind, target) {
	const row = await ensureRowMounted(finder, target);
	await row.click();
	// Let the selection commit so Space targets this file, not the previous one.
	await finder.waitForTimeout(150);
	const name = basenameOf(target);
	const startedAt = Date.now();
	await finder.keyboard.press("Space");
	const preview = await quickLookWindow(app);
	if (kind === "image") {
		await preview.waitForFunction(
			(expected) => {
				if (document.querySelector(".qlw__name")?.textContent !== expected) return false;
				const image = document.querySelector(".ql__image");
				return image instanceof HTMLImageElement && image.naturalWidth > 0;
			},
			name,
			{ polling: "raf", timeout: 30000 },
		);
	} else {
		await preview.waitForFunction(
			(expected) => {
				if (document.querySelector(".qlw__name")?.textContent !== expected) return false;
				const pages = document.querySelectorAll(".ql__paper canvas");
				for (const canvas of pages) {
					if (canvas instanceof HTMLCanvasElement && canvas.width > 0) return true;
				}
				return document.querySelectorAll(".ql__rail-item canvas[data-drawn='true']").length > 0;
			},
			name,
			{ polling: "raf", timeout: 30000 },
		);
	}
	const readyMs = Date.now() - startedAt;
	const windowVisible = await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
		return window === undefined ? false : window.isVisible();
	});
	return { kind, target, readyMs, windowVisible };
}

/* ------------------------------------------------------------------ main */

const fixture = await createFixture(stamp);

const userDataDir = flags.userDataDir ?? join(tmpdir(), `autorag-finder-perf-userdata-${stamp}`);
await seedRecents(userDataDir, fixture.recents);

const home = process.env.HOME ?? "";
const defaultDirs = home === "" ? [] : [join(home, "Downloads"), join(home, "Desktop")];
const privateDirs = (flags.dirs.length > 0 ? flags.dirs : defaultDirs).filter((dir) => existsSync(dir));

const results = [];
const skipped = [];
let mode = flags.baseline ? "baseline" : "current";
let hasEnrich = false;
let runError = null;
const quickLook = [];
let app = null;

try {
	app = await launchFinder({ repoRoot, userDataDir, qaRoot: fixture.root, rendererUrl: flags.rendererUrl });
	const finder = await finderWindow(app);
	await finder.waitForSelector(".list", { timeout: 60000 });
	hasEnrich = await finder.evaluate(() => typeof globalThis.autorag?.fs?.enrichEntries === "function");
	if (flags.baseline || !hasEnrich) mode = "baseline";

	const rootLabel = basename(fixture.root);
	const enrich = mode !== "baseline";

	// Fixture scenarios, ordered so every one except Recents can return to the
	// QA root through its breadcrumb.
	const fixtures = [
		{ id: "normal-341", segments: ["normal-341"], target: fixture.normal },
		{ id: "media-heavy", segments: ["media"], target: fixture.media },
		{ id: "flat-5000", segments: ["flat-5000"], target: fixture.flat },
	];
	for (const scenario of fixtures) {
		const uiMs = await navigateFixture(finder, scenario.segments);
		const collected = await collectScenario(finder, { id: scenario.id, target: scenario.target, enrich });
		results.push({ id: scenario.id, target: scenario.target, uiFirstPaintMs: uiMs, ...collected });
	}

	// Nested navigation: descend to level-2, timing only the last hop.
	{
		const segments = ["nested", "level-1", "level-2"];
		const uiMs = await navigateFixture(finder, segments);
		const collected = await collectScenario(finder, { id: "nested-nav", target: fixture.nestedChild, enrich });
		results.push({ id: "nested-nav", target: fixture.nestedChild, uiFirstPaintMs: uiMs, ...collected });
	}

	// Nested disclosure: expand level-1 (300 children) inline and time the first child row.
	{
		await resetToRoot(finder, rootLabel);
		await openRowPath(finder, fixture.nested);
		await waitForFolder(finder, { target: fixture.nested, label: "nested" });
		const disclosure = finder.getByRole("button", { name: `${basenameOf(fixture.nestedLevel1)} 펼치기` });
		await markAndAct(finder, () => disclosure.click());
		const uiMs = await waitForRowPath(finder, fixture.nestedChild);
		const collected = await collectScenario(finder, { id: "nested-disclosure", target: fixture.nested, enrich, scroll: false });
		results.push({ id: "nested-disclosure", target: fixture.nestedChild, uiFirstPaintMs: uiMs, ...collected });
	}

	// Recents: virtual listing seeded into the throwaway userData.
	{
		await markAndAct(finder, () => clickSidebar(finder, "Recents"));
		const uiMs = await waitForFolder(finder, { target: "Recents", label: "Recents", recents: fixture.recents });
		const collected = await collectScenario(finder, { id: "recents", target: "Recents", enrich, scroll: false });
		results.push({ id: "recents", target: "Recents", uiFirstPaintMs: uiMs, ...collected });
	}

	// Private directories last: reached from the sidebar, never mutated.
	for (const dir of privateDirs) {
		const label = basename(dir);
		const button = finder.getByLabel("Places").getByRole("button", { name: label, exact: true });
		if ((await button.count()) === 0) {
			skipped.push({ id: `private:${label}`, target: dir, reason: "no sidebar place" });
			continue;
		}
		await markAndAct(finder, () => button.click());
		const uiMs = await waitForFolder(finder, { target: dir, label });
		const collected = await collectScenario(finder, { id: `private:${label}`, target: dir, enrich });
		results.push({ id: `private:${label}`, target: dir, uiFirstPaintMs: uiMs, ...collected });
	}

	// Quick Look image/PDF ready paint, measured while the media fixture is open.
	if (flags.quickLook) {
		await resetToRoot(finder, rootLabel);
		await markAndAct(finder, () => openRowPath(finder, fixture.media));
		await waitForFolder(finder, { target: fixture.media, label: "media" });
		quickLook.push(await measureQuickLook(app, finder, "image", fixture.quickLook.image));
		await closeQuickLook(app);
		quickLook.push(await measureQuickLook(app, finder, "pdf", fixture.quickLook.pdf));
	}
} catch (error) {
	runError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
	if (app !== null) await app.close();
}

const evidence = {
	benchmark: "finder-performance",
	date: new Date().toISOString(),
	platform: process.platform,
	mode,
	hasEnrich,
	runError,
	rendererUrl: flags.rendererUrl ?? null,
	appRoot: repoRoot,
	userDataDir: flags.keepFixture ? userDataDir : null,
	fixture: {
		root: fixture.root,
		flat5000: 5000,
		normal341: 341,
		media: 202,
		nestedChild: 500,
		nestedLevel1Children: 301,
		recentsSeeds: fixture.recents.length,
	},
	notes: [
		"ipc.first is the first listDir/enrich for that folder in this process; ipc.warm is the second.",
		"payload bytes are JSON UTF-8 length; cloneMs is a renderer structuredClone proxy (IPC already clones once).",
		"uiFirstPaintMs is from the folder-opening action to crumb+row of that folder; generic row waits are never used.",
		"frames measure rAF intervals while scrolling the list and icon grid.",
	],
	scenarios: results,
	skipped,
	quickLook,
};

const outputPath = flags.output ?? join(repoRoot, ".omo", "evidence", "finder-performance", `${stamp}.json`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (!flags.keepFixture) {
	await removeFixture(fixture.root);
	if (flags.userDataDir === undefined) await removeFixture(userDataDir);
}

console.log(JSON.stringify({ output: outputPath, mode, scenarios: results.length, quickLook: quickLook.length, runError }, null, 2));
if (runError !== null) {
	console.error(runError);
	process.exitCode = 1;
} else {
	console.log(JSON.stringify(evidence, null, 2));
}
