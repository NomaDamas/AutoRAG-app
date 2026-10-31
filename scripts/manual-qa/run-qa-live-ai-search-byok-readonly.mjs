// Live end-to-end: a BYOK profile with no judgement-model credential (issue #390) must not be asked about
// shell calls that only read. Such a profile keeps the librarian's default `jev: {backend: "openrouter"}` and
// `rerank` blocks while no OpenRouter key exists, so Jev cannot classify anything. A real model runs `ls`/`cat`
// in AI Search; the app must let those through, and must still put a command that deletes a file to the person.
//
// Same harness as run-qa-live-ai-search-interaction.mjs, but the model is reached as a custom provider (an API
// key in its own environment variable, no Dazzi sign-in) so the profile is a BYOK one: the Dazzi key only pays for
// the model's tokens and never gives Jev a credential. Run `bun run build` first:
//
//   bun scripts/manual-qa/run-qa-live-ai-search-byok-readonly.mjs
//
// QA_LIVE_MODEL picks the model (default z-ai/glm-5.3-flash).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "z-ai/glm-5.3-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-byok-readonly");
mkdirSync(EVIDENCE, { recursive: true });

/** The model key for the throwaway profile: from the environment, else the developer's own `~/.pi/agent/auth.json` (read at run time, never written anywhere). */
function modelKey() {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const access = JSON.parse(readFileSync(authPath, "utf8")).dazzi?.access;
		return typeof access === "string" && access.length > 0 ? access : null;
	} catch {
		return null;
	}
}

const KEY = modelKey();
if (KEY === null) {
	console.error("A model key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-byok-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
const file = (name) => join(DOCS, name);
const seed = () => {
	writeFileSync(file("meeting-notes.md"), "Zebrafish project budget: 4,200 million won. Delivery date: March 14.\n");
	writeFileSync(file("old-draft.txt"), "stale draft, safe to delete\n");
};
seed();

// What onboarding leaves behind for BYOK without OpenRouter (the issue's config.json): the librarian's defaults.
const config = {
	searchPaths: [DOCS],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	jev: { backend: "openrouter" },
	rerank: { provider: "openrouter", model: "voyageai/rerank-3-lite", apiKeyEnv: "OPENROUTER_API_KEY", topN: 25 },
	webSearch: false,
};

// Only the model's own requests are forwarded to the live API; there is no sign-in.
const service = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	const upstream = httpsRequest(`${REAL_API}${url.pathname}${url.search}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;
config.model = {
	provider: "byok-qa",
	id: MODEL_ID,
	name: MODEL_ID,
	baseUrl: `${baseUrl}/v1`,
	api: "openai-responses",
	apiKeyEnv: "QA_BYOK_KEY",
	reasoning: true,
	input: ["text"],
	contextWindow: 1048576,
	maxTokens: 32000,
};
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	QA_BYOK_KEY: KEY,
	OPENROUTER_API_KEY: "",
	TYPESAFE_API_KEY: "",
	AI_GATEWAY_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
	const approval = panel.locator('[role="alertdialog"]');
	const shot = async (name) => {
		await page.waitForTimeout(450);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const send = async (text, { fresh = false } = {}) => {
		if (fresh) await panel.locator('button[aria-label="New chat"]').click();
		await composer.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};
	const answerText = async () => (await page.locator(".assistant-msg .assistant-prose").allTextContents()).join("\n");
	const runError = async () => (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 500 }).catch(() => null)) ?? "";
	// Answers every approval card with `button` until the run is over; returns the text of each card.
	const resolveCards = async (button) => {
		await page.waitForSelector('button[aria-label="Stop"], [role="alertdialog"]', { timeout: 60_000 });
		const cards = [];
		const deadline = Date.now() + 300_000;
		while (Date.now() < deadline) {
			if (await approval.count()) {
				cards.push(await approval.innerText());
				if (cards.length === 1) await shot(`byok-card-${button === "Deny" ? "deny" : "allow"}`);
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

	check("the mode is auto", (await page.evaluate(() => window.autorag.interaction.getMode())) === "auto");

	// ── 1. Reads through the shell: no card. ────────────────────────────────
	await send(
		`Use the bash tool, with ls and cat only (no search tools): list the folder ${DOCS}, read meeting-notes.md in it, ` +
			"then reply in one sentence with the budget and the delivery date it states.",
	);
	const readCards = await resolveCards("Deny");
	await shot("byok-01-after-read");
	const readAnswer = await answerText();
	console.log(`model answer: ${readAnswer.replace(/\s+/g, " ").slice(0, 300)}`);
	check("a read-only shell run opens no approval card", readCards.length === 0, readCards.map((card) => card.slice(0, 200).replace(/\s+/g, " ")).join(" || "));
	check("the answer states the budget from the file", /4,?200/.test(readAnswer), readAnswer.slice(0, 160).replace(/\s+/g, " "));
	check("no run error after the read", (await runError()) === "", await runError());

	// ── 2. A delete is still put to the person. ──────────────────────────────
	await send(`Run exactly this shell command and nothing else: rm ${file("old-draft.txt")} (I confirm: it is a stale draft and I want it gone.)`, { fresh: true });
	const deleteCards = await resolveCards("Deny");
	console.log(`delete card: ${deleteCards[0]?.replace(/\s+/g, " ").slice(0, 300) ?? "(none)"}`);
	check("a delete still opens an approval card", deleteCards.length > 0 && deleteCards.some((card) => card.includes("old-draft.txt")));
	check("the card never shows the raw key error", deleteCards.every((card) => !/OPENROUTER_API_KEY|JEV_BACKEND/.test(card)));
	check("Deny keeps the file", existsSync(file("old-draft.txt")));
	check("no run error after Deny", (await runError()) === "", await runError());
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
