/**
 * Manual QA — visual parity harness.
 *
 * Boots the built app (out/) on a deterministic fixture tree in a throwaway
 * HOME and writes a fixed set of screenshots to the directory given as
 * argv[2]. Run it before and after a styling change, then compare the two
 * directories to prove the rendered design did not move:
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-visual-parity.mjs /tmp/parity/before
 *   # ...change styles...
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-visual-parity.mjs /tmp/parity/after
 *   bun scripts/manual-qa/compare-visual-parity.mjs /tmp/parity/before /tmp/parity/after
 *
 * Determinism notes:
 * - The fixture folder name is fixed (no timestamp), so paths and counts match
 *   across runs.
 * - The v7 path bar carries no trailing text, so no chrome element needs
 *   hiding before screenshots.
 * - Shots are taken after a settle delay so entry animations reach their end
 *   state.
 */

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { launchFinder, openAiSearch } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const outDir = process.argv[2];
if (outDir === undefined) {
	console.error("usage: bun scripts/manual-qa/run-qa-finder-visual-parity.mjs <outDir>");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Injected before every screenshot so two runs of the same build render
 * bit-identically:
 * - the dev label carries `branch@commit` and would differ between builds;
 * - subpixel (LCD) text antialiasing is not rasterised bit-identically across
 *   renderer processes, so grayscale antialiasing is forced instead.
 */
const DETERMINISM_STYLE = ["* { -webkit-font-smoothing: antialiased !important; }"].join("\n");

// ---------------------------------------------------------------- fixture

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function solidPng(size, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y += 1) {
		const offset = y * (1 + size * 3);
		for (let x = 0; x < size; x += 1) raw.set([r, g, b], offset + 1 + x * 3);
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// A fixed HOME, not mkdtemp: the Models tab surfaces a model-status error that
// embeds the HOME path, so a random one would differ on every run.
const home = join(tmpdir(), "ulw-parity-home");
mkdirSync(home, { recursive: true });

/** Every fixture file gets this mtime so the Modified column is stable. */
const FIXTURE_MTIME = new Date("2026-01-02T09:05:00Z");
const userDataDir = mkdtempSync(join(tmpdir(), "ulw-parity-data-"));

/**
 * A seeded chat makes the AI answer, citation and Evidence surfaces reachable
 * without a model: loading it drives the real `loadHistory -> publish ->
 * EvidencePanel` path (the same deterministic lane as
 * `run-qa-finder-evidence-panel.mjs`). Without it, `shell.css`'s `.ai*` and
 * `.evidence*` rules could not be screenshot-verified at all.
 */
const seedChatHistory = (documents) => {
	const source = (name) => join(documents, "ulw-parity", name);
	const evidence = [
		{
			number: 1,
			title: "notes.md",
			summary: "발췌 요약입니다.",
			source: source("notes.md"),
			excerpts: ["## 승인 규칙\n1. 일반 환불은 5영업일 내 처리합니다.\n2. 예외는 **임원 승인**이 필요합니다.\n> 인용: 긴급 예외도 승인 생략 불가\n```\nif (!director) reject()\n```"],
			confidence: 0.92,
		},
		{
			number: 2,
			title: "alpha-1.md",
			summary: "두 번째 근거입니다.",
			source: source("alpha/alpha-1.md"),
			excerpts: ["승인 체인 원본 첨부 필수."],
			confidence: 0.81,
		},
	];
	const at = "2026-01-02T09:05:00.000Z";
	const record = {
		id: "c-parity-1",
		title: "환불 예외 승인 규칙",
		snippet: "최종 승인액은 ₩3.8억이며, 승인 체인 첨부가 필요합니다.",
		updatedAt: at,
		messages: [
			{ role: "user", text: "환불 예외 승인 규칙 요약해줘", attachments: [], at },
			{
				role: "assistant",
				sessionId: "parity-session",
				quick: {
					answer: "최종 승인액은 **₩3.8억**이며, 승인 체인 첨부가 필요합니다. [1][2]",
					evidence: evidence.slice(0, 2),
					meta: "0.4s · 2 sources",
				},
				deep: {
					answer:
						"## 승인 규칙 요약\n환불 예외는 지급 전 **임원 승인**이 필요합니다. [1][2]\n\n- 예외는 자동 반려되지 않습니다 [2]\n- 긴급 예외도 승인 생략 불가 [1]\n\n> 내규 인용 구문이 함께 표시됩니다.\n\n관련 명령은 `bun run qa` 입니다.",
					evidence,
					meta: "3 sources read · 2s",
				},
				stopped: false,
				at,
			},
		],
	};
	mkdirSync(join(userDataDir, "chat-history"), { recursive: true });
	writeFileSync(join(userDataDir, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);
};
const documents = join(home, "Documents");
const topName = "ulw-parity";
const top = join(documents, topName);

const tree = {
	[top]: ["alpha/", "budget.csv", "notes.md", "red.png"],
	[`${top}/alpha`]: ["beta/", "alpha-1.md", "alpha-2.md"],
	[`${top}/alpha/beta`]: ["gamma/", "beta-1.md"],
	[`${top}/alpha/beta/gamma`]: ["delta.txt"],
};

const createdDirs = new Set();
for (const [dir, items] of Object.entries(tree)) {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		createdDirs.add(dir);
	}
	for (const item of items) {
		if (item.endsWith("/")) continue;
		const file = join(dir, item);
		if (existsSync(file)) continue;
		if (item === "red.png") writeFileSync(file, solidPng(256, [220, 40, 40]));
		else writeFileSync(file, `fixture ${item}\n`);
		// Keep creation/change metadata stable after the first fixture initialization.
		utimesSync(file, FIXTURE_MTIME, FIXTURE_MTIME);
	}
}

for (const dir of createdDirs) utimesSync(dir, FIXTURE_MTIME, FIXTURE_MTIME);


seedChatHistory(documents);

// ---------------------------------------------------------------- capture

const shots = [];
const shot = async (page, name, target) => {
	const path = join(outDir, `${name}.png`);
	await (target === undefined ? page : page.locator(target)).screenshot({ path });
	shots.push(name);
	console.log(`  ${name}.png`);
};

/**
 * The app pre-warms the Quick Look window at startup, so `firstWindow()` is a
 * race between the Finder and the preview. Pick the Finder by URL instead.
 */
const finderWindow = async (application) => {
	const isFinder = (candidate) => candidate.url().includes("index.html");
	const existing = application.windows().find(isFinder);
	if (existing !== undefined) return existing;
	return application.waitForEvent("window", { predicate: isFinder, timeout: 60000 });
};

let app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
let page;
try {
	page = await finderWindow(app);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	// Mask the dev label and non-deterministic text AA before any screenshot.
	await page.addStyleTag({ content: DETERMINISM_STYLE });

	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();

	const row = page.locator('[role="row"]').filter({ hasText: topName }).first();
	await row.waitFor({ timeout: 30000 });
	await row.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, topName);
	await page.locator('[role="row"]').filter({ hasText: "notes.md" }).waitFor();
	await sleep(600);

	// Park the pointer before any shot. Cursor hover is real state: the double
	// click that opened the folder leaves the pointer over what is now row 1, so
	// without this the first rows carry a hover wash that depends on the click
	// history rather than on the styling.
	await page.mouse.move(2, 2);
	// Rows fade their background over `--dur-flash-fade` (600ms); a shorter wait
	// would capture them mid-transition, which is non-deterministic run to run.
	await sleep(700);

	console.log("list view");
	await shot(page, "01-list");
	await shot(page, "02-toolbar", ".toolbar");
	await shot(page, "03-sidebar", ".sidebar");
	await shot(page, "04-path-bar", "nav.pathbar");
	await shot(page, "05-tab-strip", ".tabs");

	console.log("context menu");
	await page.locator('[role="row"]').filter({ hasText: "notes.md" }).first().click({ button: "right" });
	await page.waitForSelector('[role="menuitem"]');
	await sleep(700);
	await shot(page, "06-context-menu");
	await shot(page, "07-context-menu-element", ".menu");
	await page.keyboard.press("Escape");
	await page.waitForSelector('[role="menuitem"]', { state: "detached" });

	console.log("icon view");
	await page.keyboard.press(chord("1"));
	await page.waitForSelector(".icon-grid");
	await sleep(600);
	await shot(page, "08-icons");
	await shot(page, "09-icon-tiles", ".icon-grid");

	console.log("column view");
	await page.keyboard.press(chord("3"));
	await page.waitForSelector(".column");
	await sleep(600);
	await shot(page, "10-columns");

	console.log("settings");
	await page.keyboard.press(chord("2"));
	await page.waitForSelector('[role="row"]');
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	await page.waitForSelector(".settings-panel");
	await sleep(600);
	await shot(page, "11-settings-general");
	await shot(page, "12-settings-panel", ".settings-panel");
	await shot(page, "13-settings-section", ".settings-page-head");
	await shot(page, "14-settings-switch-row", ".linear-row:has([role=\"switch\"]) >> nth=0");
	for (const [tab, name] of [
		["AI 모델", "15-settings-models"],
		["모든 연결", "16-settings-sources"],
	]) {
		await page.locator(".settings-nav-item", { hasText: tab }).click();
		await sleep(600);
		await shot(page, name);
	}
	await page.locator(".settings-nav-item", { hasText: "일반" }).click();
	await sleep(400);
	// Settings lives in its own tab in v7; ⌘W closes it back to the finder tab.
	await page.keyboard.press(chord("w"));
	await page.waitForSelector(".settings-panel", { state: "detached" });

	// Interaction states. Static shots cannot see a :hover, :focus, or
	// selection regression, and those are exactly what a utility migration
	// breaks first.
	// The app is relaunched first. The sections above leave a selection and a
	// focus zone behind, and a hover shot taken on a selected row paints a
	// different background, which would read as a styling regression when it is
	// only leftover state.
	console.log("interaction states (relaunched)");
	await app.close();
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	page = await finderWindow(app);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });
	await page.addStyleTag({ content: DETERMINISM_STYLE });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const reopened = page.locator('[role="row"]').filter({ hasText: topName }).first();
	await reopened.waitFor({ timeout: 30000 });
	await reopened.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, topName);
	await page.locator('[role="row"]').filter({ hasText: "notes.md" }).waitFor();
	await sleep(600);

	const selectedCount = () =>
		page.evaluate(() => document.querySelectorAll('.row[aria-selected="true"]').length);
	const notesRow = page.locator('[role="row"]').filter({ hasText: "notes.md" }).first();
	if ((await selectedCount()) !== 0) throw new Error("hover shot needs an empty selection");

	await notesRow.hover();
	await sleep(700);
	await shot(page, "17-row-hover");

	// The Back label is localized ("뒤로" in the default Korean UI); target it by its glyph.
	await page.locator(".toolbar button:has(.lucide-chevron-left)").first().hover();
	await sleep(400);
	await shot(page, "18-toolbar-icon-hover");

	await page.locator(".sidebar__item", { hasText: "Settings" }).hover();
	await sleep(400);
	await shot(page, "19-sidebar-item-hover");

	await page.locator(".sidebar-search input").click();
	await sleep(400);
	await shot(page, "20-search-focused");
	await shot(page, "21-search-focused-element", ".side-search");

	await page.mouse.move(2, 2);
	await notesRow.click();
	await sleep(700);
	if ((await selectedCount()) !== 1) throw new Error("selection shot needs exactly one selected row");
	await shot(page, "22-row-selected");

	await page.keyboard.press(chord("1"));
	await page.waitForSelector(".icon-grid");
	await sleep(400);
	const notesTile = page.locator('.icon-tile[aria-label="notes.md"]');
	await notesTile.hover();
	await sleep(700);
	await shot(page, "23-tile-hover");
	await notesTile.click();
	await sleep(700);
	await shot(page, "24-tile-selected");
	await page.keyboard.press(chord("2"));
	await page.waitForSelector('[role="row"]');
	await sleep(400);

	// The remaining hover targets. Each one has a hover rule whose specificity
	// against a neighbouring state class decides the result, which is exactly the
	// kind of thing a utility migration gets wrong.
	await page.locator(".path-seg").nth(1).hover();
	await sleep(300);
	await shot(page, "25-crumb-hover", ".pathbar");

	await page.locator(".seg button").nth(1).hover();
	await sleep(300);
	await shot(page, "26-view-toggle-active-hover", ".toolbar");

	await page.locator(".col-header__sort").first().hover();
	await sleep(300);
	await shot(page, "27-column-header-hover", ".col-header");

	// A single tab has no close button, so open a second one (⌘T) first.
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
	await page.locator(".tab__close").first().hover();
	await sleep(300);
	await shot(page, "28-tab-close-hover", ".tabs");

	await page.locator(".tabs__new").hover();
	await sleep(300);
	await shot(page, "29-tabs-new-hover", ".tabs");

	// The AI answer, citation and Evidence surfaces. The seeded chat drives them
	// through the real loadHistory -> publish -> EvidencePanel path, so these
	// rules are screenshot-verified rather than merely translated. The states
	// that need a live model — thinking, skeleton, pending, streaming, progress,
	// stop — cannot be reached deterministically and stay uncovered.
	console.log("ai answers + evidence");
	await openAiSearch(page);
	await page.locator('[aria-label="Chat history"]').click();
	await page.locator(".history-item").first().waitFor({ state: "visible" });
	await sleep(400);
	await shot(page, "30-ai-history-popover");
	await shot(page, "31-ai-history-element", ".history");

	await page.locator(".history-item").first().click();
	// A restored chat renders both the Quick and the Deep prose synchronously
	// (deepElapsed is null, so the deep half is expanded rather than collapsed).
	await page.waitForSelector(".assistant-msg .assistant-prose >> nth=1", { timeout: 15000 });
	await sleep(700);
	await shot(page, "32-ai-answers");
	await shot(page, "33-ai-answer-quick", ".assistant-msg .assistant-prose >> nth=0");
	await shot(page, "34-ai-answer-deep", ".assistant-msg .assistant-prose >> nth=1");

	await page.locator(".cite", { hasText: "2" }).first().click();
	await page.waitForSelector(".evidence-tab.bg-accent", { timeout: 15000 });
	await sleep(700);
	await shot(page, "35-evidence-panel");
	await shot(page, "36-evidence-element", '.inspector-half[aria-label="Evidence"]');
	await shot(page, "37-evidence-view", '.inspector-half[aria-label="Evidence"] .inspector-body');
} catch (error) {
	// A failed capture is only diagnosable with the state it failed in.
	const failureDir = join(outDir, "failure");
	mkdirSync(failureDir, { recursive: true });
	await page?.screenshot({ path: join(failureDir, "failure.png") }).catch(() => {});
	await Bun.write(join(failureDir, "failure.html"), await page?.content().catch(() => "") ?? "");
	console.error(`capture failed — wrote ${failureDir}/failure.{png,html}`);
	throw error;
} finally {
	await app.close();
}

await Bun.write(join(outDir, "manifest.json"), `${JSON.stringify({ shots, count: shots.length }, null, 2)}\n`);
console.log(`\n${shots.length} screenshots → ${outDir}`);
