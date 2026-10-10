/**
 * Manual QA — split panes (PyCharm-style tab docking).
 *
 * Drives the built app with real pointer drags and proves:
 *   1. dragging a tab over a pane previews where it lands — the edge band
 *      previews that half, the strip shows an insertion caret — and the
 *      preview follows the pointer from zone to zone;
 *   2. dropping on an edge splits the pane: the tab becomes a new pane beside
 *      (or above/below) the rest, with its own tab strip and path bar, and
 *      the new pane takes focus (accent bar on its active tab);
 *   3. panes glide into place (a size transition runs) and a new pane fades in;
 *   4. closing a pane's last tab closes the pane, the rest fill the area, and
 *      focus returns to the pane of the tab focused before — not a neighbor;
 *   5. dropping a tab on another pane's strip or body merges it there, and its
 *      emptied pane closes back to full width;
 *   6. AI Search and Settings are tabs like any other: an AI Search tab splits
 *      off beside a folder, its chat sits inside its pane, and its draft
 *      survives moving between panes; ⌘K focuses the AI tab on screen;
 *   7. an Evidence title opens the source folder as a new tab in the pane of
 *      the last focused tab, leaving the other pane alone;
 *   8. ⌘W and ⌘T act on the focused pane only;
 *   9. dragging the seam between panes resizes them.
 * No model key is needed: the answer is a seeded chat. Run `bun run build`
 * first. Evidence lands in the ignored `.omo/` tree.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-split-panes");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-split-")));
const USER_DATA = join(WORK, "user-data");
const DOCS = join(WORK, "docs");
const SOURCES = join(WORK, "sources");
mkdirSync(DOCS, { recursive: true });
mkdirSync(SOURCES, { recursive: true });
writeFileSync(join(DOCS, "brief.md"), "# brief\n");
writeFileSync(join(DOCS, "notes.txt"), "notes\n");
const POLICY = join(SOURCES, "refund-policy.md");
writeFileSync(POLICY, "## 승인 규칙\n예외는 임원 승인이 필요합니다.\n");

// A seeded chat whose evidence points at a real file, so "Show in Finder" has a folder to open.
mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
const now = new Date().toISOString();
const evidence = [
	{ number: 1, title: basename(POLICY), summary: "승인 규칙", source: POLICY, excerpts: ["예외는 임원 승인이 필요합니다."], confidence: 0.9 },
];
writeFileSync(
	join(USER_DATA, "chat-history", "chats.json"),
	`${JSON.stringify(
		[
			{
				id: "c-split-1",
				title: "환불 승인 규칙",
				snippet: "임원 승인이 필요합니다.",
				updatedAt: now,
				messages: [
					{ role: "user", text: "환불 승인 규칙?", attachments: [], at: now },
					{
						role: "assistant",
						sessionId: "qa-split-session",
						quick: { answer: "임원 승인이 필요합니다. [1]", evidence, meta: "0.4s · 1 source" },
						deep: { answer: "예외는 **임원 승인**이 필요합니다. [1]", evidence, meta: "1 source · 1s" },
						stopped: false,
						at: now,
					},
				],
			},
		],
		null,
		2,
	)}\n`,
);
mkdirSync(join(USER_DATA, "workspace"), { recursive: true });
const QA_CONFIG = join(USER_DATA, "qa-config.json");
writeFileSync(
	QA_CONFIG,
	JSON.stringify({
		searchPaths: [DOCS],
		workspacePath: join(USER_DATA, "workspace"),
		memoryPath: join(USER_DATA, "workspace", "memory.json"),
		minSync: { enabled: false },
		jikji: false,
		model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKeyEnv: "OPENROUTER_API_KEY" },
	}),
);

/* ---------------------------------------------------------------- helpers */

const panes = (page) =>
	page.$$eval("[data-workspace-pane]", (elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			const section = element.querySelector("section.finder");
			return {
				id: Number(element.dataset.workspacePane),
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(box.width),
				height: Math.round(box.height),
				focused: section?.dataset.focused === "true",
				tabs: [...element.querySelectorAll(".tabs .tab")].map((tab) => ({
					title: tab.querySelector(".tab__title")?.textContent ?? "",
					active: tab.classList.contains("tab--active"),
					focusMark: tab.classList.contains("tab--focused"),
				})),
				pathbar: element.querySelector(".pathbar") !== null,
			};
		}),
	);
const paneEl = (page, id) => page.locator(`[data-workspace-pane="${id}"]`);
const tabIn = (page, paneId, index) => paneEl(page, paneId).locator(".tabs .tab").nth(index);
/** Wait until the layout transition has settled (no pane moves for two frames). */
const settle = async (page) => {
	await page.evaluate(
		() =>
			new Promise((resolve) => {
				let last = "";
				let still = 0;
				const tick = () => {
					const now = [...document.querySelectorAll("[data-workspace-pane]")].map((element) => element.getAttribute("style")).join("|");
					still = now === last ? still + 1 : 0;
					last = now;
					if (still >= 3) resolve(undefined);
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
	);
	await sleep(350);
};
const preview = (page) =>
	page.evaluate(() => {
		const element = document.querySelector(".workspace-drop-preview");
		if (element === null) return null;
		const box = element.getBoundingClientRect();
		return { kind: element.dataset.dropKind, edge: element.dataset.dropEdge ?? null, pane: Number(element.dataset.dropPane), x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
	});

/**
 * Drag a tab like a user: press, pull it off the strip, glide over `stops`
 * (screenshotting each), and release at the last stop. Returns the preview
 * read at every stop.
 */
async function dragTab(page, tab, stops, shot) {
	const box = await tab.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 30, { steps: 5 });
	const seen = [];
	for (const [index, [x, y]] of stops.entries()) {
		await page.mouse.move(x, y, { steps: 10 });
		await sleep(260);
		seen.push(await preview(page));
		if (shot !== undefined) await page.screenshot({ path: join(EVIDENCE, `${shot}-${index}.png`) });
	}
	await page.mouse.up();
	await settle(page);
	return seen;
}
const bodyPoint = async (page, paneId, fx, fy) => {
	const box = await paneEl(page, paneId).boundingBox();
	const top = box.y + 25;
	return [box.x + box.width * fx, top + (box.height - 25) * fy];
};

/* -------------------------------------------------------------------- run */

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: { AUTORAG_CONFIG: QA_CONFIG } });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(10_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
	await page.waitForSelector(".tabs .tab", { timeout: 30_000 });
	await sleep(800);

	let state = await panes(page);
	check("starts as one full-size pane with a path bar", state.length === 1 && state[0].pathbar, JSON.stringify(state.map((pane) => pane.width)));
	const full = state[0];
	await page.screenshot({ path: join(EVIDENCE, "01-single.png") });

	// ⌘T: a second tab in the only pane.
	await page.keyboard.press(chord("t"));
	await page.waitForFunction(() => document.querySelectorAll(".tabs .tab").length === 2);

	// 1+2. Drag the tab over the body: center → right edge → bottom → strip → back to the right edge, then drop.
	const center = await bodyPoint(page, full.id, 0.5, 0.5);
	const right = await bodyPoint(page, full.id, 0.95, 0.5);
	const bottom = await bodyPoint(page, full.id, 0.5, 0.95);
	const stripBox = await tabIn(page, full.id, 0).boundingBox();
	const strip = [stripBox.x + 15, stripBox.y + stripBox.height / 2];
	const seen = await dragTab(page, tabIn(page, full.id, 1), [center, right, bottom, strip, right], "02-drag");
	check("a single-tab merge target shows no preview over its own pane body", seen[0] === null || seen[0].kind === "pane", JSON.stringify(seen[0]));
	check(
		"the right edge previews the right half",
		seen[1]?.kind === "split" && seen[1].edge === "right" && Math.abs(seen[1].x - (full.x + full.width / 2)) <= 8 && Math.abs(seen[1].width - full.width / 2) <= 10,
		JSON.stringify(seen[1]),
	);
	check("the bottom edge previews the bottom half", seen[2]?.kind === "split" && seen[2].edge === "bottom" && Math.abs(seen[2].height - full.height / 2) <= 10, JSON.stringify(seen[2]));
	check("the strip previews an insertion into the strip", seen[3]?.kind === "strip" && seen[3].height <= 30, JSON.stringify(seen[3]));
	check("the preview follows back to the right edge", seen[4]?.edge === "right", JSON.stringify(seen[4]));
	check("the preview disappears after the drop", (await preview(page)) === null);

	state = await panes(page);
	const [left, rightPane] = [...state].sort((a, b) => a.x - b.x);
	check("the drop splits the area into two side-by-side panes", state.length === 2 && left.y === rightPane.y && Math.abs(left.width - rightPane.width) <= 2, JSON.stringify(state.map(({ id, x, width }) => ({ id, x, width }))));
	check("each pane has its own tab strip and path bar", state.every((pane) => pane.tabs.length === 1 && pane.pathbar));
	check("the new pane is focused and marks its active tab", rightPane.focused && rightPane.tabs[0].focusMark && !left.focused && !left.tabs[0].focusMark);
	check("the panes tile the area with a 1px seam", left.x === full.x && left.width + rightPane.width + 1 === full.width, `${left.width}+${rightPane.width}+1 vs ${full.width}`);
	await page.screenshot({ path: join(EVIDENCE, "03-split-right.png") });

	// 3. Motion: the next structural change glides; a new pane fades in.
	await page.keyboard.press(chord("t"));
	await page.waitForFunction((id) => document.querySelectorAll(`[data-workspace-pane="${id}"] .tabs .tab`).length === 2, rightPane.id);
	const lower = await bodyPoint(page, rightPane.id, 0.5, 0.96);
	const tab = tabIn(page, rightPane.id, 1);
	const tabBox = await tab.boundingBox();
	await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(tabBox.x + tabBox.width / 2 + 12, tabBox.y + 40, { steps: 5 });
	await page.mouse.move(lower[0], lower[1], { steps: 10 });
	await sleep(260);
	const lowerPreview = await preview(page);
	await page.mouse.up();
	const motion = await page.evaluate(() => {
		const all = [...document.querySelectorAll("[data-workspace-pane]")];
		return all.map((element) => ({ transition: getComputedStyle(element).transitionProperty, animation: getComputedStyle(element).animationName }));
	});
	check("panes glide: a size transition runs during the change", motion.some((entry) => entry.transition.includes("width")), JSON.stringify(motion));
	check("the new pane fades in", motion.some((entry) => entry.animation === "paneIn"), JSON.stringify(motion));
	await page.screenshot({ path: join(EVIDENCE, "04-mid-animation.png") });
	await settle(page);
	state = await panes(page);
	const third = state.find((pane) => pane.id !== left.id && pane.id !== rightPane.id);
	const upper = state.find((pane) => pane.id === rightPane.id);
	check("the bottom edge preview targeted the right pane", lowerPreview?.edge === "bottom" && lowerPreview.pane === rightPane.id, JSON.stringify(lowerPreview));
	check(
		"a bottom drop stacks a new pane under the right pane only",
		state.length === 3 && third !== undefined && third.x === upper.x && third.y > upper.y && state.find((pane) => pane.id === left.id).height === full.height,
		JSON.stringify(state.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))),
	);
	await page.screenshot({ path: join(EVIDENCE, "05-three-panes.png") });

	// 4. Focus memory: focus left, then the new bottom pane; closing its last tab returns to left, not the neighbor above.
	await paneEl(page, left.id).locator(".pathbar").click();
	await paneEl(page, third.id).locator(".pathbar").click();
	state = await panes(page);
	check("clicking a pane focuses it", state.find((pane) => pane.id === third.id).focused);
	await page.keyboard.press(chord("w"));
	await settle(page);
	state = await panes(page);
	check("⌘W on a pane's last tab closes the pane", state.length === 2 && !state.some((pane) => pane.id === third.id));
	check("focus returns to the pane focused before, not the neighbor", state.find((pane) => pane.id === left.id).focused, JSON.stringify(state.map(({ id, focused }) => ({ id, focused }))));
	check("the remaining pane fills the closed pane's space", state.find((pane) => pane.id === rightPane.id).height === full.height);

	// 8. ⌘T acts on the focused pane only.
	await page.keyboard.press(chord("t"));
	await sleep(300);
	state = await panes(page);
	check("⌘T opens the tab in the focused pane", state.find((pane) => pane.id === left.id).tabs.length === 2 && state.find((pane) => pane.id === rightPane.id).tabs.length === 1);

	// 5a. Merge by strip: the right pane's only tab onto the left strip → full width again.
	const leftStrip = await tabIn(page, left.id, 0).boundingBox();
	await dragTab(page, tabIn(page, rightPane.id, 0), [[leftStrip.x + 10, leftStrip.y + leftStrip.height / 2]], "06-merge-strip");
	state = await panes(page);
	check("dropping a pane's last tab on another strip merges and closes the empty pane", state.length === 1 && state[0].width === full.width && state[0].tabs.length === 3, JSON.stringify(state.map((pane) => pane.tabs.length)));
	check("the merged tab lands at the caret and is active", state[0].tabs[0].active, JSON.stringify(state[0].tabs));

	// 5b. Split again, then merge by dropping on the other pane's body center.
	await dragTab(page, tabIn(page, left.id, 2), [await bodyPoint(page, left.id, 0.04, 0.5)]);
	state = await panes(page);
	const splitLeft = [...state].sort((a, b) => a.x - b.x)[0];
	check("a left-edge drop puts the new pane on the left", state.length === 2 && splitLeft.id !== left.id && splitLeft.focused);
	await dragTab(page, tabIn(page, splitLeft.id, 0), [await bodyPoint(page, left.id, 0.5, 0.5)], "07-merge-center");
	state = await panes(page);
	check("dropping on a pane body's middle merges into that pane", state.length === 1 && state[0].tabs.length === 3);

	// 6. AI Search as a tab: show it in a tab, split it off to the right, type a draft, move it back.
	await page.locator(".sidebar__item", { hasText: "AI Search" }).click();
	await page.waitForSelector(`${AI_PANEL} input[aria-label="Ask AutoRAG"]`);
	const aiTabIndex = (await panes(page))[0].tabs.findIndex((entry) => entry.active);
	await dragTab(page, tabIn(page, left.id, aiTabIndex), [await bodyPoint(page, left.id, 0.96, 0.5)], "08-ai-drag");
	state = await panes(page);
	const aiPane = state.find((pane) => pane.tabs.some((entry) => entry.title === "AI Search"));
	const folderPane = state.find((pane) => pane !== aiPane);
	const aiBox = await page.locator(AI_PANEL).boundingBox();
	check(
		"the AI Search chat sits inside its own pane, under its strip",
		aiPane !== undefined && Math.abs(aiBox.x - aiPane.x) <= 1 && Math.abs(aiBox.width - aiPane.width) <= 1 && aiBox.y >= aiPane.y + 24,
		JSON.stringify({ aiBox, aiPane: aiPane && { x: aiPane.x, y: aiPane.y, width: aiPane.width } }),
	);
	check("the folder pane stays on screen beside the chat", folderPane !== undefined && folderPane.pathbar);
	await page.locator(`${AI_PANEL} input[aria-label="Ask AutoRAG"]`).fill("draft survives moving");
	await page.screenshot({ path: join(EVIDENCE, "09-ai-split.png") });
	// ⌘K from the folder pane focuses the AI tab already on screen instead of opening another.
	await paneEl(page, folderPane.id).locator(".pathbar").click();
	await page.keyboard.press(chord("k"));
	await sleep(300);
	state = await panes(page);
	check("⌘K focuses the AI Search tab on screen in the other pane", state.find((pane) => pane.id === aiPane.id).focused && state.flatMap((pane) => pane.tabs).filter((entry) => entry.title === "AI Search").length === 1);

	// 7. Evidence → new tab in the last focused tab's pane (the AI pane), folder pane untouched.
	await page.locator('[aria-label="Chat history"]').click();
	await page.locator(".history-item").first().click();
	await page.waitForSelector('.inspector-half[aria-label="Evidence"] .evidence-tab');
	const before = await panes(page);
	await page.locator('.inspector-half[aria-label="Evidence"] button[title="Show in Finder"]').click();
	await page.waitForFunction(
		([id, count]) => document.querySelectorAll(`[data-workspace-pane="${id}"] .tabs .tab`).length === count + 1,
		[aiPane.id, before.find((pane) => pane.id === aiPane.id).tabs.length],
		{ timeout: 15_000 },
	);
	state = await panes(page);
	const revealed = state.find((pane) => pane.id === aiPane.id);
	check("an evidence title opens the source folder in the last focused tab's pane", revealed.tabs.find((entry) => entry.active)?.title === basename(SOURCES), JSON.stringify(revealed.tabs));
	check("the other pane is left alone", JSON.stringify(state.find((pane) => pane.id === folderPane.id).tabs) === JSON.stringify(before.find((pane) => pane.id === folderPane.id).tabs));
	await page.waitForFunction((name) => [...document.querySelectorAll('[role="row"][aria-selected="true"]')].some((row) => row.textContent?.includes(name)), basename(POLICY), { timeout: 10_000 });
	check("the source file is selected in the revealed tab", true);
	await page.screenshot({ path: join(EVIDENCE, "10-evidence-reveal.png") });

	// The AI tab's chat survives moving into the folder pane's strip.
	const aiIndex = revealed.tabs.findIndex((entry) => entry.title === "AI Search");
	const folderStrip = await tabIn(page, folderPane.id, 0).boundingBox();
	await dragTab(page, tabIn(page, aiPane.id, aiIndex), [[folderStrip.x + folderStrip.width - 10, folderStrip.y + folderStrip.height / 2]]);
	const draft = await page.locator(`${AI_PANEL} input[aria-label="Ask AutoRAG"]`).inputValue();
	check("the AI tab's chat (draft) survives moving to another pane", draft === "draft survives moving", draft);

	// 6b. Settings is a tab too: ⌘, opens it in the focused pane and it splits off like any tab.
	// From the pane showing the revealed folder (a click there leaves the composer), ⌘, opens Settings in that pane.
	await paneEl(page, aiPane.id).locator(".pathbar").click();
	await page.keyboard.press(chord(","));
	await page.waitForFunction(() => [...document.querySelectorAll(".tabs .tab--active .tab__title")].some((title) => title.textContent === "Settings"));
	state = await panes(page);
	const settingsPane = state.find((pane) => pane.tabs.some((entry) => entry.title === "Settings" && entry.active));
	const settingsIndex = settingsPane.tabs.findIndex((entry) => entry.title === "Settings");
	await dragTab(page, tabIn(page, settingsPane.id, settingsIndex), [await bodyPoint(page, settingsPane.id, 0.5, 0.04)]);
	state = await panes(page);
	const settingsTop = state.find((pane) => pane.tabs.length === 1 && pane.tabs[0].title === "Settings");
	check("a Settings tab splits off to the top like any tab", settingsTop !== undefined && state.some((pane) => pane.y > settingsTop.y && pane.x === settingsTop.x));
	await page.screenshot({ path: join(EVIDENCE, "11-settings-top.png") });

	// 9. Drag the seam right of the leftmost pane 120px to the right.
	const leftBefore = [...(await panes(page))].sort((a, b) => a.x - b.x)[0];
	const seams = page.locator('[role="separator"][aria-label="Resize panes"][aria-orientation="vertical"]');
	let seamBox = null;
	for (let index = 0; index < (await seams.count()); index += 1) {
		const box = await seams.nth(index).boundingBox();
		if (Math.abs(box.x + 3 - (leftBefore.x + leftBefore.width)) <= 3) seamBox = box;
	}
	check("the leftmost pane has a vertical seam beside it", seamBox !== null);
	// At a T-junction the seam that runs through must win over the nested seam ending there.
	const seamHit = await page.evaluate(([x, y]) => {
		const element = document.elementFromPoint(x, y);
		return `${element?.getAttribute("aria-label")} ${element?.getAttribute("aria-orientation")}`;
	}, [seamBox.x + 3, leftBefore.y + leftBefore.height / 2]);
	check("the vertical seam owns the T-junction under the pointer", seamHit === "Resize panes vertical", seamHit);
	await page.mouse.move(seamBox.x + 3, leftBefore.y + leftBefore.height / 2);
	await page.mouse.down();
	await page.mouse.move(seamBox.x + 123, leftBefore.y + leftBefore.height / 2, { steps: 8 });
	await page.mouse.up();
	await sleep(100);
	const leftAfter = (await panes(page)).find((pane) => pane.id === leftBefore.id);
	check("dragging the seam resizes the panes and tracks the pointer", Math.abs(leftAfter.width - leftBefore.width - 120) <= 3, `${leftBefore.width} → ${leftAfter.width}`);
	await page.screenshot({ path: join(EVIDENCE, "12-resized.png") });

	check("no renderer errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (error) {
	failures.push(String(error));
	console.error(error);
} finally {
	await app?.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exit(failures.length === 0 ? 0 : 1);
