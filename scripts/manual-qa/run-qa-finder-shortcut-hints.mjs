/**
 * Manual QA — keyboard-shortcut hints follow the host platform.
 *
 * The bindings accept Command on macOS and Control elsewhere
 * (`state/keymap.ts` resolves `meta || ctrl`), so the sidebar/tab/toolbar hints
 * and `title` attributes must match. On Windows every hint must read `Ctrl…` and
 * the macOS `⌘`/`⌥` glyphs must not appear anywhere in the UI.
 *
 * Production build first: bun run build
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord, isMac, repoRoot } from "./platform.mjs";

const ROOT = repoRoot(import.meta.url);
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-shortcut-hints");
mkdirSync(EVIDENCE, { recursive: true });

const GLYPHS = ["⌘", "⌥", "⇧"];
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-shortcuts-"));
let app;
try {
	app = await launchFinder({ userDataDir });
	const page = await finderWindow(app);
	page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
	await page.waitForSelector(".sidebar-search", { timeout: 30_000 });

	const observed = await page.evaluate(() => ({
		keycapTexts: [...document.querySelectorAll(".keycap, kbd")].map((node) => (node.textContent ?? "").trim()),
		titles: [...document.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? ""),
		ariaLabels: [...document.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label") ?? ""),
		newTab: document.querySelector('[aria-label^="New tab"]')?.getAttribute("aria-label") ?? "",
		aiSearch: document.querySelector('[title^="AI Search"]')?.getAttribute("title") ?? "",
	}));

	const allText = [...observed.keycapTexts, ...observed.titles, ...observed.ariaLabels];

	check(
		isMac ? "the search hint is ⌘F" : "the search hint is Ctrl+F",
		observed.keycapTexts.includes(isMac ? "⌘F" : "Ctrl+F"),
		JSON.stringify(observed.keycapTexts),
	);
	check(
		isMac ? "the Settings hint is ⌘," : "the Settings hint is Ctrl+,",
		observed.keycapTexts.includes(isMac ? "⌘," : "Ctrl+,"),
		JSON.stringify(observed.keycapTexts),
	);
	check(
		isMac ? "the new-tab label is ⌘T" : "the new-tab label is Ctrl+T",
		observed.newTab === (isMac ? "New tab ⌘T" : "New tab Ctrl+T"),
		observed.newTab,
	);
	// A single tab has no close affordance, so open a second one first.
	await page.keyboard.press(chord("t"));
	await page.waitForSelector(".tab__close", { timeout: 10_000 });
	const closeTab = await page.evaluate(
		() => document.querySelector(".tab__close")?.getAttribute("aria-label") ?? "",
	);
	check(
		isMac ? "the close-tab label is ⌘W" : "the close-tab label is Ctrl+W",
		closeTab === (isMac ? "Close tab ⌘W" : "Close tab Ctrl+W"),
		closeTab,
	);
	allText.push(closeTab);
	check(
		isMac ? "the AI Search title is ⌘K" : "the AI Search title is Ctrl+K",
		observed.aiSearch === (isMac ? "AI Search (⌘K)" : "AI Search (Ctrl+K)"),
		observed.aiSearch,
	);
	if (!isMac) {
		const leaked = allText.filter((text) => GLYPHS.some((glyph) => text.includes(glyph)));
		check("no Command/Option glyph leaks into the Windows UI", leaked.length === 0, JSON.stringify(leaked));
	}

	await page.screenshot({ path: join(EVIDENCE, "shortcut-hints.png") });
	await app.close();
	app = undefined;
} finally {
	if (app !== undefined) await app.close().catch(() => {});
}
console.log(`shortcut-hints: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
if (failures.length > 0) process.exitCode = 1;
