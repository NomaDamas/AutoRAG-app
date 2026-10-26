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
 * title guard, a web-page source opening in the OS browser (main's
 * shell.openExternal is stubbed to record the URL, so no browser launches),
 * and chunks whose markup the chunker cut: spreadsheet rows without their
 * <table> (starting inside a cell), a headerless pipe table, and hostile HTML.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-evidence-panel.mjs
 * Prereq: bun run build
 */
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { launchFinder, finderWindow, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

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
const MEMO = join(DOCS, "qa-evidence-memo.pdf");
const SHEET = join(DOCS, "260414 발표 목차_v0.6.xlsx");
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
// Only the file name is decomposed (macOS stores NFD names); normalizing the whole path would also rewrite a Hangul home folder.
writeFileSync(join(DOCS, basename(POLICY).normalize("NFD")), "## 승인 규칙\n1. 일반 환불은 5영업일 내 처리합니다.\n2. 예외는 임원 승인이 필요합니다.\n비고: 긴급 예외도 승인 생략 불가.\n");
const memoPdf = await PDFDocument.create();
const memoFont = await memoPdf.embedFont(StandardFonts.Helvetica);
memoPdf.addPage([600, 800]).drawText("Cover page — general overview of the approval process.", { x: 72, y: 700, size: 14, font: memoFont });
const memoPage2 = memoPdf.addPage([600, 800]);
memoPage2.drawText("Section 2 — Exceptions and escalation.", { x: 72, y: 720, size: 16, font: memoFont });
memoPage2.drawText("Approval chain original attachment is mandatory before payout.", { x: 72, y: 260, size: 12, font: memoFont });
writeFileSync(MEMO, await memoPdf.save());
writeFileSync(SHEET, "fixture");
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
		title: "qa-evidence-memo.pdf",
		summary: "승인 체인 첨부 메모입니다.",
		source: MEMO,
		excerpts: ["Approval chain original attachment is mandatory before payout."],
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
	{
		number: 5,
		title: "260414 발표 목차_v0.6.xlsx",
		summary: "발표 목차(최신 v0.6)에 별도 항목 존재**: '오픈소스 커뮤니티' 섹션에 \"해커톤/컨퍼런스/확산\" 항목이 명시적으로 들어가 있습니다",
		source: SHEET,
		excerpts: [
			[
				"사용 시나리오</td><td>15</td><td>핵심 사용 시나리오</td><td>○</td></tr>",
				"<tr><td>고도화 후 실제 사용 시나리오 &amp; 경쟁 우위</td><td>16</td><td></td><td></td></tr>",
				"<tr><td>왜 오픈소스여야 하는가</td><td>17</td><td>○</td><td></td></tr>",
				"<tr><td>개발 로드맵</td><td>18</td><td>○</td><td></td></tr>",
				"<tr><td>모듈 분리 운영 전략</td><td>19</td><td></td><td></td></tr>",
				"<tr><td>20</td><td>기관별",
			].join("\n"),
			"| 오픈소스 커뮤니티 | 21 | 해커톤/컨퍼런스/확산 |\n| 마무리 | 22 | **Q&A** |",
			'<div onclick="window.__qaPwned = true"><p>정상 문단</p><script>window.__qaPwned = true</script><img src="https://tracker.example/p.gif" alt=""><a href="https://example.com/roadmap">로드맵 링크</a> <a href="javascript:window.__qaPwned = true">나쁜 링크</a></div>',
		],
		confidence: 0.77,
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
const revealBtn = page.locator(`${EVIDENCE_HALF} .preview-title[title="Preview at the cited passage"]`);
check("the cited chip lights up with the active accent", JSON.stringify(activeCite) === JSON.stringify(["2"]), JSON.stringify(activeCite));
check("the citation selects evidence 2", activeTab === "2" && evTitle.startsWith("2. "), `tab=${activeTab} title=${evTitle.slice(0, 32)}`);
check("the evidence title is the preview-at-passage action", (await revealBtn.count()) === 1, `count=${await revealBtn.count()}`);
const detail = (await page.locator(`${EVIDENCE_HALF} .preview-sub`).textContent()) ?? "";
check("the detail shows confidence without the source path", detail.includes("Relevance 81%") && !detail.includes("qa-evidence-memo.pdf"), detail.replace(/\s+/g, " ").slice(0, 120));
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

// 5. Title click opens Quick Look at the cited passage instead of a new Finder tab.
await chipOf(2).click();
const tabsBefore = await page.locator(".tabs .tab").count();
const quickLook = app.windows().find((candidate) => candidate.url().includes("quick-look.html")) ?? (await app.waitForEvent("window", { predicate: (candidate) => candidate.url().includes("quick-look.html"), timeout: 15_000 }));
const clickedAt = Date.now();
await page.locator(`${EVIDENCE_HALF} button[title="Preview at the cited passage"]`).click();
await quickLook.waitForSelector('.ql-pages__evidence[data-evidence-state="found"]', { timeout: 10_000 });
const jumpMs = Date.now() - clickedAt;
const markedPage = await quickLook.locator('.ql__paper:has(.ql__mark[data-evidence-mark="first"])').getAttribute("data-page");
const pillText = ((await quickLook.locator(".ql-pages__pill").textContent()) ?? "").replace(/\s+/g, " ");
check("clicking the evidence title adds no Finder tab", (await page.locator(".tabs .tab").count()) === tabsBefore);
check("Quick Look highlights the cited passage on page 2 and scrolls to it", markedPage === "2" && pillText.includes("2 / 2"), `markedPage=${markedPage} pill="${pillText}" in ${jumpMs}ms`);
await quickLook.screenshot({ path: join(EVIDENCE, "04-preview-jump.png") });
await quickLook.locator('button[aria-label="Close"]').click();

// 6. Evidence Folder opens the session's files in a temporary folder tab, whose inspector is Info; switching back restores Evidence.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^1$/ }).first().click();
await page.locator(`${EVIDENCE_HALF} button[data-action="evidence-folder"]`).click();
await page.waitForFunction((count) => document.querySelectorAll(".tabs .tab").length === count + 1, tabsBefore, { timeout: 20_000, polling: 50 });
check(
	"the folder tab's inspector is the whole Info view, no Evidence",
	(await page.locator(INFO_HALF).count()) === 1 && (await page.locator(EVIDENCE_HALF).count()) === 0,
	`info=${await page.locator(INFO_HALF).count()} evidence=${await page.locator(EVIDENCE_HALF).count()}`,
);
const infoRatio = await page.evaluate((half) => document.querySelector(half).getBoundingClientRect().height / document.querySelector(".inspector").getBoundingClientRect().height, INFO_HALF);
check("the Info view fills the whole inspector column", infoRatio > 0.99, `ratio=${infoRatio.toFixed(3)}`);
await page.locator('.tabs .tab[data-ai-search="true"]').click();
await page.waitForSelector(EVIDENCE_HALF);
check(
	"refocusing the AI Search tab brings its Evidence back, still on evidence 1",
	(await page.locator(INFO_HALF).count()) === 0 && ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").startsWith("1. "),
);
await page.screenshot({ path: join(EVIDENCE, "05-back-to-ai-tab.png") });

// 7. Datasource evidence has no local preview title action.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^3$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("3. "), `${EVIDENCE_HALF} .preview-title`);
check("a virtual datasource title is not a local preview action", (await page.locator(`${EVIDENCE_HALF} .preview-title[title="Preview at the cited passage"]`).count()) === 0);
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

// 9. Chunk formats: HTML cut out of a spreadsheet, a headerless pipe table, hostile HTML.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^5$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("5. "), `${EVIDENCE_HALF} .preview-title`);
const chunk = await page.evaluate((half) => {
	const root = document.querySelector(`${half} .inspector-body`);
	const htmlTables = [...root.querySelectorAll(".evidence__block--html table")];
	const pipe = root.querySelector(".evidence__block--table table");
	const cells = (table) => [...table.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => cell.textContent));
	const wrap = root.querySelector(".evidence__table-wrap");
	return {
		htmlTables: htmlTables.length,
		rows: htmlTables[0] ? cells(htmlTables[0]) : [],
		pipe: pipe ? cells(pipe) : [],
		pipeStrong: pipe?.querySelector("strong")?.textContent ?? null,
		literalTags: /<\/?t[dr]\b/.test(root.innerText),
		html: [...root.querySelectorAll(".evidence__block--html")].map((block) => block.innerHTML).join(""),
		wrapOverflow: wrap ? getComputedStyle(wrap).overflowX : null,
		wrapFits: wrap ? wrap.getBoundingClientRect().right <= root.getBoundingClientRect().right + 0.5 : false,
	};
}, EVIDENCE_HALF);
check("no literal <td>/<tr> tags are shown", !chunk.literalTags);
check("the spreadsheet chunk renders as one table", chunk.htmlTables === 1, `tables=${chunk.htmlTables}`);
check(
	"the cut-off first cell, the cells between, and the cut-off last row survive",
	JSON.stringify(chunk.rows[0]) === JSON.stringify(["사용 시나리오", "15", "핵심 사용 시나리오", "○"]) &&
		chunk.rows[1]?.[0] === "고도화 후 실제 사용 시나리오 & 경쟁 우위" &&
		JSON.stringify(chunk.rows.at(-1)) === JSON.stringify(["20", "기관별"]),
	JSON.stringify(chunk.rows),
);
check(
	"a headerless pipe table renders as a table with inline markdown",
	chunk.pipe.length === 2 && chunk.pipe[0]?.[2] === "해커톤/컨퍼런스/확산" && chunk.pipeStrong === "Q&A",
	JSON.stringify({ pipe: chunk.pipe, strong: chunk.pipeStrong }),
);
check("a wide table scrolls inside the column instead of overflowing it", chunk.wrapOverflow === "auto" && chunk.wrapFits, JSON.stringify({ overflow: chunk.wrapOverflow, fits: chunk.wrapFits }));
check(
	"chunk HTML is sanitized: no script, handler, javascript: link, or remote image",
	!/script|onclick|javascript:|tracker\.example/.test(chunk.html) && (await page.evaluate(() => globalThis.__qaPwned === undefined)),
	chunk.html.slice(0, 200),
);
await page.locator(`${EVIDENCE_HALF} .inspector-body`).evaluate((el) => el.scrollTo(0, 0));
await page.screenshot({ path: join(EVIDENCE, "08-chunk-formats.png") });
await page.locator(`${EVIDENCE_HALF}`).screenshot({ path: join(EVIDENCE, "08b-chunk-formats-panel.png") });
const urlsBefore = (await openedUrls()).length;
const tabsBeforeLink = await page.locator(".tabs .tab").count();
await page.locator(`${EVIDENCE_HALF} .evidence__block--html a`, { hasText: "로드맵 링크" }).click();
await sleep(500);
const afterLink = await openedUrls();
check("an http(s) link in chunk HTML opens in the OS browser", afterLink.length === urlsBefore + 1 && afterLink.at(-1) === "https://example.com/roadmap", JSON.stringify(afterLink));
await page.locator(`${EVIDENCE_HALF} .evidence__block--html a`, { hasText: "나쁜 링크" }).click();
await sleep(300);
check(
	"a stripped link is inert: no navigation, no new tab, nothing opened",
	(await openedUrls()).length === afterLink.length && (await page.locator(".tabs .tab").count()) === tabsBeforeLink && page.url().includes("index.html") && (await page.evaluate(() => globalThis.__qaPwned === undefined)),
	page.url(),
);
await page.locator(`${EVIDENCE_HALF} .evidence__block--html`).last().scrollIntoViewIfNeeded();
await page.locator(`${EVIDENCE_HALF}`).screenshot({ path: join(EVIDENCE, "09-chunk-formats-bottom.png") });
const linkLooks = await page.locator(`${EVIDENCE_HALF} .evidence__block--html a`).evaluateAll((links) =>
	links.map((link) => ({ text: link.textContent, href: link.hasAttribute("href"), underline: getComputedStyle(link).textDecorationLine })),
);
check(
	"only a link that kept its href is styled as a link",
	linkLooks.some((link) => link.text === "로드맵 링크" && link.href && link.underline === "underline") &&
		linkLooks.some((link) => link.text === "나쁜 링크" && !link.href && link.underline === "none"),
	JSON.stringify(linkLooks),
);

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
// Close before sweeping: on Windows, deleting userData while Electron is
// still tearing down loses the EBUSY race even with rmRetry.
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
