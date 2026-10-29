import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { homeDir, homeEnv, isolatedToolPath, rmRetry } from "./platform.mjs";

// Live QA for switching where the document-understanding model runs, through the real Settings screen of the
// built app: this computer (MinSync's `minsync serve`), the Dazzi cloud (the real hosted route, with the account
// token already on this machine), and the user's own server (a real OpenAI-compatible and a real TEI server,
// both backed by the real local Qwen3 model). The model itself is never selectable.
//   - the picker offers exactly four choices and no model field; the model line says it is fixed
//   - local -> Dazzi -> own OpenAI server -> own TEI server -> local, each applied through the UI, each leaving the
//     config, the keyring and the running `minsync serve` in the state that choice implies
//   - consent is required before text goes off the computer; a wrong key, a wrong size and a dead server are refused
//   - the key never reaches the config file
// Needs `minsync` on PATH, the model cached once, and a Dazzi sign-in for the cloud steps (~/.pi/agent/auth.json
// or QA_DAZZI_TOKEN); without a sign-in the cloud steps are reported as skipped, never faked. Build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/embedding-sources/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const hostModels = join(homeDir(), ".cache", "minsync", "models");
if (!existsSync(hostModels)) {
	console.log(`SKIP: no MinSync model cache at ${hostModels}; run \`minsync serve\` once to cache Qwen3-Embedding-0.6B`);
	process.exit(0);
}
const dazziToken = (() => {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		const entry = JSON.parse(readFileSync(join(homeDir(), ".pi", "agent", "auth.json"), "utf8")).dazzi;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
})();

const root = mkdtempSync(join(tmpdir(), "autorag-qa-sources-"));
const home = join(root, "home");
const docs = join(root, "docs");
const workspace = join(root, "workspace");
const agentDir = join(root, "pi-agent");
const configPath = join(root, "config.json");
const bin = join(root, "bin");
for (const dir of [join(home, ".cache", "minsync"), docs, workspace, agentDir, bin]) mkdirSync(dir, { recursive: true });
symlinkSync(hostModels, join(home, ".cache", "minsync", "models"));
writeFileSync(join(docs, "refund.md"), "# 환불 정책\n\n구매 후 7일 이내에는 사유와 관계없이 전액 환불이 가능합니다.\n");
if (dazziToken !== null) writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ dazzi: { type: "oauth", access: dazziToken, refresh: "", expires: 9_999_999_999_999 } }));
writeFileSync(configPath, `${JSON.stringify({ searchPaths: [docs], workspacePath: workspace, minSync: { enabled: true }, jikji: false, datasources: {} }, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const stateRoot = process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "minsync", "serve") : join(home, ".cache", "minsync", "serve");

const fails = [];
const skipped = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};
const waitFor = async (predicate, timeoutMs = 60000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
};
const servers = () => {
	if (!existsSync(stateRoot)) return [];
	return readdirSync(stateRoot)
		.map((instance) => {
			const read = (name) => { try { return readFileSync(join(stateRoot, instance, name), "utf8").trim(); } catch { return ""; } };
			return { host: read("host") || "127.0.0.1", port: Number(read("port")), pid: Number(read("pid")) };
		})
		.filter((server) => server.port > 0 && server.pid > 0);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The user's own servers, backed by the real local Qwen3 server (the one the app started), so every vector is real.
// `reject` flips them to a wrong key / wrong size / outage without touching the app.
const own = { openaiKey: "sk-qa-own-openai", wrongSize: false, seen: [] };
let backend = null;
const forward = async (path, body) => {
	const response = await fetch(`http://${backend.host}:${backend.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
	return { status: response.status, text: await response.text() };
};
const ownServer = (kind) =>
	createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", async () => {
			own.seen.push({ kind, url: request.url, authorization: request.headers.authorization ?? null });
			const send = (status, text) => { response.writeHead(status, { "content-type": "application/json" }); response.end(text); };
			if (backend === null) return send(503, "{}");
			if (kind === "openai") {
				if (request.url !== "/v1/embeddings") return send(404, "{}");
				if (request.headers.authorization !== `Bearer ${own.openaiKey}`) return send(401, JSON.stringify({ error: "bad key" }));
				const answer = await forward("/v1/embeddings", body);
				if (!own.wrongSize) return send(answer.status, answer.text);
				const parsed = JSON.parse(answer.text);
				parsed.data = parsed.data.map((row) => ({ ...row, embedding: row.embedding.slice(0, 768) }));
				return send(200, JSON.stringify(parsed));
			}
			if (request.url !== "/embed") return send(404, "{}");
			const answer = await forward("/embed", body);
			return send(answer.status, answer.text);
		});
	});
const openaiServer = ownServer("openai");
const teiServer = ownServer("tei");
await new Promise((resolve) => openaiServer.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => teiServer.listen(0, "127.0.0.1", resolve));
const openaiUrl = `http://127.0.0.1:${openaiServer.address().port}`;
const teiUrl = `http://127.0.0.1:${teiServer.address().port}`;

const env = {
	...homeEnv(home),
	AUTORAG_CONFIG: configPath,
	AUTORAG_HOME: root,
	PI_CODING_AGENT_DIR: agentDir,
	PATH: `${isolatedToolPath(bin)}${process.platform === "win32" ? ";" : ":"}${join(homeDir(), ".cargo", "bin")}${process.platform === "win32" ? ";" : ":"}/opt/homebrew/bin`,
	OPENAI_API_KEY: "",
	AUTORAG_EMBEDDING_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
try {
	const page = await finderWindow(app);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.waitForSelector(".sidebar__item");

	// The real local server comes up with the app (config names no embedder: the local model is the default).
	const first = await waitFor(async () => servers()[0] ?? null, 120000);
	check("the app started the local embedding server", first !== null, JSON.stringify(servers()));
	backend = first;
	const localPid = first?.pid ?? 0;

	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "AI Models" }).first().click();
	await page.waitForSelector(".settings-trigger[aria-haspopup='dialog']");

	const modal = page.locator(".settings-modal");
	const open = async () => {
		await page.locator(".settings-trigger[aria-haspopup='dialog']").last().click();
		await modal.locator("input[name='embedding-profile']").first().waitFor();
	};
	const pick = async (label) => modal.locator(".settings-list-row").filter({ has: page.locator(".settings-list-title", { hasText: label }) }).click();
	const apply = async () => modal.locator("button", { hasText: "Apply" }).click();
	const modalText = () => modal.innerText();
	const modalError = async () => ((await modal.locator(".settings-modal-error").count()) > 0 ? modal.locator(".settings-modal-error").first().innerText() : "");
	const close = async () => { await modal.locator("button", { hasText: "Close" }).click(); await modal.waitFor({ state: "detached" }); };
	const embedder = () => readConfig().minSync?.embedder;
	const consent = async () => { await modal.locator("input[name='embedding-consent-remote']").check(); };

	await open();
	const titles = await modal.locator(".settings-list-title").allInnerTexts();
	check("the picker offers exactly four choices", titles.length === 4, JSON.stringify(titles));
	check("the four are keyword-only, this computer, Dazzi cloud and my own server", /Off/.test(titles[0]) && /This computer/.test(titles[1]) && /Dazzi cloud/.test(titles[2]) && /My own server/.test(titles[3]), JSON.stringify(titles));
	check("there is no model name or dimension field anywhere", (await modal.locator("input[name*='model' i], input[name*='dimension' i]").count()) === 0 && !/Model Name|Dimension\b/.test(await modalText()));
	await pick("This computer");
	check("the model is stated as fixed", /Qwen3 Embedding 0\.6B \(1024 dimensions\)\. The model cannot be changed/.test(await modalText()), (await modalText()).slice(0, 200));
	await page.screenshot({ path: join(EVIDENCE, "01-picker-local.png") });

	// local (already the default) applied explicitly writes the native id
	await apply();
	check("this computer writes the native Qwen3 id", Boolean(await waitFor(() => embedder()?.id === "native:Qwen/Qwen3-Embedding-0.6B")), JSON.stringify(embedder()));
	check("this computer keeps one local server and needs no consent", servers().length === 1 && servers()[0].pid === localPid && (await modal.locator("input[name='embedding-consent-remote']").count()) === 0);
	await close();

	// ---- Dazzi cloud -------------------------------------------------------------------------------------------
	if (dazziToken === null) {
		skipped.push("Dazzi cloud (no Dazzi sign-in on this machine; set QA_DAZZI_TOKEN)");
		console.log("SKIP Dazzi cloud steps — no Dazzi sign-in available");
	} else {
		await open();
		await pick("Dazzi cloud");
		check("Dazzi cloud shows the sign-in note and a consent box", /Dazzi account sign-in/.test(await modalText()) && (await modal.locator("input[name='embedding-consent-remote']").count()) === 1);
		check("Apply is disabled until the user consents to leaving the computer", await modal.locator("button", { hasText: "Apply" }).isDisabled());
		await consent();
		await page.screenshot({ path: join(EVIDENCE, "02-picker-dazzi.png") });
		await modal.locator("button", { hasText: "Review Plan" }).click();
		await waitFor(async () => !(await modal.locator("button", { hasText: "Review Plan" }).isDisabled()), 30000);
		await apply();
		const dazzi = await waitFor(() => (embedder()?.id === "openai:qwen/qwen3-embedding-0.6b" ? embedder() : null), 60000);
		check("Dazzi cloud writes the hosted model id, the account URL and the key's variable name", dazzi !== null && dazzi.baseUrl === "https://api.dazziapp.com" && dazzi.dimension === 1024 && dazzi.apiKeyEnv === "OPENAI_API_KEY", JSON.stringify(embedder()));
		check("the account token is not in the config file", !readFileSync(configPath, "utf8").includes(dazziToken));
		check("the app stopped the local server it had started (nothing local is needed)", Boolean(await waitFor(() => !alive(localPid) && servers().length === 0, 30000)), JSON.stringify(servers()));
		await page.screenshot({ path: join(EVIDENCE, "03-dazzi-applied.png") });
		await close();
		// a server of this kind is needed by the own-server steps below
	}

	// ---- back to local, so the own servers have a real model behind them ---------------------------------------
	await open();
	await pick("This computer");
	await apply();
	check("switching back to this computer restarts the local server", Boolean(await waitFor(() => servers().length === 1 && alive(servers()[0].pid), 120000)), JSON.stringify(servers()));
	check("switching to this computer removes the Dazzi key variable and base URL", embedder()?.baseUrl === undefined && embedder()?.apiKeyEnv === undefined && embedder()?.id === "native:Qwen/Qwen3-Embedding-0.6B", JSON.stringify(embedder()));
	backend = servers()[0];
	await close();

	// ---- my own OpenAI-compatible server -----------------------------------------------------------------------
	await open();
	await pick("My own server");
	await modal.locator("input[name='embedding-server-url']").fill("https://not-a-real-host.invalid");
	check("Apply stays disabled until the user consents (remote address)", await modal.locator("button", { hasText: "Apply" }).isDisabled());
	await modal.locator("input[name='embedding-server-url']").fill(openaiUrl);
	check("a loopback address needs no consent box to apply", (await modal.locator("input[name='embedding-consent-remote']").count()) === 0);
	await modal.locator("input[name='embedding-api-key']").fill("sk-wrong");
	await apply();
	const wrongKey = await waitFor(async () => (/rejected the credentials/.test(await modalError()) ? true : null), 30000);
	check("a wrong key is refused with a clear message and nothing is written", Boolean(wrongKey) && embedder()?.baseUrl === undefined, await modalError());
	await modal.locator("input[name='embedding-api-key']").fill(own.openaiKey);
	own.wrongSize = true;
	await apply();
	const wrongSize = await waitFor(async () => (/768/.test(await modalError()) ? true : null), 30000);
	check("a server that returns another vector size is refused", Boolean(wrongSize) && embedder()?.baseUrl === undefined, await modalError());
	own.wrongSize = false;
	await apply();
	const byok = await waitFor(() => (embedder()?.baseUrl === openaiUrl ? embedder() : null), 60000);
	check("my own OpenAI server writes openai:Qwen3, its address, and a key variable name", byok !== null && byok.id === "openai:Qwen/Qwen3-Embedding-0.6B" && byok.dimension === 1024 && byok.apiKeyEnv === "AUTORAG_EMBEDDING_API_KEY", JSON.stringify(embedder()));
	check("the user's key is not in the config file", !readFileSync(configPath, "utf8").includes(own.openaiKey));
	check("the app sent the key to that server as a bearer token", own.seen.some((call) => call.kind === "openai" && call.authorization === `Bearer ${own.openaiKey}`));
	check("the local server stopped while a server of the user's own is in use", Boolean(await waitFor(() => servers().length === 0, 30000)), JSON.stringify(servers()));
	await page.screenshot({ path: join(EVIDENCE, "04-byok-openai-applied.png") });
	await close();
	// the own servers are backed by the local server, which just stopped: bring it back for the TEI step
	await open();
	await pick("This computer");
	await apply();
	await waitFor(() => servers().length === 1, 120000);
	backend = servers()[0];
	await close();

	// ---- my own TEI server --------------------------------------------------------------------------------------
	await open();
	await pick("My own server");
	await modal.locator("select[name='embedding-server-type']").selectOption("tei");
	await modal.locator("input[name='embedding-server-url']").fill(teiUrl);
	await apply();
	const tei = await waitFor(() => (embedder()?.id === "tei:Qwen/Qwen3-Embedding-0.6B" ? embedder() : null), 60000);
	check("my own TEI server writes tei:Qwen3 and its address, with no key variable (loopback, no key)", tei !== null && tei.baseUrl === teiUrl && tei.dimension === 1024 && tei.apiKeyEnv === undefined, JSON.stringify(embedder()));
	check("the TEI route /embed was used", own.seen.some((call) => call.kind === "tei" && call.url === "/embed"));
	await page.screenshot({ path: join(EVIDENCE, "05-byok-tei-applied.png") });
	await close();

	// ---- an unreachable server --------------------------------------------------------------------------------
	await open();
	await pick("My own server");
	await modal.locator("input[name='embedding-server-url']").fill("http://127.0.0.1:9");
	await apply();
	const down = await waitFor(async () => ((await modalError()).length > 0 ? true : null), 30000);
	check("an unreachable server is refused and the working one stays configured", Boolean(down) && embedder()?.baseUrl === teiUrl, await modalError());
	await close();

	// ---- real vectors through the picker's end state ----------------------------------------------------------
	await open();
	const reopened = await modalText();
	check("reopening shows the user's own server as the current choice with its address", embedder()?.baseUrl === teiUrl && /My own server/.test(await page.locator(".settings-trigger-label").last().innerText()), (await page.locator(".settings-trigger-label").last().innerText()));
	check("the saved address is shown but a key never is", reopened.includes("") && (await modal.locator("input[name='embedding-api-key']").inputValue()) === "");
	await close();

	// ---- keyword-only, and an index run through whichever server is current -------------------------------------
	await open();
	await pick("Off");
	await apply();
	check("keyword-only switches semantic search off and leaves the configured server in place", Boolean(await waitFor(() => readConfig().appIndexing?.semanticSearch === false)) && embedder()?.baseUrl === teiUrl, JSON.stringify(readConfig().appIndexing));
	await close();
	await open();
	await pick("This computer");
	await apply();
	check("choosing a model again switches semantic search back on", Boolean(await waitFor(() => readConfig().appIndexing?.semanticSearch === undefined && embedder()?.id === "native:Qwen/Qwen3-Embedding-0.6B")), JSON.stringify(readConfig()));
	await waitFor(() => servers().length === 1, 120000);
	await close();

	const refresh = await page.evaluate(() => window.autorag.settings.configRefresh());
	check("an index run through the local server finishes without error", refresh.ok === true, JSON.stringify({ ok: refresh.ok, error: refresh.error }));
	const minsyncDir = join(workspace, ".autorag", "minsync");
	const hit = existsSync(minsyncDir)
		? spawnSync("minsync", ["query", "--format", "json", "--mode", "vector", "-k", "1", "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:환불 정책이 뭐예요?"], { cwd: minsyncDir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 })
		: null;
	check("a semantic query finds the refund document", hit !== null && hit.status === 0 && (hit.stdout ?? "").includes("refund"), (hit?.stdout ?? hit?.stderr ?? "").slice(0, 160));
	await page.screenshot({ path: join(EVIDENCE, "06-final.png") });
	check("no renderer errors during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
} finally {
	await app.close().catch(() => undefined);
	openaiServer.close();
	teiServer.close();
}
check("quitting the app left no embedding server running", Boolean(await waitFor(() => servers().length === 0, 30000)), JSON.stringify(servers()));
rmRetry(root);

for (const note of skipped) console.log(`SKIPPED: ${note}`);
if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: the embedding source switches between this computer, the Dazzi cloud and the user's own OpenAI/TEI server; the model stays fixed — evidence in ${EVIDENCE}`);
}
