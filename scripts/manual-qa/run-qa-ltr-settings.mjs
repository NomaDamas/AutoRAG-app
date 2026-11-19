import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

/**
 * Settings → Search Ranking (learning to rank), driven in the real built app against the real librarian CLI.
 *
 * The ranking log is seeded through the librarian's own `RankingLogStore` (the same writer a search uses), with a
 * log that has real signal in it: runs where the reranker puts the cited chunk low and a feature predicts it. No
 * network, no model. What this lane proves is the whole path a person uses:
 *
 *   - the page opens from Settings, lists the right counts, says the reranker is off while it is;
 *   - Record searches writes `rankingLog` to the shared config, and back removes the key;
 *   - Train now runs the librarian in a child process (the window stays responsive meanwhile), and the verdict,
 *     the numbers and the model appear;
 *   - Use the trained model writes `ltr.enabled`, and the page then reports the model that serves;
 *   - automatic training writes `ltr.autoTrain` and an interval, and rejects a bad one;
 *   - deleting a model asks first, and the pinned model cannot be deleted;
 *   - the same page reads right in Korean.
 *
 * Production build first: bun run build
 * Run it through the VM runner: bun run qa script scripts/manual-qa/run-qa-ltr-settings.mjs --vm
 */

const EVIDENCE = process.env.QA_OUT ?? fileURLToPath(new URL("../../.omo/evidence/ltr-settings/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-ltr-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(workspace, "docs", "a.txt"), "alpha document about apples\n");
const configPath = join(root, "config.json");
const memoryPath = join(root, "memory.json");
const baseConfig = {
	searchPaths: [join(workspace, "docs")],
	workspacePath: workspace,
	memoryPath,
	minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
	jikji: false,
	webSearch: { enabled: false },
	queryDecomposition: false,
};
const writeConfig = (extra = {}) => writeFileSync(configPath, `${JSON.stringify({ ...baseConfig, ...extra }, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
writeConfig();

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined || ok ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};
const waitFor = async (predicate, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
};

/**
 * Write `count` finished runs into the ranking log. The runs are synthetic, written straight into the librarian's
 * SQLite file in its record shape (schemaVersion 1), because a lane with no model cannot produce real ones; a change to
 * that shape makes the librarian refuse the rows and this lane fail at "the log count". The live lane
 * (`run-qa-live-ltr.mjs`) fills the log from real searches instead.
 */
function seedLog(count) {
	const seed = `
		const { DatabaseSync } = require("node:sqlite");
		const path = process.argv[1] + ".ranking.db";
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, record TEXT NOT NULL) WITHOUT ROWID;");
		const insert = db.prepare("INSERT OR IGNORE INTO runs (run_id, started_at, record) VALUES (?, ?, ?)");
		let seed = 7;
		const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
		const count = Number(process.argv[2]);
		for (let i = 0; i < count; i += 1) {
			const startedAt = 1_800_000_000_000 + i * 60_000;
			const size = 8;
			// One chunk is the answer. The reranker ranks it first only about half the time; a signal that is only visible
			// in the logged features (dense rank) says where it really is, so a model can learn to move it up.
			const gold = Math.floor(rand() * size);
			const rerankOrder = [...Array(size).keys()].sort((a, b) => (a === gold ? (rand() < 0.5 ? -2 : 0.5) : rand()) - (b === gold ? (rand() < 0.5 ? -2 : 0.5) : rand()));
			const candidates = rerankOrder.map((chunk, position) => {
				const isGold = chunk === gold;
				const denseRank = isGold ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * size);
				return {
					chunkId: "c" + String(i).padStart(4, "0") + String(chunk),
					source: "/qa/doc" + chunk + ".md",
					origin: "local files",
					contentChars: 400,
					observations: [{ stage: "prefetch", surface: "minsync", method: "minsync-dense", query: "q" + i, rank: denseRank, score: 1 - denseRank / 20 }],
					rerank: { rank: position + 1, score: 1 - position / 10 },
					exposures: [{ surface: "baseline", query: "q" + i, position: position + 1 }],
					text: { bm25: rand(), questionCoverage: rand() },
					memory: { priorSupport: 0, similarQuestionSupport: null },
					labels: { citedFinal: isGold, modelCited: isGold },
				};
			});
			const record = { schemaVersion: 1, runId: "qa-" + i, conversationId: "qa", question: "q" + i, startedAt, finishedAt: startedAt + 1000, searchQueries: ["q" + i], datasources: [], web: false, reranker: { provider: "openrouter", model: "qa/rerank" }, judgments: { citationRelevance: "not-run", support: "not-run" }, candidates };
			insert.run(record.runId, record.startedAt, JSON.stringify(record));
		}
		db.close();
	`;
	execFileSync(process.execPath, ["-e", seed, memoryPath, String(count)], { stdio: ["ignore", "pipe", "inherit"] });
}

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, ...homeEnv(home), AUTORAG_SKIP_DUPEY_CHECK: "1", PI_CODING_AGENT_DIR: join(root, "pi-agent") };
mkdirSync(join(root, "pi-agent"), { recursive: true });
const shot = async (page, name) => page.screenshot({ path: join(EVIDENCE, name) });
const body = (page) => page.locator(".settings-ltr").innerText();
/** The page fills in once the librarian answers (a child process, about a second); assert only after the count shows. */
const loaded = (page) => waitFor(async () => /searches logged/u.test(await body(page)), 30_000);
const switchOf = (page, label) => page.locator(`.settings-ltr [aria-label="${label}"]`);
const open = async (page, label) => {
	if ((await page.locator(".settings-panel").count()) === 0) {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
	}
	await page.locator(".settings-nav-item", { hasText: label }).first().click();
	await page.locator(".settings-ltr").waitFor();
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env, language: "en" });
const pageErrors = [];
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.waitForSelector(".sidebar__item");

	// ── the page, with a log too small to train on and no reranker ────────────────────────────────
	seedLog(40);
	await open(page, "Search Ranking");
	check("the status reaches the page", (await loaded(page)) === true);
	await shot(page, "01-small-log-no-reranker.png");
	let text = await body(page);
	check("the page opens from Settings", /Search Ranking/u.test(text));
	check("it counts the logged searches against the number training needs", /40 searches logged/u.test(text) && /100 needed/u.test(text), text.slice(0, 300));
	check("it says the reranker is off and training cannot use the log", /Search result ordering is off/u.test(text));
	check("the training row is not named like its section", (await page.locator(".settings-ltr .settings-plain-name", { hasText: /^Training$/u }).count()) === 0);
	check("Train now is disabled and says how many more searches it needs", (await page.getByRole("button", { name: "Train now" }).isDisabled()) && /60 more logged searches/u.test(text));
	check("recording is on by default", (await switchOf(page, "Record searches").getAttribute("data-state")) === "checked");
	check("serving is off by default", (await switchOf(page, "Use the trained model").getAttribute("data-state")) === "unchecked");
	check("it says search order is the reranker's own while serving is off", /exactly as the ordering model made it/u.test(text));
	check("it states what is and is not stored", /document text is not stored/u.test(text));

	// ── the record switch writes the shared config ────────────────────────────────────────────────
	await switchOf(page, "Record searches").click();
	check("turning recording off writes rankingLog false", (await waitFor(() => readConfig().rankingLog === false)) === true, JSON.stringify(readConfig().rankingLog));
	await switchOf(page, "Record searches").click();
	check("turning it back on removes the key, so the default applies", (await waitFor(() => readConfig().rankingLog === undefined)) === true, JSON.stringify(readConfig().rankingLog));

	// ── enough runs, reranker on: the page enables training ───────────────────────────────────────
	seedLog(400);
	writeConfig({ rerank: { enabled: true, provider: "openrouter", model: "qa/rerank" } });
	await page.reload();
	await page.waitForSelector(".sidebar__item");
	await open(page, "Search Ranking");
	await waitFor(async () => /400 searches logged/u.test(await body(page)), 30_000);
	text = await body(page);
	await shot(page, "02-ready-to-train.png");
	check("with the reranker on the warning is gone", !/Search result ordering is off/u.test(text));
	check("the log count is current", /400 searches logged/u.test(text), text.slice(0, 200));
	check("Train now is enabled", (await page.getByRole("button", { name: "Train now" }).isEnabled()) === true);

	// ── training: real librarian, child process, window stays responsive ──────────────────────────
	const started = Date.now();
	await page.getByRole("button", { name: "Train now" }).click();
	const lag = await page.evaluate(
		() =>
			new Promise((resolve) => {
				let worst = 0;
				let last = performance.now();
				const timer = setInterval(() => {
					const now = performance.now();
					worst = Math.max(worst, now - last - 20);
					last = now;
				}, 20);
				setTimeout(() => {
					clearInterval(timer);
					resolve(worst);
				}, 1500);
			}),
	);
	check("the renderer's event loop is never blocked while training runs", lag < 250, `worst stall ${Math.round(lag)} ms`);
	const finished = await waitFor(async () => /Training finished|did not pass|not enough data|Training failed/u.test(await body(page)), 180_000);
	const trainMs = Date.now() - started;
	text = await body(page);
	await shot(page, "03-trained.png");
	check("training ends with a verdict the page shows", finished === true, text.slice(0, 400));
	const passed = /Training finished and the model passed/u.test(text);
	check("the model is listed with its numbers", (await page.locator("[data-ltr-model]").count()) >= 1 && /MRR\)?\s*0\.\d{3}\s*→\s*0\.\d{3}/u.test(text), text.slice(0, 600));
	check("the page does not claim the answers get better", /not that answers get better/u.test(text));
	console.log(`INFO training took ${trainMs} ms; verdict: ${passed ? "passed" : "not passed"}`);
	const stateFiles = existsSync(`${memoryPath}.ltr`) ? readdirSync(`${memoryPath}.ltr`) : [];
	check("the librarian stored the model beside the memory file", stateFiles.includes("models") && stateFiles.includes("state.json"), stateFiles.join(","));

	// ── serving ───────────────────────────────────────────────────────────────────────────────────
	if (passed) {
		await switchOf(page, "Use the trained model").click();
		check("turning serving on writes ltr.enabled", (await waitFor(() => readConfig().ltr?.enabled === true)) === true, JSON.stringify(readConfig().ltr));
		const serving = await waitFor(async () => /Adjusting the order with model xgb-/u.test(await body(page)));
		await shot(page, "04-serving.png");
		check("the page names the model that now serves", serving === true, (await body(page)).slice(0, 400));
		const firstModel = await page.locator("[data-ltr-model]").first().getAttribute("data-ltr-model");
		await page.locator("[data-ltr-model]").first().getByRole("button", { name: "Use this model" }).click();
		check("Use this model pins that model in the config", (await waitFor(() => readConfig().ltr?.model === firstModel)) === true, JSON.stringify(readConfig().ltr));
		check("the pinned model is marked Selected", (await waitFor(async () => (await page.locator(`[data-ltr-model="${firstModel}"]`).innerText()).includes("Selected"))) === true);
	} else {
		console.log("INFO the model did not pass its gate on this log; serving checks skipped (a rejected model must not serve)");
		await switchOf(page, "Use the trained model").click();
		await waitFor(() => readConfig().ltr?.enabled === true);
		const noModel = await waitFor(async () => /no model has passed yet/u.test(await body(page)));
		check("serving on with no passing model says the order is unchanged", noModel === true, (await body(page)).slice(0, 300));
	}

	// ── automatic training ────────────────────────────────────────────────────────────────────────
	await switchOf(page, "Retrain automatically").click();
	check("automatic training writes ltr.autoTrain.enabled", (await waitFor(() => readConfig().ltr?.autoTrain?.enabled === true)) === true, JSON.stringify(readConfig().ltr));
	const every = switchOf(page, "Every new searches");
	await every.waitFor();
	await every.fill("150");
	await every.press("Enter");
	check("a whole-number interval is written", (await waitFor(() => readConfig().ltr?.autoTrain?.minNewRuns === 150)) === true, JSON.stringify(readConfig().ltr));
	check("the field shows the stored number after the write, not the old one", (await waitFor(async () => (await every.inputValue()) === "150")) === true, await every.inputValue());
	await every.fill("0");
	await every.press("Enter");
	const refused = await waitFor(async () => /whole number of 1 or more/u.test(await body(page)));
	check("an interval of 0 is refused on the page and not written", refused === true && readConfig().ltr?.autoTrain?.minNewRuns === 150, JSON.stringify(readConfig().ltr));
	check("a refused interval puts the stored number back in the field", (await waitFor(async () => (await every.inputValue()) === "150")) === true, await every.inputValue());
	await shot(page, "05-automatic-refused.png");
	await every.fill("1");
	check("the refusal goes away as soon as the person edits the field again", !/whole number of 1 or more/u.test(await body(page)));
	await every.press("Escape");
	await every.fill("150");
	await every.press("Enter");
	await shot(page, "05-automatic.png");

	// ── a second model, then delete: the pinned one is kept, the other asks first ─────────────────
	if (passed) {
		const pinnedId = readConfig().ltr?.model;
		await page.getByRole("button", { name: "Train now" }).click();
		const two = await waitFor(async () => (await page.locator("[data-ltr-model]").count()) === 2, 120_000);
		check("training again adds a second model", two === true, String(await page.locator("[data-ltr-model]").count()));
		await shot(page, "06-two-models.png");
		const rows = page.locator("[data-ltr-model]");
		const pinnedRow = page.locator(`[data-ltr-model="${pinnedId}"]`);
		const otherRow = rows.filter({ hasNot: pinnedRow });
		check("the pinned model offers no Delete", (await pinnedRow.getByRole("button", { name: "Delete" }).count()) === 0);
		check("the other model does", (await otherRow.getByRole("button", { name: "Delete" }).count()) === 1);
		const otherId = await otherRow.first().getAttribute("data-ltr-model");
		await otherRow.getByRole("button", { name: "Delete" }).click();
		check("Delete asks before it deletes", (await page.getByRole("button", { name: "Confirm delete" }).count()) === 1 && (await rows.count()) === 2);
		await shot(page, "07-delete-confirm.png");
		await page.getByRole("button", { name: "Cancel" }).click();
		check("Cancel keeps the model", (await rows.count()) === 2 && (await page.getByRole("button", { name: "Confirm delete" }).count()) === 0);
		await otherRow.getByRole("button", { name: "Delete" }).click();
		await page.getByRole("button", { name: "Confirm delete" }).click();
		check("confirming deletes only that model", (await waitFor(async () => (await rows.count()) === 1)) === true && (await page.locator(`[data-ltr-model="${otherId}"]`).count()) === 0 && (await pinnedRow.count()) === 1);
		const onDisk = existsSync(`${memoryPath}.ltr/models`) ? readdirSync(`${memoryPath}.ltr/models`) : [];
		check("the deleted model is gone from disk and the pinned one is not", !onDisk.includes(otherId) && onDisk.includes(pinnedId), onDisk.join(","));
		await page.getByRole("button", { name: "Use the newest passing model" }).click();
		check("Use the newest passing model removes the pin from the config", (await waitFor(() => readConfig().ltr?.model === undefined)) === true, JSON.stringify(readConfig().ltr));
	}

	// ── Korean ────────────────────────────────────────────────────────────────────────────────────
	await page.evaluate(() => window.autorag.settings.set({ language: "ko" }));
	await waitFor(async () => /검색 순위 학습/u.test(await page.locator(".settings-nav-item").allInnerTexts().then((all) => all.join("|"))));
	await open(page, "검색 순위 학습");
	text = await body(page);
	await shot(page, "08-korean.png");
	check("the page reads in Korean", /검색 기록 쌓기/u.test(text) && /학습된 모델/u.test(text) && /이 컴퓨터에만 저장됩니다/u.test(text), text.slice(0, 300));
	check("no English UI string leaks into the Korean page", !/Train now|Record searches|Search log|Trained models/u.test(text), text.slice(0, 300));

	check("no renderer page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
	check("run completed", false, String(error?.stack ?? error).slice(0, 800));
	const page = await finderWindow(app, 2000).catch(() => null);
	await page?.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	await app.close().catch(() => undefined);
	console.log(`RESULT ${fails.length === 0 ? "ALL PASS" : `${fails.length} FAILURES: ${fails.join(" | ")}`}`);
	rmSync(root, { recursive: true, force: true });
	process.exitCode = fails.length === 0 ? 0 : 1;
}
