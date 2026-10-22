/**
 * Manual QA — markdown pipe tables in AI Search answers, in the real app.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose Quick answer carries a GFM pipe table (alignment, bold,
 * citation chips, an in-cell <br>) and whose Deep answer carries a headerless
 * table plus a pipe inside a code fence. Loading the chat through the history
 * surface drives only the real render path, then checks:
 *
 *   - the table is a <table> with header cells, not literal `|---|` text;
 *   - column alignment, bold, and in-cell line breaks render;
 *   - a citation chip inside a cell opens its source in the Evidence panel, and
 *     one with no matching evidence is dropped;
 *   - the text around the table stays paragraphs;
 *   - a pipe table inside a code fence stays code.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-table.mjs
 * Prereq: bun run build.
 */
import { tmpdir } from "node:os";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-table");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const USER_DATA = join(tmpdir(), `ai-table-qa-${Date.now().toString(36)}`);
mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	try {
		if (patient === true) rmRetry(USER_DATA);
		else rmSync(USER_DATA, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${USER_DATA} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

const evidence = [
	{ number: 1, title: "pro-plan.md", summary: "Pro 플랜 안내입니다.", source: join(USER_DATA, "pro-plan.md"), excerpts: ["Pro 플랜은 월 20달러입니다."], confidence: 0.9 },
	{ number: 2, title: "free-plan.md", summary: "Free 플랜 안내입니다.", source: join(USER_DATA, "free-plan.md"), excerpts: ["Free 플랜은 무료입니다."], confidence: 0.8 },
];
const quickAnswer = [
	"두 플랜을 비교하면 다음과 같습니다.",
	"",
	"| 플랜 | 가격 | 비고 |",
	"|:--|--:|---|",
	"| **Pro** [1] | 20 | 팀용<br>연간 결제 |",
	"| Free [2] [9] | 0 | 개인 |",
	"",
	"자세한 내용은 문서를 참고하세요.",
].join("\n");
const deepAnswer = [
	"헤더 없이 잘린 표입니다.",
	"",
	"| 사용 시나리오 | 15 |",
	"| 개발 로드맵 | 18 |",
	"",
	"```",
	"| a | b |",
	"|---|---|",
	"```",
].join("\n");
const now = new Date().toISOString();
const record = {
	id: "c-table-1",
	title: "표 렌더링 확인",
	snippet: "두 플랜을 비교하면",
	updatedAt: now,
	messages: [
		{ role: "user", text: "플랜 비교해줘", attachments: [], at: now },
		{
			role: "assistant",
			sessionId: "qa-table-session",
			quick: { answer: quickAnswer, evidence, meta: "0.4s · 2 sources" },
			deep: { answer: deepAnswer, evidence, meta: "2 sources read · 2s" },
			stopped: false,
			at: now,
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
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().click();
const quick = page.locator(".assistant-msg .assistant-prose").nth(0);
const deep = page.locator(".assistant-msg .assistant-prose").nth(1);
await deep.waitFor({ state: "visible" });
await page.waitForTimeout(500);
await page.screenshot({ path: join(EVIDENCE, "01-answers.png") });

const quickText = await quick.innerText();
check("literal table syntax is not printed", !quickText.includes("|--") && !quickText.includes("| 플랜"), quickText.replace(/\s+/g, " ").slice(0, 160));
check("the quick answer holds one <table>", (await quick.locator("table").count()) === 1);
check("header cells are 플랜 / 가격 / 비고", (await quick.locator("thead th").allTextContents()).join(",") === "플랜,가격,비고", JSON.stringify(await quick.locator("thead th").allTextContents()));
check("the body has two rows", (await quick.locator("tbody tr").count()) === 2);
check("a right-aligned column renders right-aligned", (await quick.locator("thead th").nth(1).evaluate((el) => getComputedStyle(el).textAlign)) === "right");
check("**bold** renders as <strong> in a cell", (await quick.locator("tbody strong").first().textContent()) === "Pro");
check("<br> breaks the cell instead of printing", (await quick.locator("tbody td").nth(2).locator("br").count()) === 1 && !quickText.includes("<br>"));
check("the text around the table stays paragraphs", (await quick.locator("p").count()) === 2);
const chips = await quick.locator("table .cite").allTextContents();
check("citation chips render in cells; an unresolved [9] is dropped", chips.join(",") === "1,2", JSON.stringify(chips));
const wide = await quick.locator("table").evaluate((el) => el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1 || getComputedStyle(el.parentElement).overflowX === "auto");
check("the table is framed so it scrolls instead of overflowing the panel", wide);

check("a headerless table renders without a thead", (await deep.locator("table").count()) === 1 && (await deep.locator("thead").count()) === 0 && (await deep.locator("tbody tr").count()) === 2);
check("a pipe table inside a code fence stays code", (await deep.locator("pre").count()) === 1 && (await deep.locator("pre").textContent()).includes("|---|---|"));
await page.screenshot({ path: join(EVIDENCE, "02-deep.png") });

await quick.locator("table .cite").nth(1).click();
const evTitle = (await page.locator('.inspector-half[aria-label="Evidence"] .preview-title').textContent().catch(() => "")) ?? "";
check("clicking a chip in a cell opens that source in the Evidence panel", evTitle.startsWith("2."), evTitle.trim());
await page.screenshot({ path: join(EVIDENCE, "03-chip-opens-evidence.png") });

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
