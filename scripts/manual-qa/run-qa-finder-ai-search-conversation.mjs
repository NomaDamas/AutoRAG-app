/**
 * Manual QA — one chat is one model conversation, kept across restarts, in the real app.
 *
 * The real app runs end to end (real librarian agent, real pi session, real file-change gate, real preload bridge
 * and renderer). Only the model is scripted: a loopback OpenAI-compatible server records every request, so the lane
 * checks what the model is actually SENT, not just what the panel shows. Real mouse and keyboard input.
 *
 *   1. a follow-up in the same chat reaches the model with the chat's earlier question and answer;
 *   2. after the app is quit and started again, opening the chat from History and asking carries the
 *      conversation on from its session file, and the approval card still appears on the resumed session;
 *   3. a chat whose session file is gone (a chat from before conversations were kept) starts a new conversation
 *      that already holds the chat's finished turns;
 *   4. New chat starts from nothing: the model sees none of the other chat;
 *   5. clearing the history deletes the session files, and a new question works afterwards.
 *
 * POSIX only (a shell stub for MinSync, a scripted `rm`): not part of run-all.mjs. Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-search-conversation.mjs
 *
 * Screenshots land in $QA_OUT (default .omo/evidence/ai-finder-app/qa-ai-search-conversation/). Prereq: bun run build.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-conversation");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-conversation-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const USER_DATA = join(WORK, "user-data");
const SESSIONS = join(USER_DATA, "chat-sessions");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
writeMinsyncStub(join(AUTORAG_HOME, "bin"));
const stale = join(DOCS, "old-draft.txt");
writeFileSync(stale, "stale draft\n");

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
		if (url.pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const step = queue.shift() ?? { text: "(nothing scripted)" };
		seen.push({ messages: body.messages ?? [], step: step.tool ?? "text" });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
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
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;
/** Every model request after this call is recorded from scratch; `answer` is what each of them replies. */
const script = (steps) => {
	queue.splice(0, queue.length, ...steps);
	seen.length = 0;
};
const answers = (text) => script(Array.from({ length: 8 }, () => ({ text })));
/** Everything the model was sent as conversation (system prompts left out), as one string. */
const sentText = () => JSON.stringify(seen.flatMap((request) => request.messages.filter((message) => message.role !== "system")));

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			jev: false,
			webSearch: false,
			queryDecomposition: false,
			model: { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },
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

let page;
let panel;
let composer;
/** Starts the app on the same profile; what survives a restart is only what the app wrote to its user-data folder. */
const start = async () => {
	app = await launchFinder({ userDataDir: USER_DATA, env: APP_ENV });
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (/Error|error TS|not a function|undefined/i.test(text)) log(`[main:err] ${text.slice(0, 300)}`);
	});
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await openAiSearch(page);
	panel = page.locator(AI_PANEL);
	composer = panel.locator('input[aria-label="Ask Dazzi"]');
};
const stop = async () => {
	await app.close();
	app = undefined;
};
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const finished = () =>
	page.waitForFunction(() => document.querySelector('input[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 60_000 });
const ask = async (text) => {
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await finished();
};
const openFromHistory = async (title) => {
	await panel.locator('button[aria-label="Chat history"]').click();
	await panel.locator(".history-item", { hasText: title }).first().click();
	// The list closes once the chat is loaded; then the chat's own first question is on screen.
	await panel.locator(".history").waitFor({ state: "detached" });
	await panel.getByText(title).first().waitFor();
};
const history = () => page.evaluate(() => window.autorag.search.historyList());
const sessionFiles = () => (existsSync(SESSIONS) ? readdirSync(SESSIONS).filter((name) => name.endsWith(".jsonl")) : []);
const indexEntries = () => (existsSync(join(SESSIONS, "index.json")) ? Object.keys(JSON.parse(readFileSync(join(SESSIONS, "index.json"), "utf8")).chats) : []);

await start();
log("app ready");

// ── 1. A follow-up carries the chat's earlier turns to the model. ─────────
answers("Noted: the codename is Heron.");
await ask("My project codename is Heron. Remember it.");
check("the first question reaches the model", sentText().includes("My project codename is Heron"), sentText().slice(0, 200));
answers("Your codename is Heron.");
await ask("What is my project codename?");
check("the follow-up carries the earlier question to the model", sentText().includes("My project codename is Heron. Remember it."), sentText().slice(0, 300));
check("the follow-up carries the earlier answer to the model", sentText().includes("Noted: the codename is Heron."), sentText().slice(0, 300));
await shot("01-follow-up");
const [chat] = await history();
check("the chat is in History with its turns", chat !== undefined && (await page.evaluate((id) => window.autorag.search.historyGet(id), chat.id))?.messages.filter((message) => message.role === "user").length === 2);
check("the chat's conversation file is on disk and indexed", sessionFiles().length === 1 && indexEntries().includes(chat?.id), `${sessionFiles()} ${indexEntries()}`);

// ── 2. After a restart the conversation resumes from its file, and the gate still asks. ──
await stop();
await start();
await openFromHistory(chat.title);
await shot("02-chat-reopened");
answers("Heron, as you said before.");
await ask("And what did I call it earlier?");
check("after a restart the follow-up still carries the earlier question", sentText().includes("My project codename is Heron. Remember it."), sentText().slice(0, 300));
check("after a restart the follow-up still carries the earlier answer", sentText().includes("Your codename is Heron."), sentText().slice(0, 300));
check("it is still one conversation file", sessionFiles().length === 1, `${sessionFiles()}`);

await panel.locator('button[aria-label="File change approval mode"]').click();
await page.locator('[role="menuitemradio"]', { hasText: /^\s*Ask/ }).click();
// A follow-up is a plain turn of the conversation (no Quick/Deep phases): the model's first reply can be the tool call itself.
script([{ tool: "bash", args: { command: `rm ${stale}` } }, { text: "Handled." }]);
await composer.click();
await page.keyboard.type("remove the stale draft");
await page.keyboard.press("Enter");
await panel.locator('[role="alertdialog"]').waitFor();
check("the approval card appears on the resumed conversation", (await panel.locator('[role="alertdialog"]').innerText()).includes(`rm ${stale}`));
await shot("03-approval-on-resumed-chat");
await panel.locator('[role="alertdialog"]').getByRole("button", { name: "Deny", exact: true }).click();
await finished();
check("Deny keeps the file on the resumed conversation", existsSync(stale));
check("the model still saw the earlier turns in the run that asked", sentText().includes("My project codename is Heron. Remember it."));

// ── 3. A chat whose session file is gone starts a conversation that already holds its turns. ──
await stop();
rmSync(SESSIONS, { recursive: true, force: true });
await start();
await openFromHistory(chat.title);
answers("Still Heron.");
await ask("One more time: what is the codename?");
check("a chat with no session file is seeded with its earlier question", sentText().includes("My project codename is Heron. Remember it."), sentText().slice(0, 300));
check("a chat with no session file is seeded with its earlier answer", sentText().includes("Noted: the codename is Heron.") || sentText().includes("Your codename is Heron."), sentText().slice(0, 300));
check("the seeded conversation is kept in a new file", sessionFiles().length === 1 && indexEntries().includes(chat.id), `${sessionFiles()} ${indexEntries()}`);

// ── 4. New chat starts from nothing. ──────────────────────────────────────
await panel.locator('button[aria-label="New chat"]').click();
answers("I do not know of any project.");
await ask("Which project do you remember?");
check("a new chat sends nothing of the other chat", !/Heron/.test(sentText()), sentText().slice(0, 300));
await shot("04-new-chat");
check("it has its own conversation file", indexEntries().length === 2, `${indexEntries()}`);

// ── 5. Clearing the history deletes the conversations. ────────────────────
await page.evaluate(() => window.autorag.search.historyClear());
check("clearing the history leaves no conversation file", sessionFiles().length === 0 && indexEntries().length === 0, `${sessionFiles()} ${indexEntries()}`);
check("and no chat", (await history()).length === 0);
await panel.locator('button[aria-label="New chat"]').click();
answers("Fresh start.");
await ask("Hello again");
check("a question after clearing is answered in a new conversation", sentText().includes("Hello again") && !/Heron/.test(sentText()), sentText().slice(0, 300));
check("and is kept", sessionFiles().length === 1 && indexEntries().length === 1, `${sessionFiles()} ${indexEntries()}`);
await shot("05-after-clear");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
