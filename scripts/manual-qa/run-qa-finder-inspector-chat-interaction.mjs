/**
 * Manual QA — the right sidebar's AI chat takes steers, approvals and questions, like an AI Search tab (real app).
 *
 * The real librarian agent, its file-change gate and `ask_user` tool, the real preload bridge and renderer run end to
 * end; only the model is scripted by a loopback OpenAI-compatible server. Real mouse and keyboard input.
 *
 *   1. Enter while the sidebar chat streams steers it: a waiting bubble, then "Applied"; the text reaches the model;
 *   2. ⌥Enter queues the next question, shown under the chat; it is asked once the run ends; Stop drops the queue;
 *   3. a file-change approval (Ask mode) replaces the composer inside the sidebar; Deny keeps the file, Allow once runs it;
 *   4. `ask_user` renders in the sidebar; the pick reaches the model; the Info view's composer shows it too.
 *
 * POSIX only (a shell stub for MinSync, a scripted `rm`). Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-inspector-chat-interaction.mjs
 * Prereq without the runner: bun run build.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-inspector-chat-interaction");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-inspector-chat-"));
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
app = await launchFinder({ userDataDir: USER_DATA, env: APP_ENV });
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
app.process().stderr?.on("data", (chunk) => {
	const text = String(chunk).trim();
	if (/Error|error TS|not a function|undefined/i.test(text)) log(`[main:err] ${text.slice(0, 300)}`);
});


const inspector = page.locator(".inspector-chat");
const dockInput = page.locator(".inspector-chat-dock textarea");
const chatInput = inspector.locator("textarea");
const approval = page.locator('[role="alertdialog"]');
const question = page.locator('[role="dialog"]');
const shot = async (name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const pending = () => page.evaluate(() => window.autorag.interaction.pending());
/** The run is over: the Stop button is gone and a composer (not a card) is back. */
const idle = () =>
	page.waitForFunction(() => document.querySelector(".inspector-chat button[aria-label=\"Stop\"]") === null && document.querySelector(".inspector-chat textarea") !== null, null, { timeout: 60_000 });
/** The first question of a fresh chat, typed into the Info view's composer. */
const askFresh = async (text) => {
	if ((await inspector.count()) > 0) await inspector.locator('button[aria-label="New chat"]').click();
	await dockInput.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await inspector.waitFor();
};
await page.waitForSelector(".inspector-chat-dock", { timeout: 30_000 });
log("app ready");

// ── 1. Steer. ─────────────────────────────────────────────────────────────
script([{ text: "Quick: May.", delayMs: 3500 }, { text: "Deep: June." }]);
await askFresh("When is the launch?");
await chatInput.waitFor();
check("the chat composer invites a correction while it runs", /wrong way|Correct/iu.test((await chatInput.getAttribute("placeholder")) ?? ""), (await chatInput.getAttribute("placeholder")) ?? "");
// A run still building its agent takes no steer (the text is queued instead), so wait until the model is being asked.
await page.waitForFunction(() => document.querySelector(".inspector-chat .shimmer") !== null, null, { timeout: 30_000 });
for (let guard = 0; guard < 100 && seen.length === 0; guard += 1) await sleep(100);
await chatInput.click();
await page.keyboard.type("Only the June notes.");
await page.keyboard.press("Enter");
const bubble = inspector.locator(".steer-msg").first();
await bubble.waitFor();
check("the correction shows as a waiting bubble in the sidebar chat", (await bubble.getAttribute("data-steer-status")) === "pending" || (await bubble.getAttribute("data-steer-status")) === "delivered");
check("the composer clears after Enter", (await chatInput.inputValue()) === "");
await shot("01-steer-pending");
await page.waitForFunction(() => document.querySelector(".inspector-chat .steer-msg")?.getAttribute("data-steer-status") === "delivered", null, { timeout: 30_000 });
check("the bubble turns to Applied once a model request took it", (await bubble.locator(".steer-status").innerText()).includes("Applied"), await bubble.locator(".steer-status").innerText());
await idle();
check("the steer reached the model", seen.some((request) => JSON.stringify(request.messages).includes("Only the June notes.")));
check("it was one run: no second question appeared", (await inspector.locator(".inspector-chat-question").count()) === 1);
await shot("02-steer-applied");

// ── 2. Queue with ⌥Enter; Stop drops it. ──────────────────────────────────
script([{ text: "First.", delayMs: 3000 }, { text: "First deep." }, { text: "Second quick." }, { text: "Second deep." }]);
await askFresh("Question one");
await chatInput.waitFor();
await chatInput.click();
await page.keyboard.type("Question two");
await page.keyboard.press("Alt+Enter");
await inspector.locator(".queued-question").waitFor();
check("⌥Enter queues the next question under the chat", (await inspector.locator(".queued-question").innerText()).includes("Question two"));
await shot("03-queued");
await page.waitForFunction(() => document.querySelectorAll(".inspector-chat .inspector-chat-question").length === 2, null, { timeout: 60_000 });
check("the queued question is asked once the run ends", (await inspector.locator(".inspector-chat-question").nth(1).innerText()).includes("Question two"));
check("the queue is empty afterwards", (await inspector.locator(".queued-question").count()) === 0);
await idle();

script([{ text: "Slow.", delayMs: 4000 }, { text: "Slow deep." }]);
await askFresh("Question three");
await chatInput.click();
await page.keyboard.type("Question four");
await page.keyboard.press("Alt+Enter");
await inspector.locator(".queued-question").waitFor();
await inspector.locator('button[aria-label="Stop"]').click();
await idle();
await sleep(800);
check("Stop drops the queued question: it is not asked", (await inspector.locator(".inspector-chat-question").count()) === 1 && (await inspector.locator(".queued-question").count()) === 0);

// ── 3. Approval in the sidebar. ───────────────────────────────────────────
await page.evaluate(() => window.autorag.interaction.setMode("ask"));
const shellPath = (path) => path.replaceAll("\\", "/");
const deleteOld = [{ text: "Looking at it." }, { tool: "bash", args: { command: `rm ${shellPath(file("old-draft.txt"))}` } }, { text: "Handled." }];
script(deleteOld);
await askFresh("remove the stale draft");
await approval.waitFor();
check("the approval card is inside the sidebar chat", (await inspector.locator('[role="alertdialog"]').count()) === 1);
check("the card replaces the composer", (await inspector.locator("textarea").count()) === 0);
check("the card names the call", (await approval.innerText()).includes(`rm ${shellPath(file("old-draft.txt"))}`), (await approval.innerText()).slice(0, 200));
await shot("04-approval-in-sidebar");
await approval.getByRole("button", { name: "Deny", exact: true }).click();
await idle();
check("Deny keeps the file", existsSync(file("old-draft.txt")));
check("the model was told it was denied", toolResults().some((text) => /denied/i.test(text)), JSON.stringify(toolResults()));
check("the composer is back", (await chatInput.count()) === 1);

script(deleteOld);
await askFresh("really remove the stale draft");
await approval.waitFor();
await approval.getByRole("button", { name: "Allow once" }).click();
await idle();
check("Allow once runs the call", !existsSync(file("old-draft.txt")));
check("nothing is left open in the main process", (await pending()).length === 0);
seed();
await page.evaluate(() => window.autorag.interaction.setMode("full"));

// ── 4. ask_user in the sidebar. ───────────────────────────────────────────
const SINGLE = {
	question: "Which report should I summarize?",
	context: "I found two reports.",
	options: [{ title: "Q3 report", description: "report-q3.txt" }, { title: "Q4 report", description: "report-q4.txt" }],
};
script([{ text: "Checking." }, { tool: "ask_user", args: SINGLE }, { text: "Thanks, noted." }]);
await askFresh("summarize the report");
await question.waitFor();
check("the question is inside the sidebar chat", (await inspector.locator('[role="dialog"]').count()) === 1);
check("the question replaces the composer", (await inspector.locator("textarea").count()) === 0);
check("it shows its text and options", (await question.innerText()).includes("Which report should I summarize?") && (await question.innerText()).includes("report-q4.txt"), (await question.innerText()).slice(0, 200));
await shot("05-question-in-sidebar");
await question.getByRole("radio", { name: /Q4 report/ }).click();
await idle();
check("the pick reaches the model as the tool result", toolResults().some((text) => text === "User answered: Q4 report"), JSON.stringify(toolResults()));

script([{ text: "Checking." }, { tool: "ask_user", args: SINGLE }, { text: "Thanks." }]);
await askFresh("summarize once more");
await question.waitFor();
await question.getByRole("button", { name: "Skip" }).click();
await idle();
check("Skip tells the model it was cancelled", toolResults().some((text) => text === "User cancelled the question"), JSON.stringify(toolResults()));

script([{ text: "Checking." }, { tool: "ask_user", args: SINGLE }]);
await askFresh("and a stop with a question open");
await question.waitFor();
await question.getByRole("button", { name: "Stop" }).click();
await idle();
check("Stop closes the question and returns the composer", (await question.count()) === 0 && (await chatInput.count()) === 1);
check("nothing stays open in the main process", (await pending()).length === 0, JSON.stringify(await pending()));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
