/**
 * Manual QA — Settings → Indexing: the map beside the progress bar shows WHERE a running index is working.
 *
 * A corpus big enough that a real MinSync run lasts several of the map's re-reads (it reads every 10 s while indexing)
 * is built in three folders, and the run is started with a real click on the Indexing page's own refresh button.
 * While it runs, the page is sampled once a second and the lane checks, on the real app:
 *
 *   - the progress card and the map are on the page together, the card above the map;
 *   - the legend gains its "indexing now" entry while the run is on, and loses it when it ends;
 *   - the map rings places (`data-progress="true"` on a sector) while files are moving, those places are real nodes
 *     under the scope, and the ring is not stuck on one spot: it moves as the run does;
 *   - the folder list in the side panel marks the folders that hold a ringed place;
 *   - when the run ends nothing is ringed, the legend is back to the four colours, and the map reads 100%.
 *
 * Nothing here is faked: the marks come from two real reads of the real index.
 *
 *   bun run build
 *   bun run qa script scripts/manual-qa/run-qa-index-progress-map.mjs
 *
 * `QA_FILES_PER_FOLDER` (default 3000) sets the corpus size. It has to be big: the map reads every 10 s while a run
 * is on, and a corpus whose stages end inside one read (1,200 tiny files do) rings everything at once, which says
 * nothing about where. A few thousand files keep each stage going across many reads.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-index-progress-map");
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

const FILES_PER_FOLDER = Number(process.env.QA_FILES_PER_FOLDER ?? 3000);
const FOLDERS = ["alpha", "beta", "gamma"];
const TOTAL = FILES_PER_FOLDER * FOLDERS.length;

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-index-progress-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const USER_DATA = join(WORK, "user-data");
for (const dir of [DOCS, join(WORK, "workspace"), join(WORK, "pi-agent"), join(WORK, "home")]) mkdirSync(dir, { recursive: true });
// The VM runner copies the host's model cache, including the SPLADE weights for this real sparse-only index.
const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device sparse model cache at ${MODELS}; real indexing cannot run`);
	rmSync(WORK, { recursive: true, force: true });
	process.exit(2);
}
mkdirSync(join(WORK, "home", ".cache", "minsync"), { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(WORK, "home", ".cache", "minsync", "models"));

// Every file is different (identical ones would be skipped as duplicates) and a few hundred bytes long.
const WORDS = ["quarterly", "milestone", "review", "figure", "ledger", "roadmap", "estimate", "archive", "invoice", "summary", "budget", "forecast"];
for (const folder of FOLDERS) {
	mkdirSync(join(DOCS, folder), { recursive: true });
	for (let n = 1; n <= FILES_PER_FOLDER; n += 1) {
		const body = Array.from({ length: 40 }, (_, i) => WORDS[(n * 7 + i * 3 + folder.length) % WORDS.length]).join(" ");
		writeFileSync(join(DOCS, folder, `doc-${String(n).padStart(4, "0")}.md`), `# ${folder} note ${n}\n\nUnique marker ${folder}-${n}-${n * 31}. ${body}\n`);
	}
}

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
			jikji: false,
			webSearch: { enabled: false },
			queryDecomposition: false,
		},
		null,
		2,
	)}\n`,
);

const APP_ENV = {
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

app = await launchFinder({ userDataDir: join(USER_DATA, "en"), env: APP_ENV, language: "en" });
const page = await finderWindow(app, 30_000);
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
const shot = async (name) => {
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
log(`app ready; ${TOTAL} files in ${FOLDERS.length} folders`);

await page.locator(".sidebar__item--settings").click();
await page.waitForSelector(".settings-panel");
await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
await page.locator(".index-map-chart path[data-node-id]").first().waitFor();
await page.locator(".index-map-panel").evaluate((el) => el.scrollIntoView({ block: "start" }));
await page.waitForTimeout(600);

/** Everything the lane judges, read in one evaluation so a sample is one moment. */
const sample = () =>
	page.evaluate(() => {
		const summary = document.querySelector(".index-map-summary");
		const panel = document.querySelector(".index-map-panel");
		const card = document.querySelector(".settings-activity");
		const ringedPaths = [...document.querySelectorAll('.index-map-chart path[data-progress="true"]')];
		const ringed = ringedPaths.map((path) => path.getAttribute("data-path"));
		const swatch = (state) => getComputedStyle(document.querySelector(`.index-map-legend li[data-state="${state}"] .index-map-legend-swatch`) ?? document.body).backgroundColor;
		const ringedBy = {};
		for (const path of ringed) {
			const folder = /[\\/](alpha|beta|gamma)(?:[\\/]|$)/u.exec(path ?? "")?.[1] ?? "other";
			ringedBy[folder] = (ringedBy[folder] ?? 0) + 1;
		}
		return {
			ringedBy,
			// A ring must not paint over the sector's own colour: every ringed sector still wears its state's legend colour.
			fillKept: ringedPaths.every((path) => getComputedStyle(path).fill === swatch(path.getAttribute("data-state"))),
			edges: document.querySelectorAll(".index-map-chart .index-map-edge").length,
			indexed: Number(summary?.getAttribute("data-indexed") ?? "-1"),
			targets: Number(summary?.getAttribute("data-targets") ?? "-1"),
			ringed,
			legend: [...document.querySelectorAll(".index-map-legend li")].map((li) => li.getAttribute("data-state")),
			rowMarks: [...document.querySelectorAll(".index-map-folders > button[data-progress]")].map((row) => row.querySelector("span")?.textContent ?? ""),
			cardTone: card?.getAttribute("data-tone") ?? null,
			stage: document.querySelector('.settings-activity [aria-current="step"]')?.textContent ?? null,
			cardAbovePanel: card !== null && panel !== null && (card.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
			percent: document.querySelector(".index-map-center strong")?.textContent ?? "",
		};
	});

const before = await sample();
log(`before: ${JSON.stringify(before)}`);
check("nothing is indexed yet, and every file is a target", before.indexed === 0 && before.targets === TOTAL, JSON.stringify(before));
check("idle: the legend has the four colours only, and nothing is ringed", before.legend.join(",") === "indexed,partial,unindexed,excluded" && before.ringed.length === 0, JSON.stringify(before.legend));
await shot("00-before");

// A real click on the Indexing page's own refresh button for the local folders.
const startedAt = Date.now();
await page.getByRole("button", { name: "Refresh local folders now" }).click();

const samples = [];
let firstRing = null;
let lastSignature = "";
const deadline = Date.now() + 840_000;
let finished = false;
while (Date.now() < deadline) {
	await page.waitForTimeout(1000);
	const now = await sample();
	samples.push({ at: Date.now() - startedAt, ...now });
	// A line only when something moved, so run.log reads as the run's timeline.
	const signature = JSON.stringify([now.indexed, now.ringedBy, now.cardTone, now.stage]);
	if (signature !== lastSignature) {
		lastSignature = signature;
		log(`t=${Math.round((Date.now() - startedAt) / 1000)}s indexed=${now.indexed}/${now.targets} ringed=${now.ringed.length} ${JSON.stringify(now.ringedBy)} legend=${now.legend.includes("progress") ? "+progress" : "-"} card=${now.cardTone} stage=${now.stage}`);
	}
	if (firstRing === null && now.ringed.length > 0) {
		firstRing = now;
		await shot("01-ring-mid-run");
	}
	if (now.indexed === now.targets && now.targets === TOTAL && now.cardTone !== "run") {
		finished = true;
		break;
	}
}
log(`run observed for ${Math.round((Date.now() - startedAt) / 1000)} s, ${samples.length} samples; finished=${finished}`);
check("the run finished and the map reads every file as indexed", finished, JSON.stringify(samples.at(-1)));

const running = samples.filter((s) => s.cardTone === "run");
check("the progress card and the map are on the page together while it runs, the card above the map", running.length > 0 && running.every((s) => s.cardAbovePanel), `${running.length} running samples`);
check("the legend names the ring exactly while a ring is on the map, never an unexplained mark or an explanation of nothing", samples.every((s) => s.legend.includes("progress") === (s.ringed.length > 0)), JSON.stringify(samples.filter((s) => s.legend.includes("progress") !== (s.ringed.length > 0)).slice(0, 2).map((s) => [s.at, s.legend, s.ringed.length])));

const ringedSamples = samples.filter((s) => s.ringed.length > 0);
const places = new Set(ringedSamples.flatMap((s) => s.ringed));
log(`ring seen in ${ringedSamples.length} samples, ${places.size} distinct places`);
check("the map rings places while files are moving", ringedSamples.length > 0, `run lasted ${Math.round((samples.at(-1)?.at ?? 0) / 1000)} s: too short for a mid-run read? raise QA_FILES_PER_FOLDER`);
// The map names canonical paths (a temp dir is a symlink on macOS), so compare against the real one.
const realDocs = realpathSync(DOCS);
check("every ringed place is a real file or folder under the scope", places.size > 0 && [...places].every((path) => path.startsWith(realDocs) && existsSync(path)), JSON.stringify([...places].slice(0, 6)));
// "Where" means a part of the map, not all of it, and different parts over time. Samples that ring some folders but not all.
const partial = ringedSamples.filter((s) => Object.keys(s.ringedBy).length < FOLDERS.length);
const partialSignatures = new Set(partial.map((s) => JSON.stringify(Object.keys(s.ringedBy).sort())));
const partialFolders = new Set(partial.flatMap((s) => Object.keys(s.ringedBy)));
log(`partial rings: ${partial.length} samples, ${partialSignatures.size} different places, folders ${[...partialFolders].join(",")}`);
check("the ring is a part of the map, not all of it: it points at some folders while others are plain", partial.length >= 3, `${partial.length} of ${ringedSamples.length} ringed samples`);
check("the ring moves with the run: it names at least three different places over time", partialSignatures.size >= 3, JSON.stringify([...partialSignatures]));
check("over the run it has pointed at every folder", FOLDERS.every((folder) => partialFolders.has(folder)), [...partialFolders].join(","));
check("the ring is a separate arc beside each ringed sector, not a stroke over it", ringedSamples.every((s) => s.edges === s.ringed.length), JSON.stringify(ringedSamples.map((s) => [s.ringed.length, s.edges]).slice(0, 4)));
check("a ringed sector keeps its own state colour, so the red/blue under the ring stays readable", ringedSamples.length > 0 && ringedSamples.every((s) => s.fillKept));
check("the folder list marks the folders that hold a ringed place", ringedSamples.some((s) => s.rowMarks.length > 0), JSON.stringify(ringedSamples.map((s) => s.rowMarks).slice(0, 3)));

const last = samples.at(-1);
await page.waitForTimeout(1500);
const after = await sample();
log(`after: ${JSON.stringify(after)}`);
check("when the run ends nothing is ringed and the legend is back to four colours", after.ringed.length === 0 && after.legend.join(",") === "indexed,partial,unindexed,excluded", JSON.stringify({ ringed: after.ringed.length, legend: after.legend }));
check("the map reads 100% at the end", /^100\s*%$/u.test(after.percent.trim()) || last?.percent.trim() === "100%", after.percent);
await shot("02-finished");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
