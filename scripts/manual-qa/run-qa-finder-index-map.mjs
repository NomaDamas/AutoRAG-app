/**
 * Manual QA — Settings → Search Scope: the search folders, the index map and the exclusions on one page, in the real app.
 *
 * A scope is built the way a person has one (two projects, notes, an archive, a
 * private folder excluded in config, a `node_modules` the refresh never walks,
 * a folder of files no parser reads), Settings' own refresh indexes it, and
 * then one file changes and two arrive. The map is a DaisyDisk-style radial
 * territory chart inside the page, so the lane checks the real thing:
 *
 *   - every drawn territory is an SVG `path[data-node-id]` with its `data-state`
 *     (indexed / partial / unindexed / excluded), `data-kind` and `data-path`;
 *   - the eligible-only percent sits at the centre (`indexed / targets`, with
 *     excluded folders and unsupported files out of the denominator);
 *   - paths take focus and clicks, a folder click drills into its children, and
 *     the centre brings the whole scope back;
 *   - the details sidebar names the hovered or focused node, and keeps the clicked
 *     one (with its action) after the pointer leaves;
 *   - the legend lists the four colours with no per-state counts;
 *   - a folder-only-in-unsupported files is left off the map entirely;
 *   - the map follows a real refresh started from its own button, by itself;
 *   - editing from the map: a folder is left out (config `excludePaths`, the map grays
 *     it, the target set shrinks) and brought back;
 *   - editing the folder list: a folder picked in the system dialog (stubbed here; the
 *     dialog itself is the OS's) appears in `searchPaths` and as a new root on the map,
 *     one inside an existing target is refused with a reason, and Delete takes it off
 *     again.
 *
 * Korean is checked as the second language. Only the real Settings refresh and the
 * setup are called through `evaluate`; every map and page interaction is a real
 * Playwright hover, focus or click.
 *
 *   bun run build
 *   bun run qa script scripts/manual-qa/run-qa-finder-index-map.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry } from "./platform.mjs";

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

const KO = JSON.parse(readFileSync(join(ROOT, "src/shared/i18n/locales/ko.json"), "utf8"));

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-index-map-"));
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
// Only files no parser reads: the folder must leave the map entirely.
put("misc/blob-1.qaunknown", "opaque");
put("misc/blob-2.qaunknown", "opaque");
// A folder outside the scope, added to and removed from the folder list below.
const EXTRA = join(WORK, "extra");
mkdirSync(EXTRA, { recursive: true });
for (let n = 1; n <= 2; n += 1) writeFileSync(join(EXTRA, `ledger-${n}.txt`), `Ledger ${n}: a figure outside the scope.\n`);
/** Files the index is meant to hold: supported and inside the scope (archive counts until it is excluded). */
const INDEXABLE = 6 + 4 + 5 + 3;
const TARGETS_DRIFT = INDEXABLE + 2; // spec-1 changed, note-6 and note-7 arrived
const PERCENT_DRIFT = Math.round(((INDEXABLE - 1) * 100) / TARGETS_DRIFT);
const NOTES_INDEXED = 5;
const NOTES_TARGETS = 7;
const PERCENT_NOTES = Math.round((NOTES_INDEXED * 100) / NOTES_TARGETS);

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			excludePaths: [join(DOCS, "private")],
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

/** Every territory the chart drew, with the contract attributes the lane asserts on. */
const chartPaths = () =>
	page.evaluate(() =>
		[...document.querySelectorAll(".index-map-chart path[data-node-id]")].map((path) => ({
			node: path.getAttribute("data-node-id"),
			state: path.getAttribute("data-state"),
			kind: path.getAttribute("data-kind"),
			path: path.getAttribute("data-path"),
			fill: getComputedStyle(path).fill,
		})),
	);
/** The eligible-only tally the map writes on its summary. */
const summary = () =>
	page.evaluate(() => {
		const el = document.querySelector(".index-map-summary");
		return { indexed: Number(el?.getAttribute("data-indexed") ?? "-1"), targets: Number(el?.getAttribute("data-targets") ?? "-1") };
	});
/** The percent the centre button carries for the scope currently in view. */
const centerPercent = async () => Number((await page.locator(".index-map-center strong").innerText()).replace(/[^\d]/gu, ""));
/** The legend's four colour statuses (state, swatch colour, visible label). */
const legend = () =>
	page.evaluate(() =>
		[...document.querySelectorAll(".index-map-legend li")].map((item) => ({
			state: item.getAttribute("data-state"),
			color: getComputedStyle(item.querySelector(".index-map-legend-swatch") ?? item).backgroundColor,
			text: item.innerText.replace(/\s+/gu, " ").trim(),
		})),
	);
const details = async () => (await page.locator(".index-map-details").innerText()).replace(/\s+/gu, " ").trim();

const segments = (path) => (path ?? "").split(/[\\/]/u).filter(Boolean);
const hasTail = (path, ...tail) => {
	const parts = segments(path);
	return parts.length >= tail.length && parts.slice(-tail.length).join("/") === tail.join("/");
};
/** A chart path by its kind and the tail of its path (works with host and guest separators alike). */
const findPath = async ({ kind = null, tail = [] }) => {
	const index = await page.evaluate(
		({ kind, tail }) => {
			const ends = (value) => {
				const parts = (value ?? "").split(/[\\/]/u).filter(Boolean);
				return parts.length >= tail.length && parts.slice(-tail.length).join("/") === tail.join("/");
			};
			return [...document.querySelectorAll(".index-map-chart path[data-node-id]")].findIndex(
				(path) => (kind === null || path.getAttribute("data-kind") === kind) && (tail.length === 0 || ends(path.getAttribute("data-path"))),
			);
		},
		{ kind, tail },
	);
	return index < 0 ? null : page.locator(".index-map-chart path[data-node-id]").nth(index);
};

/**
 * A radial territory's bounding-box centre can sit in the annulus hole (or under
 * a child sector), so a plain locator click/hover would miss the path. Sample
 * the path's own fill (`isPointInFill`) until a client point hit-tests back to
 * this very element, and use that point for real mouse input.
 */
const interiorOf = async (locator) => {
	const handle = await locator.elementHandle();
	if (handle === null) return null;
	return handle.evaluate((el) => {
		const ctm = el.getScreenCTM();
		if (!ctm) return null;
		const bbox = el.getBBox();
		const centre = new DOMPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
		const toClient = (point) => {
			const screen = point.matrixTransform(ctm);
			return { x: screen.x, y: screen.y };
		};
		const fallback = toClient(centre);
		const steps = 40;
		for (let iy = 1; iy < steps; iy += 1) {
			for (let ix = 1; ix < steps; ix += 1) {
				const point = new DOMPoint(bbox.x + (bbox.width * ix) / steps, bbox.y + (bbox.height * iy) / steps);
				if (typeof el.isPointInFill !== "function" || !el.isPointInFill(point)) continue;
				const client = toClient(point);
				const target = document.elementFromPoint(client.x, client.y);
				if (target === el || el.contains(target)) return { ...client, hit: true };
			}
		}
		return { ...fallback, hit: false };
	});
};
/** Real hover at a point that actually belongs to the territory. */
const hoverPath = async (locator) => {
	const at = await interiorOf(locator);
	if (at === null) return false;
	await page.mouse.move(at.x, at.y);
	return at.hit;
};
/** Real click at a point that actually belongs to the territory. */
const clickPath = async (locator) => {
	const at = await interiorOf(locator);
	if (at === null) return false;
	await page.mouse.move(at.x, at.y);
	await page.mouse.click(at.x, at.y);
	return at.hit;
};

/** The saved config, read from disk: what the CLI and the librarian would see. */
const savedConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const listed = (key) => (savedConfig()[key] ?? []).map(String);
const hasEntry = (key, ...tail) => listed(key).some((entry) => hasTail(entry, ...tail));

/**
 * Settings → Search Scope. Leaving the page and coming back is what remounts the map, so it reads the disk afresh
 * (files the lane just wrote); the map itself never needs a button for that.
 */
const openMap = async (scopeLabel, otherLabel) => {
	if ((await page.locator(".settings-panel").count()) === 0) {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
	}
	await page.locator(".settings-nav-item", { hasText: otherLabel }).first().click();
	await page.locator(".settings-nav-item", { hasText: scopeLabel }).first().click();
	await page.locator(".index-map-panel").waitFor();
	await page.locator(".index-map-chart").waitFor();
	await page.locator(".index-map-summary").waitFor();
	await page.locator(".index-map-center").waitFor();
	await page.locator(".index-map-details").waitFor();
	await page.locator(".index-map-chart path[data-node-id]").first().waitFor();
	// Real pointer input needs the chart on screen: bring the map to the top of the page.
	await page.locator(".index-map-panel").evaluate((el) => el.scrollIntoView({ block: "start" }));
	await page.waitForTimeout(500);
};

/** The system folder dialog is the OS's; answer it the way a person picking these folders would. */
const answerFolderDialog = (paths) =>
	app.evaluate(({ dialog }, picked) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
	}, paths);

const waitForTargets = (expected) =>
	page
		.waitForFunction((want) => Number(document.querySelector(".index-map-summary")?.getAttribute("data-targets") ?? "-1") === want, expected, { timeout: 120_000 })
		.then(() => true, () => false);

// ── 1. English: index the scope with Settings' own refresh, then let it drift. ──
await start("en");
log("app ready (en)");
// The full refresh: the parsed phase writes the mirror, the MinSync phase stages it; a file is in the index once staged.
const refresh = await page.evaluate(() => window.autorag.settings.configRefresh());
log(`refresh: ${JSON.stringify({ ok: refresh.ok, error: refresh.error, written: refresh.written, diagnostics: refresh.diagnostics?.slice(0, 4) })}`);
check("the real MinSync refresh completed successfully", refresh.ok === true, JSON.stringify(refresh));
const indexed = (await page.evaluate(() => window.autorag.settings.sourcesList())).local.documentCount;
check("Settings' refresh indexed every eligible file", indexed === INDEXABLE, `local.documentCount=${indexed}`);
put("projects/alpha/spec-1.md", "# Alpha spec 1\n\nThe alpha milestone moved: it now ships in week nine, after the review.\n");
put("notes/note-6.txt", "Note 6: a new figure, 42.\n");
put("notes/note-7.txt", "Note 7: another new figure, 49.\n");

await openMap("Search Scope", "Indexing");
const placement = await page.evaluate(() => ({ modal: document.querySelector(".settings-modal-backdrop") !== null, inContent: document.querySelector(".settings-content .index-map-panel") !== null, folders: document.querySelectorAll(".settings-path-line").length }));
check("the map is part of the page, not a dialog, with the folder list on it", !placement.modal && placement.inContent && placement.folders === 1, JSON.stringify(placement));
const geometry = await page.evaluate(() => {
	const chart = document.querySelector(".index-map-chart").getBoundingClientRect();
	const stage = document.querySelector(".index-map-stage").getBoundingClientRect();
	const center = document.querySelector(".index-map-center").getBoundingClientRect();
	return {
		centered: Math.abs(center.x + center.width / 2 - chart.x - chart.width / 2) < 1 && Math.abs(center.y + center.height / 2 - chart.y - chart.height / 2) < 1,
		contained: chart.x >= stage.x - 1 && chart.y >= stage.y - 1 && chart.right <= stage.right + 1 && chart.bottom <= stage.bottom + 1,
	};
});
check("the completion readout is centered in the chart", geometry.centered, JSON.stringify(geometry));
check("the chart fits inside its stage", geometry.contained, JSON.stringify(geometry));
await shot("01-index-map-en");

// The tally is eligible-only: the changed file and the two new ones are in the
// target set, the excluded and unsupported files are not.
const drift = await summary();
log(`summary while drifted: ${JSON.stringify(drift)}`);
check("the summary counts eligible targets only", drift.indexed === INDEXABLE - 1 && drift.targets === TARGETS_DRIFT, JSON.stringify(drift));
check("the centre shows indexed over targets", (await centerPercent()) === PERCENT_DRIFT, `${await centerPercent()} (want ${PERCENT_DRIFT})`);

// Four colour statuses, no per-state count.
const statuses = await legend();
log(`legend: ${JSON.stringify(statuses)}`);
check(
	"the legend lists the four statuses",
	statuses.length === 4 && statuses.every((item) => ["indexed", "partial", "unindexed", "excluded"].includes(item.state)),
	JSON.stringify(statuses.map((item) => item.state)),
);
check("every status has its own colour", new Set(statuses.map((item) => item.color)).size === 4, JSON.stringify(statuses.map((item) => item.color)));
check("the legend carries no per-state counts", statuses.every((item) => !/\d/u.test(item.text)), JSON.stringify(statuses.map((item) => item.text)));
const colorByState = new Map(statuses.map((item) => [item.state, item.color]));

// The chart itself: real paths, tagged with the contract's attributes.
const paths = await chartPaths();
log(`paths: ${paths.length} (${[...new Set(paths.map((p) => p.state))].join(", ")})`);
check(
	"every territory is a tagged path with a numeric node id",
	paths.length > 0 && paths.every((p) => /^\d+$/u.test(p.node ?? "") && (p.state ?? "") !== ""),
	`${paths.length} paths`,
);
check("folders and files are both drawn", paths.some((p) => p.kind === "folder") && paths.some((p) => p.kind === "file"), JSON.stringify([...new Set(paths.map((p) => p.kind))]));
const painted = new Set(paths.map((p) => p.state));
check(
	"all four statuses appear on the chart",
	["indexed", "partial", "unindexed", "excluded"].every((state) => painted.has(state)),
	[...painted].join(","),
);
const fillByState = new Map();
for (const path of paths) if (!fillByState.has(path.state)) fillByState.set(path.state, path.fill);
check(
	"the four statuses are painted in four distinct colours",
	new Set(["indexed", "partial", "unindexed", "excluded"].map((state) => fillByState.get(state))).size === 4,
	JSON.stringify([...fillByState]),
);

// Unsupported-only files, and their folder, never reach the chart.
const leaked = paths.filter((p) => /qaunknown/iu.test(p.path ?? "") || hasTail(p.path, "misc"));
check("unsupported files and their folder are left off the map", leaked.length === 0, JSON.stringify(leaked.slice(0, 4)));

// The explicit exclusion is drawn, but gray and out of the count.
const privateFill = paths.find((p) => hasTail(p.path, "private"))?.fill;
check("the excluded folder is drawn in the excluded colour", privateFill === colorByState.get("excluded"), `${privateFill} vs ${colorByState.get("excluded")}`);

// Excluded folders must be wide enough to see and to hit with a real pointer, not a hairline beside a big sibling.
const widths = await page.evaluate(() =>
	Object.fromEntries(
		[...document.querySelectorAll('.index-map-chart path[data-state="excluded"][data-kind="folder"]')].map((path) => {
			const box = path.getBoundingClientRect();
			return [path.getAttribute("data-path"), Math.max(box.width, box.height)];
		}),
	),
);
const thinnest = Math.min(...Object.values(widths));
check("every excluded folder is drawn wide enough to see", Object.keys(widths).length >= 2 && thinnest >= 8, JSON.stringify(widths));
const privatePath = await findPath({ kind: "folder", tail: ["private"] });
if (privatePath !== null) await hoverPath(privatePath);
await page.waitForTimeout(300);
const privateDetails = await details();
check("hovering an excluded folder names it and says it is excluded", privateDetails.includes("private") && /Excluded/u.test(privateDetails), privateDetails.slice(0, 160));

// The text the person asked to drop stays gone: no label under the percent, no fold note, no bottom hint.
const chrome = await page.evaluate(() => ({
	centerText: document.querySelector(".index-map-center")?.innerText.replace(/\s+/gu, " ").trim() ?? "",
	footer: document.querySelector(".index-map-footer") !== null,
	note: document.querySelector(".index-map-note")?.textContent ?? null,
	legendAbove: (() => {
		const legend = document.querySelector(".index-map-legend")?.getBoundingClientRect();
		const body = document.querySelector(".index-map-body")?.getBoundingClientRect();
		return legend !== undefined && body !== undefined && legend.bottom <= body.top + 1;
	})(),
	modalText: document.querySelector(".index-map-panel")?.innerText ?? "",
}));
check("the centre shows only the percent and the scope name", !/Indexed$/u.test(chrome.centerText) && /^\d+%/u.test(chrome.centerText), chrome.centerText);
check("no bottom hint or fold note", !chrome.footer && chrome.note === null && !/Click a folder to zoom/u.test(chrome.modalText) && !/grouped together/u.test(chrome.modalText), String(chrome.note));
check("the legend sits above the chart", chrome.legendAbove);
check("no '..' row while the whole scope is shown", (await page.locator('[data-action="index-map-parent"]').count()) === 0);

// Hover a folder: the sidebar names it and counts it.
const alpha = await findPath({ kind: "folder", tail: ["projects", "alpha"] });
check("the alpha folder is on the chart", alpha !== null);
const tabindex = alpha === null ? null : await alpha.getAttribute("tabindex");
check("a folder path is focusable", tabindex !== null || (alpha !== null && (await alpha.getAttribute("role")) === "button"), String(tabindex));
if (alpha !== null) await hoverPath(alpha);
await page.waitForTimeout(300);
const hovered = await details();
check("hovering a folder names its path and counts", hovered.includes("alpha") && /5/u.test(hovered) && /6/u.test(hovered), hovered.slice(0, 160));
await shot("02-hover");

if (alpha !== null) await alpha.focus();
await page.waitForTimeout(250);
check("focusing a folder keeps its details", (await details()).includes("alpha"), (await details()).slice(0, 160));

// Drill into the top-level notes folder: the centre follows and brings the whole scope back. The map has no
// overview or reload button any more: it keeps itself current (checked below).
const notes = await findPath({ kind: "folder", tail: ["notes"] });
check("the notes folder is on the chart", notes !== null);
const notesHit = notes === null ? false : await clickPath(notes);
await page.waitForTimeout(450);
check("clicking a folder drills the centre into it", (await centerPercent()) === PERCENT_NOTES, `${await centerPercent()} (want ${PERCENT_NOTES}); pointer ${notesHit ? "hit" : "missed"}`);
await shot("03-drill");
await page.locator(".index-map-center").click();
await page.waitForTimeout(450);
check("the centre moves back up to the whole scope", (await centerPercent()) === PERCENT_DRIFT, `${await centerPercent()} (want ${PERCENT_DRIFT})`);
check("the overview button is gone", (await page.locator('[data-action="index-map-overview"]').count()) === 0);
check("there is no reload button either", (await page.locator(".index-map-tools, .index-map-tool").count()) === 0);

// The '..' row at the top of the list goes up one level, like the centre does.
const notesForParent = await findPath({ kind: "folder", tail: ["notes"] });
if (notesForParent !== null) await clickPath(notesForParent);
await page.waitForTimeout(450);
const parentRow = page.locator('[data-action="index-map-parent"]');
check("a '..' row heads the list inside a folder", (await parentRow.count()) === 1 && ((await page.locator(".index-map-folders > button").first().getAttribute("data-action")) === "index-map-parent"));
await parentRow.click();
await page.waitForTimeout(450);
check("the '..' row goes back up to the whole scope", (await centerPercent()) === PERCENT_DRIFT && (await parentRow.count()) === 0, `${await centerPercent()}`);

// Leaving the page and coming back reads the files written meanwhile.
// ── 2. A folder of brand-new files, and an exclusion toggled while open. ──
put("incoming/inbox-1.txt", "Inbox one, never indexed.\n");
put("incoming/inbox-2.txt", "Inbox two, never indexed.\n");
await openMap("Search Scope", "Indexing");
const withIncoming = await summary();
log(`summary with incoming: ${JSON.stringify(withIncoming)}`);
check("a new-only folder widens the target set", withIncoming.indexed === INDEXABLE - 1 && withIncoming.targets === TARGETS_DRIFT + 2, JSON.stringify(withIncoming));
check("the global percent follows the wider set", (await centerPercent()) === Math.round(((INDEXABLE - 1) * 100) / (TARGETS_DRIFT + 2)), `${await centerPercent()}`);
const incoming = await findPath({ kind: "folder", tail: ["incoming"] });
check("the new-only folder is drawn unindexed", incoming !== null && (await incoming.getAttribute("data-state")) === "unindexed", incoming === null ? "absent" : String(await incoming.getAttribute("data-state")));
await shot("04-incoming");

// Live refresh: leave the map open and run a real index refresh from outside. While it runs the map re-reads on its
// own, so it ends up showing the finished index without any button, never going empty and never losing the item the
// pointer is on.
const watchPath = await findPath({ kind: "folder", tail: ["incoming"] });
if (watchPath !== null) await hoverPath(watchPath);
await page.waitForTimeout(300);
await page.evaluate(() => {
	const seen = { minPaths: Infinity, empty: 0, overlay: 0, samples: 0 };
	window.__mapWatch = seen;
	window.__mapWatchTimer = setInterval(() => {
		const count = document.querySelectorAll(".index-map-chart path[data-node-id]").length;
		seen.samples += 1;
		seen.minPaths = Math.min(seen.minPaths, count);
		if (count === 0) seen.empty += 1;
		if (document.querySelector(".index-map-overlay") !== null) seen.overlay += 1;
	}, 50);
});
const beforeLive = await summary();
// The refresh indexes the two inbox files and the one changed earlier: 17/22 becomes 22/22 once it ends. It is
// started with the map's own button, pressed from the keyboard so the real pointer stays on the folder it is over.
const refreshButton = page.locator('[data-action="index-map-refresh"]');
check("the map has a refresh button", (await refreshButton.count()) === 1 && (await refreshButton.isEnabled()));
const refreshStartedAt = Date.now();
await refreshButton.focus();
await page.keyboard.press("Enter");
const followed = await page
	.waitForFunction((expected) => Number(document.querySelector(".index-map-summary")?.getAttribute("data-indexed") ?? "-1") === expected, beforeLive.targets, { timeout: 120_000 })
	.then(() => true, () => false);
// How fast MinSync finishes is not the lane's to decide: keep watching for a fixed window, so "never emptied" is
// judged over the update and the settled state after it, not over however few samples a quick refresh allowed.
await page.waitForTimeout(Math.max(0, 2000 - (Date.now() - refreshStartedAt)));
const watch = await page.evaluate(() => {
	clearInterval(window.__mapWatchTimer);
	return window.__mapWatch;
});
const afterLive = await summary();
log(`live refresh followed in ${Date.now() - refreshStartedAt} ms, ${watch.samples} samples`);
check("the open map follows a running refresh by itself, with no further input", followed && afterLive.indexed === beforeLive.targets, JSON.stringify({ beforeLive, afterLive }));
check("the chart never emptied or showed a loading overlay while updating", watch.empty === 0 && watch.overlay === 0 && watch.minPaths > 0 && watch.samples > 20, JSON.stringify(watch));
const stillHovered = await page.evaluate(() => document.querySelector(".index-map-sector[data-active='true']")?.getAttribute("data-path") ?? null);
check("the item under the pointer is still the one being shown after the update", stillHovered !== null && hasTail(stillHovered, "incoming"), String(stillHovered));
await shot("04b-followed-refresh");

// Excluding the archive from the map: pick the territory, press the action. Its three files leave the index and
// the target set, its territory turns gray, and the exclusion lands in the config the CLI reads.
check("an idle refresh button is enabled again once the run ends", await page.waitForFunction(() => !document.querySelector('[data-action="index-map-refresh"]')?.disabled, null, { timeout: 120_000 }).then(() => true, () => false));
const archivePick = await findPath({ kind: "folder", tail: ["archive"] });
check("the archive folder is on the chart", archivePick !== null);
if (archivePick !== null) await clickPath(archivePick);
await page.waitForTimeout(400);
const pickedDetails = await details();
check("the picked folder is named with an exclude action", pickedDetails.includes("archive") && (await page.locator('[data-action="index-map-exclude"]').count()) === 1, pickedDetails.slice(0, 160));
// Hovering elsewhere only previews; moving the pointer off the chart returns to the picked folder, action intact.
await page.mouse.move(2, 2);
await page.waitForTimeout(300);
check("the action is still there after the pointer leaves the chart", (await details()).includes("archive") && (await page.locator('[data-action="index-map-exclude"]').count()) === 1, (await details()).slice(0, 120));
await shot("05a-pick-exclude");
await page.locator('[data-action="index-map-exclude"]').click();
const settled = await waitForTargets(withIncoming.targets - 3);
const after = await summary();
log(`summary after exclusion: ${JSON.stringify(after)}`);
check("excluding a folder drops its files from the target set", settled && after.targets === withIncoming.targets - 3, JSON.stringify({ before: withIncoming, after }));
check("the exclusion is in the saved config", hasEntry("excludePaths", "archive"), JSON.stringify(listed("excludePaths")));
const archive = await findPath({ kind: "folder", tail: ["archive"] });
check("the excluded archive turns gray", archive !== null && (await archive.getAttribute("data-state")) === "excluded", archive === null ? "absent" : String(await archive.getAttribute("data-state")));
check("the exclusion list under the map shows it", (await page.locator(".settings-chip", { hasText: "archive" }).count()) === 1);
await shot("05-exclusion");

// And back in: pick the gray territory, press include.
if (archive !== null) await clickPath(archive);
await page.waitForTimeout(400);
check("the gray archive offers include, not exclude", (await page.locator('[data-action="index-map-include"]').count()) === 1 && (await page.locator('[data-action="index-map-exclude"]').count()) === 0);
await page.locator('[data-action="index-map-include"]').click();
const restored = await waitForTargets(withIncoming.targets);
check("bringing it back puts its files in the target set again", restored, JSON.stringify(await summary()));
check("the exclusion is gone from the saved config", !hasEntry("excludePaths", "archive") && hasEntry("excludePaths", "private"), JSON.stringify(listed("excludePaths")));
const archiveBack = await findPath({ kind: "folder", tail: ["archive"] });
check("the archive is no longer gray", archiveBack !== null && (await archiveBack.getAttribute("data-state")) !== "excluded", archiveBack === null ? "absent" : String(await archiveBack.getAttribute("data-state")));

// A folder the person did not exclude themselves (the private one is, in config) cannot be undone from a folder inside it.
// The private folder is excluded directly, so it offers include; a search root offers neither.
const rootPath = await findPath({ kind: "root" });
if (rootPath !== null) await clickPath(rootPath);
await page.waitForTimeout(400);
check("a search root offers neither exclude nor include: it is removed from the folder list", (await page.locator('[data-action="index-map-exclude"], [data-action="index-map-include"]').count()) === 0);

// ── The folder list: add a folder from the system dialog, see it become a root, refuse one already covered, remove it. ──
await answerFolderDialog([EXTRA]);
await page.getByRole("button", { name: "Add folder" }).click();
const added = await page
	.waitForFunction((tail) => [...document.querySelectorAll('.index-map-chart path[data-kind="root"]')].some((path) => (path.getAttribute("data-path") ?? "").endsWith(tail)), "extra", { timeout: 30_000 })
	.then(() => true, () => false);
check("a picked folder is written to searchPaths", listed("searchPaths").length === 2 && hasEntry("searchPaths", "extra"), JSON.stringify(listed("searchPaths")));
check("a picked folder appears as a new root on the map", added);
check("the folder list shows it", (await page.locator(".settings-path-line", { hasText: "extra" }).count()) === 1);
check("its files join the target set", await waitForTargets(withIncoming.targets + 2), JSON.stringify(await summary()));
await shot("06a-folder-added");

await answerFolderDialog([join(DOCS, "notes")]);
await page.getByRole("button", { name: "Add folder" }).click();
await page.locator('.settings-error[role="alert"]').waitFor();
const refusal = await page.locator('.settings-error[role="alert"]').innerText();
check("a folder inside a search folder is refused, with the reason", /notes/u.test(refusal) && /already covered/u.test(refusal), refusal);
check("nothing was written for the refused folder", listed("searchPaths").length === 2 && !hasEntry("searchPaths", "notes"), JSON.stringify(listed("searchPaths")));
await shot("06b-folder-refused");

await page.locator(".settings-path-line", { hasText: "extra" }).getByRole("button", { name: "Delete" }).click();
const removed = await page
	.waitForFunction(() => [...document.querySelectorAll('.index-map-chart path[data-kind="root"]')].length === 1, null, { timeout: 30_000 })
	.then(() => true, () => false);
check("removing it takes the folder out of searchPaths and off the map", removed && listed("searchPaths").length === 1 && !hasEntry("searchPaths", "extra"), JSON.stringify(listed("searchPaths")));
check("the target set is back to what it was", await waitForTargets(withIncoming.targets), JSON.stringify(await summary()));

await app.close();
app = undefined;

// ── 3. Korean: the same map in the second language. ──
await start("ko");
log("app ready (ko)");
await openMap(KO.settingsSources.scope.title, KO.settingsCore.nav.indexing);
const ko = await legend();
const koTexts = ko.map((item) => item.text);
const KO_LABELS = ["indexed", "partial", "unindexed", "excluded"].map((state) => KO.settingsSources.indexMap.state[state]);
log(`ko legend: ${koTexts.join(" / ")}`);
check(
	"the Korean legend names all four statuses",
	ko.length === 4 && [...koTexts].sort().join("|") === [...KO_LABELS].sort().join("|"),
	koTexts.join(" / "),
);
check("the Korean chart draws real territories", (await page.locator(".index-map-chart path[data-node-id]").count()) > 0);
await shot("06-index-map-ko");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
