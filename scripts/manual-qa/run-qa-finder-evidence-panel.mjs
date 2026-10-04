/**
 * Manual QA — AI Search markdown answers + the Evidence half of the real
 * AI Finder app, per the v7 Bloom design reference.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose Quick/Deep answers carry markdown (bold, headings,
 * lists, quote, inline code) and numbered citations, and whose evidence items
 * point at REAL fixture files on disk. Loading the chat exercises only the
 * real render path (loadHistory -> publish -> Inspector evidence half), then
 * drives: citation chips, evidence tabs, background-free feedback (toast),
 * title -> new-tab reveal with file selection, ⌘E toggle, and the datasource
 * virtual-source title guard.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-evidence-panel.mjs
 * Prereq: bun run build
 */
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-evidence-panel");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const RUN_ID = `ulw-evidence-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const DOCS = join(process.env.HOME, "Documents", RUN_ID);
const POLICY = join(DOCS, "한글 공백 정책.md");
const MEMO = join(DOCS, "qa-evidence-memo.md");
const FOLDER = basename(DOCS);

let app;
let swept = false;
const sweep = () => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	rmSync(USER_DATA, { recursive: true, force: true });
	rmSync(DOCS, { recursive: true, force: true });
	log(`cleanup: removed ${USER_DATA} and ${DOCS}; app closed`);
};
process.on("exit", sweep);

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
		feedbackId: "fb-1",
	},
	{
		number: 2,
		title: "qa-evidence-memo.md",
		summary: "승인 체인 첨부 메모입니다.",
		source: MEMO,
		excerpts: ["승인 체인 원본 첨부 필수."],
		confidence: 0.81,
		feedbackId: "fb-2",
	},
	{
		number: 3,
		title: "채널 스레드 정리",
		summary: "외부 채널에서 온 데이터소스 근거입니다.",
		source: "/kakao/ulw-qa/chunks/7",
		excerpts: ["스레드에서 합의된 내용 요약."],
		confidence: 0.44,
		feedbackId: "fb-3",
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
				answer: "## 승인 규칙 요약\n환불 예외는 지급 전 **임원 승인**이 필요합니다. [1][2]\n\n- 예외는 자동 반려되지 않습니다 [2]\n- 긴급 예외도 승인 생략 불가 [1]\n\n> 내규 인용 구문이 함께 표시됩니다.\n\n관련 명령은 `bun run qa` 입니다.",
				evidence: evidenceAll,
				meta: "3 sources read · 2s",
			},
			stopped: false,
			at: new Date().toISOString(),
		},
	],
};
writeFileSync(join(USER_DATA, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);

// The feedback lane builds the real main-process agent; point it at a throwaway
// config so the construction succeeds and no workspace state leaks into the repo.
mkdirSync(join(USER_DATA, "workspace"), { recursive: true });
const QA_CONFIG = join(USER_DATA, "qa-config.json");
writeFileSync(QA_CONFIG, JSON.stringify({
	searchPaths: [DOCS],
	workspacePath: join(USER_DATA, "workspace"),
	memoryPath: join(USER_DATA, "workspace", "memory.json"),
	minSync: { enabled: false },
	jikji: false,
	model: {
		provider: "openrouter",
		id: "deepseek/deepseek-v4.1-flash",
		baseUrl: "https://openrouter.ai/api/v1",
		api: "openai-completions",
		apiKeyEnv: "OPENROUTER_API_KEY",
	},
}, null, 2));

app = await launchFinder({ userDataDir: USER_DATA, env: { AUTORAG_CONFIG: QA_CONFIG } });
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector('[aria-label="Ask AutoRAG"]');
log("app ready");

const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';
/** v7 renders the loaded chat as two prose blocks: Quick first, Deep second. */
const quickProse = page.locator(".assistant-msg .assistant-prose").nth(0);
const deepProse = page.locator(".assistant-msg .assistant-prose").nth(1);

// 1. Open the seeded chat through the real history surface.
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await deepProse.waitFor({ state: "visible" });
// The evidence half is on-demand now: a restored answer alone must not paint it.
check("evidence stays hidden until a citation is clicked", (await page.locator(EVIDENCE_HALF).count()) === 0, `count=${await page.locator(EVIDENCE_HALF).count()}`);
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

check("the Evidence half stays hidden until a citation is clicked", (await page.locator(EVIDENCE_HALF).count()) === 0);
// 2. Citation click -> inspector evidence half, selected tab, title reveal.
await chipOf(2).click();
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab.bg-accent`);
const activeCite = await quickProse.locator(".cite.active").allTextContents();
const activeTab = (await page.locator(`${EVIDENCE_HALF} .evidence-tab.bg-accent`).textContent())?.trim();
const evTitle = (await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "";
const revealBtn = page.locator(`${EVIDENCE_HALF} .preview-title[title="Show in Finder"]`);
check("the cited chip lights up with the active accent", JSON.stringify(activeCite) === JSON.stringify(["2"]), JSON.stringify(activeCite));
check("the evidence half opens on evidence 2", activeTab === "2" && evTitle.startsWith("2. "), `tab=${activeTab} title=${evTitle.slice(0, 32)}`);
check("the evidence title is the Show-in-Finder action", (await revealBtn.count()) === 1, `count=${await revealBtn.count()}`);
const detail = (await page.locator(`${EVIDENCE_HALF} .preview-sub`).textContent()) ?? "";
check("the detail shows confidence without the source path", detail.includes("관련도 81%") && !detail.includes("qa-evidence-memo.md"), detail.replace(/\s+/g, " ").slice(0, 120));
check("the Evidence header, eye, and close controls are removed", (await page.locator(`${EVIDENCE_HALF} .inspector-head`).count()) === 0 && (await page.locator(`${EVIDENCE_HALF} button[aria-label="Quick Look"]`).count()) === 0 && (await page.locator(`${EVIDENCE_HALF} button[aria-label="근거 닫기"]`).count()) === 0, "header controls absent");
await page.screenshot({ path: join(EVIDENCE, "02-evidence-panel.png") });

// 2b. Layout geometry per the v7 reference (evidence half = lower 50% of the
// column, numbered tabs first, transparent feedback controls, subtle inspector surface).
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
        finder: box('section[aria-label="Finder"]'),
        tabs: box(`${half} .evidence-tabs`),
        tab: box(`${half} .evidence-tab`),
        vote: box(`${half} .feedback button`),
        voteStyle: style(`${half} .feedback button`, ["backgroundColor", "borderTopWidth", "borderLeftWidth"]),
        inspectorBg: style(".inspector", ["backgroundColor"]),
    };
}, EVIDENCE_HALF);
const ratio = geometry.panel.height / geometry.finder.height;
check("the open evidence half takes the lower 50% of the column", Math.abs(ratio - 0.5) < 0.03, `ratio=${ratio.toFixed(3)}`);
check("evidence tabs are the first content row", geometry.tabs !== null && geometry.tab !== null && geometry.tabs.top <= geometry.tab.top + 1, JSON.stringify({ tabs: geometry.tabs, tab: geometry.tab }));
check("feedback votes have no box background or border", geometry.voteStyle.backgroundColor === "rgba(0, 0, 0, 0)" && geometry.voteStyle.borderTopWidth === "0px" && geometry.voteStyle.borderLeftWidth === "0px", JSON.stringify(geometry.voteStyle));
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

// 4. Thumbs-up feedback records through the real bridge and toasts.
await page.locator(`${EVIDENCE_HALF} button[title="이 근거가 도움이 됨"]`).click();
await page.waitForSelector(".toast", { timeout: 8000 });
const toastText = (await page.locator(".toast").textContent()) ?? "";
check("thumbs-up toast follows the reference copy", toastText.includes("근거 1 — 도움이 됨으로 기록했습니다"), toastText.trim());
await sleep(300);
const voteStyle = await page.locator(`${EVIDENCE_HALF} button[title="이 근거가 도움이 됨"]`).evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, borderTopWidth: s.borderTopWidth, borderLeftWidth: s.borderLeftWidth, color: s.color };
});
check("the active vote keeps the transparent Apple-style control", voteStyle.bg === "rgba(0, 0, 0, 0)" && voteStyle.borderTopWidth === "0px" && voteStyle.borderLeftWidth === "0px", JSON.stringify(voteStyle));
await page.screenshot({ path: join(EVIDENCE, "03-feedback.png") });
// 5. Title click opens the enclosing folder in a NEW tab and selects the source row.
const tabsBefore = await page.locator(".tabs .tab").count();
await page.locator(`${EVIDENCE_HALF} button[title="Show in Finder"]`).click();
await page.waitForFunction((count) => document.querySelectorAll(".tabs .tab").length === count + 1, tabsBefore);
await sleep(400);
const newTabTitle = (await page.locator(".tabs .tab--active .tab__title").textContent()) ?? "";
const sourceRow = page.locator('[role="row"]').filter({ hasText: basename(POLICY).normalize("NFD") }).first();
check("the title opens the source folder in a new tab", newTabTitle === FOLDER, `tab="${newTabTitle}" want="${FOLDER}"`);
check("the title selects and flashes a Korean filename with spaces and different Unicode normalization", (await sourceRow.getAttribute("aria-selected")) === "true" && (await page.locator(".row.bg-accent-flash").count()) >= 1);
await page.screenshot({ path: join(EVIDENCE, "04-new-tab-reveal.png") });

// 6. ⌘E hides and reopens the evidence half without a persistent header.
await page.keyboard.press("Meta+e");
await page.waitForFunction((half) => document.querySelector(half) === null, EVIDENCE_HALF);
check("⌘E hides the evidence half", true);
await page.screenshot({ path: join(EVIDENCE, "05-collapsed.png") });
await page.keyboard.press("Meta+e");
await page.waitForFunction((half) => document.querySelector(half) !== null, EVIDENCE_HALF);
check("⌘E reopens the evidence half", true);

// 7. Datasource evidence has no local Finder title action.
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^3$/ }).first().click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("3. "), `${EVIDENCE_HALF} .preview-title`);
check("a virtual datasource title is not a local Finder action", (await page.locator(`${EVIDENCE_HALF} .preview-title[title="Show in Finder"]`).count()) === 0);
await page.screenshot({ path: join(EVIDENCE, "06-datasource.png") });


log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
sweep();
process.exitCode = failures.length === 0 ? 0 : 1;
