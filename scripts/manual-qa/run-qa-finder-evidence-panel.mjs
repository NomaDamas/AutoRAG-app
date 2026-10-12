import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
/**
 * Manual QA — AI Search markdown answers + the Evidence view of the real
 * AI Finder app, per the v7 Bloom design reference.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose Quick/Deep answers carry markdown (bold, headings,
 * lists, quote, inline code) and numbered citations, and whose evidence items
 * point at REAL fixture files on disk. Loading the chat exercises only the
 * real render path (loadHistory -> publish -> Inspector Evidence view), then
 * drives: the full-height Evidence view on an AI Search tab and Info on a
 * folder tab, citation chips, evidence tabs (no thumbs controls: the librarian dropped feedback),
 * title -> new-tab reveal with file selection, the datasource virtual-source
 * title guard, and a web-page source opening in the OS browser (main's
 * shell.openExternal is stubbed to record the URL, so no browser launches).
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-evidence-panel.mjs
 * Prereq: bun run build
 */
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { launchFinder, finderWindow, openAiSearch } from "./launch-finder.mjs";
import { chord, isWindows, rmRetry } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-evidence-panel");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const RUN_ID = `ulw-evidence-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const DOCS = join(homedir(), "Documents", RUN_ID);
const POLICY = join(DOCS, "한글 공백 정책.md");
const MEMO = join(DOCS, "qa-evidence-memo.md");
const FOLDER = basename(DOCS);
/** A web evidence source, the shape a model cites for a page it read. */
const WEB_SOURCE = "https://music.bugs.co.kr/artist/20047596";

let app;
let swept = false;
/**
 * Best-effort cleanup. On the exit path (`patient === false`) a single
 * non-throwing attempt per directory: blocking retries there would freeze the
 * event loop that `app.close()` still needs, and a throw would mask the lane's
 * real failure. After an awaited close the patient path retries through
 * Windows' teardown locks.
 */
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	for (const dir of [USER_DATA, DOCS]) {
		try {
			if (patient === true) rmRetry(dir);
			else rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			log(`cleanup: ${dir} stayed behind (${error.code ?? error.message})`);
		}
	}
};
process.on("exit", () => sweep(false));

mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
mkdirSync(DOCS, { recursive: true });
writeFileSync(POLICY.normalize("NFD"), "## 승인 규칙\n1. 일반 환불은 5영업일 내 처리합니다.\n2. 예외는 임원 승인이 필요합니다.\n비고: 긴급 예외도 승인 생략 불가.\n");
writeFileSync(MEMO, "## 메모\n승인 체인 원본 첨부 필수.\n");
log(`fixtures: ${DOCS}`);

const evidenceAll = [
	{
		number: 1,
		title: basename(POLICY),
		summary: "환불 정책에서 승인 규칙을 발췌했습니다.",
		source: POLICY,
		excerpts: [
			"## 승인 규칙\n1. 일반 환불은 5영업일 내 처리합니다.\n2. 예외는 **임원 승인**이 필요합니다.\n> 비고 인용: 긴급 예외도 승인 생략 불가\n```\nif (!director) reject()\n```",
		],
		confidence: 0.92,
	},
	{
		number: 2,
		title: "qa-evidence-memo.md",
		summary: "승인 체인 첨부 메모입니다.",
		source: MEMO,
		excerpts: ["승인 체인 원본 첨부 필수."],
		confidence: 0.81,
	},
	{
		number: 3,
		title: "채널 스레드 정리",
		summary: "외부 채널에서 온 데이터소스 근거입니다.",
		source: "/kakao/ulw-qa/chunks/7",
		excerpts: ["스레드에서 합의된 내용 요약."],
		confidence: 0.44,
	},
	{
		number: 4,
		title: "프로미스나인 데뷔 멤버 9명",
		summary: "웹 페이지에서 찾은 근거입니다.",
		source: WEB_SOURCE,
		excerpts: ["프로미스나인은 2018년 1월 24일 9인조로 데뷔."],
		confidence: 0.9,
	},
];
const record = {
	id: "c-ev-1",
	title: "환불 예외 승인 규칙",
	snippet: "최종 승인액은 ₩3.8억이며, 승인 체인 첨부가 필요합니다.",
	updatedAt: new Date().toISOString(),
	messages: [
		{ role: "user", text: "환불 예외 승인 규칙 요약해줘", attachments: [], at: new Date().toISOString() },
		{
			role: "assistant",
			sessionId: "qa-evidence-session",
			quick: {
				answer: "최종 승인액은 **₩3.8억**이며, 승인 체인 첨부가 필요합니다. [1][2]",
				evidence: evidenceAll.slice(0, 2),
				meta: "0.4s · 2 sources",
			},
			deep: {
				answer: "## 승인 규칙 요약\n환불 예외는 지급 전 **임원 승인**이 필요합니다. [1][2]\n\n- 예외는 자동 반려되지 않습니다 [2]\n- 긴급 예외도 승인 생략 불가 [1]\n\n> 내규 인용 구문이 함께 표시됩니다.\n\n관련 명령은 `bun run qa` 입니다.\n\n별도 확인이 필요한 항목입니다[7].",
				evidence: evidenceAll,
				meta: "3 sources read · 2s",
			},
			stopped: false,
			at: new Date().toISOString(),
		},
	],
};
writeFileSync(join(USER_DATA, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);

app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);
// Record what main hands the OS browser instead of launching one.
await app.evaluate(({ shell }) => {
	globalThis.__qaOpenedUrls = [];
	shell.openExternal = async (url) => {
		globalThis.__qaOpenedUrls.push(url);
	};
});
const openedUrls = () => app.evaluate(() => globalThis.__qaOpenedUrls);
log("app ready");

const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';
const INFO_HALF = '.inspector-half[aria-label="Info"]';
/** v7 renders the loaded chat as two prose blocks: Quick first, Deep second. */
const quickProse = page.locator(".assistant-msg .assistant-prose").nth(0);
const deepProse = page.locator(".assistant-msg .assistant-prose").nth(1);

// 1. Open the seeded chat through the real history surface.
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await deepProse.waitFor({ state: "visible" });
// An AI Search tab owns the whole inspector: Evidence, never the Info view.
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab`);
check(
	"the AI Search tab shows the Evidence view and no Info view",
	(await page.locator(EVIDENCE_HALF).count()) === 1 && (await page.locator(INFO_HALF).count()) === 0,
	`evidence=${await page.locator(EVIDENCE_HALF).count()} info=${await page.locator(INFO_HALF).count()}`,
);
await page.screenshot({ path: join(EVIDENCE, "01-answers.png") });

const boldCount = await quickProse.locator("strong").count();
check("quick answer renders **bold** as <strong>", boldCount >= 1, `strong=${boldCount}`);
const quickCites = await quickProse.locator(".cite").allTextContents();
check("quick answer citation chips show bare numbers", quickCites.join(",") === "1,2", JSON.stringify(quickCites));
await sleep(300);
const chipOf = (n) => quickProse.locator(".cite", { hasText: new RegExp(`^${n}$`) }).first();
const chipStyle = async (locator) => locator.evaluate((el) => {
	const s = getComputedStyle(el);
	return { bg: s.backgroundColor, color: s.color, radius: s.borderRadius, fontSize: s.fontSize, fontWeight: s.fontWeight };
});
const inactiveStyle = await chipStyle(chipOf(2));
check(
	"an inactive citation chip matches the v7 accent chip (accent wash / accent-text / radius 5 / 11 / 600)",
	inactiveStyle.bg === "rgb(219, 234, 254)" && inactiveStyle.color === "rgb(10, 100, 216)" && inactiveStyle.radius === "5px" && inactiveStyle.fontSize === "11px" && inactiveStyle.fontWeight === "600",
	JSON.stringify(inactiveStyle),
);
const activeStyle = await chipStyle(chipOf(1));
check(
	"the default-selected evidence lights chip 1 in the solid accent",
	activeStyle.bg === "rgb(10, 100, 216)" && activeStyle.color === "rgb(255, 255, 255)",
	JSON.stringify(activeStyle),
);
// v7 renders assistant prose as plain blocks (no `ai__block--*` hooks); the
// block types are asserted from the rendered text.
const deepText = await deepProse.innerText();
check("deep answer renders the ## heading block", deepText.includes("승인 규칙 요약"), deepText.slice(0, 40));
check("deep answer renders two list bullets", (deepText.match(/–/g) ?? []).length === 2, JSON.stringify(deepText.match(/–/g) ?? []));
check("deep answer renders the quote block", deepText.includes("내규 인용 구문"), deepText.slice(-80));
const inlineCode = await deepProse.locator("code").first().textContent();
check("deep answer renders inline code", (inlineCode ?? "").includes("bun run qa"), inlineCode);

// A citation whose number has no evidence entry (the library can cite fast-
// answer units that never reach `results`; see AutoRAG#1788) is dropped from
// the rendered answer, and can never open unrelated evidence.
const missingChip = deepProse.locator(".cite", { hasText: /^7$/ });
check("an unresolved citation is not rendered at all", (await missingChip.count()) === 0, `count=${await missingChip.count()}`);
const renderedDeep = await deepProse.innerText();
check("the sentence keeps its text without the dead marker", renderedDeep.includes("별도 확인이 필요한 항목입니다."), renderedDeep.slice(-60));
check("the deep answer no longer shows the unresolved number", !/\[?7\]?/.test(renderedDeep.split("별도 확인이 필요한 항목입니다.")[1] ?? ""), renderedDeep.slice(-60));

// 2. Citation click -> selects that evidence, title reveal.
await chipOf(2).click();
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab.bg-accent`);
const activeCite = await quickProse.locator(".cite.active").allTextContents();
const activeTab = (await page.locator(`${EVIDENCE_HALF} .evidence-tab.bg-accent`).textContent())?.trim();
const evTitle = (await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "";
const revealBtn = page.locator(`${EVIDENCE_HALF} .preview-title[title="Show in Finder"]`);
check("the cited chip lights up with the active accent", JSON.stringify(activeCite) === JSON.stringify(["2"]), JSON.stringify(activeCite));
check("the citation selects evidence 2", activeTab === "2" && evTitle.startsWith("2. "), `tab=${activeTab} title=${evTitle.slice(0, 32)}`);
check("the evidence title is the Show-in-Finder action", (await revealBtn.count()) === 1, `count=${await revealBtn.count()}`);
const detail = (await page.locator(`${EVIDENCE_HALF} .preview-sub`).textContent()) ?? "";
check("the detail shows confidence without the source path", detail.includes("Relevance 81%") && !detail.includes("qa-evidence-memo.md"), detail.replace(/\s+/g, " ").slice(0, 120));
check("the Evidence header, eye, and close controls are removed", (await page.locator(`${EVIDENCE_HALF} .inspector-head`).count()) === 0 && (await page.locator(`${EVIDENCE_HALF} button[aria-label="Quick Look"]`).count()) === 0 && (await page.locator(`${EVIDENCE_HALF} button[aria-label="Close"]`).count()) === 0, "header controls absent");
await page.screenshot({ path: join(EVIDENCE, "02-evidence-panel.png") });

// 2b. Layout geometry (Evidence fills the whole inspector column, numbered
// tabs first, subtle inspector surface).
const geometry = await page.evaluate((half) => {
    const box = (sel) => { const e = document.querySelector(sel); return e ? JSON.parse(JSON.stringify(e.getBoundingClientRect())) : null; };
    const style = (sel, props) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const s = getComputedStyle(e);
        return Object.fromEntries(props.map((p) => [p, s[p]]));
    };
    return {
        panel: box(half),
        inspector: box(".inspector"),
        tabs: box(`${half} .evidence-tabs`),
        tab: box(`${half} .evidence-tab`),
        votes: document.querySelectorAll(`${half} .feedback`).length,
        inspectorBg: style(".inspector", ["backgroundColor"]),
    };
}, EVIDENCE_HALF);
const ratio = geometry.panel.height / geometry.inspector.height;
check("the Evidence view fills the whole inspector column", ratio > 0.99 && Math.abs(geometry.panel.top - geometry.inspector.top) < 1, `ratio=${ratio.toFixed(3)} top=${geometry.panel.top}/${geometry.inspector.top}`);
check("evidence tabs are the first content row", geometry.tabs !== null && geometry.tab !== null && geometry.tabs.top <= geometry.tab.top + 1, JSON.stringify({ tabs: geometry.tabs, tab: geometry.tab }));
check("the Evidence view offers no thumbs-up/down controls", geometry.votes === 0, `feedback nodes=${geometry.votes}`);
check("the inspector sits on the subtle surface", geometry.inspectorBg.backgroundColor === "rgb(250, 250, 250)", JSON.stringify(geometry.inspectorBg));

// 3. Tabs switch; the excerpt renders the reference block types.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^1$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("1. "), `${EVIDENCE_HALF} .preview-title`);
const kindCount = async (kind) => page.locator(`${EVIDENCE_HALF} .evidence__block--${kind}`).count();
check(
	"evidence 1 chunk renders heading/list ×2/quote/code blocks plus the summary paragraph",
	(await kindCount("heading")) === 1 && (await kindCount("list")) === 2 && (await kindCount("quote")) === 1 && (await kindCount("code")) === 1 && (await kindCount("paragraph")) === 1,
	JSON.stringify({ heading: await kindCount("heading"), list: await kindCount("list"), quote: await kindCount("quote"), code: await kindCount("code"), paragraph: await kindCount("paragraph") }),
);
const evBold = await page.locator(`${EVIDENCE_HALF} .inspector-body strong`).count();
check("chunk text bold renders as emphasized strong", evBold >= 1, `strong=${evBold}`);

// 5. Title click opens the enclosing folder in a NEW tab and selects the source row.
const tabsBefore = await page.locator(".tabs .tab").count();
const targetName = basename(POLICY).normalize("NFC");
// The flash is a 1.8s transient that can end before a slow listing paints the
// row selected, so record it with an observer armed before the click.
await page.evaluate((name) => {
	window.__qaFlashSeen = false;
	const seen = () =>
		[...document.querySelectorAll(".row.bg-accent-flash")].some((row) => row.textContent?.normalize("NFC").includes(name));
	window.__qaFlashObserver = new MutationObserver(() => {
		if (seen()) window.__qaFlashSeen = true;
	});
	window.__qaFlashObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
}, targetName);
const clickedAt = Date.now();
await page.locator(`${EVIDENCE_HALF} button[title="Show in Finder"]`).click();
// A slow Windows runner paints the folder listing late; the default 8s page
// timeout is not enough for the new tab to appear (see the 10s/30s waits below).
await page.waitForFunction((count) => document.querySelectorAll(".tabs .tab").length === count + 1, tabsBefore, { timeout: 20_000, polling: 50 });
const newTabTitle = (await page.locator(".tabs .tab--active .tab__title").textContent()) ?? "";
check("the title opens the source folder in a new tab", newTabTitle === FOLDER, `tab="${newTabTitle}" want="${FOLDER}"`);
const selected = await page
	.waitForFunction(
		(name) =>
			[...document.querySelectorAll('[role="row"]')].some(
				(row) => row.getAttribute("aria-selected") === "true" && row.textContent?.normalize("NFC").includes(name),
			),
		targetName,
		{ timeout: 10_000, polling: 50 },
	)
	.then(() => true)
	.catch(() => false);
const reveal = await page.evaluate(() => {
	window.__qaFlashObserver.disconnect();
	return {
		flash: window.__qaFlashSeen,
		rows: [...document.querySelectorAll('[role="row"]')].map((row) => ({
			text: (row.textContent ?? "").normalize("NFC").slice(0, 40),
			selected: row.getAttribute("aria-selected"),
		})),
	};
});
check(
	"the title selects and flashes a Korean filename with spaces and different Unicode normalization",
	selected && reveal.flash,
	`selected=${selected} flash=${reveal.flash} after=${Date.now() - clickedAt}ms rows=${JSON.stringify(reveal.rows)}`,
);
check(
	"the folder tab's inspector is the whole Info view, no Evidence",
	(await page.locator(INFO_HALF).count()) === 1 && (await page.locator(EVIDENCE_HALF).count()) === 0,
	`info=${await page.locator(INFO_HALF).count()} evidence=${await page.locator(EVIDENCE_HALF).count()}`,
);
const infoRatio = await page.evaluate((half) => document.querySelector(half).getBoundingClientRect().height / document.querySelector(".inspector").getBoundingClientRect().height, INFO_HALF);
check("the Info view fills the whole inspector column", infoRatio > 0.99, `ratio=${infoRatio.toFixed(3)}`);
await page.screenshot({ path: join(EVIDENCE, "04-new-tab-reveal.png") });

// 6. Back on the AI Search tab, the inspector is that tab's Evidence again.
await page.locator('.tabs .tab[data-ai-search="true"]').click();
await page.waitForSelector(EVIDENCE_HALF);
check(
	"refocusing the AI Search tab brings its Evidence back, still on evidence 1",
	(await page.locator(INFO_HALF).count()) === 0 && ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").startsWith("1. "),
);
await page.screenshot({ path: join(EVIDENCE, "05-back-to-ai-tab.png") });

// 7. Datasource evidence has no local Finder title action.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^3$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("3. "), `${EVIDENCE_HALF} .preview-title`);
check("a virtual datasource title is not a local Finder action", (await page.locator(`${EVIDENCE_HALF} .preview-title[title="Show in Finder"]`).count()) === 0);
await page.screenshot({ path: join(EVIDENCE, "06-datasource.png") });

// 8. A web-page source opens in the OS browser: no Finder tab, no error toast.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^4$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("4. "), `${EVIDENCE_HALF} .preview-title`);
const urlLine = (await page.locator(`${EVIDENCE_HALF} .evidence-url`).textContent()) ?? "";
check("a web source shows its URL under the title", urlLine === WEB_SOURCE, urlLine);
const tabsBeforeUrl = await page.locator(".tabs .tab").count();
// Let any earlier toast expire, so a new toast would be this click's.
await page.locator(".toast").waitFor({ state: "detached", timeout: 8000 }).catch(() => undefined);
await page.locator(`${EVIDENCE_HALF} button[title="Open in browser"]`).click();
await sleep(600);
const opened = await openedUrls();
check("the web source title opens the page in the OS browser", JSON.stringify(opened) === JSON.stringify([WEB_SOURCE]), JSON.stringify(opened));
check("opening a web source adds no Finder tab", (await page.locator(".tabs .tab").count()) === tabsBeforeUrl);
check("opening a web source raises no error toast", (await page.locator(".toast").count()) === 0, (await page.locator(".toast").textContent().catch(() => "")) ?? "");
await page.screenshot({ path: join(EVIDENCE, "07-web-source.png") });


log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
// Close before sweeping: on Windows, deleting userData while Electron is
// still tearing down loses the EBUSY race even with rmRetry.
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
