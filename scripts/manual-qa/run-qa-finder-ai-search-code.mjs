/**
 * Manual QA — syntax highlighting of fenced code in AI Search answers and in
 * evidence excerpts, in the real app.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose Quick answer carries fences in Python, TypeScript, JSON,
 * shell (`bash`), an unknown language, and no language, plus markup-looking code
 * (`<img onerror>`); its evidence excerpt carries a ```json fence. Loading the
 * chat through the history surface drives only the real render path, then checks:
 *
 *   - a fence with a known language is coloured by highlight.js tokens, and the
 *     computed colours are the Quick Look palette (`--ql-syntax-*`);
 *   - the coloured block's text is exactly the source (copy/paste is unchanged);
 *   - an untagged or unknown-language fence stays plain text, with no tokens;
 *   - code that looks like HTML never becomes DOM;
 *   - the dark appearance recolours the same tokens;
 *   - opening a cited source colours its ```json fence in the Evidence panel.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-code.mjs
 * Prereq: bun run build.
 */
import { tmpdir } from "node:os";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-code");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const USER_DATA = join(tmpdir(), `ai-code-qa-${Date.now().toString(36)}`);
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

const PY = 'def greet(name):\n    return f"hi {name}"  # say hi';
const TS = "export const answer: number = 42;\ninterface User { id: string }";
const SHELL = "git commit -m \"fix\" && echo 'done'";
const MARKUP = '<img src=x onerror="window.__pwned = 1"><script>window.__pwned = 2</script>';

const evidence = [
	{
		number: 1,
		title: "config.md",
		summary: "설정 예시입니다.",
		source: join(USER_DATA, "config.md"),
		excerpts: ['설정 파일은 다음과 같습니다.\n```json\n{"retries": 3, "name": "dazzi"}\n```'],
		confidence: 0.9,
	},
];
const quickAnswer = [
	"예시 코드입니다. [1]",
	"",
	"```python",
	PY,
	"```",
	"",
	"```typescript",
	TS,
	"```",
	"",
	"```bash",
	SHELL,
	"```",
	"",
	"```brainfuck",
	"++[>+<-]",
	"```",
	"",
	"```",
	"def not_tagged(): pass",
	"```",
	"",
	"```html",
	MARKUP,
	"```",
	"",
	"끝.",
].join("\n");
const now = new Date().toISOString();
const record = {
	id: "c-code-1",
	title: "코드 하이라이트 확인",
	snippet: "예시 코드입니다",
	updatedAt: now,
	messages: [
		{ role: "user", text: "예시 코드 보여줘", attachments: [], at: now },
		{
			role: "assistant",
			sessionId: "qa-code-session",
			quick: { answer: quickAnswer, evidence, meta: "0.4s · 1 source" },
			deep: { answer: "", evidence: [], meta: "" },
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
await quick.waitFor({ state: "visible" });
await page.waitForTimeout(500);
await page.screenshot({ path: join(EVIDENCE, "01-light.png") });

const blocks = quick.locator("pre");
check("six fenced blocks render as <pre>", (await blocks.count()) === 6, String(await blocks.count()));
const py = blocks.nth(0);
const ts = blocks.nth(1);
const sh = blocks.nth(2);
const unknown = blocks.nth(3);
const untagged = blocks.nth(4);
const markup = blocks.nth(5);

check("python: the keyword is a token", (await py.locator(".hljs-keyword").first().textContent()) === "def");
check("python: strings and comments are tokens", (await py.locator(".hljs-string").count()) > 0 && (await py.locator(".hljs-comment").count()) > 0);
check("python: text is exactly the source", (await py.evaluate((el) => el.textContent)) === PY);
check("typescript: keywords and the number are tokens", (await ts.locator(".hljs-keyword").count()) >= 2 && (await ts.locator(".hljs-number").count()) === 1);
check("typescript: text is exactly the source", (await ts.evaluate((el) => el.textContent)) === TS);
check("bash: the string is a token", (await sh.locator(".hljs-string").count()) > 0);
check("bash: text is exactly the source", (await sh.evaluate((el) => el.textContent)) === SHELL);
check("unknown language stays plain (no tokens)", (await unknown.locator("span").count()) === 0 && (await unknown.textContent()) === "++[>+<-]");
check("untagged fence stays plain (no tokens)", (await untagged.locator("span").count()) === 0 && (await untagged.textContent()) === "def not_tagged(): pass");
check("markup-looking code is text, never DOM", (await markup.locator("img, script").count()) === 0 && (await markup.evaluate((el) => el.textContent)) === MARKUP);
check("no injected script ran", (await page.evaluate(() => window.__pwned)) === undefined);

const colorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
const paletteColor = (token) =>
	page.evaluate((name) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, token);
const keywordLight = await colorOf(py.locator(".hljs-keyword").first());
const stringLight = await colorOf(py.locator(".hljs-string").first());
const commentLight = await colorOf(py.locator(".hljs-comment").first());
const plainLight = await colorOf(untagged);
check("keyword colour is the Quick Look keyword colour", keywordLight === (await paletteColor("--ql-syntax-keyword")), `${keywordLight}`);
check("string colour is the Quick Look string colour", stringLight === (await paletteColor("--ql-syntax-string")), `${stringLight}`);
check("comment colour is the Quick Look comment colour", commentLight === (await paletteColor("--ql-syntax-comment")), `${commentLight}`);
check("tokens differ from plain code ink", keywordLight !== plainLight && stringLight !== plainLight, `${keywordLight} / ${stringLight} / ${plainLight}`);
check("keywords are bold like Quick Look", (await py.locator(".hljs-keyword").first().evaluate((el) => Number(getComputedStyle(el).fontWeight))) >= 600);

await page.evaluate(() => document.documentElement.setAttribute("data-appearance", "dark"));
await page.waitForTimeout(400);
const keywordDark = await colorOf(py.locator(".hljs-keyword").first());
check("dark appearance recolours keywords", keywordDark !== keywordLight && keywordDark === (await paletteColor("--ql-syntax-keyword")), `${keywordLight} -> ${keywordDark}`);
await page.screenshot({ path: join(EVIDENCE, "02-dark.png") });
await page.evaluate(() => document.documentElement.removeAttribute("data-appearance"));
await page.waitForTimeout(300);

await quick.locator(".cite").first().click();
const excerptCode = page.locator('.inspector-half[aria-label="Evidence"] .evidence__block--code');
await excerptCode.first().waitFor({ state: "visible" });
check("evidence excerpt: the json fence has tokens", (await excerptCode.first().locator(".hljs-attr").count()) > 0 && (await excerptCode.first().locator(".hljs-number").count()) === 1);
check("evidence excerpt: text is exactly the source", (await excerptCode.first().evaluate((el) => el.textContent)) === '{"retries": 3, "name": "dazzi"}');
await page.screenshot({ path: join(EVIDENCE, "03-evidence.png") });

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
