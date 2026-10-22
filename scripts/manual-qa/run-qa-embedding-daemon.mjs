import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { homeDir, homeEnv, isolatedToolPath, rmRetry } from "./platform.mjs";

// Live end-to-end for the local embedding model's life cycle, against the real built app and the real
// `minsync` and Qwen3-Embedding-0.6B weights (no stand-in server):
//   1. a config left by an earlier Dazzi (retired `profile`, mailcrawl overrides) is migrated on launch
//   2. launching the app starts exactly one `minsync serve` for the model, answering /health with real vectors
//   3. a second app instance adopts that server; quitting the first leaves a server it did not start alone
//   4. indexing a document folder embeds through that server and a semantic query finds the document
//   5. quitting the app stops the server it started, and removes its state files
// The profile and home are throwaway; the host's model cache is linked in read-only so nothing is downloaded.
// Needs `minsync` on PATH and the model cached once (`minsync serve` or any sync caches it). Build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/embedding-daemon/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const hostModels = join(homeDir(), ".cache", "minsync", "models");
if (!existsSync(hostModels)) {
	console.log(`SKIP: no MinSync model cache at ${hostModels}; run \`minsync serve\` once to cache Qwen3-Embedding-0.6B`);
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "autorag-qa-daemon-"));
const home = join(root, "home");
const docs = join(root, "docs");
const workspace = join(root, "workspace");
const agentDir = join(root, "pi-agent");
const configPath = join(root, "config.json");
const bin = join(root, "bin");
for (const dir of [join(home, ".cache", "minsync"), docs, workspace, agentDir, bin]) mkdirSync(dir, { recursive: true });
symlinkSync(hostModels, join(home, ".cache", "minsync", "models"));
writeFileSync(join(docs, "refund.md"), "# 환불 정책\n\n구매 후 7일 이내에는 사유와 관계없이 전액 환불이 가능합니다.\n");
writeFileSync(join(docs, "weather.md"), "# 오늘의 날씨\n\n서울은 맑고 낮 최고 기온은 21도입니다.\n");
// What an earlier Dazzi left behind: the retired runtime profile and the overrides it wrote into mailcrawl.
writeFileSync(
	configPath,
	`${JSON.stringify({
		searchPaths: [docs],
		workspacePath: workspace,
		minSync: { enabled: true, embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024 } },
		jikji: false,
		datasources: { mail: { type: "mailcrawl", connector: { env: { MAILCRAWL_EMBEDDER_PROVIDER: "native", MAILCRAWL_NATIVE_MODEL: "Qwen/Qwen3-Embedding-0.6B", MAILCRAWL_DATA_DIR: join(root, "mail") }, dataDir: join(root, "mail") }, enabled: false } },
	}, null, 2)}\n`,
);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const stateRoot = process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "minsync", "serve") : join(home, ".cache", "minsync", "serve");
const env = {
	...homeEnv(home),
	AUTORAG_CONFIG: configPath,
	AUTORAG_HOME: root,
	PI_CODING_AGENT_DIR: agentDir,
	PATH: `${isolatedToolPath(bin)}${process.platform === "win32" ? ";" : ":"}${join(homeDir(), ".cargo", "bin")}${process.platform === "win32" ? ";" : ":"}/opt/homebrew/bin`,
};

const fails = [];
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
/** The published `host:port:pid` of every server in the throwaway home, or [] when none. */
const servers = () => {
	if (!existsSync(stateRoot)) return [];
	return readdirSync(stateRoot)
		.map((instance) => {
			const read = (name) => { try { return readFileSync(join(stateRoot, instance, name), "utf8").trim(); } catch { return ""; } };
			return { instance, host: read("host") || "127.0.0.1", port: Number(read("port")), pid: Number(read("pid")) };
		})
		.filter((server) => server.port > 0);
};
const health = async (server) => {
	try {
		const response = await fetch(`http://${server.host}:${server.port}/health`, { signal: AbortSignal.timeout(2000) });
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

const userData = join(root, "user-data");
let first = null;
let second = null;
let serverPid = 0;
try {
	first = await launchFinder({ userDataDir: userData, env });
	const page = await finderWindow(first);
	await page.waitForSelector(".sidebar__item");
	await page.screenshot({ path: join(EVIDENCE, "01-launched.png") });

	// 1. migration of what an earlier Dazzi wrote
	const migrated = readConfig();
	check("the retired runtime profile became the local Qwen3 model", migrated.minSync?.embedder?.id === "native:Qwen/Qwen3-Embedding-0.6B" && migrated.minSync.embedder.profile === undefined, JSON.stringify(migrated.minSync));
	const mailEnv = migrated.datasources?.mail?.connector?.env ?? {};
	check("the embedding overrides the app used to write into mailcrawl were removed", !Object.keys(mailEnv).some((key) => /^MAILCRAWL_(EMBED|NATIVE_)/.test(key)), JSON.stringify(mailEnv));
	check("the user's own mailcrawl variable survived", mailEnv.MAILCRAWL_DATA_DIR === join(root, "mail"), JSON.stringify(mailEnv));

	// 2. the server is started by the app for the configured model
	const running = await waitFor(async () => {
		const [server] = servers();
		return server !== undefined && (await health(server)) !== null ? server : null;
	}, 120000);
	check("launching the app starts a `minsync serve` that answers /health", running !== null, JSON.stringify(servers()));
	const info = running === null ? null : await health(running);
	check("it serves Qwen3-Embedding-0.6B at 1024 dimensions", info?.model_id === "Qwen/Qwen3-Embedding-0.6B" && info?.dimension === 1024, JSON.stringify(info));
	check("exactly one server is running", servers().length === 1, String(servers().length));
	serverPid = running?.pid ?? 0;
	check("the owner file records the server's pid, so a crash can be cleaned up", existsSync(join(userData, "embedding-daemon.json")) && JSON.parse(readFileSync(join(userData, "embedding-daemon.json"), "utf8")).pid === serverPid);

	// real vectors from the server the app started
	const embed = async (input) => {
		const response = await fetch(`http://${running.host}:${running.port}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "Qwen/Qwen3-Embedding-0.6B", input }) });
		return (await response.json()).data.map((row) => row.embedding);
	};
	const [query] = await embed(["Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:환불 정책이 뭐예요?"]);
	const [refund, weather] = await embed(["구매 후 7일 이내에는 전액 환불이 가능합니다.", "서울은 맑고 낮 최고 기온은 21도입니다."]);
	check("real vectors rank the refund passage above the weather passage", query.length === 1024 && cosine(query, refund) > cosine(query, weather), `${cosine(query, refund).toFixed(3)} vs ${cosine(query, weather).toFixed(3)}`);

	// 3. a second app instance on another profile adopts the running server; it never starts a duplicate
	second = await launchFinder({ userDataDir: join(root, "user-data-2"), env });
	await finderWindow(second);
	await waitFor(async () => false, 4000);
	check("a second app instance adopts the running server instead of starting another", servers().length === 1 && servers()[0].pid === serverPid, JSON.stringify(servers()));
	await second.close();
	second = null;
	await waitFor(async () => false, 1500);
	check("closing an instance that did not start the server leaves it running", alive(serverPid) && (await health(servers()[0] ?? {})) !== null);

	// 4. indexing embeds through that server; a semantic query finds the right document
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
	await page.screenshot({ path: join(EVIDENCE, "02-indexing.png") });
	const refresh = await page.evaluate(() => window.autorag.settings.configRefresh());
	check("the app's index refresh finished without error", refresh.ok === true, JSON.stringify({ ok: refresh.ok, error: refresh.error, diagnostics: refresh.diagnostics?.slice(0, 3) }));
	const mirrors = existsSync(workspace) ? readdirSync(workspace, { recursive: true }).filter((name) => String(name).endsWith(".md")).length : 0;
	check("both documents were parsed into the workspace", refresh.written >= 2 || mirrors >= 2, `written=${refresh.written} mirrors=${mirrors}`);
	check("indexing did not start a second server", servers().length === 1 && servers()[0].pid === serverPid, JSON.stringify(servers()));
	const minsyncDir = join(workspace, ".autorag", "minsync");
	const hit = existsSync(minsyncDir)
		? spawnSync("minsync", ["query", "--format", "json", "--mode", "vector", "-k", "2", "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:환불 정책이 뭐예요?"], { cwd: minsyncDir, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 })
		: null;
	const top = hit === null ? "" : JSON.stringify(JSON.parse(hit.stdout || "{}"));
	check("a semantic query over the index returns the refund document first", hit !== null && hit.status === 0 && top.indexOf("refund") !== -1 && (top.indexOf("weather") === -1 || top.indexOf("refund") < top.indexOf("weather")), top.slice(0, 300) || String(hit?.stderr).slice(0, 300));
	await page.screenshot({ path: join(EVIDENCE, "03-before-quit.png") });
} finally {
	if (second !== null) await second.close().catch(() => undefined);
	if (first !== null) await first.close().catch(() => undefined);
}

// 5. quitting stops the server the app started and removes its state files
if (serverPid > 0) {
	const gone = await waitFor(() => !alive(serverPid), 30000);
	check("quitting the app stopped the server it started", gone === true, `pid ${serverPid} alive=${alive(serverPid)}`);
	check("its state files were removed", servers().length === 0, JSON.stringify(servers()));
	check("the owner file was removed", !existsSync(join(userData, "embedding-daemon.json")));
}
rmRetry(root);

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: the app runs one minsync serve for the local model, adopts it across instances, and stops what it started — evidence in ${EVIDENCE}`);
}
