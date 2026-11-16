/**
 * Manual QA — AI Chat: a streamed message stays on screen while the run thinks, every turn's sources stay one click away in
 * the right sidebar and scroll the text to where they are cited, and the product is named "AI Chat" (real app).
 *
 * Part A seeds a stored two-turn chat (turn 1 cites sources 1-5, turn 2 cites 6-10) and drives the real evidence tabs.
 * Part B runs the real librarian agent against a scripted loopback model, so what the model writes before a tool call
 * is known, and samples the panel while the run thinks. Real mouse and keyboard input.
 *
 * POSIX only (a shell stub for MinSync, a scripted shell call). Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-chat-evidence-stream.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-chat-evidence-stream");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-ai-chat-stream-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const USER_DATA = join(WORK, "user-data");
mkdirSync(DOCS, { recursive: true });
// pi's bash tool refuses to run from a missing working directory; onboarding creates the workspace in a real profile.
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
// No MinSync here: a stub that exits at once keeps the index out of the way of the scenarios.
writeMinsyncStub(join(AUTORAG_HOME, "bin"));
const file = (name) => join(DOCS, name);
const seed = () => {
	writeFileSync(file("old-draft.txt"), "stale draft\n");
	writeFileSync(file("report-q3.txt"), "Q3 revenue was 120.\n");
	writeFileSync(file("report-q4.txt"), "Q4 revenue was 150.\n");
};
seed();

// ── The scripted model: an OpenAI-compatible chat-completions endpoint on loopback. ──
const queue = [];
const seen = [];
const frame = (delta, finish) =>
	`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (url.pathname === "/__script") {
			queue.splice(0, queue.length, ...JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(204).end();
			return;
		}
		if (url.pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		// The decision model (jev.backend "sllm") asks its typed questions through the `submit_decisions` tool: answer them the plain
		// way, like test/baseline-jev.ts (local route, always verify, keep every citation, no file change approved on its own).
		const decisionTool = (body.tools ?? []).find((tool) => tool.function?.name === "submit_decisions");
		if (decisionTool !== undefined) {
			const asked = decisionTool.function.parameters?.properties?.answers?.properties ?? {};
			const answers = {};
			for (const [key, schema] of Object.entries(asked)) {
				const shares = schema.properties?.probabilities?.properties;
				if (shares === undefined) {
					answers[key] = { yes: key === "follow_up" || key.startsWith("citation:") || key.startsWith("citation_") || key.startsWith("permission_") ? 1 : 0, confidence: 1 };
					continue;
				}
				const labels = Object.keys(shares);
				const winner = key === "route" && labels.includes("local") ? "local" : key === "permission_gate" && labels.includes("deny") ? "deny" : labels[0];
				answers[key] = { probabilities: Object.fromEntries(labels.map((label) => [label, label === winner ? 1 : 0])), confidence: 1 };
			}
			const call = { index: 0, id: "call_decision", type: "function", function: { name: "submit_decisions", arguments: JSON.stringify({ answers }) } };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(frame({ role: "assistant", tool_calls: [call] }, null));
			res.write(frame({}, "tool_calls"));
			res.end("data: [DONE]\n\n");
			return;
		}
		const step = queue.shift() ?? { text: "(nothing scripted)" };
		seen.push({
			tools: (body.tools ?? []).map((tool) => tool.function?.name),
			system: body.messages?.find((message) => message.role === "system")?.content ?? "",
			messages: body.messages ?? [],
			step: step.tool ?? "text",
		});
		void (async () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (step.delayMs) await sleep(step.delayMs);
			// A step may carry the words the model writes before it calls a tool (a progress note) and the call itself.
			if (step.tool && step.text) res.write(frame({ role: "assistant", content: step.text }, null));
			if (step.tool) {
				const call = { index: 0, id: `call_${seen.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } };
				res.write(frame({ role: "assistant", tool_calls: [call] }, null));
				res.write(frame({}, "tool_calls"));
			} else {
				res.write(frame({ role: "assistant", content: step.text }, null));
				res.write(frame({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		})();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;
const script = (steps) => {
	queue.splice(0, queue.length, ...steps);
	seen.length = 0;
};
/** Text of every tool message the model was sent, newest request last. */
const toolResults = () => seen.flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))));

const QA_MODEL = { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 };
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			jev: { backend: "sllm", sllm: { model: QA_MODEL } },
			webSearch: false,
			queryDecomposition: false,
			model: QA_MODEL,
		},
		null,
		2,
	)}\n`,
);

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	server.close();
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

const APP_ENV = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	QA_API_KEY: "qa-key",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	AUTORAG_PERMISSION_MODE: "",
};

// ── Seed a stored chat: turn 1 cites 1-5, turn 2 cites 6-10. ──────────────────
const filler = (label) => Array.from({ length: 9 }, (_, i) => `${label} 문단 ${i + 1}: 근거를 바탕으로 설명하는 줄글입니다. 이 문단은 화면을 스크롤하게 만들기 위해 충분히 길게 씁니다.`).join("\n\n");
const evidenceOf = (numbers, turn) =>
	numbers.map((number) => ({ number, title: `turn${turn}-source-${number}.md`, summary: `근거 ${number}`, source: null, excerpts: [`turn ${turn}의 ${number}번 근거 본문`], confidence: 0.9 }));
const deepOne = `${filler("첫 턴")}\n\n첫 근거 [1] 와 [2], 그리고 중간 근거 [3].\n\n${filler("첫 턴 이어서")}\n\n마지막 근거 [4][5].`;
const deepTwo = `${filler("둘째 턴")}\n\n새 근거 [6][7], 그리고 [8].\n\n${filler("둘째 턴 이어서")}\n\n끝 근거 [9][10].`;
const stamp = new Date().toISOString();
mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
writeFileSync(
	join(USER_DATA, "chat-history", "chats.json"),
	`${JSON.stringify([
		{
			id: "c-two-turns",
			title: "두 턴 근거",
			snippet: "첫 턴",
			updatedAt: stamp,
			messages: [
				{ role: "user", text: "첫 질문", attachments: [], at: stamp },
				{ role: "assistant", sessionId: "s1", quick: { answer: "짧게는 [1][2] 입니다.", evidence: evidenceOf([1, 2], 1) }, deep: { answer: deepOne, evidence: evidenceOf([1, 2, 3, 4, 5], 1) }, stopped: false, at: stamp },
				{ role: "user", text: "둘째 질문", attachments: [], at: stamp },
				{ role: "assistant", sessionId: "s2", quick: null, deep: null, stopped: false, at: stamp },
			],
		},
	], null, 2)}\n`,
);
// The second turn is stored as one phase (what a run that skipped verification keeps): its answer is the Quick one.
{
	const path = join(USER_DATA, "chat-history", "chats.json");
	const chats = JSON.parse(readFileSync(path, "utf8"));
	chats[0].messages[3] = { role: "assistant", sessionId: "s2", quick: { answer: deepTwo, evidence: evidenceOf([6, 7, 8, 9, 10], 2) }, deep: null, stopped: false, at: stamp };
	writeFileSync(path, `${JSON.stringify(chats, null, 2)}\n`);
}

app = await launchFinder({ userDataDir: USER_DATA, env: APP_ENV });
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
const shot = async (name) => {
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};

// ── The product is named AI Chat. ─────────────────────────────────────────
const favorites = await page.locator(".sidebar__item-label").allInnerTexts();
check("the sidebar row is AI Chat", favorites[0] === "AI Chat", JSON.stringify(favorites.slice(0, 3)));
check("no label still says AI Search", !(await page.locator("body").innerText()).includes("AI Search"));
await openAiSearch(page);
const panel = page.locator(AI_PANEL);
check("the panel is titled AI Chat", (await panel.locator("strong").first().innerText()) === "AI Chat", await panel.locator("strong").first().innerText());
const composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
const body = panel.locator(".ai-body");
const bodyText = async () => (await body.innerText().catch(() => "")).replace(/\n+/g, " | ");

// ── Part A: sources of every turn, and the scroll to where they are cited. ──
await panel.locator('button[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await panel.locator("[data-cite-scope]").first().waitFor();
const tabsLabel = async () => (await page.locator(".evidence-tab").allInnerTexts()).join(",");
await page.waitForFunction(() => document.querySelectorAll(".evidence-tab").length > 0);
check("the sidebar lists the sources of both turns: 1-10", (await tabsLabel()) === "1,2,3,4,5,6,7,8,9,10", await tabsLabel());
await shot("01-evidence-tabs-both-turns");

/** Whether the citation chip `number` of text block `scope` is inside the visible part of the chat body. */
const visibleCite = (scope, number) =>
	page.evaluate(
		({ scope, number }) => {
			const bodyBox = document.querySelector('section[aria-label="AI Chat"]:not([aria-hidden="true"]) .ai-body')?.getBoundingClientRect();
			const cite = document.querySelector(`section[aria-label="AI Chat"]:not([aria-hidden="true"]) [data-cite-scope="${scope}"] [data-cite="${number}"]`);
			if (!bodyBox || !cite) return null;
			const box = cite.getBoundingClientRect();
			return box.top >= bodyBox.top - 1 && box.bottom <= bodyBox.bottom + 1;
		},
		{ scope, number },
	);
const evidenceTab = (number) => page.locator(".evidence-tab", { hasText: new RegExp(`^${number}$`) });
const settle = () => page.waitForTimeout(1200);

await evidenceTab(7).click();
await settle();
check("source 7 (turn 2) opens its card", (await page.locator(".inspector-half").innerText()).includes("turn2-source-7.md"));
check("picking 7 scrolls the text to where turn 2 cites it", (await visibleCite("1:quick", 7)) === true);
await shot("02-picked-7");

await evidenceTab(1).click();
await settle();
check("source 1 (turn 1) opens straight away, with turn 2's sources still listed", (await page.locator(".inspector-half").innerText()).includes("turn1-source-1.md") && (await tabsLabel()) === "1,2,3,4,5,6,7,8,9,10", await tabsLabel());
check("picking 1 scrolls up to where turn 1 cites it", (await visibleCite("0:deep", 1)) === true);
check("turn 2's citation is no longer the one in view", (await visibleCite("1:quick", 7)) === false);
await shot("03-picked-1-scrolled-up");

await evidenceTab(10).click();
await settle();
check("picking 10 scrolls back down to the end of turn 2", (await visibleCite("1:quick", 10)) === true);
// Picking a source again after scrolling away from it scrolls again.
await body.evaluate((node) => { node.scrollTop = 0; });
await page.waitForTimeout(300);
await evidenceTab(10).click();
await settle();
check("picking the same source again scrolls to it again", (await visibleCite("1:quick", 10)) === true);

// A source cited in the Quick text of turn 1 is also reachable.
await evidenceTab(2).click();
await settle();
check("source 2 scrolls to turn 1's text", (await visibleCite("0:deep", 2)) === true || (await visibleCite("0:quick", 2)) === true);

// ── Part B: what streamed stays while the run goes on. ───────────────────
await panel.locator('button[aria-label="New chat"]').click();
const type = async (text) => {
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
};
const done = () => page.waitForFunction(() => document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 60_000 });

// B1. The Quick answer stays while verification thinks.
script([{ text: "The launch is on May 3." }, { text: "Verifying.", delayMs: 3500 }, { text: "Deep: the launch is May 3." }]);
await type("when is the launch");
await page.waitForFunction(() => document.querySelector(".ai-body")?.textContent?.includes("The launch is on May 3."), null, { timeout: 30_000 });
let kept = true;
for (let i = 0; i < 6; i += 1) {
	await sleep(400);
	if (!(await bodyText()).includes("The launch is on May 3.")) kept = false;
}
check("the Quick answer stays on screen while the Deep phase thinks", kept, await bodyText());
await shot("04-quick-stays");
await done();

// B2. A follow-up whose message streams text and then calls a tool: that text is not taken back.
const NOTE = "I will list the folder to check the dates.";
script([{ text: NOTE, tool: "bash", args: { i: "Listing the folder", command: "sleep 3; ls" } }, { text: "The final follow-up answer.", delayMs: 600 }]);
await type("now check the dates");
await page.waitForFunction((note) => document.querySelector(".ai-body")?.textContent?.includes(note), NOTE, { timeout: 30_000 });
let noteStayed = true;
const samples = [];
for (let i = 0; i < 6; i += 1) {
	await sleep(400);
	const text = await bodyText();
	samples.push(text.slice(-120));
	if (!text.includes(NOTE)) noteStayed = false;
}
check("the message streamed before the tool call stays while the tool runs and the model thinks", noteStayed, JSON.stringify(samples.at(-1)));
await shot("05-note-stays-during-tool");
await done();
const finalText = await bodyText();
check("the final answer comes below it, and the note is still there", finalText.includes(NOTE) && finalText.includes("The final follow-up answer.") && finalText.indexOf(NOTE) < finalText.indexOf("The final follow-up answer."), finalText.slice(-220));
check("the note is not shown twice", finalText.split(NOTE).length === 2, String(finalText.split(NOTE).length - 1));
await shot("06-note-and-answer");

// B3. The same chat opened again from History shows the same text: what was stored is what was streamed.
await panel.locator('button[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await page.waitForTimeout(800);
const restored = await bodyText();
check("a chat opened from History shows the note and the answer", restored.includes(NOTE) && restored.includes("The final follow-up answer."), restored.slice(-220));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
