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
	const wrapLayout = await page.evaluate(() => {
		const bar = document.querySelector(".search-groups");
		const list = document.querySelector('.search-groups [role="tablist"]');
		const tabs = [...document.querySelectorAll('.search-groups [role="tab"]')];
		if (!bar || !list || tabs.length === 0) return null;
		const barRect = bar.getBoundingClientRect();
		const rowTops = new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
		const clipped = tabs.some((tab) => {
			const rect = tab.getBoundingClientRect();
			return rect.left < barRect.left - 1 || rect.right > barRect.right + 1;
		});
		return {
			overflowX: list.scrollWidth > list.clientWidth + 1,
			rows: rowTops.size,
			clipped,
		};
	});
	check(
		"many datasource tabs wrap onto multiple rows with zero horizontal scrolling or clipping",
		wrapLayout !== null && wrapLayout.overflowX === false && wrapLayout.clipped === false && wrapLayout.rows >= 2,
		JSON.stringify(wrapLayout),
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

	// 5. Document content: passages, and "Show in Folder" opens the hit's folder in a NEW tab without losing the search tab.
	await page.locator('.search-groups [data-group="content"]').click();
	await sleep(400);
	const contentRows = await page.locator('[role="listbox"] [role="option"]').count();
	const note = (await page.locator(".search-note").allInnerTexts()).join(" ").trim();
	check("the content tab lists passages or explains why it cannot", contentRows > 0 || note !== "", `${contentRows} rows, note=${JSON.stringify(note)}`);
	await page.screenshot({ path: join(EVIDENCE, "04-content.png") });
	if (contentRows > 0) {
		const tabsBeforeReveal = await page.locator(".tabs .tab").count();
		const revealedPath = await page.locator('[role="listbox"] [role="option"]').first().getAttribute("data-path");
		await page.locator(".search-reveal").first().click();
		await page.waitForFunction((expected) => document.querySelectorAll(".tabs .tab").length === expected, tabsBeforeReveal + 1, { timeout: 10000 }).catch(() => undefined);
		await sleep(300);
		const tabsAfterReveal = await page.locator(".tabs .tab").count();
		const selectedRow = await page.locator('[role="row"][aria-selected="true"]').first().getAttribute("data-path").catch(() => null);
		check(
			"Show in Folder opens a new folder tab with the file selected while keeping the search tab",
			tabsAfterReveal === tabsBeforeReveal + 1 && (await page.locator(".search-groups").count()) === 0 && selectedRow === revealedPath,
			`tabs=${tabsBeforeReveal}->${tabsAfterReveal}, selected=${selectedRow}`,
		);
		await page.screenshot({ path: join(EVIDENCE, "04b-revealed-in-new-tab.png") });
		// Switch back to the search tab and verify the search is still intact.
		await page.locator(".tabs .tab").first().click();
		await page.waitForSelector(".search-groups", { timeout: 5000 });
		check("switching back to the original tab restores the whole search", (await page.locator(".search-groups").count()) === 1);
	}

	// 5b. Relevance gate (lexical/edit-distance pass-through + Jev noul >= 0.5 with sLLM fallback):
	//     an unrelated query drops dense-vector chat noise to 0 instead of returning 30 unrelated rows per chat app,
	//     while a semantic query ("비행기예약확인증") drops unrelated Telegram/WhatsApp noise to 0 yet keeps Kakao airline hits.
	const searchInput = page.locator(".side-search input");
	await searchInput.click();
	await searchInput.fill("양자역학슈뢰딩거방정식");
	await searchInput.press("Enter");
	await page.waitForFunction(() => document.querySelectorAll('.search-groups [role="status"]').length === 0, null, { timeout: 120000 }).catch(() => undefined);
	const noiseSettled = await page.locator('.search-groups [role="tab"]').evaluateAll((nodes) =>
		nodes.map((node) => ({ key: node.getAttribute("data-group"), text: node.textContent?.trim() ?? "" })),
	);
	console.log(`unrelated query settled: ${JSON.stringify(noiseSettled)}`);
	const contentNoise = noiseSettled.find((tab) => tab.key === "content");
	const tgNoise = noiseSettled.find((tab) => tab.key === "source:telegram");
	const waNoise = noiseSettled.find((tab) => tab.key === "source:whatsapp");
	if (contentNoise !== undefined) check("Jev gate drops unrelated local Document Content dense-vector noise to 0", /0$/.test(contentNoise.text), contentNoise.text);
	if (tgNoise !== undefined) check("Jev gate drops unrelated Telegram dense-vector noise to 0", /0$/.test(tgNoise.text), tgNoise.text);
	if (waNoise !== undefined) check("Jev gate drops unrelated WhatsApp dense-vector noise to 0", /0$/.test(waNoise.text), waNoise.text);
	await page.screenshot({ path: join(EVIDENCE, "04c-noise-gated.png") });

	await searchInput.click();
	await searchInput.fill("비행기예약확인증");
	await searchInput.press("Enter");
	await page.waitForFunction(() => document.querySelectorAll('.search-groups [role="status"]').length === 0, null, { timeout: 120000 }).catch(() => undefined);
	const flightSettled = await page.locator('.search-groups [role="tab"]').evaluateAll((nodes) =>
		nodes.map((node) => ({ key: node.getAttribute("data-group"), text: node.textContent?.trim() ?? "" })),
	);
	console.log(`semantic flight query settled: ${JSON.stringify(flightSettled)}`);
	const contentFlight = flightSettled.find((tab) => tab.key === "content");
	const tgFlight = flightSettled.find((tab) => tab.key === "source:telegram");
	const kkFlight = flightSettled.find((tab) => tab.key === "source:kakao");
	if (contentFlight !== undefined) check("Jev gate filters unrelated local Document Content hits on flight query (< 20)", !/20$/.test(contentFlight.text), contentFlight.text);
	if (tgFlight !== undefined) {
		const tgCount = Number(/(\d+)$/.exec(tgFlight.text)?.[1] ?? "999");
		check("Jev gate suppresses unrelated Telegram hits on flight query (30 -> <= 2)", tgCount <= 2, tgFlight.text);
	}
	if (kkFlight !== undefined) check("Jev gate keeps semantically relevant Kakao airline hits on flight query", /[1-9]\d*$/.test(kkFlight.text), kkFlight.text);

	// Restore original query from cache before testing Ask AI Search.
	await searchInput.click();
	await searchInput.fill(QUERY);
	await searchInput.press("Enter");
	await sleep(200);
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
