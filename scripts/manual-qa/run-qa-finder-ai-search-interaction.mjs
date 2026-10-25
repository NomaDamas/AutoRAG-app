/**
 * Manual QA — the approval mode and the questions the agent asks (librarian v2.12), in the real app.
 *
 * The real app runs end to end: the real librarian agent, its real file-change gate and its `ask_user` tool,
 * the real preload bridge and renderer. Only the model is scripted: a loopback OpenAI-compatible server hands
 * out the steps each scenario queues (a text answer, a `bash` call, an `ask_user` call), so what the person
 * sees is deterministic. Real mouse and keyboard input; the files on disk and the requests the model receives
 * are checked, not just the pixels.
 *
 *   1. the mode menu sits left of the message box, defaults to Auto, lists Ask / Auto / Full and persists a choice;
 *   2. Ask: a shell call that deletes a file stops at an approval card in place of the message box; Deny keeps
 *      the file, "Deny and tell the model" hands the note over, Allow once runs it;
 *   3. Auto (no judgment model here) asks about the call, and says it could not classify it;
 *   4. Full never asks;
 *   5. `ask_user`: one question (pick), several picks, a written answer, and 2 questions together; each answer
 *      reaches the model as the tool result; a draft typed meanwhile survives;
 *   6. Stop with a question open ends the run and brings the message box back;
 *   7. the cards follow the Interface language.
 *
 * POSIX only (a shell stub for MinSync, a scripted `rm`): not part of run-all.mjs, which also runs on Windows. Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-search-interaction.mjs
 *
 * Screenshots land in $QA_OUT (default .omo/evidence/ai-finder-app/qa-ai-search-interaction/). Prereq: bun run build.
 *   bun scripts/manual-qa/run-qa-finder-ai-search-interaction.mjs
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-interaction");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-interaction-"));
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
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
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
app = await launchFinder({ userDataDir: USER_DATA, env: APP_ENV });
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
app.process().stderr?.on("data", (chunk) => {
	const text = String(chunk).trim();
	if (/Error|error TS|not a function|undefined/i.test(text)) log(`[main:err] ${text.slice(0, 300)}`);
});

await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);
const panel = page.locator(AI_PANEL);
const composer = panel.locator('input[aria-label="Ask Dazzi"]');
const modeButton = panel.locator('button[aria-label="File change approval mode"]');
const approval = panel.locator('[role="alertdialog"]');
const question = panel.locator('[role="dialog"]');
// Colors ease over a few hundred ms; capture the settled state.
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const mode = () => page.evaluate(() => window.autorag.interaction.getMode());
const pending = () => page.evaluate(() => window.autorag.interaction.pending());
// The run is over when the message box is back and not in its "running" state (the Stop button): while a card is open the box is not on screen at all.
const finished = () =>
	page.waitForFunction(() => document.querySelector('input[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 60_000 });
// Every scenario below scripts a chat's FIRST question (the librarian answers it in two phases, Quick then Deep). A later question of the same
// chat is a plain turn of the conversation, so each one starts a new chat; the conversation lane covers follow-ups and the gate on them.
const ask = async (text) => {
	await panel.locator('button[aria-label="New chat"]').click();
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
};
const chooseMode = async (label) => {
	await modeButton.click();
	await page.locator('[role="menuitemradio"]', { hasText: new RegExp(`^\\s*${label}`) }).click();
	await page.waitForFunction((wanted) => document.querySelector('button[aria-label="File change approval mode"]')?.textContent?.includes(wanted), label);
};
log("app ready");

// ── 1. The mode menu. ─────────────────────────────────────────────────────
check("the mode defaults to auto", (await mode()) === "auto", await mode());
check("the menu button shows Auto", (await modeButton.innerText()).includes("Auto"), await modeButton.innerText());
const geometry = await panel.evaluate((root) => {
	const button = root.querySelector('button[aria-label="File change approval mode"]');
	const input = root.querySelector('input[aria-label="Ask Dazzi"]');
	if (!button || !input) return null;
	const a = button.getBoundingClientRect();
	const b = input.getBoundingClientRect();
	return { buttonRight: a.right, inputLeft: b.left, sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 20 };
});
check("the mode menu sits to the left of the message box, on its row", geometry !== null && geometry.buttonRight <= geometry.inputLeft + 1 && geometry.sameRow, JSON.stringify(geometry));
await modeButton.click();
const items = await page.locator('[role="menuitemradio"]').allInnerTexts();
check("the menu lists Ask, Auto and Full", items.length === 3 && /Ask/.test(items[0]) && /Auto/.test(items[1]) && /Full/.test(items[2]), JSON.stringify(items));
check("Auto is the checked item", (await page.locator('[role="menuitemradio"][aria-checked="true"]').innerText()).includes("Auto"));
await page.waitForTimeout(400);
await shot("01-mode-menu");
await page.keyboard.press("Escape");
await chooseMode("Ask");
check("choosing Ask changes the mode in the main process", (await mode()) === "ask", await mode());
const settingsFile = join(USER_DATA, "settings", "settings-state.json");
check("the choice is stored in the app settings", existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf8")).settings.approvalMode === "ask");

// ── 2. Ask: the approval card. ────────────────────────────────────────────
const deleteOld = [{ text: "Looking at it." }, { tool: "bash", args: { command: `rm ${file("old-draft.txt")}` } }, { text: "Handled." }];
script(deleteOld);
await ask("remove the stale draft");
await approval.waitFor();
check("the approval card replaces the message box", (await composer.count()) === 0);
const cardText = await approval.innerText();
check("the card names the call", cardText.includes(`rm ${file("old-draft.txt")}`), cardText.slice(0, 200));
check("the card offers the four answers", ["Allow once", "Deny"].every((label) => cardText.includes(label)) && /session/i.test(cardText) && /tell the model/i.test(cardText));
await shot("02-approval-card-ask");
await approval.getByRole("button", { name: "Deny", exact: true }).click();
await finished();
check("Deny keeps the file", existsSync(file("old-draft.txt")));
check("the model was told it was denied", toolResults().some((text) => /denied/i.test(text)), JSON.stringify(toolResults()));
check("the message box is back after the answer", (await composer.count()) === 1);

script(deleteOld);
await ask("remove the stale draft, please");
await approval.waitFor();
await approval.getByRole("button", { name: /tell the model/i }).click();
const note = approval.locator("input, textarea").first();
await note.fill("copy it to the archive folder instead");
await shot("03-approval-deny-with-note");
await page.keyboard.press("Enter");
await finished();
check("Deny with a note keeps the file", existsSync(file("old-draft.txt")));
check("the note reached the model", toolResults().some((text) => text.includes("copy it to the archive folder instead")), JSON.stringify(toolResults()));

script(deleteOld);
await ask("really remove the stale draft");
await approval.waitFor();
await approval.getByRole("button", { name: "Allow once" }).click();
await finished();
check("Allow once runs the call", !existsSync(file("old-draft.txt")));
check("the person was asked exactly once, and nothing is left open", (await pending()).length === 0);
seed();

// Enter on the card must not approve anything: focus starts on Deny, so a stray Enter denies.
script(deleteOld);
await ask("remove it once more");
await approval.waitFor();
await page.keyboard.press("Enter");
await finished();
check("a stray Enter does not approve (focus starts on Deny)", existsSync(file("old-draft.txt")) && toolResults().some((text) => /denied/i.test(text)));
script(deleteOld);
await ask("remove it yet again");
await approval.waitFor();
await page.keyboard.press("Escape");
await finished();
check("Escape denies", existsSync(file("old-draft.txt")) && toolResults().some((text) => /denied/i.test(text)));

// ── 3. Auto (no judgment model): asks, and says it could not classify. ────
await chooseMode("Auto");
script(deleteOld);
await ask("clean up the stale draft");
await approval.waitFor();
const autoText = await approval.innerText();
check("Auto asks when it cannot judge the call", /unclassified/i.test(autoText), autoText.slice(0, 240));
await shot("04-approval-card-auto");
await approval.getByRole("button", { name: "Deny", exact: true }).click();
await finished();
check("the file survives Auto's denial", existsSync(file("old-draft.txt")));

// ── 4. Full never asks. ───────────────────────────────────────────────────
await chooseMode("Full");
check("Full is shown as a warning", (await modeButton.innerText()).includes("Full"));
await shot("05-mode-full");
script(deleteOld);
await ask("delete the stale draft now");
await finished();
check("Full runs the call without asking", !existsSync(file("old-draft.txt")) && (await approval.count()) === 0);
seed();

// What the agent says it is doing stays on screen as the one shimmering line while it works with no answer text yet (a message
// that goes on to call a tool is a progress note: its streamed draft is taken back, and nothing else animates in its place).
script([
	{ text: "Looking through the Downloads folder.", tool: "bash", args: { command: "sleep 3" } },
	{ text: "Done." },
	{ text: "Verified." },
]);
await ask("organize the downloads");
await page.waitForFunction(() => [...document.querySelectorAll(".water-wave-thinking")].some((el) => (el.textContent ?? "").includes("Looking through the Downloads folder.")), null, { timeout: 15_000 });
check("the agent's progress note is on screen while it works", true);
check("the shimmering note is the only loading indicator: no grey placeholder bars", (await panel.locator(".skeleton").count()) === 0 && (await panel.locator(".water-wave-thinking .shimmer").count()) === 1 && (await panel.locator(".water-wave-thinking").first().innerText()).includes("Downloads"));
await shot("06b-progress-note");
await finished();
await chooseMode("Auto");

// ── 5. ask_user. ──────────────────────────────────────────────────────────
const askStep = (args) => [{ text: "Checking." }, { tool: "ask_user", args }, { text: "Thanks, noted." }];
const SINGLE = {
	question: "Which report should I summarize?",
	context: "I found two reports in the folder.",
	options: [
		{ title: "Q3 report", description: "report-q3.txt, revenue 120" },
		{ title: "Q4 report", description: "report-q4.txt, revenue 150" },
	],
};
script(askStep(SINGLE));
await ask("summarize the report");
await question.waitFor();
check("the question replaces the message box", (await composer.count()) === 0);
const questionText = await question.innerText();
check("the question shows its text, context and option descriptions", questionText.includes("Which report should I summarize?") && questionText.includes("I found two reports") && questionText.includes("report-q4.txt, revenue 150"), questionText.slice(0, 300));
await shot("06-question-single");
check("the system prompt tells the model it can ask", seen.some((request) => request.system.includes("ask_user")));
await question.getByRole("radio", { name: /Q4 report/ }).click();
await finished();
check("the pick reaches the model as the tool result", toolResults().some((text) => text === "User answered: Q4 report"), JSON.stringify(toolResults()));
check("the message box returns", (await composer.count()) === 1);

// A draft typed while the run waits survives the question.
script([{ text: "Checking.", delayMs: 1500 }, { tool: "ask_user", args: SINGLE }, { text: "Thanks." }]);
await ask("summarize again");
await composer.click();
await page.keyboard.type("also mention revenue");
await question.waitFor();
await question.getByRole("radio", { name: /Q3 report/ }).click();
await finished();
check("a draft typed during the run is still in the message box", (await composer.inputValue()) === "also mention revenue", await composer.inputValue());
await composer.fill("");

const MULTI = { question: "Which files should I include?", options: [{ title: "report-q3.txt" }, { title: "report-q4.txt" }, { title: "old-draft.txt" }], allowMultiple: true };
script(askStep(MULTI));
await ask("combine the reports");
await question.waitFor();
const send = question.getByRole("button", { name: /^Send$/ });
check("Send is disabled until something is picked", await send.isDisabled());
await question.getByRole("checkbox", { name: /report-q3/ }).click();
await question.getByRole("checkbox", { name: /report-q4/ }).click();
await shot("07-question-multi");
await send.click();
await finished();
check("several picks reach the model in option order", toolResults().some((text) => text === "User answered: report-q3.txt, report-q4.txt"), JSON.stringify(toolResults()));

script(askStep({ question: "What should the summary be titled?" }));
await ask("write the summary");
await question.waitFor();
await shot("08-question-open");
await page.keyboard.type("Quarterly revenue");
await page.keyboard.press("Enter");
await finished();
check("a written answer reaches the model", toolResults().some((text) => text === "User answered: Quarterly revenue"), JSON.stringify(toolResults()));

const BATCH = {
	question: "Before I start",
	questions: [
		{ question: "Which format?", options: [{ title: "PDF" }, { title: "Word" }], allowFreeform: false },
		{ question: "Which folder should it go in?" },
	],
};
script(askStep(BATCH));
await ask("export it");
await question.waitFor();
check("a batch shows a step counter", /1\s*\/\s*2/.test(await question.innerText()), (await question.innerText()).slice(0, 200));
await shot("09-question-batch-1");
await question.getByRole("radio", { name: /PDF/ }).click();
await question.getByRole("button", { name: /^Next$/ }).click();
await page.keyboard.type("Reports");
await shot("10-question-batch-2");
await question.getByRole("button", { name: /^Send$/ }).click();
await finished();
const batchResult = toolResults().find((text) => text.includes("User answered 2 of 2 questions")) ?? "";
check("both batch answers reach the model", batchResult.includes("1. Which format? → PDF") && batchResult.includes("2. Which folder should it go in? → Reports"), batchResult);

// A batch whose questions all offer options and context: stepping keeps every answer, and each step is clickable once it is on screen.
const BATCH_OPTIONS = {
	question: "Two decisions",
	questions: [
		{ question: "Which report?", context: "Two reports were found.", options: [{ title: "Q3", description: "older" }, { title: "Q4", description: "latest" }], allowFreeform: false },
		{ question: "Which format?", context: "The summary can be exported.", options: [{ title: "PDF" }, { title: "Word" }], allowFreeform: false },
	],
};
script(askStep(BATCH_OPTIONS));
await ask("summarize and export");
await question.waitFor();
await question.getByRole("radio", { name: /Q4/ }).click();
await question.getByRole("button", { name: /^Next$/ }).click();
await question.getByRole("radio", { name: /Word/ }).click();
await shot("10b-question-batch-options");
await question.getByRole("button", { name: /^Back$/ }).click();
check("going back keeps the first answer", (await question.getByRole("radio", { name: /Q4/ }).getAttribute("aria-checked")) === "true");
await question.getByRole("button", { name: /^Next$/ }).click();
await question.getByRole("button", { name: /^Send$/ }).click();
await finished();
const optionsBatch = toolResults().find((text) => text.includes("User answered 2 of 2 questions")) ?? "";
check("a batch of choices reaches the model in order", optionsBatch.includes("1. Which report? → Q4") && optionsBatch.includes("2. Which format? → Word"), optionsBatch);

// The same card, answered by a loop that clicks whatever is on screen (what the live lane does for a model's own batch).
script(askStep({ questions: [
	{ question: "Which report should I summarize?", options: [{ title: "report-q3.txt", description: "Summarize the Q3 report" }, { title: "report-q4.txt", description: "Summarize the Q4 report" }], allowFreeform: false },
	{ question: "Which language?", options: [{ title: "English" }, { title: "Korean" }], allowFreeform: false },
] }));
await ask("summarize with a batch");
await question.waitFor();
for (let guard = 0; guard < 8 && (await question.count()) > 0; guard += 1) {
	await question.getByRole("radio").first().click({ timeout: 5000 });
	const next = question.getByRole("button", { name: /^Next$/ });
	const submit = question.getByRole("button", { name: /^Send$/ });
	if ((await next.count()) > 0) {
		await next.click();
		await page.waitForTimeout(250);
	} else {
		await submit.click();
		// The card closes after the answer's round trip to the main process; wait for that before looking again.
		await question.waitFor({ state: "detached", timeout: 10_000 });
	}
}
await finished();
check("a loop that clicks the first option of each step answers a batch", toolResults().some((text) => text.includes("1. Which report should I summarize? → report-q3.txt") && text.includes("2. Which language? → English")), JSON.stringify(toolResults().slice(-1)));

// ── 6. Stop with a question open. ─────────────────────────────────────────
script(askStep(SINGLE));
await ask("summarize one more time");
await question.waitFor();
const calls = seen.length;
await question.getByRole("button", { name: "Stop" }).click();
await page.waitForFunction(() => document.querySelector('input[aria-label="Ask Dazzi"]') !== null);
await sleep(600);
check("Stop closes the question and returns the message box", (await question.count()) === 0 && (await composer.count()) === 1);
check("nothing stays open in the main process", (await pending()).length === 0, JSON.stringify(await pending()));
check("the stopped run asks the model nothing more", seen.length === calls, `${calls} -> ${seen.length}`);

// Dismissing a question (Skip) tells the model nothing was answered, and the run goes on.
script(askStep(SINGLE));
await ask("one more summary");
await question.waitFor();
await question.getByRole("button", { name: "Skip" }).click();
await finished();
check("Skip tells the model the question was cancelled", toolResults().some((text) => text === "User cancelled the question"), JSON.stringify(toolResults()));

// ── 7. Language: the cards follow the Interface language (a fresh profile that starts in Korean). ──
await app.close();
app = await launchFinder({ userDataDir: join(WORK, "user-data-ko"), env: APP_ENV, language: "ko" });
const koPage = await finderWindow(app, 30_000);
koPage.setDefaultTimeout(15_000);
await koPage.waitForSelector(".sidebar__item", { timeout: 30_000 });
await koPage.locator(".sidebar__item").first().click();
// The panel's own label is translated too, so this part finds it by structure, not by its English name.
await koPage.waitForSelector("form.composer input", { timeout: 30_000 });
await koPage.evaluate(() => window.autorag.interaction.setMode("ask"));
const koPanel = koPage.locator("body");
const koIdle = () => koPage.waitForFunction(() => document.querySelector("form.composer input") !== null && document.querySelector('button[aria-label="중지"]') === null, null, { timeout: 60_000 });
// The first words of every run are the librarian's own English sentence; the app shows them in the interface language.
script([{ text: "빠른 답변", delayMs: 2500 }, { text: "검증된 답변" }]);
await koPanel.locator("form.composer input").first().click();
await koPage.keyboard.type("안녕");
await koPage.keyboard.press("Enter");
const koRow = koPanel.locator(".water-wave-thinking");
await koRow.first().waitFor();
const koNote = await koRow.first().innerText();
check("the opening note is in Korean, not the librarian's English", /[가-힣]/.test(koNote) && !/Reviewing/i.test(koNote), koNote);
check("it is the one shimmering line, with no grey bars", (await koRow.count()) === 1 && (await koPanel.locator(".skeleton").count()) === 0);
await koPage.screenshot({ path: join(EVIDENCE, "10c-opening-note-ko.png") });
await koIdle();
script(deleteOld);
// The scripted steps are a first question's (Quick, then Deep); a later question of the same chat is a plain conversation turn.
await koPanel.locator('button[aria-label="새 대화"]').click();
await koPanel.locator("form.composer input").first().click();
await koPage.keyboard.type("오래된 초안 지워줘");
await koPage.keyboard.press("Enter");
await koPanel.locator('[role="alertdialog"]').waitFor();
const koText = await koPanel.locator('[role="alertdialog"]').innerText();
check("the approval card is in Korean", /[가-힣]/.test(koText) && !/Allow once|Deny/.test(koText), koText.slice(0, 200));
await koPage.screenshot({ path: join(EVIDENCE, "11-approval-card-ko.png") });
await koPage.keyboard.press("Escape");
await koPage.waitForFunction(() => document.querySelector("form.composer input") !== null && document.querySelector("button[aria-label=\"중지\"]") === null, null, { timeout: 60_000 });
await koPage.locator('button[aria-label^="파일 변경"]').click();
await koPage.waitForTimeout(400);
await koPage.screenshot({ path: join(EVIDENCE, "12-mode-menu-ko.png") });
const koMenu = await koPage.locator('[role="menu"]').innerText();
check("the mode menu is in Korean", /[가-힣]/.test(koMenu) && !/Asks before every/.test(koMenu), koMenu.slice(0, 160));
await koPage.keyboard.press("Escape");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
