// Live end-to-end: a real model decides to ask the person a question and to change a file, and the real
// app must put both in front of the person (librarian v2.12: `ask_user` and the file-change gate).
//
// Same harness as run-qa-live-ai-search-table.mjs: a fresh profile signs in through a loopback stand-in for
// the Dazzi web sign-in and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so the model's
// decisions are its own. The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the
// developer's `~/.pi/agent/auth.json`; it is only handed to the throwaway profile. Run `bun run build` first,
// on this machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-interaction.mjs
//
// QA_LIVE_MODEL picks the Dazzi plan model (default z-ai/glm-5.3-flash).
//
//   1. Auto (the default): the model is asked to check with the person which of two files to summarize. It
//      calls `ask_user`; the question card replaces the message box; the pick reaches the model, whose answer
//      is about the chosen file only.
//   2. Ask: the model is asked to delete a file with a shell command. The approval card shows the command;
//      Deny keeps the file; Allow once deletes it.
//   3. Full: the same request deletes the file with no card.
//   4. Auto with Dazzi's judgment model: the same request is let through, or asked about with the reason.
//   5. All of the above happen in ONE chat, which is one model conversation: the model is told a codeword and
//      answers it from memory in the next question, and again after the app is quit and started on the same
//      profile (the chat is opened from History; its session file is resumed).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "z-ai/glm-5.3-flash";
// QA_OPENROUTER_MODEL=<id> runs the same scenarios against that OpenRouter model instead of the Dazzi plan (no Dazzi account needed).
// Pick an LLM from OpenRouter's live catalog, https://openrouter.ai/api/v1/models, never from memory.
const OPENROUTER_MODEL = process.env.QA_OPENROUTER_MODEL?.trim() || "";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-interaction");
mkdirSync(EVIDENCE, { recursive: true });

/** The key of `provider` for the throwaway profile: from the environment, else the developer's own `~/.pi/agent/auth.json` (read at run time, never written anywhere). */
function realToken(provider, envName, field) {
	const fromEnv = process.env[envName]?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8"))[provider];
		return typeof entry?.[field] === "string" && entry[field].length > 0 ? entry[field] : null;
	} catch {
		return null;
	}
}

const TOKEN = OPENROUTER_MODEL === "" ? realToken("dazzi", "QA_DAZZI_TOKEN", "access") : realToken("openrouter", "QA_OPENROUTER_KEY", "access");
if (TOKEN === null) {
	console.error(
		OPENROUTER_MODEL === ""
			? "A Dazzi account key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine."
			: "An OpenRouter key is required: set QA_OPENROUTER_KEY or add one to ~/.pi/agent/auth.json.",
	);
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-interaction-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
// pi's bash tool refuses to run from a missing working directory; onboarding creates the workspace in a real profile.
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
const file = (name) => join(DOCS, name);
const seed = () => {
	writeFileSync(file("report-q3.txt"), "Q3 revenue was 120 million won.\n");
	writeFileSync(file("report-q4.txt"), "Q4 revenue was 150 million won.\n");
	writeFileSync(file("old-draft.txt"), "stale draft, safe to delete\n");
};
seed();
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false, ...(OPENROUTER_MODEL === "" ? {} : { jev: false, webSearch: false, queryDecomposition: false }) }, null, 2)}\n`,
);

const forwarded = [];
const service = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/desktop/authorize") {
		const target = new URL(url.searchParams.get("redirect_uri"));
		target.searchParams.set("code", "qa-code");
		target.searchParams.set("state", url.searchParams.get("state"));
		res.writeHead(302, { location: target.toString() }).end();
		return;
	}
	if (url.pathname === "/api/desktop/token") {
		req.resume();
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: TOKEN }));
		return;
	}
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	forwarded.push(`${req.method} ${url.pathname}`);
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: OPENROUTER_MODEL === "" ? "" : TOKEN,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

let app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (/\[account\]|\[providers\]|No API key|permission/i.test(text)) console.log(`[main:err] ${text.slice(0, 300)}`);
	});
	let page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	if (OPENROUTER_MODEL === "") {
		const status = await page.evaluate(() => window.autorag.account.signIn());
		check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
		cfg.model = {
			provider: "dazzi",
			id: MODEL_ID,
			name: MODEL_ID,
			baseUrl: `${baseUrl}/v1`,
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 32000,
		};
	} else {
		cfg.model = {
			provider: "openrouter-qa",
			id: OPENROUTER_MODEL,
			name: OPENROUTER_MODEL,
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			apiKeyEnv: "OPENROUTER_API_KEY",
			reasoning: false,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: 16000,
		};
	}
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	console.log(`model: ${OPENROUTER_MODEL === "" ? MODEL_ID : `${OPENROUTER_MODEL} (OpenRouter)`}`);

	await openAiSearch(page);
	let panel = page.locator(AI_PANEL);
	let composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
	let approval = panel.locator('[role="alertdialog"]');
	let question = panel.locator('[role="dialog"]');
	const shot = async (name) => {
		await page.waitForTimeout(450);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const finished = () =>
		page.waitForFunction(
			() => document.querySelector('textarea[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null,
			null,
			{ timeout: 300_000 },
		);
	// A chat is one model conversation: what an earlier question's Deny or answer taught the model is in its context for the next. Scenarios that
	// must not depend on each other start a new chat (`fresh`); the memory scenario at the end deliberately does not.
	const send = async (text, { fresh = false } = {}) => {
		if (fresh) await panel.locator('button[aria-label="New chat"]').click();
		await composer.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};
	const answerText = async () => (await page.locator(".assistant-msg .assistant-prose").allTextContents()).join("\n");
	const runError = async () => (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 500 }).catch(() => null)) ?? "";

	// A real model may ask one question or several together; answer whatever card opens, preferring Q4.
	const answerQuestionCard = async () => {
		for (let guard = 0; guard < 8 && (await question.count()) > 0; guard += 1) {
			const radios = question.getByRole("radio");
			if ((await radios.count()) > 0) {
				const q4 = radios.filter({ hasText: /q4/i });
				await ((await q4.count()) > 0 ? q4.first() : radios.first()).click();
			} else if ((await question.getByRole("checkbox").count()) > 0) {
				await question.getByRole("checkbox").first().click();
			} else if ((await question.locator("textarea").count()) > 0) {
				await question.locator("textarea").fill("report-q4.txt");
			}
			await page.waitForTimeout(250);
			const next = question.getByRole("button", { name: /^Next$/ });
			const submit = question.getByRole("button", { name: /^Send$/ });
			if ((await next.count()) > 0 && (await next.isEnabled())) {
				await next.click();
				await page.waitForTimeout(250);
			} else if ((await submit.count()) > 0 && (await submit.isEnabled())) {
				await submit.click();
				// The card closes after the answer's round trip to the main process; wait for that before looking again.
				await question.waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
			}
		}
	};

	check("the mode defaults to auto", (await page.evaluate(() => window.autorag.interaction.getMode())) === "auto");

	// ── 1. The model asks which report to summarize. ────────────────────────
	await send(
		`The folder ${DOCS} has two reports, report-q3.txt and report-q4.txt. I have not told you which one I mean. ` +
			"Do not guess: use the ask_user tool to ask me which report to summarize, offering both as options. " +
			"After I answer, read only that report and reply with one sentence stating its revenue.",
	);
	await question.waitFor({ timeout: 240_000 });
	const questionText = await question.innerText();
	check("the model's question replaces the message box", (await composer.count()) === 0, questionText.slice(0, 160).replace(/\s+/g, " "));
	check("both reports are offered as choices", /q3/i.test(questionText) && /q4/i.test(questionText));
	await shot("live-01-question");
	await answerQuestionCard();
	await finished();
	await shot("live-02-after-answer");
	const answer = await answerText();
	console.log(`model answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
	check("no run error", (await runError()) === "", await runError());
	check("the answer is about the report the person chose", /150/.test(answer) && !/\b120\b/.test(answer), answer.slice(0, 160).replace(/\s+/g, " "));

	// In Ask every shell call is put to the person, a harmless `ls` included, so a run may open several cards:
	// answer each with `button` until the run is over and return the text of every card.
	const resolveCards = async (button) => {
		await page.waitForSelector('button[aria-label="Stop"], [role="alertdialog"], [role="dialog"]', { timeout: 60_000 });
		const cards = [];
		const deadline = Date.now() + 300_000;
		while (Date.now() < deadline) {
			if (await approval.count()) {
				cards.push(await approval.innerText());
				if (cards.length === 1) await shot(`live-card-${button === "Deny" ? "deny" : "allow"}`);
				await approval.getByRole("button", { name: button, exact: true }).click();
				await page.waitForTimeout(300);
				continue;
			}
			const idle = await page.evaluate(() => document.querySelector('textarea[aria-label="Ask Dazzi"]') !== null && document.querySelector('button[aria-label="Stop"]') === null);
			if (idle) return cards;
			await page.waitForTimeout(250);
		}
		throw new Error("the run did not finish");
	};
	const chooseMode = async (label) => {
		await page.locator('button[aria-label="File change approval mode"]').click();
		await page.locator('[role="menuitemradio"]', { hasText: new RegExp(`^\\s*${label}`) }).click();
	};
	const deleteRequest = `Run exactly this shell command and nothing else: rm ${file("old-draft.txt")} (I confirm: it is a stale draft and I want it gone.)`;

	// ── 2. Ask: the model's shell calls reach the person. ────────────────────
	await chooseMode("Ask");
	await send(deleteRequest, { fresh: true });
	const denied = await resolveCards("Deny");
	check("the approval card shows the model's command", denied.length > 0 && denied.some((card) => card.includes(DOCS)), denied.map((card) => card.slice(0, 120).replace(/\s+/g, " ")).join(" || "));
	check("Deny keeps the file", existsSync(file("old-draft.txt")));
	check("no run error after Deny", (await runError()) === "", await runError());
	await shot("live-04-after-deny");

	await send(deleteRequest, { fresh: true });
	const allowed = await resolveCards("Allow once");
	console.log(`Allow once answered ${allowed.length} card(s); model said: ${(await answerText()).replace(/\s+/g, " ").slice(-300)}`);
	check("Allow once lets the delete run", !existsSync(file("old-draft.txt")), `cards=${allowed.length}`);
	check("no run error after Allow", (await runError()) === "", await runError());

	// ── 3. Full: no card. ────────────────────────────────────────────────────
	seed();
	await chooseMode("Full");
	await send(deleteRequest, { fresh: true });
	const shownInFull = await resolveCards("Deny");
	console.log(`Full: model said: ${(await answerText()).replace(/\s+/g, " ").slice(-400)}`);
	// The gate is what Full switches off; what the model then does with the file (rm, or the trash its rules prefer) is its own call.
	console.log(`Full: file still on disk: ${existsSync(file("old-draft.txt"))}`);
	check("Full runs the shell calls without an approval card", shownInFull.length === 0, `cards=${shownInFull.length}`);
	check("no run error in Full", (await runError()) === "", await runError());

	// ── 4. Auto with Dazzi's judgment model (Jev): an explicit request that covers the call is let through, or asked about with Jev's reason. ──
	seed();
	await chooseMode("Auto");
	await send(deleteRequest, { fresh: true });
	const inAuto = await resolveCards("Allow once");
	console.log(`Auto asked ${inAuto.length} time(s)${inAuto.length > 0 ? `: ${inAuto[0].replace(/\s+/g, " ").slice(0, 300)}` : " (Jev let it through)"}; model said: ${(await answerText()).replace(/\s+/g, " ").slice(-300)}`);
	check("Auto removes the file the person explicitly asked to delete (Jev let it through or the person allowed it)", !existsSync(file("old-draft.txt")), `asked=${inAuto.length}`);
	check("no run error in Auto", (await runError()) === "", await runError());
	if (OPENROUTER_MODEL === "") check("the model request went through the Dazzi service", forwarded.some((entry) => entry.startsWith("POST /v1/")), forwarded.slice(-3).join(", "));

	// ── 5. The chat is one conversation: the model remembers what the person told it, and still does after a restart. ──
	// The chat the last scenario ended in is used as it is. A fact given now is not in any file, so only the conversation can supply it.
	const lastAnswer = async () => ((await page.locator(".assistant-msg .assistant-prose").last().innerText({ timeout: 5000 }).catch(() => "")) ?? "").trim();
	await send("Remember this for the rest of our conversation: the codeword is PERIWINKLE-7. Reply with just OK.");
	await resolveCards("Deny");
	await send("What is the codeword I gave you? Answer from memory, do not use any tool. One word.");
	await resolveCards("Deny");
	const remembered = await lastAnswer();
	console.log(`remembered: ${remembered.replace(/\s+/g, " ").slice(0, 200)}`);
	check("a follow-up is answered from the chat's earlier turns", /PERIWINKLE-7/i.test(remembered), remembered.slice(0, 160));
	check("no run error in the follow-up", (await runError()) === "", await runError());
	await shot("live-05-remembered");

	await app.close();
	app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	await openAiSearch(page);
	panel = page.locator(AI_PANEL);
	composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
	approval = panel.locator('[role="alertdialog"]');
	question = panel.locator('[role="dialog"]');
	await panel.locator('button[aria-label="Chat history"]').click();
	await panel.locator(".history-item").first().click();
	await panel.locator(".history").waitFor({ state: "detached" });
	await send("After the restart: what was the codeword? Answer from memory, do not use any tool. One word.");
	await resolveCards("Deny");
	const afterRestart = await lastAnswer();
	console.log(`after restart: ${afterRestart.replace(/\s+/g, " ").slice(0, 200)}`);
	check("after a restart the same chat still remembers", /PERIWINKLE-7/i.test(afterRestart), afterRestart.slice(0, 160));
	check("no run error after the restart", (await runError()) === "", await runError());
	await shot("live-06-after-restart");
} catch (error) {
	check("run completed", false, String(error).slice(0, 600));
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
