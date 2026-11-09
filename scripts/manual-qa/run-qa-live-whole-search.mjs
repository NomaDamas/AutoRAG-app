// Live end-to-end: the Finder's whole search (⌘F) against this machine's real shared AutoRAG config, so every
// datasource tab is answered by the datasource's own CLI or server, not a stub.
//
//   1. Enter shows the file-name rows at once, with the group tabs above them (files, content, then each datasource);
//   2. the datasource tabs follow config order, and only datasources the librarian can run get one (a type it no
//      longer ships, such as `cloud-drive`, is left out rather than shown as a tab that always fails);
//   3. the datasource tabs settle from a spinner to a count or a dash, and at least one returns hits;
//   4. the first datasource with hits lists its own rows (title, snippet) in place of the Finder list;
//   5. the content tab lists document passages or says why the index cannot answer;
//   6. "Ask AI Search" hands the same query to a new AI Search tab.
//
// It reads the real `~/.autorag/config.json` (or AUTORAG_CONFIG) and drives the real desktop, so it runs on this
// machine only, never in a VM: `bun run build`, then
//
//   bun scripts/manual-qa/run-qa-live-whole-search.mjs [query]
//
// The profile is a throwaway user-data directory; nothing is written to the home directory.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-whole-search");
mkdirSync(EVIDENCE, { recursive: true });
const QUERY = process.argv[2] ?? "AutoRAG";
const CONFIG = process.env.AUTORAG_CONFIG ?? join(homedir(), ".autorag", "config.json");
if (!existsSync(CONFIG)) {
	console.error(`No shared AutoRAG config at ${CONFIG}; connect a datasource in Settings first.`);
	process.exit(2);
}
const datasources = Object.entries(JSON.parse(readFileSync(CONFIG, "utf8")).datasources ?? {})
	.filter(([, value]) => value !== null && typeof value === "object" && value.enabled !== false)
	.map(([id]) => id);

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userDataDir = mkdtempSync(join(tmpdir(), "autorag-qa-live-whole-"));

let app;
try {
	app = await launchFinder({ userDataDir });
	const page = await finderWindow(app);
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".side-search input", { timeout: 30000 });

	// 1. ⌘F, type, Enter: the file names land first, the tabs sit above them.
	await page.keyboard.press(chord("f"));
	await page.keyboard.type(QUERY);
	const committed = Date.now();
	await page.keyboard.press("Enter");
	await page.waitForSelector(".search-groups", { timeout: 10000 });
	await page.waitForSelector('[role="row"] .row__label', { timeout: 20000 }).catch(() => undefined);
	const fileRowsAt = Date.now() - committed;
	const pendingAtFiles = await page.locator('.search-groups [role="status"]').count();
	check("file-name rows show fast under the group tabs without waiting for datasources", (await page.locator('[role="row"] .row__label').count()) > 0 && fileRowsAt < 1500, `${fileRowsAt} ms, ${pendingAtFiles} tab(s) still answering`);
	await page.screenshot({ path: join(EVIDENCE, "01-files-first.png") });

	// 2. Files, content, then the runnable datasources in config order (file rows arrive before the librarian thread finishes cold-loading).
	await page.waitForFunction(() => document.querySelectorAll('.search-groups [role="tab"]').length > 2, null, { timeout: 10000 }).catch(() => undefined);
	const keys = await page.locator('.search-groups [role="tab"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group")));
	const sourceIds = keys.slice(2).map((key) => key?.replace(/^source:/, "") ?? "");
	const inConfigOrder = sourceIds.every((id, index) => index === 0 || datasources.indexOf(id) > datasources.indexOf(sourceIds[index - 1]));
	check(
		"the tabs are files, content, then configured datasources in config order",
		keys[0] === "files" && keys[1] === "content" && sourceIds.length > 0 && sourceIds.every((id) => datasources.includes(id)) && inConfigOrder,
		`${JSON.stringify(keys)}; left out: ${JSON.stringify(datasources.filter((id) => !sourceIds.includes(id)))}`,
	);

	// 3. Every tab settles; at least one datasource answers with hits.
	await page.waitForFunction(() => document.querySelectorAll('.search-groups [role="status"]').length === 0, null, { timeout: 120000 }).catch(() => undefined);
	const settled = await page.locator('.search-groups [role="tab"]').evaluateAll((nodes) =>
		nodes.map((node) => ({ key: node.getAttribute("data-group"), text: node.textContent?.trim() ?? "", title: node.getAttribute("title") ?? "" })),
	);
	console.log(`settled after ${Date.now() - committed} ms: ${JSON.stringify(settled)}`);
	check("every group settles out of its spinner", (await page.locator('.search-groups [role="status"]').count()) === 0);
	const withHits = settled.filter((tab) => tab.key?.startsWith("source:") && /[1-9]\d*$/.test(tab.text));
	check("at least one datasource returns hits", withHits.length > 0, withHits.map((tab) => tab.key).join(", "));
	await page.screenshot({ path: join(EVIDENCE, "02-settled.png") });

	// 4. The first datasource with hits lists its rows in place of the Finder list.
	if (withHits.length > 0) {
		const key = withHits[0].key;
		await page.locator(`.search-groups [data-group="${key}"]`).click();
		await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 10000 }).catch(() => undefined);
		const titles = await page.locator('[role="listbox"] [role="option"] .font-medium').allInnerTexts();
		check(`${key} lists its own rows instead of the Finder list`, titles.length > 0 && (await page.locator('[role="row"] .row__label').count()) === 0, JSON.stringify(titles.slice(0, 5)));
		await page.keyboard.press("ArrowDown");
		await sleep(300);
		await page.screenshot({ path: join(EVIDENCE, "03-datasource.png") });
	}

	// 5. Document content: passages, or the reason the index cannot answer.
	await page.locator('.search-groups [data-group="content"]').click();
	await sleep(400);
	const contentRows = await page.locator('[role="listbox"] [role="option"]').count();
	const note = (await page.locator(".search-note").allInnerTexts()).join(" ").trim();
	check("the content tab lists passages or explains why it cannot", contentRows > 0 || note !== "", `${contentRows} rows, note=${JSON.stringify(note)}`);
	await page.screenshot({ path: join(EVIDENCE, "04-content.png") });

	// 6. Ask AI Search takes the same query to the chat.
	await page.locator(".search-ask").click();
	await page.locator(".user-msg .bubble").first().waitFor({ timeout: 10000 });
	const bubble = (await page.locator(".user-msg .bubble").first().innerText()).trim();
	check("Ask AI Search sends the query to a new AI Search tab", bubble === QUERY, bubble);
	await page.screenshot({ path: join(EVIDENCE, "05-ask-ai.png") });
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 400)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
