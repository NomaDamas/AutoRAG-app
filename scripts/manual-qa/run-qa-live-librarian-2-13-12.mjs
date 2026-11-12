/**
 * Live QA — the app on librarian 2.13.12, on the real built app with a real index and a real model.
 *
 * Librarian 2.13.12 reads an `excludePaths` entry with `*`, `?` or `[` as a glob over the whole absolute path, keeps
 * it verbatim in the resolved config, and applies it in the refresh walk; it also unions MinSync's dense and SPLADE
 * candidates for a reranker. The app reads `excludePaths` itself (index badges, the index map, the scope editor), so this
 * lane checks that all of those agree with the index:
 *
 *   A. Settings → Search Scope: a pattern typed into the exclusion list is saved verbatim (never resolved against the
 *      workspace); Settings' own refresh then takes the matched files out of a real MinSync index while the rest stay;
 *      the Finder's index status and the Settings → Indexing map call the matched files excluded and name the pattern;
 *      removing a search folder keeps the pattern.
 *   B. AI Search on a dense + SPLADE index with a reranker configured: the baseline search succeeds, the reranker is
 *      called with the union of both channels, and the answer is right.
 *
 * Part B uses a real OpenRouter model released in 2026 (QA_ANSWER_MODEL) and a rerank model through a loopback proxy that
 * records, and never alters, what passes. The key comes from QA_OPENROUTER_KEY, else OPENROUTER_API_KEY, else the
 * `openrouter` entry of ~/.pi/agent/auth.json; without one part B is skipped. Part B also needs the dense embedding
 * model in the MinSync cache.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-live-librarian-2-13-12.mjs
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const LIBRARIAN_CLI = join(ROOT, "node_modules", "@autorag", "librarian", "dist", "cli", "index.js");
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-librarian-2-13-12");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};

const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device model cache at ${MODELS}; real indexing cannot run`);
	process.exit(2);
}
const HAS_DENSE = existsSync(join(MODELS, "models--Qwen--Qwen3-Embedding-0.6B"));

function openRouterKey() {
	const fromEnv = process.env.QA_OPENROUTER_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const entry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).openrouter;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : typeof entry?.key === "string" ? entry.key : null;
	} catch {
		return null;
	}
}
const KEY = openRouterKey();
const ANSWER_MODEL = process.env.QA_ANSWER_MODEL?.trim() || "z-ai/glm-5.3-flash";
const RERANK_MODEL = process.env.QA_RERANK_MODEL?.trim() || "voyageai/rerank-3-lite";

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-2-13-12-"));
const HOME = join(WORK, "home");
for (const dir of [join(WORK, "pi-agent"), join(HOME, ".cache", "minsync")]) mkdirSync(dir, { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(HOME, ".cache", "minsync", "models"));

const TOKEN = "zebrafruit";
const write = (root, relative, text) => {
	const path = join(root, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return path;
};
const makeCorpus = (root) => {
	write(root, "keep-1.md", `# Keep one\n\nThe ${TOKEN} harvest of site one was logged by team ONE.\n`);
	write(root, "notes/todo.md", `# Todo\n\nThe ${TOKEN} delivery is due on Friday.\n`);
	write(root, "notes/todo.draft.md", `# Draft todo\n\nThe ${TOKEN} draft delivery, not final.\n`);
	write(root, "vault-glob/secret-1.md", `# Secret one\n\nThe ${TOKEN} vault code is 1111.\n`);
	write(root, "vault-glob/deep/secret-2.md", `# Secret two\n\nThe ${TOKEN} vault code is 2222.\n`);
};
const KEPT = ["keep-1.md", "todo.md"];
const GLOBBED = ["todo.draft.md", "secret-1.md", "secret-2.md"];
const GLOBS = ["**/vault-glob/**", "**/*.draft.md"];

const baseConfig = (docs, workspace, extra = {}) => ({
	searchPaths: [docs],
	workspacePath: workspace,
	memoryPath: join(workspace, "..", "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
	jikji: false,
	webSearch: { enabled: false },
	queryDecomposition: false,
	...extra,
});
const baseEnv = (config) => ({
	AUTORAG_HOME: join(WORK, "autorag-home"),
	...homeEnv(HOME),
	AUTORAG_CONFIG: config,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: KEY ?? "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	FASTEMBED_CACHE_DIR: MODELS,
});

async function launch(env, label) {
	const app = await launchFinder({ userDataDir: join(WORK, `user-data-${label}`), env, language: "en" });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	return { app, page, pageErrors };
}
const goTo = async (page, label) => {
	if ((await page.locator(".settings-panel").count()) === 0) {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
	}
	await page.locator(".settings-nav-item", { hasText: label }).first().click();
};
const refresh = (page) => page.evaluate(() => window.autorag.settings.configRefresh());
const documentCount = (page) => page.evaluate(() => window.autorag.settings.sourcesList().then((snap) => snap.local.documentCount));

let session = null;
try {
	// ── A. glob exclusions, end to end ────────────────────────────────────────────────────────────────────────────
	const docsA = join(WORK, "a-docs");
	const configA = join(WORK, "a-config.json");
	makeCorpus(docsA);
	writeFileSync(configA, `${JSON.stringify(baseConfig(docsA, join(WORK, "a-workspace")), null, 2)}\n`);
	const readA = () => JSON.parse(readFileSync(configA, "utf8"));
	session = await launch(baseEnv(configA), "a");
	let { page } = session;

	const first = await refresh(page);
	check("the first refresh over the whole corpus succeeds", first.ok === true, JSON.stringify({ ok: first.ok, error: first.error }));
	const before = await documentCount(page);
	check("every file is indexed before any exclusion", before === KEPT.length + GLOBBED.length, `documentCount=${before}`);

	// The person types the patterns into Settings → Search Scope → exclusion list.
	await goTo(page, "Search Scope");
	for (const glob of GLOBS) {
		await page.locator(".settings-chip-add").click();
		await page.locator(".modal input, [role='dialog'] input").last().fill(glob);
		await page.keyboard.press("Enter");
		await page.waitForFunction((want) => [...document.querySelectorAll(".settings-chip")].some((chip) => chip.textContent?.includes(want)), glob);
	}
	await page.screenshot({ path: join(EVIDENCE, "01-scope-exclusions.png") });
	check("the patterns are saved verbatim, not resolved against the workspace", JSON.stringify(readA().excludePaths) === JSON.stringify(GLOBS), JSON.stringify(readA().excludePaths));

	const second = await refresh(page);
	check("the refresh after the exclusion succeeds", second.ok === true, JSON.stringify({ ok: second.ok, error: second.error }));
	const after = await documentCount(page);
	check("the index lost exactly the files the patterns match", after === KEPT.length, `documentCount=${after}`);
	check("the patterns are still verbatim after the refresh wrote its state", JSON.stringify(readA().excludePaths) === JSON.stringify(GLOBS), JSON.stringify(readA().excludePaths));

	const statuses = await page.evaluate(
		(paths) => window.autorag.fs.indexStatus(paths),
		[join(docsA, "keep-1.md"), join(docsA, "notes", "todo.draft.md"), join(docsA, "vault-glob", "deep", "secret-2.md")],
	);
	log(`index status: ${JSON.stringify(statuses.map((s) => ({ kind: s.kind, excluded: s.excluded, toggleable: s.toggleable, detail: s.detail })))}`);
	check("a kept file reads as included", statuses[0]?.kind === "included" && statuses[0].excluded === false, JSON.stringify(statuses[0]));
	check("a file the pattern matches reads as excluded and not toggleable, naming the pattern", statuses[1]?.excluded === true && statuses[1].toggleable === false && statuses[1].detail.includes("**/*.draft.md"), JSON.stringify(statuses[1]));
	check("a deep file under a folder pattern reads as excluded", statuses[2]?.excluded === true && statuses[2].detail.includes("**/vault-glob/**"), JSON.stringify(statuses[2]));

	// What the librarian itself retrieves over that index: only the kept files, never a matched one.
	const retrieve = spawnSync(process.execPath, [LIBRARIAN_CLI, "lite", "retrieve", `${TOKEN} vault code delivery harvest`, "--json", "--top-k", "20"], { cwd: WORK, env: { ...process.env, ...baseEnv(configA) }, encoding: "utf8", timeout: 120_000 });
	writeFileSync(join(EVIDENCE, "retrieve-a.json"), retrieve.stdout);
	const sources = retrieve.status === 0 ? [...new Set(JSON.parse(retrieve.stdout).results.map((row) => row.source))] : [];
	check("`lite retrieve` over the app's config returns kept files only", retrieve.status === 0 && sources.length > 0 && sources.every((source) => KEPT.some((name) => source.endsWith(name))), retrieve.status === 0 ? JSON.stringify(sources) : retrieve.stderr.slice(0, 300));
	await goTo(page, "Indexing");
	await page.locator(".index-map-panel").waitFor();
	await page.locator(".index-map-chart path[data-node-id]").first().waitFor();
	const map = await page.evaluate(() =>
		[...document.querySelectorAll(".index-map-chart path[data-node-id]")].map((path) => ({ state: path.getAttribute("data-state"), kind: path.getAttribute("data-kind"), path: path.getAttribute("data-path") })),
	);
	await page.locator(".index-map-panel").evaluate((el) => el.scrollIntoView({ block: "start" }));
	await page.screenshot({ path: join(EVIDENCE, "02-index-map.png") });
	const vault = map.find((node) => node.kind === "folder" && node.path?.endsWith("vault-glob"));
	check("the index map shows the folder a pattern matches as excluded", vault?.state === "excluded", JSON.stringify(vault));
	const draft = map.find((node) => node.path?.endsWith("todo.draft.md"));
	check("…and the matched file in a kept folder as excluded", draft === undefined || draft.state === "excluded", JSON.stringify(draft));
	const kept = map.find((node) => node.path?.endsWith("keep-1.md"));
	check("…while a kept file is indexed", kept === undefined || kept.state === "indexed", JSON.stringify(kept));

	// Removing the only search folder keeps the pattern: it is not tied to one folder.
	await goTo(page, "Search Scope");
	await page.locator(".settings-path-line button").first().click();
	await page.waitForFunction(() => document.querySelectorAll(".settings-path-line").length === 0);
	check("removing a search folder keeps the patterns", JSON.stringify(readA().excludePaths) === JSON.stringify(GLOBS), JSON.stringify(readA().excludePaths));
	check("no renderer page error (part A)", session.pageErrors.length === 0, session.pageErrors.slice(0, 2).join(" | "));
	await session.app.close().catch(() => undefined);
	session = null;

	// ── B. dense + SPLADE candidates into a reranker ──────────────────────────────────────────────────────────────
	if (KEY === null || !HAS_DENSE) {
		log(`SKIP part B: ${KEY === null ? "no OpenRouter key" : "no dense embedding model in the MinSync cache"}`);
	} else {
		const traffic = { chat: [], rerank: [], statuses: [] };
		const proxy = createServer((req, res) => {
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				try {
					(req.url?.includes("/rerank") ? traffic.rerank : traffic.chat).push(JSON.parse(body.toString("utf8")));
				} catch {
					// not JSON: pass it through
				}
				const headers = { ...req.headers, host: "openrouter.ai", "content-length": String(body.length) };
				delete headers["accept-encoding"];
				const upstream = httpsRequest(`https://openrouter.ai${req.url}`, { method: req.method, headers }, (reply) => {
					traffic.statuses.push(`${req.url?.includes("/rerank") ? "rerank" : "chat"}:${reply.statusCode}`);
					res.writeHead(reply.statusCode ?? 502, reply.headers);
					reply.pipe(res);
				});
				upstream.on("error", (error) => {
					res.writeHead(502);
					res.end(String(error));
				});
				upstream.end(body);
			});
		});
		await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyUrl = `http://127.0.0.1:${proxy.address().port}/api/v1`;
		try {
			const docsB = join(WORK, "b-docs");
			const configB = join(WORK, "b-config.json");
			makeCorpus(docsB);
			const modelBlock = { provider: "openrouter-qa", id: ANSWER_MODEL, name: ANSWER_MODEL, baseUrl: proxyUrl, api: "openai-completions", apiKeyEnv: "OPENROUTER_API_KEY", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 16000 };
			writeFileSync(
				configB,
				`${JSON.stringify(
					baseConfig(docsB, join(WORK, "b-workspace"), {
						minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
						jev: { backend: "sllm" },
						rerank: { enabled: true, provider: "openrouter", model: RERANK_MODEL, baseUrl: proxyUrl, apiKeyEnv: "OPENROUTER_API_KEY" },
						model: modelBlock,
						queryDecomposition: { model: modelBlock },
					}),
					null,
					2,
				)}\n`,
			);
			session = await launch(baseEnv(configB), "b");
			({ page } = session);
			const built = await refresh(page);
			check("the dense + SPLADE index builds", built.ok === true, JSON.stringify({ ok: built.ok, error: built.error }));
			const count = await documentCount(page);
			check("every file is in the dense index", count === KEPT.length + GLOBBED.length, `documentCount=${count}`);

			await openAiSearch(page);
			await page.locator(`${AI_PANEL} button[aria-label="New chat"]`).click();
			await page.fill('textarea[aria-label="Ask Dazzi"]', `내 문서에서 ${TOKEN} vault code가 뭐야? 숫자로 답해줘.`);
			await page.keyboard.press("Enter");
			const deadline = Date.now() + 300_000;
			await page.waitForTimeout(1500);
			const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
			for (;;) {
				const done = await page.evaluate(() => document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null && document.querySelector('textarea[aria-label="Ask Dazzi"]') !== null);
				if (done) break;
				if (Date.now() > deadline) throw new Error("the answer did not finish within 300s");
				if (await allowOnce.isVisible().catch(() => false)) await allowOnce.click();
				await page.waitForTimeout(500);
			}
			const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
			const proses = page.locator(".assistant-msg .assistant-prose");
			let answer = "";
			for (let index = 0; index < (await proses.count()); index += 1) answer += `${await proses.nth(index).innerText()}\n`;
			await page.screenshot({ path: join(EVIDENCE, "03-ai-search-rerank.png") });
			writeFileSync(join(EVIDENCE, "rerank-requests.json"), JSON.stringify(traffic.rerank, null, 2));
			log(`answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}; statuses: ${traffic.statuses.join(",")}`);
			check("AI Search shows no error", error === "", error);
			check("the reranker was called", traffic.rerank.length >= 1, `${traffic.rerank.length} rerank request(s)`);
			const documents = traffic.rerank.flatMap((request) => (request.documents ?? []).map((doc) => (typeof doc === "string" ? doc : (doc?.text ?? JSON.stringify(doc)))));
			check("the reranker was shown the document that holds the answer", documents.some((text) => text.includes("1111") || text.includes("2222")), `${documents.length} candidate(s)`);
			check("every rerank and chat request succeeded", traffic.statuses.every((status) => status.endsWith(":200")), traffic.statuses.join(","));
			check("the answer carries the vault code", /1111|2222/u.test(answer), answer.slice(0, 200));
			check("no renderer page error (part B)", session.pageErrors.length === 0, session.pageErrors.slice(0, 2).join(" | "));
		} finally {
			proxy.close();
		}
	}
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 800));
	await session?.page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	await session?.app.close().catch(() => undefined);
	log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
	rmSync(WORK, { recursive: true, force: true });
	process.exitCode = failures.length === 0 ? 0 : 1;
}
