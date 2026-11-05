/**
 * Manual QA — Settings → Search Scope → View index map, in the real app.
 *
 * A scope is built the way a person has one (projects, notes, an archive, a
 * private folder they excluded, a `node_modules` the refresh never walks, and
 * files no parser reads), Settings' own refresh indexes it, and then one file
 * changes and two arrive. The map must count each state the way the index
 * holds it, play the opening count (the scoreboard ticks from red to blue and
 * settles on the index's own numbers), paint blue and red land on the globe,
 * turn the globe under a real drag, name what is under the pointer, and
 * redraw after a refresh that an exclusion toggle started while the map is
 * open. Korean is checked as the second language.
 *
 *   bun run build
 *   bun run qa script scripts/manual-qa/run-qa-finder-index-map.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-index-map");
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

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-index-map-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const BIN = join(AUTORAG_HOME, "bin");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const USER_DATA = join(WORK, "user-data");
for (const dir of [DOCS, join(WORK, "workspace"), join(WORK, "pi-agent"), join(WORK, "home")]) mkdirSync(dir, { recursive: true });
writeMinsyncStub(BIN);
// The on-device model the runner copies into the guest (or the host's own cache); the refresh refuses to stage without it.
const MODELS = process.env.FASTEMBED_CACHE_DIR ?? join(process.env.HOME ?? "", ".cache", "minsync", "models");
if (!existsSync(MODELS)) {
	console.log(`SKIP: no on-device embedding model at ${MODELS}; the map needs a real index`);
	rmSync(WORK, { recursive: true, force: true });
	process.exit(0);
}
mkdirSync(join(WORK, "home", ".cache", "minsync"), { recursive: true });
if (process.platform !== "win32") symlinkSync(MODELS, join(WORK, "home", ".cache", "minsync", "models"));

const put = (relative, text) => {
	const path = join(DOCS, relative);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};
for (let n = 1; n <= 6; n += 1) put(`projects/alpha/spec-${n}.md`, `# Alpha spec ${n}\n\nThe alpha milestone ${n} ships in week ${n * 2}.\n`);
for (let n = 1; n <= 4; n += 1) put(`projects/beta/plan-${n}.md`, `# Beta plan ${n}\n\nBeta needs ${n * 3} reviewers.\n`);
for (let n = 1; n <= 5; n += 1) put(`notes/note-${n}.txt`, `Note ${n}: the quarterly figure is ${n * 7}.\n`);
for (let n = 1; n <= 3; n += 1) put(`archive/2024/report-${n}.txt`, `Report ${n} from 2024.\n`);
for (let n = 1; n <= 3; n += 1) put(`private/diary-${n}.txt`, `Private entry ${n}.\n`);
put("node_modules/pkg/README.md", "# pkg\n");
put("node_modules/pkg/CHANGELOG.md", "# changes\n");
put("misc/blob-1.qaunknown", "opaque");
put("misc/blob-2.qaunknown", "opaque");
const INDEXABLE = 6 + 4 + 5 + 3;

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			excludePaths: [join(DOCS, "private")],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
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
	PATH: `${BIN}${delimiter}${process.env.PATH ?? ""}`,
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

let page;
const start = async (language) => {
	app = await launchFinder({ userDataDir: join(USER_DATA, language), env: APP_ENV, language });
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
};
const shot = async (name) => {
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
/** A cheap fingerprint of the canvas, to tell whether the globe moved. */
const canvasPrint = () =>
	page.evaluate(() => {
		const canvas = document.querySelector(".index-map-canvas");
		const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
		let sum = 0;
		for (let offset = 0; offset < data.length; offset += 52) sum = (sum * 31 + data[offset]) % 1_000_000_007;
		return sum;
	});
const scoreboard = () =>
	page.evaluate(() => {
		const board = document.querySelector(".index-map-scoreboard");
		const read = (party) => Number(board?.querySelector(`.index-map-party[data-party="${party}"] strong`)?.textContent?.replace(/[^\d]/gu, "") ?? "-1");
		return { counting: board?.getAttribute("data-counting") ?? null, blue: read("blue"), red: read("red") };
	});
const openMap = async (scopeLabel, buttonLabel) => {
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: scopeLabel }).click();
	await page.getByRole("button", { name: buttonLabel }).click();
	await page.locator(".index-map-modal").waitFor();
	await page.locator(".index-map-legend").waitFor();
	// The overlay leaves once the map has arrived.
	await page.waitForFunction(() => document.querySelector(".index-map-overlay") === null, null, { timeout: 60_000 });
};
const legend = () =>
	page.evaluate(() =>
		Object.fromEntries([...document.querySelectorAll(".index-map-legend li")].map((item) => [item.getAttribute("data-state"), Number(item.querySelector("strong")?.textContent?.replace(/[^\d]/gu, "") ?? "0")])),
	);
/** Share of canvas pixels that are blue (indexed) or red (needs indexing) land; sea and the studio are darker and less saturated. */
const landColors = () =>
	page.evaluate(() => {
		const canvas = document.querySelector(".index-map-canvas");
		const context = canvas.getContext("2d");
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		let blue = 0;
		let red = 0;
		let grey = 0;
		for (let offset = 0; offset < data.length; offset += 16) {
			const r = data[offset];
			const g = data[offset + 1];
			const b = data[offset + 2];
			if (b > 175 && b > g + 70 && r < 140) blue += 1;
			else if (r > 120 && r > g + 60 && r > b + 50) red += 1;
		}
		const total = data.length / 16;
		return { blue: blue / total, red: red / total };
	});
/** Moves the real pointer over the canvas in a grid until a tooltip names something. */
const hoverSomething = async () => {
	const box = await page.locator(".index-map-canvas").boundingBox();
	for (let y = 0.2; y <= 0.8; y += 0.05) {
		for (let x = 0.15; x <= 0.85; x += 0.035) {
			await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
			if ((await page.locator(".index-map-tooltip").count()) > 0) return (await page.locator(".index-map-tooltip").innerText()).replace(/\s+/gu, " ");
		}
	}
	return null;
};

// ── 1. English: index the scope with Settings' own refresh, then let it drift. ──
await start("en");
log("app ready (en)");
// The full refresh: the parsed phase writes the mirror, the MinSync phase stages it; a file is in the index once staged.
const refresh = await page.evaluate(() => window.autorag.settings.configRefresh());
log(`refresh: ${JSON.stringify({ ok: refresh.ok, error: refresh.error, written: refresh.written, diagnostics: refresh.diagnostics?.slice(0, 4) })}`);
const indexed = (await page.evaluate(() => window.autorag.settings.sourcesList())).local.documentCount;
check("Settings' refresh indexed every indexable file", indexed === INDEXABLE, `local.documentCount=${indexed}`);
put("projects/alpha/spec-1.md", "# Alpha spec 1\n\nThe alpha milestone moved: it now ships in week nine, after the review.\n");
put("notes/note-6.txt", "Note 6: a new figure, 42.\n");
put("notes/note-7.txt", "Note 7: another new figure, 49.\n");

await openMap("Search Scope", "View index map");
const early = await scoreboard();
log(`scoreboard while counting: ${JSON.stringify(early)}`);
check("the opening count is live and blue has not taken everything yet", early.counting === "true" && early.blue < INDEXABLE - 1, JSON.stringify(early));
await page.waitForTimeout(300);
await shot("00-counting");
await page.waitForTimeout(4200);
const counts = await legend();
log(`legend: ${JSON.stringify(counts)}`);
check("indexed counts the files the index holds unchanged", counts.indexed === INDEXABLE - 1, JSON.stringify(counts));
check("the changed file needs a refresh", counts.stale === 1, JSON.stringify(counts));
check("the two new files are not indexed yet", counts.unindexed === 2, JSON.stringify(counts));
check("the excluded folder and node_modules are left out", counts.excluded >= 3, JSON.stringify(counts));
check("files no parser reads are counted apart", counts.unindexable === 2, JSON.stringify(counts));
const final = await scoreboard();
log(`scoreboard after the count: ${JSON.stringify(final)}`);
check("the count settles on the index's own numbers", final.counting === "false" && final.blue === counts.indexed && final.red === counts.stale + counts.unindexed, JSON.stringify(final));
const coverage = await page.locator(".index-map-coverage strong").innerText();
check("coverage is indexed over indexable", coverage === `${Math.round(((INDEXABLE - 1) * 100) / (INDEXABLE + 2))}%`, coverage);
const colors = await landColors();
log(`land colors: ${JSON.stringify(colors)}`);
check("blue indexed land is painted", colors.blue > 0.01, JSON.stringify(colors));
check("red land marks what needs indexing", colors.red > 0.0008, JSON.stringify(colors));
check("there is more blue land than red", colors.blue > colors.red, JSON.stringify(colors));
await shot("01-index-map-en");

const tooltip = await hoverSomething();
check("hovering the globe names what is under it", tooltip !== null && tooltip.length > 0, String(tooltip));
log(`tooltip: ${tooltip}`);
await shot("02-hover");

// Turn the globe with a real drag: it moves, then holds still where it was left.
const box = await page.locator(".index-map-canvas").boundingBox();
const beforeDrag = await canvasPrint();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let n = 1; n <= 12; n += 1) await page.mouse.move(box.x + box.width / 2 + n * 18, box.y + box.height / 2 + n * 4);
await page.mouse.up();
await page.waitForTimeout(2000);
const held = await canvasPrint();
await page.waitForTimeout(600);
check("dragging turns the globe", held !== beforeDrag);
check("after a drag the globe stays where it was left", held === (await canvasPrint()));
await shot("02b-turned");

// Zoom with the wheel, then frame the map again with the fit button.
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let n = 0; n < 6; n += 1) await page.mouse.wheel(0, -240);
await page.waitForTimeout(400);
await shot("03-zoomed");
await page.getByRole("button", { name: "Fit to view" }).click();
await page.waitForTimeout(1500);
await shot("04-fit");

// ── 2. An exclusion toggled while the map is open: the map redraws after the refresh. ──
await page.evaluate((path) => window.autorag.fs.setIndexExcluded(path, true), join(DOCS, "archive"));
// An excluded folder is not walked, so it counts its direct entries (`archive/` holds `2024/`); its three files
// leave the indexable total once the toggle's refresh drops them from the index.
const archiveGone = (state) =>
	state.excluded === counts.excluded + 1 && state.indexed + state.stale + state.unindexed === INDEXABLE + 2 - 3;
const settled = await page
	.waitForFunction(
		(expected) => {
			const read = (name) => Number(document.querySelector(`.index-map-legend li[data-state="${name}"] strong`)?.textContent?.replace(/[^\d]/gu, "") ?? "-1");
			return read("excluded") === expected.excluded && read("indexed") + read("stale") + read("unindexed") === expected.rest;
		},
		{ excluded: counts.excluded + 1, rest: INDEXABLE + 2 - 3 },
		{ timeout: 120_000 },
	)
	.then(() => true, () => false);
const after = await legend();
log(`legend after exclusion: ${JSON.stringify(after)}`);
check("after the refresh the archive is left out", settled && archiveGone(after), JSON.stringify(after));
await page.waitForTimeout(3000);
await shot("05-after-exclusion");

await page.keyboard.press("Escape");
check("Escape closes the map", (await page.locator(".index-map-modal").count()) === 0);
await app.close();
app = undefined;
// ── 3. Korean: the same map in the second language. ──
await start("ko");
log("app ready (ko)");
await openMap("검색 범위", "인덱싱 지도 보기");
await page.waitForTimeout(4500);
const ko = await page.locator(".index-map-legend").innerText();
check("Korean legend names the states", /인덱싱됨/u.test(ko) && /인덱싱 안 됨/u.test(ko) && /제외됨/u.test(ko), ko.replace(/\s+/gu, " "));
await shot("06-index-map-ko");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
