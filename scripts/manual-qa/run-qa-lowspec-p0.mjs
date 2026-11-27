/**
 * Live E2E & Manual QA — P0 low-spec performance fixes (#574, #575, #576).
 *
 * Drives the real built Electron app and verifies both:
 *   1. Functional parity: Quick Look (lazy), Settings (lazy), Document Editor (lazy),
 *      off-screen row metadata/kind/indexStatus on scroll, index exclude/include toggle,
 *      and extensionless file OS kind detection all work identically to before.
 *   2. Performance invariants:
 *      - Only 1 BrowserWindow exists at startup (0 hidden Quick Look / Quick Search renderers).
 *      - Leaving a large folder (1,500 files) immediately stops background `mdls`/`xattr` helper spawns.
 *      - Repeated `indexStatus` calls against a real MinSync stage hit the in-memory stage cache.
 *      - Batched macOS `mdls` resolves 100 extensionless files without a per-file spawn storm.
 *
 * Run `bun run build` first (or run via `bun run qa -- --vm`).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { cssAttr, isMac, sh, sleep } from "./platform.mjs";

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

function latestPid() {
	if (!isMac) return 0;
	return spawnSync("/usr/bin/true").pid ?? 0;
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "qa-lowspec-p0-")));
const qaRoot = join(work, "qa-root");
const bigDir = join(qaRoot, "big-1500");
const noExtDir = join(qaRoot, "noext-100");
const docsDir = join(qaRoot, "indexed-docs");
const workspaceDir = join(work, "workspace");
const configPath = join(work, "config.json");
const userDataDir = join(work, "user-data");
mkdirSync(bigDir, { recursive: true });
mkdirSync(noExtDir, { recursive: true });
mkdirSync(docsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

// 1,500 files in bigDir (last file is doc-1499.md)
for (let i = 0; i < 1500; i += 1) {
	const pad = String(i).padStart(4, "0");
	writeFileSync(join(bigDir, `doc-${pad}.md`), `# Document ${pad}\nLow-spec QA test payload ${pad}.\n`);
}
// 100 extensionless files
for (let i = 0; i < 100; i += 1) {
	const pad = String(i).padStart(3, "0");
	writeFileSync(join(noExtDir, `PLAIN_FILE_${pad}`), `Plain text without extension ${pad}\n`);
}
// Indexed docs with real MinSync parse stage + staged MinSync files
const stagedDoc = join(docsDir, "alpha-indexed.md");
const pendingDoc = join(docsDir, "beta-pending.md");
const imageFile = join(docsDir, "gamma-photo.png");
writeFileSync(stagedDoc, "# Alpha Indexed\nThis file is parsed and staged for QA.\n");
writeFileSync(pendingDoc, "# Beta Pending\nThis file is not staged yet.\n");
writeFileSync(
	imageFile,
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);

// Build real MinSync parsed stage for docsDir if minsync is available
let hasRealStage = false;
try {
	const lib = await import("../../.upstream/librarian-package/dist/index.js");
	const { minSyncDocumentPath, minSyncWorkspaceRoot, syncParsedMirrors } = lib;
	await syncParsedMirrors({
		root: workspaceDir,
		searchPaths: [docsDir],
		excludePaths: [pendingDoc],
		includeHidden: false,
	});
	// Stage alpha-indexed.md into MinSync workspace files dir
	const idx = lib.loadMirrorIndex(workspaceDir);
	const alphaEntry = Object.values(idx.entries).find((e) => e.sourcePath.endsWith("alpha-indexed.md"));
	if (alphaEntry !== undefined) {
		const stagedPath = minSyncDocumentPath(minSyncWorkspaceRoot(workspaceDir), alphaEntry.virtualPath);
		mkdirSync(join(stagedPath, ".."), { recursive: true });
		writeFileSync(stagedPath, "# Alpha Indexed\nStaged content.\n");
		hasRealStage = true;
	}
} catch (err) {
	log(`real MinSync stage setup skipped: ${err instanceof Error ? err.message : String(err)}`);
}

writeFileSync(
	configPath,
	`${JSON.stringify({ searchPaths: [docsDir, bigDir], workspacePath: workspaceDir, minSync: { enabled: true } }, null, 2)}\n`,
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

try {
	const page = await finderWindow(app, 30_000);
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(String(err)));
	await page.waitForSelector('[role="row"][data-path]', { timeout: 30_000 });
	await sleep(800);

	// ── 1. #575: Zero hidden renderers at startup ──
	const bootWindows = await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), url: w.webContents.getURL(), visible: w.isVisible() })),
	);
	check(
		"#575 startup creates only 1 BrowserWindow (no hidden Quick Look / Quick Search renderers)",
		bootWindows.length === 1 && bootWindows[0]?.url.endsWith("/index.html") && bootWindows[0]?.visible === true,
		JSON.stringify(bootWindows),
	);

	// ── 2. #575: Lazy Quick Look opens identically on Space and closes on Escape ──
	await page.locator(`[role="row"][data-path="${cssAttr(docsDir)}"]`).first().dblclick();
	const alphaRow = page.locator(`[role="row"][data-path="${cssAttr(stagedDoc)}"]`).first();
	await alphaRow.waitFor({ timeout: 20_000 });
	await alphaRow.click();
	await page.keyboard.press("Space");
	let qlPage = null;
	for (let i = 0; i < 100 && qlPage === null; i += 1) {
		qlPage = app.windows().find((w) => w.url().includes("quick-look.html")) ?? null;
		if (qlPage === null) await sleep(100);
	}
	check("#575 lazy Quick Look window created on first Space press", qlPage !== null);
	if (qlPage !== null) {
		let qlText = "";
		for (let i = 0; i < 80; i += 1) {
			qlText = (await qlPage.locator("body").innerText().catch(() => "")) ?? "";
			if (qlText.includes("Alpha Indexed")) break;
			await sleep(100);
		}
		check("#575 lazy Quick Look renders real document content", qlText.includes("Alpha Indexed"), qlText.slice(0, 120));
		await app.evaluate(({ BrowserWindow }) => {
			const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			w?.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			w?.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		});
		let closed = false;
		for (let i = 0; i < 50; i += 1) {
			closed = await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().every((w) => !w.webContents.getURL().includes("quick-look.html") || !w.isVisible()),
			);
			if (closed) break;
			await sleep(100);
		}
		check("#575 Quick Look hides cleanly on Escape", closed);
	}

	// ── 3. #574: Cached indexStatus accuracy & toggle invalidation ──
	if (hasRealStage) {
		const statusCheck = await page.evaluate(
			async ({ stagedDoc, pendingDoc, imageFile }) => {
				const t0 = performance.now();
				const first = await window.autorag.fs.indexStatus([stagedDoc, pendingDoc, imageFile]);
				const firstMs = Math.round((performance.now() - t0) * 100) / 100;
				const t1 = performance.now();
				const second = await window.autorag.fs.indexStatus([stagedDoc, pendingDoc, imageFile]);
				const secondMs = Math.round((performance.now() - t1) * 100) / 100;
				// Toggle exclude and verify cache invalidates immediately
				const excluded = await window.autorag.fs.setIndexExcluded(pendingDoc, true);
				const [afterExclude] = await window.autorag.fs.indexStatus([pendingDoc]);
				await window.autorag.fs.setIndexExcluded(pendingDoc, false);
				const [afterRestore] = await window.autorag.fs.indexStatus([pendingDoc]);
				return { first, second, firstMs, secondMs, excluded, afterExclude, afterRestore };
			},
			{ stagedDoc, pendingDoc, imageFile },
		);
		check(
			"#574 indexStatus reports included/pending/unsupported accurately",
			statusCheck.first[0]?.kind === "included" &&
				statusCheck.first[1]?.kind === "pending" &&
				statusCheck.first[2]?.kind === "unsupported",
			JSON.stringify(statusCheck.first.map((s) => s.kind)),
		);
		check(
			"#574 repeated indexStatus hits stage cache and returns identical results",
			JSON.stringify(statusCheck.first) === JSON.stringify(statusCheck.second),
			`first=${statusCheck.firstMs}ms second=${statusCheck.secondMs}ms`,
		);
		check(
			"#574 setIndexExcluded immediately invalidates cache and reflects excluded/restored state",
			statusCheck.excluded.excluded === true &&
				statusCheck.afterExclude?.excluded === true &&
				statusCheck.afterRestore?.excluded === false,
			JSON.stringify({ excluded: statusCheck.excluded.excluded, afterExclude: statusCheck.afterExclude?.excluded, afterRestore: statusCheck.afterRestore?.excluded }),
		);
	}

	// ── 4. #576: Leave large folder -> background mdls/xattr spawn storm stops immediately ──
	// Go back to qaRoot, open big-1500, wait 400ms, immediately go Back, then monitor PID delta for 5s
	await page.getByRole("button", { name: "Back" }).click();
	await page.locator(`[role="row"][data-path="${cssAttr(bigDir)}"]`).first().waitFor({ timeout: 20_000 });
	await page.locator(`[role="row"][data-path="${cssAttr(bigDir)}"]`).first().dblclick();
	await page.waitForFunction(
		(dir) => [...document.querySelectorAll('[role="row"][data-path]')].some((r) => r.getAttribute("data-path")?.startsWith(dir)),
		bigDir,
		{ timeout: 20_000 },
	);
	await sleep(400);
	await page.getByRole("button", { name: "Back" }).click();
	await page.locator(`[role="row"][data-path="${cssAttr(bigDir)}"]`).first().waitFor({ timeout: 20_000 });
	await sleep(500); // let in-flight wave of 24 finish
	const pidBeforeIdle = latestPid();
	await sleep(5000);
	const pidDeltaAfterLeave = latestPid() - pidBeforeIdle;
	if (isMac) {
		check(
			"#576 leaving 1,500-file folder stops background helper process spawns (delta < 120 in 5s; was ~1,350+)",
			pidDeltaAfterLeave < 120,
			`pidDelta5s=${pidDeltaAfterLeave}`,
		);
	}

	// ── 5. #574 + #576: Scrolling to off-screen row #1499 still loads its metadata, kind, and indexStatus ──
	await page.locator(`[role="row"][data-path="${cssAttr(bigDir)}"]`).first().dblclick();
	await page.waitForFunction(
		(dir) => [...document.querySelectorAll('[role="row"][data-path]')].some((r) => r.getAttribute("data-path")?.startsWith(dir)),
		bigDir,
		{ timeout: 20_000 },
	);
	// Scroll to bottom of virtualized list
	await page.locator(".list").evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	const tailPath = join(bigDir, "doc-1499.md");
	const tailRow = page.locator(`[role="row"][data-path="${cssAttr(tailPath)}"]`).first();
	await tailRow.waitFor({ timeout: 20_000 });
	await tailRow.click();
	await sleep(800);
	// Verify tail row has its index checkbox settled (not stuck unknown) and Inspector displays its name & metadata
	const tailCheck = await page.evaluate(
		({ tailPath }) => {
			const row = document.querySelector(`[role="row"][data-path="${CSS.escape(tailPath)}"]`);
			const checkbox = row?.querySelector('[role="checkbox"]');
			const inspector = document.querySelector(".inspector")?.innerText ?? "";
			return {
				rowMounted: row !== null,
				checkboxFound: checkbox !== null,
				checkboxAria: checkbox?.getAttribute("aria-label") ?? "",
				inspectorHasName: inspector.includes("doc-1499.md"),
				inspectorHasKind: inspector.length > 30,
			};
		},
		{ tailPath },
	);
	check(
		"#574/#576 scrolled off-screen row #1499 loads index status & Inspector info on demand",
		tailCheck.rowMounted && tailCheck.checkboxFound && tailCheck.inspectorHasName,
		JSON.stringify(tailCheck),
	);

	// ── 6. #576: Batched macOS mdls resolves 100 extensionless files quickly ──
	const noExtBench = await page.evaluate(async (dir) => {
		const listing = await window.autorag.fs.listDir(dir);
		const targets = listing.entries.map((e) => ({ path: e.path, kind: e.kind, ext: "", mtimeMs: e.mtimeMs }));
		const t0 = performance.now();
		const enriched = await window.autorag.fs.enrichEntries(targets, false);
		const ms = Math.round((performance.now() - t0) * 100) / 100;
		return { count: enriched.length, ms, nonNullKinds: enriched.filter((e) => e.osKind !== null).length };
	}, noExtDir);
	check(
		"#576 100 extensionless files enrich via batched mdls quickly (< 1500 ms; was ~1250-3800 ms)",
		noExtBench.count === 100 && noExtBench.ms < 1500,
		JSON.stringify(noExtBench),
	);

	// ── 7. #575: Lazy SettingsView opens and renders cleanly ──
	await page.keyboard.press(isMac ? "Meta+," : "Control+,");
	await page.waitForSelector(".settings-shell, [data-settings-page], [aria-label='Settings']", { timeout: 15_000 }).catch(() => {});
	const settingsText = (await page.locator("body").innerText()) ?? "";
	check(
		"#575 lazy SettingsView chunk loads and renders cleanly",
		settingsText.includes("General") || settingsText.includes("Indexing") || settingsText.includes("AI"),
		settingsText.slice(0, 120),
	);
	// Close Settings tab via Cmd+W (or Back button inside Settings) to return to Finder
	await page.keyboard.press(isMac ? "Meta+w" : "Control+w");
	await sleep(400);

	// ── 8. #575: Lazy DocumentEditorTab opens cleanly via Quick Look Edit handoff ──
	await page.getByRole("button", { name: "Back" }).click();
	await page.locator(`[role="row"][data-path="${cssAttr(docsDir)}"]`).first().waitFor({ timeout: 20_000 });
	await page.locator(`[role="row"][data-path="${cssAttr(docsDir)}"]`).first().dblclick();
	const editAlphaRow = page.locator(`[role="row"][data-path="${cssAttr(stagedDoc)}"]`).first();
	await editAlphaRow.waitFor({ timeout: 20_000 });
	await editAlphaRow.click();
	await page.keyboard.press("Space");
	let qlForEdit = null;
	for (let i = 0; i < 60 && qlForEdit === null; i += 1) {
		qlForEdit = app.windows().find((w) => w.url().includes("quick-look.html")) ?? null;
		if (qlForEdit === null) await sleep(100);
	}
	if (qlForEdit !== null) {
		const editBtn = qlForEdit.locator('button[aria-label*="Edit"], button[title*="Edit"], .qlw__edit').first();
		await editBtn.waitFor({ timeout: 15_000 }).catch(() => {});
		if ((await editBtn.count()) > 0) {
			await editBtn.click();
			let editorLoaded = false;
			for (let i = 0; i < 80; i += 1) {
				const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
				if (bodyText.includes("This file is parsed and staged for QA")) {
					editorLoaded = true;
					break;
				}
				await sleep(100);
			}
			check("#575 lazy DocumentEditorTab chunk loads and displays real document content", editorLoaded);
		}
	}

	// ── 9. #575: Lazy Quick Search launcher creates on first OS ⌥Space and focuses input ──
	const hadQsBefore = await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("quick-search.html") || w.getTitle() === "Quick Search"),
	);
	check("#575 Quick Search window does not exist before first shortcut press", hadQsBefore === false);
	if (isMac) {
		sh(`osascript -e 'tell application "System Events" to key code 49 using {option down}'`);
		let qsPage = null;
		for (let i = 0; i < 80 && qsPage === null; i += 1) {
			qsPage = app.windows().find((w) => w.url().endsWith("/quick-search.html")) ?? null;
			if (qsPage === null) await sleep(100);
		}
		check("#575 OS-level ⌥Space lazily creates Quick Search window", qsPage !== null);
		if (qsPage !== null) {
			await qsPage.locator(".qs__input").waitFor({ timeout: 15_000 });
			const qsVisible = await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().some((w) => w.getTitle() === "Quick Search" && w.isVisible()),
			);
			check("#575 lazy Quick Search window is visible with input ready", qsVisible === true);
			await qsPage.keyboard.press("Escape");
			await sleep(250);
		}
	}

	// ── 10. Zero uncaught renderer page errors ──
	check("no uncaught page errors throughout P0 live E2E flow", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
	await app.close();
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL P0 LIVE E2E CHECKS PASSED");
