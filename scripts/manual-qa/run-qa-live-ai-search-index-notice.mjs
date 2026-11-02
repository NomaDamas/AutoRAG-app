// Live end-to-end: AI Search warns about an index that is not ready exactly when the real Jev routes the question to
// the local branch, and never when Jev sends it elsewhere.
//
// Same harness as run-qa-live-ai-search-links.mjs: a fresh profile signs in through a loopback stand-in for the Dazzi
// web sign-in, and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so the routing verdict and the
// answer are the live models' own output. The stand-in also reads each `/v1/jev` exchange to learn which branch the
// librarian's routing rules take from Jev's verdict (the branch with the highest probability, kept only when it
// clears the librarian's 0.75 floor, else local); what the panel shows is checked against that. The account key comes
// from QA_DAZZI_TOKEN, else from the `dazzi` entry of the developer's `~/.pi/agent/auth.json`; it is only handed to
// the throwaway profile. Run `bun run build` first, then on this machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-index-notice.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-index-notice");
mkdirSync(EVIDENCE, { recursive: true });

function realToken() {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8")).dazzi;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
}

const TOKEN = realToken();
if (TOKEN === null) {
	console.error("A dazzi key is required: set QA_DAZZI_TOKEN or sign in to dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-index-notice-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(WORK, "home"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

/** Every route question Jev answered, newest last: the answer's probability per branch. */
const routeVerdicts = [];
const jevCalls = [];
function noteJev(sent, received) {
	try {
		const questions = JSON.parse(sent).questions ?? {};
		const answers = JSON.parse(received).answers ?? {};
		jevCalls.push(Object.keys(questions).join(","));
		if (questions.route !== undefined && answers.route !== undefined) routeVerdicts.push({ choice: answers.route.choice, probabilities: answers.route.probabilities ?? {} });
	} catch {
		jevCalls.push("(unreadable)");
	}
}

/** The branch the librarian takes from Jev's verdict: the most probable one, kept off local only above 0.75. */
function branchOf(verdict) {
	let best = null;
	for (const [label, probability] of Object.entries(verdict.probabilities)) {
		if (!["local", "organize", "extra", "config"].includes(label) || !Number.isFinite(probability)) continue;
		if (best === null || probability > best.probability) best = { label, probability };
	}
	if (best === null) return verdict.choice ?? "local";
	return best.label !== "local" && best.probability <= 0.75 ? "local" : best.label;
}

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
	const isJev = req.method === "POST" && url.pathname === "/v1/jev";
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	let sent = "";
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		if (isJev) {
			const parts = [];
			reply.on("data", (part) => parts.push(part));
			reply.on("end", () => noteJev(sent, Buffer.concat(parts).toString("utf8")));
		}
		reply.pipe(res);
	});
	upstream.on("error", () => {
		if (res.headersSent) res.destroy();
		else res.writeHead(502).end();
	});
	if (isJev) {
		const parts = [];
		req.on("data", (part) => parts.push(part));
		req.on("end", () => {
			sent = Buffer.concat(parts).toString("utf8");
			upstream.end(sent);
		});
	} else {
		req.pipe(upstream);
	}
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const env = {
	AUTORAG_HOME,
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	// Never let the on-device model download start in this profile: nothing here embeds.
	FASTEMBED_CACHE_DIR: join(WORK, "model-cache"),
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			if (new URL(url).hostname === "127.0.0.1") await fetch(url);
		};
	});

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = { provider: "dazzi", id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", baseUrl: `${baseUrl}/v1`, api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32000 };
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
	check("signing in put the live Jev (the Dazzi backend) in the config", JSON.parse(readFileSync(CONFIG, "utf8")).jev?.backend === "dazzi", JSON.stringify(JSON.parse(readFileSync(CONFIG, "utf8")).jev));

	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const composer = panel.locator('input[aria-label="Ask Dazzi"]');
	const notices = () => panel.locator('[role="status"]', { hasText: /index/iu });
	const stopButton = panel.locator('button[aria-label="Stop"]');
	const shot = async (name) => {
		await page.waitForTimeout(450);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const asked = async (text) => {
		const before = routeVerdicts.length;
		await composer.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector('button[aria-label="Stop"]') !== null || document.querySelector(".text-danger-text") !== null, null, { timeout: 30_000 });
		return before;
	};
	const finished = () => page.waitForFunction(() => document.querySelector('button[aria-label="Stop"]') === null && document.querySelector('input[aria-label="Ask Dazzi"]') !== null, null, { timeout: 240_000 });
	const errorText = async () => (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	const verdictSince = (before) => (routeVerdicts.length > before ? routeVerdicts[before] : undefined);
	const describe = (verdict) => (verdict === undefined ? "no verdict" : `${branchOf(verdict)} ${JSON.stringify(verdict.probabilities)}`);
	const newChat = () => panel.locator('button[aria-label="New chat"]').click();

	// ── 1. A question about the person's own documents, over an empty index. ──
	let before = await asked("내 문서에서 분기 수치가 얼마인지 찾아줘.");
	await notices().first().waitFor({ timeout: 120_000 }).catch(() => undefined);
	let verdict = verdictSince(before);
	console.log(`Jev routed question 1: ${describe(verdict)}`);
	check("the live Jev judged the question", verdict !== undefined);
	check("Jev sent it to the local branch", verdict !== undefined && branchOf(verdict) === "local", describe(verdict));
	check("the warning appears", (await notices().count()) === 1);
	const stillRunning = (await stopButton.count()) === 1;
	check("the warning arrives while the answer is still being produced, not with it", stillRunning);
	const text = (await notices().count()) === 1 ? await notices().first().innerText() : "";
	console.log(`warning: ${text.replace(/\s+/g, " ")}`);
	check("it says nothing is indexed", /No documents are indexed/.test(text), text.replace(/\s+/g, " "));
	await shot("01-live-warning-while-answering");
	await finished();
	check("the search ran to an answer", (await errorText()) === "" && (await panel.locator(".assistant-msg .assistant-prose").count()) > 0, await errorText());
	check("the warning is still there with the answer", (await notices().count()) === 1);
	await shot("02-live-warning-with-answer");

	const button = notices().first().getByRole("button", { name: "Manage indexing" });
	check("the warning carries the button", (await button.count()) === 1);
	await button.click();
	await page.waitForSelector(".settings-view");
	const active = await page.locator(".settings-nav-item.is-active").first().innerText();
	check("the button opens Settings on the Indexing page", /Indexing/.test(active), active.replace(/\s+/g, " "));
	await shot("03-live-settings-indexing");
	await openAiSearch(page);

	// ── 2. Small talk: Jev must not send it to the local branch, so nothing says the index is not ready. ──
	await newChat();
	before = await asked("안녕! 오늘도 고마워.");
	await finished();
	verdict = verdictSince(before);
	console.log(`Jev routed question 2: ${describe(verdict)}`);
	check("the live Jev judged the greeting", verdict !== undefined);
	const expectLocal = verdict === undefined ? true : branchOf(verdict) === "local";
	check("a question Jev keeps off the local branch shows no warning, and one it sends there shows it", (await notices().count()) === (expectLocal ? 1 : 0), `${describe(verdict)} → ${await notices().count()} warning(s)`);
	if (expectLocal) console.log("note: Jev sent the greeting to the local branch this time, so a warning is the right outcome.");
	await shot("04-live-greeting");

	// ── 3. An index with enough documents: the same kind of question no longer warns. ──
	for (let n = 1; n <= 12; n += 1) writeFileSync(join(DOCS, `quarter-${n}.txt`), `분기 ${n} 보고서: 이번 분기 수치는 ${n * 13}입니다.\n`);
	await page.evaluate(() => window.autorag.settings.configRefresh(["parsed"]));
	const indexed = (await page.evaluate(() => window.autorag.settings.sourcesList())).local.documentCount;
	check("Settings' own refresh indexed the twelve documents", indexed === 12, `local.documentCount=${indexed}`);
	await newChat();
	before = await asked("내 문서에서 분기 수치가 얼마인지 찾아줘.");
	await finished();
	verdict = verdictSince(before);
	console.log(`Jev routed question 3: ${describe(verdict)}`);
	check("Jev sent the question over the real index to the local branch", verdict !== undefined && branchOf(verdict) === "local", describe(verdict));
	check("a ready index shows no warning", (await notices().count()) === 0, (await notices().allInnerTexts()).join(" | "));
	check("the search ran to an answer", (await errorText()) === "" && (await panel.locator(".assistant-msg .assistant-prose").count()) > 0, await errorText());
	await shot("05-live-ready-index");

	console.log(`Jev calls: ${jevCalls.length} (${[...new Set(jevCalls)].join(" | ")})`);
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
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
