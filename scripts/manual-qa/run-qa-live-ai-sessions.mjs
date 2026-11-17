// Live end-to-end: AI Sessions (the `wombat` datasource) in the real built app, with a real `wombat`, a real `minsync`
// and MinSync's own SPLADE + Qwen3 models. Nothing is stubbed.
//
// It walks what a user does:
//   1. Settings: "AI Sessions" is offered in the gallery (by that name), connect it, and the row shows "not fetched yet";
//   2. Sync it from Settings: the row turns to "N sessions" (the `session` unit), and the status goes Ready;
//   3. Whole search (⌘F): an "AI Sessions"-typed tab appears and lists real session rows by title and agent, with the
//      conversation as the snippet (not the model's label line); a keyword the sessions share finds them;
//   4. MCP: the app's own MCP server (`out/main/mcp-server.js`) lists the connection and answers a datasource search;
//   5. Keyword-only: with `minSync.embedder.id: "none"` the same search still answers (SPLADE only, no dense model).
//
// ISOLATION IS THE POINT. A first version of this feature leaked a test run into the developer's real `~/.wombat`. Here:
//   - HOME is a throwaway directory, so wombat's default `~/.wombat` and every agent's default folder resolve inside it;
//   - the fixtures are the ONLY sessions there, pinned with `connector.sources`;
//   - WOMBAT_DATA_DIR / WOMBAT_CONFIG are set explicitly;
//   - before anything starts, the lane refuses to run if any of those paths sits under the real home directory, and it
//     hashes the real `~/.wombat/catalog.sqlite3` and `~/.autorag/config.json` before and after: they must be identical.
//
// Run on this machine, never in a VM (it needs the real wombat and the model cache): `bun run build`, then
//   WOMBAT_BINARY=/path/to/wombat bun scripts/manual-qa/run-qa-live-ai-sessions.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const REAL_HOME = homedir();
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-sessions");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A file's sha256, or "absent": the real stores this lane must leave exactly as they were. */
const fingerprint = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : "absent");
const REAL_STORES = [join(REAL_HOME, ".wombat", "catalog.sqlite3"), join(REAL_HOME, ".autorag", "config.json")];
const before = REAL_STORES.map(fingerprint);

const wombatBinary = process.env.WOMBAT_BINARY ?? "wombat";
const version = spawnSync(wombatBinary, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
	console.error(`wombat is not runnable (${wombatBinary}); set WOMBAT_BINARY`);
	process.exit(2);
}
console.log(`using ${version.stdout.trim()} at ${wombatBinary}`);

const root = mkdtempSync(join(tmpdir(), "autorag-qa-ai-sessions-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const dataDir = join(root, "wombat-data");
const claudeRoot = join(root, "sessions", "claude");
const codexRoot = join(root, "sessions", "codex");
const configPath = join(root, "config.json");
const userData = join(root, "user-data");
for (const dir of [home, workspace, join(workspace, "docs"), claudeRoot, codexRoot, join(home, ".cache", "minsync")]) mkdirSync(dir, { recursive: true });
const realModels = join(REAL_HOME, ".cache", "minsync", "models");
if (existsSync(realModels)) symlinkSync(realModels, join(home, ".cache", "minsync", "models"));

// Refuse to start if anything this run will write could land in the real home.
for (const path of [home, workspace, dataDir, claudeRoot, codexRoot, configPath, userData]) {
	if (!resolve(path).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run: ${path} is outside the temp directory`);
	if (resolve(path).startsWith(join(REAL_HOME, ".wombat")) || resolve(path).startsWith(join(REAL_HOME, ".autorag"))) throw new Error(`refusing to run: ${path} is inside a real store`);
}

function claudeSession(id, turns) {
	const dir = join(claudeRoot, "proj-a");
	mkdirSync(dir, { recursive: true });
	const lines = turns.flatMap(([user, assistant], index) => [
		JSON.stringify({ type: "user", sessionId: id, cwd: "/work/alpha", timestamp: `2026-10-16T01:${String(index).padStart(2, "0")}:00Z`, message: { role: "user", content: user } }),
		JSON.stringify({ type: "assistant", sessionId: id, timestamp: `2026-10-16T01:${String(index).padStart(2, "0")}:10Z`, message: { role: "assistant", content: [{ type: "text", text: assistant }] } }),
	]);
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}
claudeSession("claude-sess-1", [
	["how do I stop the ingress from dropping long uploads", "Raise the proxy read timeout on the ingress controller and keep the upstream keepalive higher than it."],
	["baryon_lattice_cache 무효화 조건 설명해줘", "baryon_lattice_cache는 파일 해시가 바뀔 때만 갱신됩니다."],
]);
claudeSession("claude-sess-2", [["postgres table keeps growing even after deletes", "Autovacuum is falling behind; tune its cost limit and run VACUUM on the hot table."]]);
mkdirSync(codexRoot, { recursive: true });
writeFileSync(
	join(codexRoot, "rollout-2026-10-15T12-00-00-codex-sess-1.jsonl"),
	`${[
		{ timestamp: "2026-10-15T12:00:00Z", type: "session_meta", payload: { session_id: "codex-sess-1", cwd: "/work/beta", thread_source: "user" } },
		{ timestamp: "2026-10-15T12:00:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "zephyr_quasar_protocol 핸드셰이크 버그를 고쳐줘" }] } },
		{ timestamp: "2026-10-15T12:00:15Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "zephyr_quasar_protocol 타임아웃 재시도 로직을 수정했습니다." }] } },
	]
		.map((line) => JSON.stringify(line))
		.join("\n")}\n`,
);

const writeConfig = (minSync) =>
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				searchPaths: [join(workspace, "docs")],
				workspacePath: workspace,
				jikji: false,
				minSync,
				datasources: {},
			},
			null,
			2,
		)}\n`,
	);
writeFileSync(join(workspace, "docs", "note.md"), "# note\nA local document the AI Sessions search must not return.\n");
writeConfig({ autoInstall: false });

const env = {
	HOME: home,
	AUTORAG_HOME: root,
	AUTORAG_CONFIG: configPath,
	WOMBAT_DATA_DIR: dataDir,
	WOMBAT_CONFIG: join(root, "wombat.toml"),
	MINSYNC_SERVER: "off",
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	PATH: `${join(root, "bin")}:/usr/bin:/bin:${process.env.WOMBAT_PATH_EXTRA ?? ""}`,
};
mkdirSync(join(root, "bin"), { recursive: true });
symlinkSync(resolve(wombatBinary), join(root, "bin", "wombat"));
const minsync = spawnSync("which", ["minsync"], { encoding: "utf8" }).stdout.trim();
if (minsync.length > 0) symlinkSync(minsync, join(root, "bin", "minsync"));
else console.log("minsync is not on PATH; the sync will report it");

let app;
try {
	app = await launchFinder({ userDataDir: userData, env });
	const page = await finderWindow(app);
	page.setDefaultTimeout(20000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".sidebar__item--settings", { timeout: 30000 });

	const list = () => page.evaluate(() => window.autorag.settings.sourcesList());
	const openSettings = async () => {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "All Connections" }).click();
		await page.locator(".settings-content .linear-title", { hasText: "Connected apps" }).waitFor();
	};

	// 1. The gallery offers it by name, and connecting writes a plain entry.
	await openSettings();
	const titles = await page.locator(".settings-list-title").allInnerTexts();
	check('the gallery offers "AI Sessions" by that name', titles.includes("AI Sessions"), JSON.stringify(titles.slice(0, 20)));
	await page.screenshot({ path: join(EVIDENCE, "01-gallery.png") });
	const galleryRow = page.locator(".settings-list-row", { has: page.locator(".settings-list-title", { hasText: /^AI Sessions$/ }) });
	await galleryRow.locator("button").first().click();
	await page.locator(".settings-modal input").first().fill("wombat");
	await page.locator(".settings-modal .settings-btn-primary").click();
	await sleep(800);
	let saved = JSON.parse(readFileSync(configPath, "utf8"));
	check("connecting AI Sessions writes datasources.wombat", saved.datasources?.wombat !== undefined, JSON.stringify(saved.datasources));

	// Pin the fixtures: only these sessions exist for this run, whatever the host has installed.
	saved.datasources.wombat = { connector: { sources: { "claude-code": [claudeRoot], codex: [codexRoot] }, indexTimeoutMs: 1_800_000 } };
	writeFileSync(configPath, `${JSON.stringify(saved, null, 2)}\n`);
	await sleep(500);
	const first = (await list()).sources.find((row) => row.id === "wombat");
	// An empty wombat data dir is a true zero, not "unreadable": the row reads the CLI's own count, in sessions.
	check("before the first sync it is installed and holds no sessions yet", first?.install.state === "installed" && first?.index.state === "empty" && first?.index.unit === "session", JSON.stringify({ install: first?.install.state, index: first?.index.state, unit: first?.index.unit }));

	// 2. Sync from the app, the way the Sync button does.
	const started = Date.now();
	const synced = await page.evaluate(() => window.autorag.settings.sourcesSync("wombat"));
	check("syncing AI Sessions succeeds", synced.ok === true, JSON.stringify({ state: synced.state, chunks: synced.chunkCount, ms: Date.now() - started, error: synced.error }));
	const after = (await list()).sources.find((row) => row.id === "wombat");
	check("the row counts sessions", after?.index.state === "indexed" && after.index.unit === "session" && after.index.chunkCount === 3, JSON.stringify(after?.index));
	check("the status is ready", after?.status === "ready", after?.status);
	check("nothing was written under the real wombat home", !existsSync(join(home, ".wombat")) && existsSync(join(dataDir, "mirror")));
	// The connections list reads the snapshot the page fetched on opening; leave Settings and reopen it, as a user does.
	await page.keyboard.press(chord("w"));
	await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	await openSettings();
	await page.waitForFunction(() => /\d+\s+sessions/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => undefined);
	const connected = page.locator(".settings-list-row", { has: page.locator(".settings-list-title", { hasText: /^AI Sessions$/ }) });
	const rowText = await connected.first().innerText();
	check("the connections list reads the count in sessions under the name AI Sessions", /3\s+sessions/i.test(rowText), rowText.replace(/\s+/g, " ").slice(0, 160));
	await page.screenshot({ path: join(EVIDENCE, "02-settings-row.png") });
	await page.locator(".settings-nav-item--source[data-source-alias=\"wombat\"]").click();
	await page.waitForSelector('.settings-source[data-source-id="wombat"]');
	const detail = await page.locator('.settings-source[data-source-id="wombat"]').innerText();
	check("the connection's page offers the AI Sessions fields", /AI Sessions settings/.test(detail) && /Agents/.test(detail) && /Include subagent sessions/.test(detail), detail.replace(/\s+/g, " ").slice(0, 160));
	await page.screenshot({ path: join(EVIDENCE, "02b-settings-detail.png") });
	await page.keyboard.press(chord("w"));
	await page.waitForFunction(() => document.querySelector(".settings-panel") === null);

	// 3. Whole search.
	const search = async (query) => {
		await page.keyboard.press(chord("f"));
		await page.keyboard.type(query);
		await page.keyboard.press("Enter");
		await page.waitForSelector(".search-groups", { timeout: 15000 });
		await page.waitForFunction(() => document.querySelectorAll('.search-groups [role="status"]').length === 0, null, { timeout: 120000 }).catch(() => undefined);
	};
	await search("baryon_lattice_cache");
	const tab = page.locator('.search-groups [data-group="source:wombat"]');
	check("a tab for the AI Sessions connection appears among the groups", (await tab.count()) === 1, JSON.stringify(await page.locator('.search-groups [role="tab"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group")))));
	// The tab settles from a spinner to a count; read it only then.
	await page.waitForFunction(() => /\(\s*\d+\s*\)/.test(document.querySelector('.search-groups [data-group="source:wombat"]')?.textContent ?? ""), null, { timeout: 60000 }).catch(() => undefined);
	const label = ((await tab.first().textContent().catch(() => "")) ?? "").trim();
	check("the tab is named AI Sessions and holds a count", /^AI Sessions\s*\(\s*[1-9]\d*\s*\)$/.test(label), label);
	await tab.click();
	await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 });
	const rows = await page.locator('[role="listbox"] [role="option"]').allInnerTexts();
	const joined = rows.join(" | ");
	check("the row names the session by its title and the agent that ran it", /baryon_lattice_cache/.test(joined) && /claude-code/.test(joined), joined.replace(/\s+/g, " ").slice(0, 200));
	check("the snippet is the conversation, not the model's label line", !/\[claude-code:claude-sess-1/.test(joined) && /baryon_lattice_cache/.test(joined), joined.replace(/\s+/g, " ").slice(0, 200));
	await page.screenshot({ path: join(EVIDENCE, "03-whole-search.png") });
	await page.keyboard.press("Escape");

	await search("프로토콜 핸드셰이크 재시도");
	await page.locator('.search-groups [data-group="source:wombat"]').click();
	await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 }).catch(() => undefined);
	const korean = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).join(" | ");
	check("a Korean question finds the Codex session", /zephyr_quasar_protocol/.test(korean), korean.replace(/\s+/g, " ").slice(0, 160));
	await page.screenshot({ path: join(EVIDENCE, "04-korean.png") });
	await page.keyboard.press("Escape");

	// 4. The app's MCP server. It answers once the app's full refresh has marked the workspace ready; the lane's local
	// index is empty, so the marker is written the way that refresh writes it.
	mkdirSync(join(workspace, ".autorag"), { recursive: true });
	writeFileSync(join(workspace, ".autorag", "refresh-complete.json"), JSON.stringify({ version: 1, completed: true, parsed: true }));
	const mcpEntry = join(ROOT, "out", "main", "mcp-server.js");
	const transport = new StdioClientTransport({ command: process.execPath.includes("electron") ? "node" : process.execPath, args: [mcpEntry], env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" } });
	const client = new Client({ name: "ai-sessions-qa", version: "1.0.0" });
	try {
		await client.connect(transport);
		const tools = (await client.listTools()).tools.map((tool) => tool.name);
		check("the app's MCP server gives AI Sessions its own search tool", tools.includes("autorag.search_datasource_wombat"), tools.filter((name) => name.includes("datasource")).join(", "));
		const answer = await client.callTool({ name: "autorag.search_datasource_wombat", arguments: { query: "baryon_lattice_cache" } });
		const text = answer.content.find((item) => item.type === "text")?.text ?? "";
		const parsed = JSON.parse(text);
		const first = parsed.results?.[0];
		check(
			"an MCP client gets session-labelled hits with opaque sources",
			parsed.ok === true && /^\/wombat\/default\/chunks\/[A-Za-z0-9_-]+$/.test(first?.source ?? "") && /claude-code:claude-sess-1/.test(first?.metadata?.sessionKey ?? "") && !String(first?.source).includes(claudeRoot),
			JSON.stringify({ ok: parsed.ok, stale: parsed.stale, source: first?.source, sessionKey: first?.metadata?.sessionKey }),
		);
		// Known, reported in the PR: the librarian's hit metadata also carries `sessionPath`, the real log path. Nothing in the
		// agent flow reads it (`wombat show` / `trace` take the session key), so the contract this lane asserts is the source and the content.
		// Known finding (AutoRAG#2182 follow-up, not fixed here): the librarian's hit content is a chunk of wombat's mirror, whose
		// header block repeats the source log's path (`- source_path: ...`), and the hit metadata carries `sessionPath`. The
		// `source` id is opaque as the contract requires; the app's own rows strip the header (see `sourceHit`).
		console.log(`NOTE content carries the log path: ${String(first?.content).includes(claudeRoot)}`);
		console.log(`NOTE metadata.sessionPath present: ${typeof first?.metadata?.sessionPath === "string"}`);
		check("an MCP hit carries the session key the agent opens with `wombat show`", /"sessionKey":\s*"claude-code:claude-sess-1"/.test(text));
	} finally {
		await client.close().catch(() => undefined);
	}

	// 5. Keyword-only: SPLADE alone still answers.
	const keywordOnly = JSON.parse(readFileSync(configPath, "utf8"));
	keywordOnly.minSync = { ...keywordOnly.minSync, embedder: { id: "none" } };
	writeFileSync(configPath, `${JSON.stringify(keywordOnly, null, 2)}\n`);
	await sleep(500);
	const direct = spawnSync(wombatBinary, ["--data-dir", dataDir, "search", "--mode", "keyword", "--json", "ingress timeout"], { encoding: "utf8", env: { ...process.env, ...env } });
	check("SPLADE keyword search answers on its own", direct.status === 0 && /read timeout/.test(direct.stdout), direct.stdout.slice(0, 120));
} finally {
	await app?.close().catch(() => undefined);
	const afterStores = REAL_STORES.map(fingerprint);
	check("the real ~/.wombat catalog and ~/.autorag config are byte-identical afterwards", JSON.stringify(before) === JSON.stringify(afterStores), `${before.join(",")} -> ${afterStores.join(",")}`);
	rmSync(root, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\nLIVE QA PASSED" : `\nLIVE QA FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
