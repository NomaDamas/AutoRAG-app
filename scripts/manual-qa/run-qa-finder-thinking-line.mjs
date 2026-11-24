/**
 * Manual QA — the thinking line (SeedLoader + shimmer) stays while a run still works, on both chat surfaces (real app).
 *
 * The real librarian agent, the real preload bridge and renderer run end to end; only the model is scripted by a
 * loopback OpenAI-compatible server. The line has one rule, with no Quick/Deep special case: it shows while the run is
 * live and it sits after everything the run has written. So a message the model wrote on the way (a note before a
 * tool call) is shown, and the line keeps going under it until the run ends:
 *
 *   A. a note in the Quick phase, then its tool call, then the Quick answer;
 *   B. a Quick answer, then a note in the Deep phase and its tool call (the case that lost the line before), then Deep.
 *
 * Each scenario runs in the right sidebar's chat and in the AI Agent tab. POSIX only (`sleep`, a MinSync stub). Run it in a VM:
 *   bun run qa script scripts/manual-qa/run-qa-finder-thinking-line.mjs
 * Prereq without the runner: bun run build.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-thinking-line");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-thinking-line-"));
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



const SCENARIOS = [
	{
		name: "a note and a tool call in the Quick phase",
		note: "Looking through the folder.",
		steps: [{ text: "Looking through the folder.", tool: "bash", args: { command: "sleep 5" } }, { text: "Quick answer." }, { text: "Deep final." }],
	},
	{
		name: "a note and a tool call in the Deep phase, after the Quick answer",
		note: "Checking more files.",
		steps: [{ text: "Quick answer." }, { text: "Checking more files.", tool: "bash", args: { command: "sleep 5" } }, { text: "Deep final." }],
	},
];

/**
 * One scenario on one surface. `root` holds the chat, `status` is its thinking line, `ask` sends the question and
 * `idle` resolves once the run is over.
 */
async function runScenario(surface, scenario, { root, status, ask, idle }) {
	const label = `${surface} / ${scenario.name}`;
	script(scenario.steps);
	await ask(`question for ${scenario.name}`);
	const note = root.getByText(scenario.note).first();
	await note.waitFor({ timeout: 60_000 });
	check(`${label}: the message the model wrote on the way is on screen`, (await note.count()) === 1);
	check(`${label}: the thinking line is still there under it`, (await status.count()) === 1, `status=${await status.count()}`);
	check(`${label}: the line animates (SeedLoader and shimmer)`, (await status.locator("svg.seed-loader").count()) === 1 && (await status.locator(".shimmer").count()) === 1);
	await sleep(1500);
	check(`${label}: it is still there while the tool runs`, (await status.count()) === 1 && (await note.count()) === 1, `status=${await status.count()}`);
	const noteBox = await note.boundingBox();
	const statusBox = await status.boundingBox();
	check(`${label}: it sits below the message, not above it`, noteBox !== null && statusBox !== null && statusBox.y >= noteBox.y + noteBox.height - 1, JSON.stringify({ noteBox, statusBox }));
	await page.screenshot({ path: join(EVIDENCE, `${surface}-${scenario.steps.length}-${scenario.note.length}.png`) });
	await idle();
	check(`${label}: the line is gone once the run ends`, (await status.count()) === 0, `status=${await status.count()}`);
	check(`${label}: the final answer is shown`, (await root.getByText("Deep final.").count()) + (await root.getByText("Quick answer.").count()) >= 1);
}

// The right sidebar's chat, asked from the Info view's dock.
const inspector = page.locator(".inspector-chat");
const dockInput = page.locator(".inspector-chat-dock textarea");
await page.waitForSelector(".inspector-chat-dock", { timeout: 30_000 });
log("app ready");
for (const scenario of SCENARIOS) {
	await runScenario("sidebar", scenario, {
		root: inspector,
		status: inspector.locator('[role="status"]'),
		ask: async (text) => {
			if ((await inspector.count()) > 0) await inspector.locator('button[aria-label="New chat"]').click();
			await dockInput.click();
			await page.keyboard.type(text);
			await page.keyboard.press("Enter");
			await inspector.waitFor();
		},
		idle: () => page.waitForFunction(() => document.querySelector('.inspector-chat button[aria-label="Stop"]') === null && document.querySelector(".inspector-chat textarea") !== null, null, { timeout: 60_000 }),
	});
}

// The AI Agent tab.
await openAiSearch(page);
const panel = page.locator(AI_PANEL);
const composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
for (const scenario of SCENARIOS) {
	await runScenario("AI Agent tab", scenario, {
		root: panel,
		status: panel.locator(".water-wave-thinking"),
		ask: async (text) => {
			await panel.locator('button[aria-label="New chat"]').click();
			await composer.click();
			await page.keyboard.type(text);
			await page.keyboard.press("Enter");
		},
		idle: () => page.waitForFunction(() => document.querySelector('textarea[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: 60_000 }),
	});
}

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
