/**
 * Finder tab-switch benchmark.
 *
 * Opens two real folders (default `$HOME/Downloads` and `$HOME/Desktop`) in two
 * tabs of the built app, then clicks between the tabs. Each switch samples
 * every animation frame for a fixed window and reports, from the click:
 *
 *   - activeMs   — the clicked tab is highlighted;
 *   - titleMs    — the toolbar names the target folder;
 *   - firstRowMs — a row that genuinely lives in the target folder is mounted;
 *   - settledMs  — the last frame whose rows or icons still changed;
 *   - staleFrames — frames that named the target folder but still showed the
 *                   previous tab's rows (or none): the visible "flash";
 *   - longTasks  — main-thread tasks over 50 ms inside the window.
 *
 * The IPC cost of re-reading each folder (`listDir`, `enrichEntries`,
 * `indexStatus`) is measured separately so a switch can be attributed to IPC
 * or to rendering. Folders are only read, never mutated.
 *
 * Usage:
 *   bun run build
 *   bun scripts/benchmarks/finder-tab-switch.mjs
 *   bun scripts/benchmarks/finder-tab-switch.mjs --rounds 12 --dir ~/Documents --dir ~/Desktop
 *   # React dev build, as `make run` serves it (docs/finder-performance.md
 *   # "Tab switching" shows how to start the renderer-only dev server):
 *   bun scripts/benchmarks/finder-tab-switch.mjs --renderer-url http://localhost:5173
 *
 * Flags:
 *   --dir <path>              Folder for a tab (repeat twice). Must be a sidebar place.
 *   --rounds <n>              Switches per direction (default 8).
 *   --window <ms>             Frames sampled per switch (default 1500).
 *   --view <mode>             icons | list | columns (default: the app default).
 *   --renderer-url <url>      Point Electron at a dev Vite server (ELECTRON_RENDERER_URL).
 *   --seed-user-data <dir>    Copy `dupey-cache` and `settings` from an existing userData
 *                             into the throwaway one, so version stacks match a real install.
 *   --app-root <dir>          Repo/build root to launch (default: this repo).
 *   --output <path>           Evidence JSON (default .omo/evidence/finder-tab-switch/<stamp>.json).
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { clickSidebar, finderWindow, launchFinder, markAndAct, waitForFolder } from "./finder-harness.mjs";

function parseArgs(argv) {
	const flags = { dirs: [], rounds: 8, windowMs: 1500 };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--dir") flags.dirs.push(argv[++index]);
		else if (value === "--rounds") flags.rounds = Number(argv[++index]);
		else if (value === "--window") flags.windowMs = Number(argv[++index]);
		else if (value === "--view") flags.view = argv[++index];
		else if (value === "--renderer-url") flags.rendererUrl = argv[++index];
		else if (value === "--seed-user-data") flags.seedUserData = argv[++index];
		else if (value === "--app-root") flags.appRoot = argv[++index];
		else if (value === "--output") flags.output = argv[++index];
	}
	return flags;
}

const flags = parseArgs(process.argv.slice(2));
const repoRoot = flags.appRoot ?? join(import.meta.dirname, "..", "..");
const stamp = `${Date.now()}-${process.pid}`;
const home = process.env.HOME ?? "";
const dirs = flags.dirs.length > 0 ? flags.dirs : [join(home, "Downloads"), join(home, "Desktop")];
if (dirs.length !== 2 || dirs.some((dir) => !existsSync(dir))) {
	throw new Error(`Need exactly two existing folders, got: ${dirs.join(", ")}`);
}

/* ------------------------------------------------- page-side measurements */

/**
 * Clicks tab `index` and samples every rAF for `windowMs`. Runs in the page as
 * one self-contained function so the click and the clock share a task.
 */
function switchAndSample({ index, target, label, windowMs }) {
	const titles = document.querySelectorAll(".tab .tab__title");
	const button = titles[index];
	if (button === undefined) throw new Error(`No tab at index ${index}`);
	const longTasks = [];
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
	});
	observer.observe({ type: "longtask" });
	const inTarget = (path) => path !== null && (path.startsWith(`${target}/`) || path.startsWith(`${target}\\`));
	const snapshot = () => {
		const rows = document.querySelectorAll('[role="row"][data-path], [role="option"][data-path]');
		let targetRows = 0;
		let icons = 0;
		let signature = "";
		for (const row of rows) {
			const path = row.getAttribute("data-path");
			if (inTarget(path)) targetRows += 1;
			const image = row.querySelector("img");
			const src = image === null ? "" : image.getAttribute("src") ?? "";
			if (src !== "") icons += 1;
			signature += `${path}\u0000${src}\u0001`;
		}
		return {
			active: document.querySelector(".tab--active .tab__title")?.textContent ?? null,
			title: document.querySelector(".toolbar-title")?.textContent ?? null,
			rows: rows.length,
			targetRows,
			icons,
			signature,
		};
	};
	const startedAt = performance.now();
	button.click();
	return new Promise((resolve) => {
		const frames = [];
		const tick = () => {
			const now = performance.now();
			frames.push({ ms: now - startedAt, ...snapshot() });
			if (now - startedAt < windowMs) {
				requestAnimationFrame(tick);
				return;
			}
			observer.disconnect();
			const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
			const first = (predicate) => frames.find(predicate)?.ms ?? null;
			const firstRow = frames.findIndex((frame) => frame.title === label && frame.targetRows > 0);
			let settled = null;
			// Only the frames where something on screen changed, for diagnosis.
			const timeline = [];
			for (let at = 0; at < frames.length; at += 1) {
				const frame = frames[at];
				const previous = at === 0 ? null : frames[at - 1];
				if (previous !== null && frame.signature !== previous.signature) settled = frame.ms;
				if (previous === null || frame.signature !== previous.signature || frame.title !== previous.title) {
					timeline.push({ ms: round(frame.ms), title: frame.title, rows: frame.rows, targetRows: frame.targetRows, icons: frame.icons });
				}
			}
			const staleFrames = frames
				.slice(0, firstRow < 0 ? frames.length : firstRow)
				.filter((frame) => frame.title === label).length;
			const inWindow = longTasks.filter((task) => task.startMs >= startedAt - 1);
			const last = frames[frames.length - 1];
			resolve({
				activeMs: round(first((frame) => frame.active === label)),
				titleMs: round(first((frame) => frame.title === label)),
				firstRowMs: firstRow < 0 ? null : round(frames[firstRow].ms),
				settledMs: round(settled),
				staleFrames,
				longTasks: inWindow.length,
				longTaskMs: round(inWindow.reduce((sum, task) => sum + task.durationMs, 0)),
				maxLongTaskMs: round(inWindow.reduce((max, task) => Math.max(max, task.durationMs), 0)),
				finalRows: last.rows,
				finalTargetRows: last.targetRows,
				finalIcons: last.icons,
				timeline,
			});
		};
		requestAnimationFrame(tick);
	});
}

/** One warm re-read of `target` through the same bridge calls a tab switch makes. */
function ipcCost({ target }) {
	const fs = globalThis.autorag?.fs;
	if (fs === undefined) return { error: "window.autorag.fs is unavailable" };
	const round = (value) => Math.round(value * 10) / 10;
	return (async () => {
		let startedAt = performance.now();
		const listing = await fs.listDir(target);
		const listMs = round(performance.now() - startedAt);
		const files = listing.entries.filter((entry) => entry.kind === "file" && typeof entry.modifiedAt === "string");
		const targets = files.map((entry) => ({
			path: entry.path,
			kind: entry.kind,
			ext: entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "",
			modifiedAt: entry.modifiedAt,
		}));
		startedAt = performance.now();
		await fs.enrichEntries(targets, true);
		const enrichMs = round(performance.now() - startedAt);
		startedAt = performance.now();
		await fs.indexStatus(files.map((entry) => entry.path));
		const indexStatusMs = round(performance.now() - startedAt);
		return { entries: listing.entries.length, files: files.length, listMs, enrichMs, indexStatusMs };
	})();
}

/* --------------------------------------------------------- orchestration */

function summarize(samples, key) {
	const values = samples.map((sample) => sample[key]).filter((value) => typeof value === "number").sort((a, b) => a - b);
	if (values.length === 0) return null;
	const pick = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return { n: values.length, min: values[0], p50: pick(0.5), p90: pick(0.9), max: values[values.length - 1], mean: Math.round(mean * 10) / 10 };
}

const userDataDir = join(tmpdir(), `autorag-finder-tabs-userdata-${stamp}`);
const labels = dirs.map((dir) => basename(dir));
const switches = [];
const ipc = [];
let runError = null;
let app = null;

try {
	if (flags.seedUserData !== undefined) {
		for (const name of ["dupey-cache", "settings"]) {
			const from = join(flags.seedUserData, name);
			if (existsSync(from)) await cp(from, join(userDataDir, name), { recursive: true });
		}
	}
	app = await launchFinder({ repoRoot, userDataDir, qaRoot: "", rendererUrl: flags.rendererUrl });
	const finder = await finderWindow(app);
	await finder.waitForSelector(".list", { timeout: 60000 });
	if (flags.view !== undefined) {
		const label = { icons: "Icons", list: "List", columns: "Columns" }[flags.view];
		await finder.getByRole("group", { name: "View" }).getByRole("button", { name: label, exact: true }).click();
	}

	// Tab 1 → first folder; tab 2 (⌘T clone) → second folder.
	await markAndAct(finder, () => clickSidebar(finder, labels[0]));
	await waitForFolder(finder, { target: dirs[0], label: labels[0] });
	await finder.locator(".tabs__new").click();
	await finder.waitForFunction(() => document.querySelectorAll(".tab .tab__title").length === 2);
	await markAndAct(finder, () => clickSidebar(finder, labels[1]));
	await waitForFolder(finder, { target: dirs[1], label: labels[1] });
	// Let the first listings enrich (icons, OS kinds, index state) and the
	// version-family snapshot load before timing.
	await finder.waitForTimeout(3000);

	for (let round = 0; round < flags.rounds; round += 1) {
		for (const index of [0, 1]) {
			const sample = await finder.evaluate(switchAndSample, {
				index,
				target: dirs[index],
				label: labels[index],
				windowMs: flags.windowMs,
			});
			switches.push({ round, to: labels[index], ...sample });
		}
	}
	for (const dir of dirs) {
		ipc.push({ dir: basename(dir), ...(await finder.evaluate(ipcCost, { target: dir })) });
	}
} catch (error) {
	runError = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
	if (app !== null) await app.close();
	await rm(userDataDir, { recursive: true, force: true });
}

const keys = ["activeMs", "titleMs", "firstRowMs", "settledMs", "staleFrames", "longTaskMs", "maxLongTaskMs"];
const summary = Object.fromEntries(
	labels.map((label) => {
		const samples = switches.filter((sample) => sample.to === label);
		return [label, Object.fromEntries(keys.map((key) => [key, summarize(samples, key)]))];
	}),
);
const evidence = {
	benchmark: "finder-tab-switch",
	date: new Date().toISOString(),
	platform: process.platform,
	appRoot: repoRoot,
	rendererUrl: flags.rendererUrl ?? null,
	seededUserData: flags.seedUserData !== undefined,
	view: flags.view ?? "default",
	dirs,
	rounds: flags.rounds,
	windowMs: flags.windowMs,
	runError,
	summary,
	ipc,
	switches,
};

const outputPath = flags.output ?? join(repoRoot, ".omo", "evidence", "finder-tab-switch", `${stamp}.json`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ output: outputPath, runError, summary, ipc }, null, 2));
if (runError !== null) {
	console.error(runError);
	process.exitCode = 1;
}
