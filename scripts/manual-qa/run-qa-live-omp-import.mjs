/**
 * Live end-to-end QA: a person who already uses omp (oh-my-pi) brings that setup into Dazzi and connects a model, with a real
 * 2026+ LLM (`deepseek/deepseek-v4.1-flash`) through the Dazzi account.
 *
 * The throwaway home holds a fixture shaped like a real omp setup (`~/.omp/agent/models.yml` with custom providers whose `apiKey`
 * is an env-var NAME, a literal-key provider, a command-backed one and one whose protocol Dazzi does not speak; the env var's value is
 * in `~/.zshrc`). The assistant must find it, import the provider after the confirm card, store the key encrypted, make its model the
 * answer model, and the app must then actually be able to use that connection: a local server stands in for the provider and has to
 * receive a real chat request carrying the imported key.
 *
 * Run in a VM: bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-omp-import.mjs --token "$TOKEN"
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, isMac } from "./platform.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-omp-import");
mkdirSync(EVIDENCE, { recursive: true });

function resolveToken() {
	const flagIdx = process.argv.indexOf("--token");
	if (flagIdx >= 0 && typeof process.argv[flagIdx + 1] === "string" && process.argv[flagIdx + 1].trim().length > 0) {
		return process.argv[flagIdx + 1].trim();
	}
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

const TOKEN = resolveToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: pass --token, set QA_DAZZI_TOKEN, or sign in to Dazzi on this machine.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-omp-import-"));
const HOME_DIR = join(WORK, "home");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "minsync 0.6.0"; exit 0; fi\nexit 0\n');
chmodSync(minsyncStub, 0o755);

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
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
	req.pipe(upstream);
});
{
	const { promise, resolve } = Promise.withResolvers();
	service.listen(0, "127.0.0.1", resolve);
	await promise;
}
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const baseConfig = {
	searchPaths: [join(HOME_DIR, "Documents")],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: true, embedder: { id: "none" } },
	jikji: false,
	model: {
		provider: "dazzi",
		id: MODEL_ID,
		name: MODEL_ID,
		baseUrl: `${baseUrl}/v1`,
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 32000,
	},
};
writeFileSync(CONFIG, `${JSON.stringify(baseConfig, null, 2)}\n`);

const env = {
	HOME: HOME_DIR,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

// A stand-in for the omp provider: records what the app sends and answers like an OpenAI-compatible chat server.
const received = [];
const PROXY_KEY = "mp-live-OmpQaProxyKey0123456789abcd";
const LITERAL_KEY = "lit-OmpQaLiteralKey0123456789abcd";
const proxy = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		received.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", body: body.slice(0, 400) });
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "omp-model-a" }, { id: "omp-model-b" }] }));
			return;
		}
		const event = (delta, finish) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "omp-model-a", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		if (/"stream"\s*:\s*true/u.test(body)) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(event({ role: "assistant", content: "pong" }, null));
			res.write(event({}, "stop"));
			res.end("data: [DONE]\n\n");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
	});
});
{
	const { promise, resolve } = Promise.withResolvers();
	proxy.listen(0, "127.0.0.1", resolve);
	await promise;
}
const PROXY_URL = `http://127.0.0.1:${proxy.address().port}/v1`;

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(90_000);
	await app.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			await fetch(url);
		};
	});

	const status = await page.evaluate(() => window.autorag.account.signIn());
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);

	// Re-ensure our 2026+ model is written after sign-in
	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = baseConfig.model;
	const configJsonBefore = `${JSON.stringify(cfg, null, 2)}\n`;
	writeFileSync(CONFIG, configJsonBefore);
	console.log(`live model: ${MODEL_ID}`);

	const shot = async (name) => {
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};
	const CRED_FILE = join(USER_DATA, "credentials.enc.json");
	const readCreds = () => (existsSync(CRED_FILE) ? readFileSync(CRED_FILE, "utf8") : "");
	const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
	const modelsJson = join(AGENT_DIR, "models.json");
	const readModelsJson = () => (existsSync(modelsJson) ? readFileSync(modelsJson, "utf8") : "{}");
	const everythingOnScreen = async () => (await page.evaluate(() => document.body.innerText)) + (await page.evaluate(() => [...document.querySelectorAll("input")].map((input) => input.value).join(" ")));

	// The fixture: a real-shaped omp setup in the throwaway home.
	mkdirSync(join(HOME_DIR, ".omp", "agent"), { recursive: true });
	writeFileSync(
		join(HOME_DIR, ".omp", "agent", "models.yml"),
		[
			"providers:",
			"  qaproxy:",
			`    baseUrl: ${PROXY_URL}`,
			"    api: openai-completions",
			"    apiKey: QAPROXY_API_KEY",
			"    auth: apiKey",
			"    models:",
			"      - id: omp-model-a",
			"        name: Omp Model A",
			"        reasoning: true",
			"        input: [text, image]",
			"        contextWindow: 272000",
			"        maxTokens: 128000",
			"      - id: omp-model-b",
			"        name: Omp Model B",
			"  qaliteral:",
			`    baseUrl: ${PROXY_URL}`,
			"    api: openai-completions",
			`    apiKey: ${LITERAL_KEY}`,
			"    models:",
			"      - id: lit-model",
			"        name: Lit Model",
			"  qacommand:",
			`    baseUrl: ${PROXY_URL}`,
			"    api: openai-completions",
			'    apiKey: "!pass show qa"',
			"    models:",
			"      - id: cmd-model",
			"        name: Cmd Model",
			"  qaodd:",
			`    baseUrl: ${PROXY_URL}`,
			"    api: some-unknown-protocol",
			"    apiKey: QAODD_KEY",
			"    models:",
			"      - id: odd-model",
			"        name: Odd Model",
			"",
		].join("\n"),
	);
	writeFileSync(join(HOME_DIR, ".zshrc"), `export QAPROXY_API_KEY=${PROXY_KEY}\nexport QAODD_KEY=unused-odd-key-0123456789\n`);

	await page.locator(".sidebar__item--settings").click();
	const panelOf = () => page.locator('[data-testid="app-customizer-panel"][data-surface="ai"]:not([hidden])');
	await page.locator(".settings-nav-item", { hasText: "AI 모델" }).first().click();
	await panelOf().waitFor();
	let turns = 0;
	const turn = async (text, label) => {
		const index = turns;
		turns += 1;
		const input = panelOf().locator('textarea[data-testid="app-customizer-input"]');
		await input.click();
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
		const seen = [];
		const finished = page
			.waitForFunction(
				(count) => {
					const root = document.querySelector('[data-testid="app-customizer-panel"][data-surface="ai"]');
					const last = (root?.querySelectorAll(".customizer-turn") ?? [])[count];
					return last !== undefined && last.querySelector(".customizer-turn__reply, .customizer-turn__error") !== null && root?.querySelector('[data-action="stop-customizer-message"]') === null;
				},
				index,
				{ timeout: 150_000 },
			)
			.then(() => "done");
		for (;;) {
			const next = await Promise.race([finished, panelOf().locator("[data-prompt]").first().waitFor({ timeout: 2_000 }).then(() => "card").catch(() => "idle")]);
			if (next === "done") break;
			if (next !== "card") continue;
			const card = panelOf().locator("[data-prompt]").first();
			const text = (await card.innerText()).replace(/\s+/g, " ");
			seen.push(text);
			// The card's buttons must be on screen the moment it opens, not hidden below the conversation.
			const box = await card.locator('[data-action="prompt-confirm"], [data-action="prompt-submit"]').first().boundingBox();
			const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
			check(`카드의 버튼이 열리자마자 화면 안에 보인다 (${label})`, box !== null && box.y >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width, JSON.stringify({ box, viewport }));
			console.log(`[${label}] card: ${text.slice(0, 260)}`);
			await shot(`card-${label}-${seen.length}`);
			await card.locator('[data-action="prompt-confirm"]').click().catch(() => card.locator('[data-action="prompt-cancel"]').click());
		}
		const reply = (await panelOf().locator(".customizer-turn").nth(index).locator(".customizer-turn__reply").allInnerTexts()).join("\n\n");
		console.log(`[${label}] -> ${reply.replace(/\n+/g, " ").slice(0, 320)}`);
		return { reply, cards: seen };
	};

	// 1. Find omp's setup.
	{
		const { reply } = await turn("내 컴퓨터에 omp(oh-my-pi)가 설치되어 있는지, 거기 어떤 모델 제공자들이 설정되어 있는지 알려줘. 키 값은 말하지 말고.", "scan");
		await shot("01-scan");
		check("omp의 제공자들을 찾아 알려준다", /qaproxy/.test(reply) && /qaliteral/.test(reply), reply.slice(0, 200));
		check("Dazzi가 쓰지 못하는 프로토콜의 제공자는 이유와 함께 가져올 수 없다고 말한다", /qaodd|some-unknown-protocol|프로토콜/.test(reply), reply.slice(0, 200));
		check("답변과 화면에 키가 없다", !reply.includes("OmpQaProxyKey") && !(await everythingOnScreen()).includes("OmpQaProxyKey"));
	}

	// 2. Import qaproxy after the card (the answer model stays the real one for now: a stand-in server cannot drive the assistant).
	{
		const { reply, cards } = await turn("omp의 qaproxy 제공자를 Dazzi로 그대로 가져와줘. 답변 모델은 아직 바꾸지 마.", "import");
		await shot("02-import");
		const card = cards.find((text) => /qaproxy/.test(text));
		check("가져오기 확인창이 주소·프로토콜·모델 수를 보여주고 키 값은 보여주지 않는다", card !== undefined && card.includes("127.0.0.1") && /openai-completions/.test(card) && !card.includes("OmpQaProxyKey"), card?.slice(0, 220));
		const models = readModelsJson();
		check("제공자가 models.json에 프로토콜·주소·모델과 함께 들어갔고 키는 평문이 아니다", /qaproxy/.test(models) && models.includes("omp-model-a") && models.includes("omp-model-b") && !models.includes("OmpQaProxyKey"), models.slice(0, 300));
		check("키가 암호화 저장소에 저장되었다 (평문 아님)", readCreds().includes("QAPROXY_API_KEY") && !readCreds().includes("OmpQaProxyKey"));
		check("답변과 화면에 키가 없다", !reply.includes("OmpQaProxyKey") && !(await everythingOnScreen()).includes("OmpQaProxyKey"));
		check("모델을 바꾸지 말라고 했으니 답변 모델은 그대로다", readConfig().model?.provider === "dazzi", JSON.stringify(readConfig().model).slice(0, 120));
	}

	// 3. A literal-key provider comes over too, and a command-backed one is refused with a reason.
	{
		const { reply } = await turn("omp의 qaliteral 제공자도 가져와줘. 그리고 qacommand 도 가져와줘.", "literal-and-command");
		await shot("03-literal-command");
		const models = readModelsJson();
		check("키가 직접 적힌 제공자도 가져왔고 키는 평문 설정에 남지 않는다", /qaliteral/.test(models) && !models.includes("OmpQaLiteralKey") && !readCreds().includes("OmpQaLiteralKey"), models.slice(0, 200));
		check("명령으로 키를 얻는 제공자는 가져오지 않았다", !/qacommand/.test(models), reply.slice(0, 200));
		check("답변과 화면에 키가 없다", !reply.includes("OmpQaLiteralKey") && !(await everythingOnScreen()).includes("OmpQaLiteralKey"));
	}

	// 4. The connection really works: the app probes the imported provider, then the person makes its model the answer model and AI
	//    Search sends a real chat request through it with the imported key.
	{
		const connection = await page.evaluate(async () => {
			const providers = await window.autorag.settings.providersList();
			const imported = providers.find((provider) => provider.name === "qaproxy");
			if (imported === undefined) return { found: false };
			const test = await window.autorag.settings.providersTest(imported.id).catch((error) => ({ ok: false, error: String(error) }));
			return { found: true, id: imported.id, connected: imported.authConfigured, models: imported.models.map((model) => model.id), test };
		});
		console.log("[connection]", JSON.stringify(connection).slice(0, 300));
		check("Dazzi가 가져온 제공자를 연결된 것으로 보고 모델 목록을 가진다", connection.found && connection.connected === true && connection.models.includes("omp-model-a"), JSON.stringify(connection).slice(0, 200));
		check("연결 확인이 성공한다", connection.test?.ok === true, JSON.stringify(connection.test).slice(0, 200));
		check("제공자 서버가 요청을 받았고, 가져온 키로 인증했다", received.some((entry) => entry.auth === `Bearer ${PROXY_KEY}`), JSON.stringify(received.map((entry) => `${entry.url} ${entry.auth.slice(0, 12)}`)).slice(0, 240));

		// What the person does next: pick the imported model for the answer role, the way the page's picker does.
		await page.evaluate(async (id) => {
			const catalog = (await window.autorag.settings.providersList()).find((provider) => provider.id === id);
			const entry = catalog.models.find((model) => model.id === "omp-model-a");
			await window.autorag.settings.configPatch([
				{ path: ["model", "provider"], value: entry.provider },
				{ path: ["model", "id"], value: entry.id },
				{ path: ["model", "name"], value: entry.name },
				{ path: ["model", "api"], value: "openai-completions" },
				{ path: ["model", "baseUrl"], value: entry.baseUrl ?? catalog.baseUrl },
				{ path: ["model", "apiKeyEnv"], value: "QAPROXY_API_KEY" },
			]);
		}, connection.id);
		// The page reads the config when it opens: leave it and come back, as a person would after switching the model elsewhere.
		await page.locator(".settings-nav-item", { hasText: "일반" }).first().click();
		await page.locator(".settings-nav-item", { hasText: "AI 모델" }).first().click();
		await page.locator('button[data-role="answer"]').filter({ hasText: "Omp Model A" }).waitFor({ timeout: 15_000 }).catch(() => undefined);
		await shot("04-connected");
		check("답변 모델 선택칸이 끊어진 연결(빨간 느낌표)로 표시되지 않고 가져온 모델 이름을 보여준다", (await page.locator('button[data-role="answer"].is-broken').count()) === 0 && /Omp Model A/.test(await page.locator('button[data-role="answer"]').innerText()), await page.locator('button[data-role="answer"]').innerText());
		// A real chat request through the imported connection: the AI assistant itself now runs on it.
		const before = received.length;
		const { reply } = await turn("안녕", "chat-through-omp");
		const chat = received.slice(before).find((entry) => /chat\/completions/.test(entry.url));
		check("가져온 연결로 실제 채팅 요청이 나가고 가져온 키로 인증했다", chat !== undefined && chat.auth === `Bearer ${PROXY_KEY}`, chat ? `${chat.url} ${chat.auth.slice(0, 14)}…` : "no chat request");
		check("제공자의 답이 화면에 돌아온다", /pong/.test(reply), reply.slice(0, 120));
		await shot("05-chat-through-omp");
	}
} finally {
	await app.close().catch(() => undefined);
	proxy.close();
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("\nAll live omp import checks passed.");
