/**
 * Live QA — the app on librarian 2.13.7 + MinSync 0.7.x, on the real built app with a real index.
 *
 * Librarian 2.13.7 syncs MinSync alongside parsing: `refresh-progress.json` keeps `phase: "parsed"` while MinSync
 * already syncs batches, and MinSync's total grows with every committed batch. This lane checks, on a real run
 * started by a real click on Settings → Indexing:
 *
 *   - while parsing is still on, MinSync's stage is `running` beside it (it was `pending` before), exactly one stage
 *     is the current step (`aria-current="step"`), and the bar never moves backwards;
 *   - the run finishes with every stage done and the index holds every file;
 *   - the index answers a real search that names a document by a word only it holds (the keyword index serves it);
 *   - a config an earlier Dazzi wrote (`jev: false`) is repaired at launch, and a Settings edit over it succeeds.
 *
 * Nothing is faked: the stage list is the app's own, fed by the real `refresh-progress.json`.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-live-librarian-2-13-7.mjs
 *
 * `QA_FILES` (default 1500) sets the corpus size: a run has to last long enough for parsing and syncing to overlap.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-librarian-2-13-7");
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

const FILES = Number(process.env.QA_FILES ?? 1500);
const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-2137-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const WORKSPACE = join(WORK, "workspace");
for (const dir of [DOCS, WORKSPACE, join(WORK, "pi-agent"), join(WORK, "home")]) mkdirSync(dir, { recursive: true });
const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device sparse model cache at ${MODELS}; real indexing cannot run`);
	rmSync(WORK, { recursive: true, force: true });
	process.exit(2);
}
mkdirSync(join(WORK, "home", ".cache", "minsync"), { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(WORK, "home", ".cache", "minsync", "models"));

const WORDS = ["quarterly", "milestone", "review", "figure", "ledger", "roadmap", "estimate", "archive", "invoice", "summary", "budget", "forecast"];
for (let n = 1; n <= FILES; n += 1) {
	const body = Array.from({ length: 40 }, (_, i) => WORDS[(n * 7 + i * 3) % WORDS.length]).join(" ");
	writeFileSync(join(DOCS, `doc-${String(n).padStart(4, "0")}.md`), `# note ${n}\n\nUnique marker m${n}-${n * 31}. ${body}\n`);
}
const NEEDLE = "zephyrquartz";
writeFileSync(join(DOCS, "needle.md"), `# Needle\n\nThe only document that mentions ${NEEDLE} in the whole corpus.\n`);
const TOTAL = FILES + 1;

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: WORKSPACE,
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
			jikji: false,
			// What an earlier Dazzi wrote: the librarian refuses it outright.
			jev: false,
			webSearch: { enabled: false },
			queryDecomposition: false,
		},
		null,
		2,
	)}\n`,
);

const env = {
	AUTORAG_HOME,
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	FASTEMBED_CACHE_DIR: MODELS,
};

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

app = await launchFinder({ userDataDir: join(WORK, "user-data"), env, language: "en" });
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(30_000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });

// 1. launch repaired the legacy value
check("launch rewrote `jev: false` to the small chat model", JSON.stringify(JSON.parse(readFileSync(CONFIG, "utf8")).jev) === JSON.stringify({ backend: "sllm" }), readFileSync(CONFIG, "utf8").slice(0, 200));
const legacy = JSON.parse(readFileSync(CONFIG, "utf8"));
legacy.jev = false;
writeFileSync(CONFIG, `${JSON.stringify(legacy, null, 2)}\n`);
const patched = await page.evaluate(() => window.autorag.settings.configPatch([{ path: ["rerank"], value: false }]).then((snap) => ({ ok: true, error: snap.error }), (error) => ({ ok: false, error: String(error) })));
check("a Settings edit over a legacy `jev: false` succeeds", patched.ok && patched.error === null, JSON.stringify(patched));

await page.locator(".sidebar__item--settings").click();
await page.waitForSelector(".settings-panel");
await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
await page.getByRole("button", { name: "Refresh local folders now" }).waitFor();

/** One moment of the stage list, the bar and the count line. */
const sample = () =>
	page.evaluate(() => {
		const card = document.querySelector(".settings-activity");
		const stages = [...document.querySelectorAll(".settings-activity-stages li")].map((item) => ({ label: item.textContent ?? "", state: item.getAttribute("data-state"), current: item.getAttribute("aria-current") === "step" }));
		const bar = document.querySelector('.settings-activity [role="progressbar"]');
		return {
			tone: card?.getAttribute("data-tone") ?? null,
			stages,
			percent: bar?.getAttribute("aria-valuenow") === null || bar === null ? null : Number(bar.getAttribute("aria-valuenow")),
			lines: [...document.querySelectorAll('[data-testid="index-progress-detail"] p')].map((line) => line.textContent ?? ""),
		};
	});

const startedAt = Date.now();
await page.getByRole("button", { name: "Refresh local folders now" }).click();
const samples = [];
let last = "";
const deadline = Date.now() + 600_000;
let finished = false;
while (Date.now() < deadline) {
	await page.waitForTimeout(400);
	const now = await sample();
	samples.push({ at: Date.now() - startedAt, ...now });
	const signature = JSON.stringify([now.tone, now.stages.map((stage) => `${stage.label}:${stage.state}${stage.current ? "*" : ""}`), now.percent]);
	if (signature !== last) {
		last = signature;
		log(`t=${((Date.now() - startedAt) / 1000).toFixed(1)}s tone=${now.tone} ${now.stages.map((stage) => `${stage.label}:${stage.state}${stage.current ? "*" : ""}`).join(" ")} bar=${now.percent}`);
	}
	if (now.tone !== null && now.tone !== "run" && samples.some((s) => s.tone === "run")) {
		finished = true;
		break;
	}
}
log(`run observed for ${Math.round((Date.now() - startedAt) / 1000)} s, ${samples.length} samples; finished=${finished}`);
await page.screenshot({ path: join(EVIDENCE, "02-finished.png") });
check("the run finished", finished, JSON.stringify(samples.at(-1)));

const running = samples.filter((s) => s.tone === "run" && s.stages.length === 4);
// Overlap: the read stage is running AND MinSync's stage (third) is running in the same sample.
const overlapped = running.filter((s) => s.stages[1]?.state === "running" && s.stages[2]?.state === "running");
log(`running samples: ${running.length}; samples with parse and MinSync running together: ${overlapped.length}`);
check("MinSync's stage runs beside the read stage while parsing goes on", overlapped.length >= 1, `corpus too small for the stages to overlap? raise QA_FILES (now ${FILES})`);
check("exactly one stage is the current step in every running sample", running.every((s) => s.stages.filter((stage) => stage.current).length === 1), JSON.stringify(running.find((s) => s.stages.filter((stage) => stage.current).length !== 1)));
check("while both run, the current step is the read stage", overlapped.every((s) => s.stages[1]?.current === true && s.stages[2]?.current === false), JSON.stringify(overlapped[0]?.stages));
check("a stage never goes back from done to running", running.every((s, index) => index === 0 || s.stages.every((stage, i) => !(running[index - 1].stages[i]?.state === "done" && stage.state !== "done"))));
const percents = running.map((s) => s.percent).filter((value) => value !== null);
const regressions = percents.filter((value, index) => index > 0 && value < percents[index - 1] - 1);
check("the bar never moves backwards while MinSync's total grows", regressions.length === 0, JSON.stringify(regressions.slice(0, 5)));
const overlapLines = overlapped.map((s) => s.lines.join(" | "));
log(`a line while overlapped: ${overlapLines[0] ?? "(none)"}`);
const after = await sample();
check("when it ends every stage reads done (or the card is idle)", after.stages.length === 0 || after.stages.every((stage) => stage.state === "done"), JSON.stringify(after.stages));
if (overlapped.length > 0) await page.screenshot({ path: join(EVIDENCE, "01-overlap-note.png") }).catch(() => undefined);

// 3. the index holds every file and answers by a word only one document has
const progress = JSON.parse(readFileSync(join(WORKSPACE, ".autorag", "refresh-progress.json"), "utf8"));
check("the librarian recorded a successful run over every file", progress.state === "success" && (progress.parsedCounts?.scanned ?? 0) >= TOTAL, JSON.stringify({ state: progress.state, scanned: progress.parsedCounts?.scanned, minsync: progress.minsync }));
// The keyword index answers a real search through the app's own content-search bridge.
let hits = [];
for (let attempt = 0; attempt < 20 && hits.length === 0; attempt += 1) {
	const found = await page.evaluate((needle) => window.autorag.fs.contentSearch(needle, 5), NEEDLE);
	hits = found.hits ?? [];
	if (hits.length === 0) await page.waitForTimeout(500);
}
log(`content search for "${NEEDLE}": ${JSON.stringify(hits.map((hit) => hit.entry?.name))}`);
check("the keyword index finds the one document that holds the word", hits.length >= 1 && hits[0].entry?.name === "needle.md", JSON.stringify(hits.map((hit) => hit.entry?.name)));
check("no renderer page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
