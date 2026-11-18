import { homedir } from "node:os";
/**
 * Manual QA — path bar fitting (folders fold into a "…" dropdown, Windows Explorer style).
 *
 * Drives the real production build (out/) at device scale factor 2 against a
 * fixture folder in the real HOME, so the trail mirrors the reference:
 *
 *   Macintosh HD › Users › <you> › Documents › ulw-pathbar-qa › quicklook-preview-reference
 *
 * The main window is resized programmatically (its minimum size lowered for the
 * run) through every width from "every folder" down to "… and the current folder", at
 * several window heights. At each size it checks, from the live DOM:
 *   - the bar is one line: one line box per label, every segment on one row,
 *     nothing taller than the bar;
 *   - no text ellipsis anywhere ("…" is an icon button, never truncated text);
 *   - the trail fits the bar unless even "…" and the narrowest last label do not;
 *   - folders fold in order (middle segments, root, parent) and the folded ones
 *     sit behind exactly one "…"; the last segment never folds, only clips with a fade;
 *   - every shown label is whole, except a clipped last label;
 *   - the fit is minimal: unfolding the last folded folder would not fit;
 *   - the fit does not depend on the window height;
 *   - "…" opens a dropdown that lists the folded folders in path order.
 * It then screenshots each distinct state at every height for visual review.
 * Evidence goes to .omo/evidence/ai-finder-app/qa-path-bar/.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-path-bar.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldOrder, trailWidth } from "../../src/renderer/src/state/path-fit.ts";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { isWindows, rmRetry } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-path-bar");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const fixtureName = "ulw-pathbar-qa";
const leafName = "quicklook-preview-reference";
const fileName = "preview-notes.md";
const fixture = join(homedir(), "Documents", fixtureName);
rmSync(fixture, { recursive: true, force: true });
await Bun.write(join(fixture, leafName, fileName), "path bar qa\n");
const userDataDir = mkdtempSync(join(tmpdir(), "ulw-pathbar-data-"));

const HEIGHTS = [640, 820, 1100];
const WIDEST = 1520;
const NARROWEST = 760;
const STEP = 4;

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	if (!pass) console.log(`FAIL  ${label} ${detail}`);
};

/** Live DOM facts about the path bar. */
const probe = (page) =>
	page.evaluate(() => {
		const nav = document.querySelector("nav.pathbar");
		const trail = nav.querySelector(".path-trail");
		const viewport = trail.parentElement;
		const measure = nav.querySelector(".path-measure");
		const lineCount = (element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
		};
		const segments = [...trail.querySelectorAll(".path-seg")].map((button) => {
			const slot = button.querySelector(".path-label");
			const name = slot.querySelector(".path-name");
			const style = getComputedStyle(slot);
			return {
				label: name.textContent,
				fit: slot.dataset.fit,
				slot: slot.getBoundingClientRect().width,
				name: name.getBoundingClientRect().width,
				top: Math.round(button.getBoundingClientRect().top),
				lines: lineCount(name),
				mask: style.maskImage,
			};
		});
		const gap = Number.parseFloat(getComputedStyle(measure).columnGap) || 0;
		const ellipsis = [...nav.querySelectorAll("*")].some((element) => getComputedStyle(element).textOverflow === "ellipsis");
		return {
			dpr: window.devicePixelRatio,
			bar: { height: nav.clientHeight, scrollHeight: nav.scrollHeight },
			viewport: viewport.getBoundingClientRect().width,
			trail: { width: trail.getBoundingClientRect().width, height: trail.getBoundingClientRect().height },
			overflow: getComputedStyle(viewport).justifyContent === "flex-end",
			ellipsis,
			text: nav.innerText,
			more: trail.querySelectorAll("[data-path-more]").length,
			segments,
			all: [...measure.querySelectorAll("[data-measure-segment]")].map((button) => ({ label: button.textContent, width: button.getBoundingClientRect().width })),
			layout: {
				separator: measure.querySelector("[data-measure-separator]").getBoundingClientRect().width + gap,
				gap,
				more: measure.querySelector("[data-measure-more]").getBoundingClientRect().width,
			},
		};
	});

/** Indices of the trail's segments that are not on the bar. */
const hiddenOf = (state) => {
	const shown = state.segments.map((segment) => segment.label);
	const hidden = [];
	let at = 0;
	state.all.forEach((segment, index) => {
		if (shown[at] === segment.label) at += 1;
		else hidden.push(index);
	});
	return hidden;
};

const verify = (where, state) => {
	const { segments } = state;
	const hidden = hiddenOf(state);
	check(`${where}: bar content is not taller than the bar`, state.bar.scrollHeight <= state.bar.height, JSON.stringify(state.bar));
	check(`${where}: every label is one line`, segments.every((segment) => segment.lines === 1), JSON.stringify(segments.map((s) => s.lines)));
	check(`${where}: every segment sits on one row`, new Set(segments.map((segment) => segment.top)).size === 1);
	check(`${where}: trail is a single 20px row`, state.trail.height <= 20.5, String(state.trail.height));
	check(`${where}: no text ellipsis`, !state.ellipsis && !state.text.includes("…") && !state.text.includes("..."), state.text);
	check(
		`${where}: trail fits the bar unless even the dots and the last label overflow`,
		state.overflow || state.trail.width <= state.viewport + 0.5,
		`trail=${state.trail.width} viewport=${state.viewport} overflow=${state.overflow}`,
	);
	check(`${where}: one dots button exactly when folders are folded`, state.more === (hidden.length > 0 ? 1 : 0), `more=${state.more} hidden=${hidden}`);
	const order = foldOrder(state.all.length);
	check(
		`${where}: folders fold in order (middle, root, parent)`,
		JSON.stringify(hidden) === JSON.stringify(order.slice(0, hidden.length).sort((a, b) => a - b)),
		`hidden=${hidden} order=${order}`,
	);
	check(`${where}: the last segment never folds`, segments.at(-1)?.label === state.all.at(-1)?.label, segments.at(-1)?.label ?? "");
	segments.forEach((segment, index) => {
		const last = index === segments.length - 1;
		if (segment.fit === "full") check(`${where}: ${segment.label} shows its whole label`, Math.abs(segment.slot - segment.name) < 0.5 && segment.mask === "none");
		if (segment.fit === "clip") {
			check(`${where}: only the last label clips, once nothing else can fold`, last && hidden.length === order.length, segment.label);
			check(`${where}: ${segment.label} clip fades its trailing edge`, String(segment.mask).includes("linear-gradient(to right"), String(segment.mask));
		}
	});
	if (hidden.length > 0 && !segments.some((segment) => segment.fit === "clip")) {
		// Folding the last folded folder was necessary: unfolding it would not fit.
		const unfolded = new Set(order.slice(0, hidden.length - 1));
		const wider = trailWidth({ segments: state.all.map((segment) => segment.width), ...state.layout }, unfolded);
		check(`${where}: folding ${state.all[order[hidden.length - 1]].label} was necessary`, wider > state.viewport, `unfolded=${wider} viewport=${state.viewport}`);
	}
};

const signature = (state) => `hidden:${hiddenOf(state).join(",")}${state.segments.map((segment) => (segment.fit === "clip" ? ` clip:${Math.round(segment.slot)}` : "")).join("")}`;
const stateClass = (state) => `hidden:${hiddenOf(state).length}${state.segments.some((segment) => segment.fit === "clip") ? " clip" : ""}${state.overflow ? " overflow" : ""}`;

let app;
try {
	app = await launchFinder({ userDataDir, args: ["--force-device-scale-factor=2"] });
	const page = await finderWindow(app, 30000);
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.addStyleTag({ content: "* { -webkit-font-smoothing: antialiased !important; }" });

	const resize = async (width, height) => {
		await app.evaluate(
			({ BrowserWindow }, [w, h]) => {
				const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html"));
				window.setMinimumSize(600, 500);
				window.setSize(w, h);
			},
			[width, height],
		);
		await page.waitForFunction(([w]) => Math.abs(window.innerWidth - w) <= 1, [width], { timeout: 5000 });
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	};

	await resize(WIDEST, 900);
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	for (const name of [fixtureName, leafName]) {
		const row = page.locator('[role="row"]').filter({ hasText: name }).first();
		await row.waitFor({ timeout: 30000 });
		await row.dblclick();
		await page.waitForFunction((title) => document.querySelector(".toolbar-title")?.textContent === title, name);
	}
	await page.locator('[role="row"]').filter({ hasText: fileName }).waitFor();
	await page.mouse.move(2, 2);
	await new Promise((resolve) => setTimeout(resolve, 700));

	const first = await probe(page);
	check("device scale factor is 2", first.dpr === 2, String(first.dpr));
// The app renders the real home path's segments; `%USERNAME%`/`$USER` and the
// profile folder can differ (truncated Microsoft-account profiles, renamed
// accounts, non-C: profiles), so derive the expectation from `homedir()`.
const homeSegments = homedir().split(/[\\/]+/).filter(Boolean);
const deviceLabel = isWindows ? homeSegments[0] : "Macintosh HD";
const expectedTrail = [deviceLabel, ...homeSegments.slice(isWindows ? 1 : 0), "Documents", fixtureName, leafName];
check(
	"trail mirrors the reference path",
	JSON.stringify(first.all.map((segment) => segment.label)) === JSON.stringify(expectedTrail),
	JSON.stringify(first.all.map((segment) => segment.label)),
);

	// Sweep every width at every height; remember one width per distinct state.
	const sweeps = {};
	const representatives = new Map();
	for (const height of HEIGHTS) {
		sweeps[height] = [];
		for (let width = WIDEST; width >= NARROWEST; width -= STEP) {
			await resize(width, height);
			const state = await probe(page);
			verify(`${width}x${height}`, state);
			sweeps[height].push({ width, viewport: state.viewport, trail: state.trail.width, overflow: state.overflow, fits: signature(state) });
			const key = stateClass(state);
			if (height === HEIGHTS[0]) representatives.set(key, [...(representatives.get(key) ?? []), width]);
		}
	}
	for (const height of HEIGHTS.slice(1)) {
		const drift = sweeps[height].filter((row, index) => row.fits !== sweeps[HEIGHTS[0]][index].fits);
		check(`fit at ${height}px tall matches ${HEIGHTS[0]}px tall at every width`, drift.length === 0, JSON.stringify(drift.slice(0, 3)));
	}
	console.log(`distinct states: ${representatives.size}`);

	// Screenshot each state in the middle of its width range, at every height.
	const shots = [];
	let ordinal = 0;
	for (const [key, widths] of representatives) {
		ordinal += 1;
		const width = widths[Math.floor(widths.length / 2)];
		for (const height of HEIGHTS) {
			await resize(width, height);
			const state = await probe(page);
			const name = `${String(ordinal).padStart(2, "0")}-w${width}-h${height}`;
			await page.locator("nav.pathbar").screenshot({ path: join(EVIDENCE, `${name}-bar.png`) });
			if (height === 820) await page.screenshot({ path: join(EVIDENCE, `${name}-window.png`) });
			shots.push({ name, key, width, height, fits: signature(state), labels: state.segments.map((segment) => segment.label) });
		}
	}

	// The dots button lists the folded folders in path order, and Escape closes it.
	{
		await resize(NARROWEST, 820);
		const state = await probe(page);
		const hidden = hiddenOf(state).map((index) => state.all[index].label);
		check("the narrowest width folds at least one folder", hidden.length > 0, String(hidden.length));
		if (hidden.length > 0) {
			await page.locator("nav.pathbar .path-trail [data-path-more]").click();
			const items = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
			check("the dropdown lists the folded folders in path order", JSON.stringify(items) === JSON.stringify(hidden), JSON.stringify(items));
			check("opening the dropdown does not open the path editor", (await page.locator("nav.pathbar input").count()) === 0);
			await page.screenshot({ path: join(EVIDENCE, "dropdown-window.png") });
			await page.keyboard.press("Escape");
			check("Escape closes the dropdown", (await page.locator('[role="menu"]').count()) === 0);
		}
		await resize(WIDEST, 900);
	}

	// A selected file joins the trail as its last segment and fits the same way,
	// at every height.
	await resize(1180, 820);
	await page.locator('[role="row"]').filter({ hasText: fileName }).first().click();
	await page.mouse.move(2, 2);
	await page.waitForFunction((name) => [...document.querySelectorAll(".pathbar .path-name")].at(-1)?.textContent === name, fileName);
	for (const width of [1520, 1180, 1100, 1000, 900]) {
		const fits = new Set();
		for (const height of HEIGHTS) {
			await resize(width, height);
			const state = await probe(page);
			verify(`file selected ${width}x${height}`, state);
			fits.add(signature(state));
			const name = `file-w${width}-h${height}`;
			await page.locator("nav.pathbar").screenshot({ path: join(EVIDENCE, `${name}-bar.png`) });
			shots.push({ name, key: stateClass(state), width, height, fits: signature(state), labels: state.segments.map((segment) => segment.label) });
		}
		check(`file selected at ${width}px wide: fit matches at every height`, fits.size === 1, [...fits].join(" | "));
	}

	await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify({ platform: process.platform, shots, sweeps, checks: results }, null, 2));
	for (const shot of shots) console.log(`${shot.name}: ${shot.fits}`);
} finally {
	if (app !== undefined) await app.close();
	// Electron can hold userData briefly after close on Windows (EBUSY).
	rmRetry(fixture);
	rmRetry(userDataDir);
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
