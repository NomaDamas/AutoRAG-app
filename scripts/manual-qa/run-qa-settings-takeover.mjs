/**
 * Manual QA — Settings takes over the window, in the real built app (live e2e).
 *
 * Real Playwright input against the built Electron app, with a loopback OpenAI-compatible model so the
 * Settings assistant in the right sidebar can answer a real chat turn:
 *   1. Before: the Finder shows its tab strip and toolbar (view / sort / group) and its own left sidebar.
 *   2. Opening Settings (sidebar gear, ⌘,): the left column becomes Settings' own sidebar with a back
 *      button and the 설정 title at its top-left; the tab strip and the toolbar are gone; the page content
 *      starts right under the window's top edge; the Finder sidebar is not on screen.
 *   3. The right sidebar stays: on a customizable page (사이드바) it hosts the AI assistant, and a chat turn
 *      streams a reply there.
 *   4. The right sidebar's hide button works, and Settings' own button brings it back.
 *   5. Back returns to the Finder, on the folder and tab that were focused before; the Settings tab is gone
 *      and the Finder chrome is back.
 *   6. A hidden Finder sidebar stays hidden after Settings, but Settings still shows its own sidebar.
 *   7. Korean copy; the sidebar width follows the Finder sidebar's width.
 *
 * Run `bun run build` first, then (VM, no focus steal):
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-settings-takeover.mjs
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/settings-takeover");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail = "") => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-takeover-"));
const HOME_DIR = join(WORK, "home");
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");
for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) mkdirSync(join(HOME_DIR, folder), { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeMinsyncStub(join(AUTORAG_HOME, "bin"));

const REPLY = "사이드바는 설정에서 바꿀 수 있어요.";
const frame = (delta, finish) => `data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(frame({ role: "assistant", content: REPLY }, null));
		res.write(frame({}, "stop"));
		res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [join(HOME_DIR, "Documents")],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			webSearch: { enabled: false },
			queryDecomposition: false,
			model: { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
		},
		null,
		2,
	)}\n`,
);

let app;
let swept = false;
const sweep = () => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	server.close();
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
};
process.on("exit", sweep);

const env = {
	HOME: HOME_DIR,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	QA_API_KEY: "qa-key",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
};

try {
	app = await launchFinder({ userDataDir: USER_DATA, env, language: "en" });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 200)}`));
	const shot = async (name) => {
		await page.waitForTimeout(350);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		log(`screenshot: ${name}.png`);
	};
	/**
	 * An element counts as on screen when something of it is hit-testable at its centre: display:none, a zero-width
	 * column that clips it, or another surface over it all read as not shown.
	 */
	const ON_SCREEN = `(el) => {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
		const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
		const hit = document.elementFromPoint(x, y);
		return hit !== null && el.contains(hit);
	}`;
	const shown = (selector) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(${ON_SCREEN})`);
	const box = (selector) =>
		page.evaluate(`(() => {
			const visible = ${ON_SCREEN};
			const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
			if (el === undefined) return null;
			const { x, y, width, height, right, bottom } = el.getBoundingClientRect();
			return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), right: Math.round(right), bottom: Math.round(bottom) };
		})()`);

	await page.locator(".sidebar .sidebar__item-label", { hasText: "Documents" }).waitFor({ timeout: 30_000 });
	await page.locator(".sidebar .sidebar__item-label", { hasText: "Documents" }).click();
	await page.waitForTimeout(400);
	const tabsBefore = await page.locator(".tabs [role=tab], .tabs > div > div").count();
	const titleBefore = await page.locator(".toolbar-title").innerText();
	const sidebarBefore = await box("aside.sidebar");

	// 1. The Finder chrome before Settings.
	check("Finder shows its tab strip", await shown(".tabs"));
	check("Finder shows its toolbar with the view / sort / group controls", (await shown(".toolbar")) && (await shown('[aria-label="View"]')) && (await shown('button[aria-label="Sort"]')));
	check("Finder shows its own left sidebar", await shown("aside.sidebar"));
	await shot("01-finder-before");

	// 2. Open Settings with the sidebar gear.
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-view");
	await page.waitForTimeout(400);
	check("the tab strip is gone", !(await shown(".tabs")));
	check("the toolbar (and with it view / sort / group) is gone", !(await shown(".toolbar")) && !(await shown('[aria-label="View"]')) && !(await shown('button[aria-label="Sort"]')));
	check("the Finder sidebar is not on screen", !(await shown("aside.sidebar")));
	const nav = await box("aside.settings-sidebar");
	check("Settings' own sidebar fills the left column, flush at the window's left edge", nav !== null && nav.x === 0 && nav.y === 0 && sidebarBefore !== null && nav.width === sidebarBefore.width && nav.bottom === (await page.evaluate(() => innerHeight)), JSON.stringify({ nav, sidebarBefore }));
	const search = await box("aside.settings-sidebar label.side-search");
	const finderSearchClass = await page.evaluate(() => document.querySelector("aside.settings-sidebar label.side-search")?.className.replace(/\bsettings-search\b/, "").trim());
	const back = await box("aside.settings-sidebar .settings-sidebar-back");
	check("no title or back button at the sidebar's top-left: the head is empty", (await page.locator(".settings-sidebar-title").count()) === 0 && (await page.locator(".settings-sidebar-head button, .settings-sidebar-head :text('Settings')").count()) === 0);
	check("the search sits right under the head, where the Finder sidebar's search does", search !== null && search.y >= 52 && search.y < 64, JSON.stringify(search));
	check("the back button is one row directly under the search, as wide as a page row", search !== null && back !== null && back.y > search.bottom && back.y - search.bottom < 24 && (await page.locator("aside.settings-sidebar .settings-sidebar-back").innerText()).trim() === "Back", JSON.stringify({ search, back }));
	check("the search carries the Finder sidebar's design classes", /rounded-8/.test(finderSearchClass ?? "") && /bg-hover/.test(finderSearchClass ?? "") && /h-30/.test(finderSearchClass ?? ""), finderSearchClass);
	const content = await box("main.settings-content");
	check("the settings content starts right at the window's top, beside the sidebar", content !== null && content.y === 0 && content.x >= (nav?.right ?? 0), JSON.stringify(content));
	const heading = await box(".settings-content .linear-title");
	check("the first page heading is near the top (no tab-strip + toolbar rows above it)", heading !== null && heading.y < 90, JSON.stringify(heading));
	const inspector = await box(".inspector-column");
	check("the right sidebar is kept, flush with the window's right edge", inspector !== null && inspector.right === (await page.evaluate(() => innerWidth)), JSON.stringify(inspector));
	check("only one Settings tab exists and it is the focused one", (await page.locator(".tabs", { hasText: "Settings" }).count()) <= 1);
	await shot("02-settings-general");

	// The window's focus-search shortcut (⌘F) goes to Settings' own search box: the Finder's is hidden.
	await page.locator(".settings-content").click({ position: { x: 5, y: 300 } });
	await page.keyboard.press(chord("f"));
	await page.waitForTimeout(150);
	check("⌘F focuses Settings' search box while Settings is open", await page.evaluate(() => document.activeElement === document.querySelector(".settings-search input")));

	// 3. A customizable page: the assistant fills the right sidebar and chats.
	await page.locator(".settings-nav-item", { hasText: "Sidebar" }).click();
	const panel = page.locator('[data-testid="app-customizer-panel"][data-surface="sidebar"]');
	await panel.waitFor();
	const panelBox = await panel.boundingBox();
	check("on the Sidebar page the assistant is in the right sidebar, outside the page", panelBox !== null && Math.round(panelBox.x) >= (await box("main.settings-content")).right && (await panel.evaluate((el) => el.closest(".settings-view") === null)), JSON.stringify(panelBox));
	await panel.locator('textarea[data-testid="app-customizer-input"]').click();
	await page.keyboard.type("how do I change the sidebar?");
	await page.keyboard.press("Enter");
	await panel.locator(".customizer-turn__reply", { hasText: REPLY }).waitFor({ timeout: 20_000 });
	check("a chat turn answers in the right sidebar", true);
	await shot("03-assistant-chat");

	// 4. Hide / show the right sidebar.
	const hideBox = await box('.inspector-head button[aria-label="Hide inspector"]');
	await page.locator('.inspector-head button[aria-label="Hide inspector"]').click();
	await page.waitForTimeout(400);
	check("hiding the right sidebar leaves Settings' own show button", (await shown('.settings-main-head button[aria-label="Show inspector"]')) && !(await shown(".inspector-column")));
	const showBox = await box('.settings-main-head button[aria-label="Show inspector"]');
	const windowWidth = await page.evaluate(() => innerWidth);
	check(
		"the show button keeps the Finder toolbar's margins: centred in a toolbar-high row, 12px from the right edge, level with the hide button",
		showBox !== null && hideBox !== null && showBox.y + showBox.height / 2 === 26 && windowWidth - showBox.right === 12 && showBox.y === hideBox.y && showBox.height === hideBox.height,
		JSON.stringify({ showBox, hideBox, windowWidth }),
	);
	await shot("04-right-sidebar-hidden");
	await page.locator('.settings-main-head button[aria-label="Show inspector"]').click();
	await page.waitForTimeout(400);
	check("the show button brings the right sidebar (and the assistant) back, then disappears", (await shown(".inspector-column")) && !(await shown('.settings-main-head button[aria-label="Show inspector"]')) && (await panel.isVisible()));

	// 5. Back.
	await page.locator(".settings-sidebar-back").click();
	await page.waitForSelector("aside.sidebar", { state: "visible" });
	await page.waitForTimeout(400);
	check("Back restores the tab strip, toolbar and Finder sidebar", (await shown(".tabs")) && (await shown(".toolbar")) && (await shown("aside.sidebar")) && !(await shown(".settings-view")));
	check("Back returns to the folder that was focused before", (await page.locator(".toolbar-title").innerText()) === titleBefore, `${titleBefore} -> ${await page.locator(".toolbar-title").innerText()}`);
	check("the Settings tab did not stay behind", (await page.locator(".tabs [role=tab], .tabs > div > div").count()) === tabsBefore, `${tabsBefore} -> ${await page.locator(".tabs [role=tab], .tabs > div > div").count()}`);
	await shot("05-back-in-finder");

	// ⌘, reopens Settings.
	await page.keyboard.press(chord(","));
	await page.waitForSelector(".settings-view");
	check("the Settings shortcut opens Settings again", !(await shown(".toolbar")) && (await shown("aside.settings-sidebar")));
	await page.locator(".settings-sidebar-back").click();
	await page.waitForSelector("aside.sidebar", { state: "visible" });

	// The Finder chrome stays mounted under Settings: an AI Search tab's composer draft survives a round trip.
	await page.locator('.sidebar__item:has-text("AI Search")').first().click();
	const composer = page.locator('section[aria-label="AI Search"]:not([aria-hidden="true"]) textarea[aria-label="Ask Dazzi"]');
	await composer.fill("draft kept while Settings is open");
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-view");
	await page.waitForTimeout(300);
	await page.locator(".settings-sidebar-back").click();
	await page.waitForSelector("aside.sidebar", { state: "visible" });
	check("Back returns to the AI Search tab with its composer draft intact", (await composer.inputValue()) === "draft kept while Settings is open");
	await shot("05b-ai-draft-after-settings");

	// 6. A hidden Finder sidebar stays hidden; Settings still has its own.
	await page.locator('aside.sidebar button[aria-label="Hide sidebar"]').click();
	await page.waitForTimeout(400);
	check("the Finder sidebar is hidden", !(await shown("aside.sidebar")));
	await page.keyboard.press(chord(","));
	await page.waitForSelector(".settings-view");
	await page.waitForTimeout(400);
	const navHidden = await box("aside.settings-sidebar");
	check("Settings still shows its own sidebar while the Finder's is hidden", navHidden !== null && navHidden.x === 0 && navHidden.width > 100, JSON.stringify(navHidden));
	await shot("06-settings-finder-sidebar-hidden");
	await page.locator(".settings-sidebar-back").click();
	await page.waitForSelector(".toolbar", { state: "visible" });
	await page.waitForTimeout(400);
	check("Back leaves the Finder sidebar hidden, as it was", !(await shown("aside.sidebar")) && (await shown('.toolbar button[aria-label="Show sidebar"]')));
	await page.locator('.toolbar button[aria-label="Show sidebar"]').click();
	await page.waitForSelector("aside.sidebar", { state: "visible" });

	// 7. Korean.
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-view");
	await page.locator(".settings-nav-item", { hasText: "General" }).click();
	await page.selectOption('select[aria-label="App Language"]', "ko");
	await page.waitForFunction(() => document.querySelector(".settings-sidebar-back")?.textContent?.trim() === "뒤로", null, { timeout: 10_000 });
	check("the back row follows the interface language", (await page.locator(".settings-sidebar-back").innerText()).trim() === "뒤로");
	await shot("07-settings-ko");
	await page.locator(".settings-sidebar-back").click();
	await page.waitForSelector(".toolbar", { state: "visible" });
	await shot("08-back-ko");
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 800)}`);
	failures.push("harness error");
} finally {
	sweep();
}

log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
