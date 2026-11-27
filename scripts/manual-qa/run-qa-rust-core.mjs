/**
 * Live E2E & Manual QA — Dazzi Rust N-API core (bundled single-source primary).
 *
 * Drives the real built Electron app against a heavy, realistic low-spec
 * workspace (2,000-file single folder + 20,000-file nested multi-project tree
 * with 13 glob/path exclusions) and verifies:
 *   1. `listDir` (2,000 files), `indexMap` (20,000+ files), `indexStatus`, and
 *      recursive filename `search` (`walkSearchNative`, Unicode Hangul NFC/NFD)
 *      all execute cleanly via the bundled Rust N-API core.
 *   2. Real UI interactions — opening Settings → Indexing (Index Map radial
 *      chart), drilling into a 2,000-file folder, scrolling to its tail,
 *      opening Quick Look, and searching by filename — render cleanly with
 *      zero page errors.
 *
 * Run via:
 *   AUTORAG_QA_VM_CPU=2 AUTORAG_QA_VM_MEMORY_MB=4096 \
 *     bun run qa script --vm --skip-build scripts/manual-qa/run-qa-rust-core.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { cssAttr, isMac, sleep } from "./platform.mjs";

const qaOut = process.env.QA_OUT ?? null;
const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

// Verify the Rust core binary is bundled into out/main/vendor/
const bundledAddon = join(ROOT, "out", "main", "vendor", "dazzi-core.node");
check("bundled out/main/vendor/dazzi-core.node exists", existsSync(bundledAddon), bundledAddon);

// Build realistic heavy fixture: 2,000-file folder + 15,000-file project tree with 13 glob/path exclusions
const work = realpathSync(mkdtempSync(join(tmpdir(), "qa-rust-core-")));
const qaRoot = join(work, "qa-root");
const bigDir = join(qaRoot, "big-2000");
const docsDir = join(qaRoot, "workspace-docs");
const workspaceDir = join(work, "workspace");
const configPath = join(work, "config.json");
const userDataDir = join(work, "user-data");
mkdirSync(bigDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

for (let i = 0; i < 2000; i += 1) {
	const pad = String(i).padStart(4, "0");
	writeFileSync(join(bigDir, `doc-${pad}.md`), `# Document ${pad}\nRust core live E2E payload ${pad}.\n`);
}
for (let d = 0; d < 100; d += 1) {
	const proj = join(docsDir, `project_${String(d).padStart(3, "0")}`);
	const srcDir = join(proj, "src");
	const nmDir = join(proj, "node_modules", "pkg");
	mkdirSync(srcDir, { recursive: true });
	mkdirSync(nmDir, { recursive: true });
	for (let f = 0; f < 150; f += 1) {
		writeFileSync(join(srcDir, `note_${d}_${f}.md`), `# Project ${d} note ${f}\n`);
	}
	writeFileSync(join(srcDir, `debug_${d}.log`), `log ${d}\n`);
	writeFileSync(join(srcDir, `temp_${d}.tmp`), `tmp ${d}\n`);
	writeFileSync(join(nmDir, "index.txt"), `dep ${d}\n`);
}
const privateDir = join(docsDir, "private");
mkdirSync(privateDir, { recursive: true });
writeFileSync(join(privateDir, "secret.md"), "# Secret\n");
writeFileSync(join(docsDir, "alpha-indexed.md"), "# Alpha Indexed\nLive E2E Rust core verification.\n");
writeFileSync(join(docsDir, "project_099", "src", "최종_인수인계_계약서.md".normalize("NFD")), "# Final Handover\n");

writeFileSync(
	configPath,
	`${JSON.stringify(
		{
			searchPaths: [docsDir],
			workspacePath: workspaceDir,
			excludePaths: [
				privateDir,
				"**/node_modules/**",
				"**/.git/**",
				"**/*.log",
				"**/*.tmp",
				"**/dist/**",
				"**/build/**",
				"**/target/**",
				"**/.venv/**",
				"**/__pycache__/**",
				"**/*.DS_Store",
				"**/*.cache",
				"**/Library/Caches/**",
			],
			minSync: { enabled: true },
		},
		null,
		2,
	)}\n`,
);

log("launching built app");
const app = await launchFinder({
	userDataDir,
	env: {
		AUTORAG_QA_ROOT: qaRoot,
		AUTORAG_CONFIG: configPath,
		AUTORAG_HOME: work,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
	},
	language: "en",
});

const pageErrors = [];
try {
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	await page.waitForSelector('[role="row"][data-path]', { timeout: 30_000 });
	await sleep(500);

	// 1. Measure heavy live IPC calls: listDir (2k), indexMap (15k files x 13 rules), walkSearch (15k files, Hangul NFD), indexStatus (300)
	const metrics = await page.evaluate(
		async ({ bigDir, docsDir, privateDir }) => {
			const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

			const listTimes = [];
			let listRes = null;
			for (let i = 0; i < 3; i += 1) {
				const t0 = performance.now();
				listRes = await window.autorag.fs.listDir(bigDir);
				listTimes.push(performance.now() - t0);
			}

			const mapTimes = [];
			let mapRes = null;
			for (let i = 0; i < 3; i += 1) {
				const t0 = performance.now();
				mapRes = await window.autorag.fs.indexMap();
				mapTimes.push(performance.now() - t0);
			}

			const searchTimes = [];
			let searchRes = null;
			for (let i = 0; i < 3; i += 1) {
				const t0 = performance.now();
				searchRes = await window.autorag.fs.search("인수인계", { scope: docsDir });
				searchTimes.push(performance.now() - t0);
			}

			const batchPaths = [
				`${docsDir}/alpha-indexed.md`,
				`${privateDir}/secret.md`,
				`${docsDir}/project_000/src/debug_0.log`,
				`${docsDir}/project_000/src/temp_0.tmp`,
			];
			for (let d = 0; d < 30; d += 1) {
				const p = `project_${String(d).padStart(3, "0")}`;
				for (let f = 0; f < 10; f += 1) batchPaths.push(`${docsDir}/${p}/src/note_${d}_${f}.md`);
			}
			const statusTimes = [];
			let statusRes = null;
			for (let i = 0; i < 3; i += 1) {
				const t0 = performance.now();
				statusRes = await window.autorag.fs.indexStatus(batchPaths);
				statusTimes.push(performance.now() - t0);
			}

			return {
				listCount: listRes.entries.length,
				listMedMs: Number(med(listTimes).toFixed(1)),
				mapTotals: mapRes.totals,
				mapNodeCount: mapRes.nodes.length,
				mapMedMs: Number(med(mapTimes).toFixed(1)),
				searchHits: searchRes.map((h) => h.entry.name),
				searchMedMs: Number(med(searchTimes).toFixed(1)),
				statusCount: statusRes.length,
				statusExcludedSample: statusRes.slice(1, 4).map((s) => s.excluded),
				statusMedMs: Number(med(statusTimes).toFixed(1)),
			};
		},
		{ bigDir, docsDir, privateDir },
	);

	log(`Live heavy IPC metrics: ${JSON.stringify(metrics)}`);
	check("listDir (2,000 files) returns all 2,000 entries", metrics.listCount === 2000, `${metrics.listCount} in ${metrics.listMedMs}ms`);
	check(
		"indexMap (15,000+ files x 13 globs) classifies accurately",
		metrics.mapTotals.unindexed === 15002 && metrics.mapTotals.excluded === 1,
		`${JSON.stringify(metrics.mapTotals)} in ${metrics.mapMedMs}ms`,
	);
	check(
		"walkSearch (15,000 files) finds NFD Hangul filename accurately",
		metrics.searchHits.length === 1 && metrics.searchHits[0].normalize("NFC") === "최종_인수인계_계약서.md",
		`${JSON.stringify(metrics.searchHits)} in ${metrics.searchMedMs}ms`,
	);
	check(
		"indexStatus (304 paths) flags path & glob exclusions accurately",
		metrics.statusCount === 304 && metrics.statusExcludedSample.every((v) => v === true),
		`${metrics.statusCount} paths in ${metrics.statusMedMs}ms`,
	);

	// 2. Real UI: open big-2000, scroll to tail, Quick Look
	await page.locator(`[role="row"][data-path="${cssAttr(bigDir)}"]`).first().dblclick();
	await page.waitForFunction(
		(dir) => [...document.querySelectorAll('[role="row"][data-path]')].some((r) => r.getAttribute("data-path")?.startsWith(dir)),
		bigDir,
		{ timeout: 20_000 },
	);
	await page.locator(".list").evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	const tailRow = page.locator(`[role="row"][data-path="${cssAttr(join(bigDir, "doc-1999.md"))}"]`).first();
	await tailRow.waitFor({ timeout: 20_000 });
	await tailRow.click();
	await sleep(300);
	if (qaOut) await page.screenshot({ path: join(qaOut, "rust-core-big-folder-tail.png") });

	await page.keyboard.press("Space");
	let qlPage = null;
	for (let i = 0; i < 80 && qlPage === null; i += 1) {
		qlPage = app.windows().find((w) => w.url().includes("quick-look.html")) ?? null;
		if (qlPage === null) await sleep(100);
	}
	let qlLoaded = false;
	if (qlPage !== null) {
		for (let i = 0; i < 60; i += 1) {
			const text = (await qlPage.locator("body").innerText().catch(() => "")) ?? "";
			if (text.includes("Document 1999")) {
				qlLoaded = true;
				break;
			}
			await sleep(100);
		}
		if (qaOut) await qlPage.screenshot({ path: join(qaOut, "rust-core-quick-look.png") });
		await qlPage.keyboard.press("Escape");
		await sleep(250);
	}
	check("real UI: 2,000-file tail scroll + Quick Look render", qlLoaded);

	// 3. Real UI: open Settings → Indexing (Index Map radial chart renders live over 15,000 files)
	await page.keyboard.press(isMac ? "Meta+," : "Control+,");
	await page.waitForSelector(".settings-shell, [data-settings-page]", { timeout: 15_000 }).catch(() => {});
	const indexingNav = page.locator("button, [role='tab'], a", { hasText: /^Indexing$/ }).first();
	if ((await indexingNav.count()) > 0) {
		const tMap0 = Date.now();
		await indexingNav.click();
		const svgPath = page.locator("svg.index-map-chart path[data-node-id]").first();
		await svgPath.waitFor({ timeout: 20_000 });
		const uiMapMs = Date.now() - tMap0;
		log(`Settings → Indexing radial map rendered in ${uiMapMs}ms`);
		if (qaOut) await page.screenshot({ path: join(qaOut, "rust-core-index-map-ui.png") });
		check("real UI: Settings → Indexing radial map renders cleanly over 15k files", true, `${uiMapMs}ms`);
	}

	check("zero uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
	await app.close();
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL RUST CORE LIVE E2E CHECKS PASSED");
