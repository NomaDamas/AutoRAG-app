/**
 * Manual QA — web links in AI Search answers and evidence excerpts, in the real app.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose Quick answer carries markdown links, bare URLs (followed
 * by a Korean particle and by a period), a bold-wrapped link, a link in a list
 * item and a table cell, a `[1](url)` link, a very long URL, and non-web
 * destinations (`javascript:`, `file:`); the evidence excerpt carries a link as
 * well. Loading the chat through the history surface drives only the real
 * render path. `shell.openExternal` is replaced in the main process, so no
 * browser opens and every URL the app hands to the OS is recorded. Checks:
 *
 *   - every http(s) link is an <a> showing its label (or the URL as written)
 *     with the normalized href; a particle or final period stays outside it;
 *   - javascript: / file: destinations never become links;
 *   - links look like links (underline, accent colour, also when bold);
 *   - a long URL wraps inside the answer instead of overflowing;
 *   - click, Cmd/Ctrl-click, middle click and Enter on a focused link hand the
 *     URL to the OS browser, and the Finder window never navigates or opens
 *     another window;
 *   - a [n] citation chip beside a link still opens its evidence, and a link
 *     in the evidence excerpt opens in the OS browser too.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-links.mjs
 * Prereq: bun run build.
 */
import { tmpdir } from "node:os";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { MOD, rmRetry } from "./platform.mjs";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-links");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const USER_DATA = join(tmpdir(), `ai-links-qa-${Date.now().toString(36)}`);
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

const LONG = `https://example.com/${"a".repeat(180)}`;
const evidence = [
	{
		number: 1,
		title: "press.md",
		summary: "보도자료 요약입니다.",
		source: join(USER_DATA, "press.md"),
		excerpts: ["출처: [보도자료](https://example.com/press) 와 https://example.com/raw 를 참고하세요."],
		confidence: 0.9,
	},
];
const quickAnswer = [
	"공식 문서는 [Dazzi 문서](https://example.com/docs)를 참고하세요. [1]",
	"**[굵은 링크](https://example.com/bold)** 와 홈페이지 https://example.com/home에서 확인하세요.",
	"문장 끝 주소는 https://example.com/end.",
	"- 목록 항목 [목록 링크](https://example.com/list)",
	"[1](https://example.com/numeric) 숫자 라벨 링크",
	"위험한 [x](javascript:alert(1)) 와 [파일](file:///etc/hosts) 는 링크가 아닙니다.",
	"",
	"| 이름 | 링크 |",
	"|---|---|",
	"| 셀 | https://example.com/cell |",
	"",
	LONG,
].join("\n");
const deepAnswer = "깊은 답변의 자동 링크 <https://example.com/deep> 입니다.";
const now = new Date().toISOString();
const record = {
	id: "c-links-1",
	title: "링크 렌더링 확인",
	snippet: "공식 문서는",
	updatedAt: now,
	messages: [
		{ role: "user", text: "링크 모아줘", attachments: [], at: now },
		{
			role: "assistant",
			sessionId: "qa-links-session",
			quick: { answer: quickAnswer, evidence, meta: "0.4s · 1 source" },
			deep: { answer: deepAnswer, evidence, meta: "1 source read · 2s" },
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
// No browser may open during QA: record what the app hands to the OS instead.
await app.evaluate(({ shell }) => {
	globalThis.__opened = [];
	shell.openExternal = async (url) => {
		globalThis.__opened.push(url);
	};
});
const opened = () => app.evaluate(() => globalThis.__opened.slice());
const windowCount = () => app.windows().length;
const startUrl = page.url();
const startWindows = windowCount();

await openAiSearch(page);
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().click();
const quick = page.locator(".assistant-msg .assistant-prose").nth(0);
const deep = page.locator(".assistant-msg .assistant-prose").nth(1);
await deep.waitFor({ state: "visible" });
await page.waitForTimeout(500);
await page.screenshot({ path: join(EVIDENCE, "01-answers.png") });

const links = quick.locator("a");
const hrefs = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
const texts = await links.allTextContents();
const WANT_HREFS = [
	"https://example.com/docs",
	"https://example.com/bold",
	"https://example.com/home",
	"https://example.com/end",
	"https://example.com/list",
	"https://example.com/numeric",
	"https://example.com/cell",
	LONG,
];
check("every http(s) link in the quick answer is an <a> with its href", JSON.stringify(hrefs) === JSON.stringify(WANT_HREFS), JSON.stringify(hrefs).slice(0, 300));
check("a markdown link shows its label, a bare URL shows itself", texts[0] === "Dazzi 문서" && texts[2] === "https://example.com/home" && texts[5] === "1", JSON.stringify(texts.slice(0, 6)));
const quickText = await quick.innerText();
check("the Korean particle and the final period stay outside the link", quickText.includes("https://example.com/home에서") && quickText.includes("https://example.com/end.") && texts[3] === "https://example.com/end");
check("javascript: and file: destinations stay as written, never links", quickText.includes("[x](javascript:alert(1))") && quickText.includes("[파일](file:///etc/hosts)") && !hrefs.some((href) => /^(?:javascript|file):/iu.test(href ?? "")));
check("markdown link syntax is not printed for real links", !quickText.includes("](https://"), quickText.replace(/\s+/g, " ").slice(0, 200));
check("the table cell holds a link", (await quick.locator("table a").count()) === 1);
check("the list item holds a link", (await quick.locator("a", { hasText: "목록 링크" }).count()) === 1);
check("the deep answer's <url> autolink renders without its angle brackets", (await deep.locator("a").count()) === 1 && (await deep.locator("a").textContent()) === "https://example.com/deep" && !(await deep.innerText()).includes("<"));

const look = await links.nth(0).evaluate((node) => {
	const style = getComputedStyle(node);
	return { underline: style.textDecorationLine, color: style.color, body: getComputedStyle(node.closest("p")).color, cursor: style.cursor };
});
check("a link is underlined, accent-coloured, and shows a pointer", look.underline.includes("underline") && look.color !== look.body && look.cursor === "pointer", JSON.stringify(look));
const bold = await links.nth(1).evaluate((node) => ({ link: getComputedStyle(node).color, strong: getComputedStyle(node.querySelector("strong")).color, weight: getComputedStyle(node.querySelector("strong")).fontWeight }));
check("a bold link label keeps the link colour and stays bold", bold.link === bold.strong && Number(bold.weight) >= 600, JSON.stringify(bold));
const overflow = await links.nth(7).evaluate((node) => {
	const block = node.closest("p");
	return { scroll: block.scrollWidth, client: block.clientWidth };
});
check("the long URL wraps inside the answer", overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
await links.nth(0).hover();
await page.screenshot({ path: join(EVIDENCE, "02-link-hover.png") });
await links.nth(7).scrollIntoViewIfNeeded();
await page.screenshot({ path: join(EVIDENCE, "03-long-url.png") });

// Mouse and keyboard, as a user would.
await links.nth(0).click();
check("a click hands the URL to the OS browser", JSON.stringify(await opened()) === JSON.stringify(["https://example.com/docs"]), JSON.stringify(await opened()));
await links.nth(1).click({ modifiers: [MOD] });
await links.nth(2).click({ button: "middle" });
await links.nth(3).focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const afterInput = await opened();
check(
	"Cmd/Ctrl-click, middle click, and Enter each open the link in the OS browser",
	JSON.stringify(afterInput) === JSON.stringify(["https://example.com/docs", "https://example.com/bold", "https://example.com/home", "https://example.com/end"]),
	JSON.stringify(afterInput),
);
check("the Finder window did not navigate and no window opened", page.url() === startUrl && windowCount() === startWindows, `${page.url() === startUrl ? "same url" : page.url()} windows ${startWindows}->${windowCount()}`);

// A citation chip beside a link still opens its evidence, and the excerpt's links work too.
const before = (await opened()).length;
await quick.locator(".cite").first().click();
const evTitle = (await page.locator('.inspector-half[aria-label="Evidence"] .preview-title').textContent().catch(() => "")) ?? "";
check("a citation chip still opens its source in the Evidence panel", evTitle.startsWith("1.") && (await opened()).length === before, evTitle.trim());
const excerptLinks = page.locator('.inspector-half[aria-label="Evidence"] a');
await excerptLinks.first().waitFor({ state: "visible" });
await page.screenshot({ path: join(EVIDENCE, "04-evidence-links.png") });
const excerptHrefs = await excerptLinks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
check("the evidence excerpt renders its markdown link and bare URL as links", JSON.stringify(excerptHrefs) === JSON.stringify(["https://example.com/press", "https://example.com/raw"]), JSON.stringify(excerptHrefs));
await excerptLinks.first().click();
check("an evidence excerpt link opens in the OS browser", (await opened()).at(-1) === "https://example.com/press", JSON.stringify((await opened()).slice(-2)));
check("still the same window and page after every click", page.url() === startUrl && windowCount() === startWindows);

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
