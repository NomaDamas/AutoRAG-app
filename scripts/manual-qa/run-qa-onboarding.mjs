// Drives first-run onboarding end to end in the built app: every step, the real
// Full Disk Access probe, folder pre-scan, the shared-config write, a real first
// index (local embedder), and the hand-off to the Finder.

// AUTORAG_HOME and AUTORAG_CONFIG point inside a temp dir, so the user's own
// config and index are never touched. Electron resolves the home folder from
// the OS (not $HOME), so the lane deselects the real Desktop/Documents
// candidates and adds two fixture folders through a stubbed folder dialog. The
// local native embedding model is referenced from the real MinSync cache when
// present (otherwise the first index downloads it).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeDir, rmRetry } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/onboarding");
mkdirSync(EVIDENCE, { recursive: true });
const WORK = mkdtempSync(join(tmpdir(), "autorag-onboarding-"));
const FIXTURES = join(WORK, "fixtures");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config", "config.json");
const DESK = join(FIXTURES, "회의");
const DOCS = join(FIXTURES, "reports");
mkdirSync(join(DESK, "node_modules"), { recursive: true });
mkdirSync(DOCS, { recursive: true });
writeFileSync(join(DESK, "node_modules", "skip.md"), "# skipped dependency folder\n");
writeFileSync(join(DESK, "회의록.md"), "# 3분기 회의록\n\n마케팅 비용은 전분기보다 18% 줄었습니다.\n");
writeFileSync(join(DESK, "image.bin"), "not a supported document");
writeFileSync(join(DOCS, "report-q3.md"), "# Q3 report\n\nOperating cost fell because of the vendor change.\n");
writeFileSync(join(DOCS, "notes.txt"), "Budget summary for the third quarter.\n");
mkdirSync(AUTORAG_HOME, { recursive: true });
mkdirSync(join(WORK, "config"), { recursive: true });
const realMinsyncModels =
	process.env.FASTEMBED_CACHE_DIR?.trim() ||
	(process.platform === "win32"
		? join(process.env.LOCALAPPDATA?.trim() || join(homeDir(), "AppData", "Local"), "minsync", "models")
		: join(homeDir(), ".cache", "minsync", "models"));
// The first argument (or QA_ONBOARDING_EMBED) picks the embedding card: none (default, keyword-only) or local. `bun run qa script` forwards arguments into the VM, environment variables do not. Cloud needs an account, so it is not drivable here.
const EMBED = process.argv[2]?.trim() || process.env.QA_ONBOARDING_EMBED?.trim() || "none";
const EMBED_CARD = { none: 0, local: 1 }[EMBED];
if (EMBED_CARD === undefined) throw new Error(`the embed mode must be none or local, got ${EMBED}`);
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

// A local OpenAI-compatible endpoint for the BYOK step: records the auth header
// and lists one model, so verification exercises the real request path offline.
const stubHits = [];
const stub = createServer((request, response) => {
	stubHits.push(request.headers.authorization ?? "");
	response.writeHead(request.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
	response.end(JSON.stringify({ object: "list", data: [{ id: "qa-stub-model", object: "model" }] }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;
const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	...(existsSync(realMinsyncModels) ? { FASTEMBED_CACHE_DIR: realMinsyncModels } : {}),
};
const userDataDir = join(WORK, "user-data");
const app = await launchFinder({ userDataDir, env, onboarding: true, language: "ko" });
const errors = [];
try {
	const page = await finderWindow(app, 20_000);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.waitForSelector(".onb .screen", { timeout: 20_000 });
	// macOS clamps a window to the display's work area (a portrait monitor is 1080 wide).
	const windowSize = () =>
		app.evaluate(({ BrowserWindow, screen }) => {
			const window = BrowserWindow.getAllWindows().find((w) => w.isVisible());
			const work = screen.getDisplayMatching(window.getBounds()).workAreaSize;
			return { content: window.getContentSize(), min: window.getMinimumSize(), work: [work.width, work.height] };
		});
	const fits = ({ content, work }, [width, height]) => content[0] === Math.min(width, work[0]) && content[1] === Math.min(height, work[1]);
	const size = await windowSize();
	check("onboarding window opens at the onboarding size", fits(size, [1120, 720]) && size.min[0] === 960, JSON.stringify(size));
	const shot = (name) => page.locator(".onb").screenshot({ path: join(EVIDENCE, `${name}.png`) });
	const primary = page.locator(".onb .footer button.primary");
	const heading = () => page.locator(".onb .screen h1").first().innerText();

	// welcome
	check("welcome headline", (await heading()).includes("파일에게"));
	check("back is disabled on the first step", await page.locator(".onb .back-btn").isDisabled());
	await shot("01-welcome");
	await page.keyboard.press("Enter");

	// permissions: the gate follows the real Full Disk Access probe.
	await page.waitForSelector(".onb .permission-list");
	check("permissions step", (await heading()).includes("허용"));
	await page.waitForTimeout(500);
	const status = await page.evaluate(() => window.autorag.onboarding.permissions());
	if (process.platform === "darwin") {
		check("next gate matches the FDA probe", (await primary.isEnabled()) === status.fullDiskAccess, JSON.stringify(status));
		const granted = await page.locator(".onb .permission-list .state.ok").count();
		check("FDA row shows the probed state", (granted > 0) === status.fullDiskAccess);
		if (!status.fullDiskAccess) {
			await shot("02-permissions-blocked");
			throw new Error("grant Full Disk Access to Electron to drive the rest of the lane");
		}
	}
	await shot("02-permissions");
	await primary.click();

	// account: signing in is real (system browser); the lane takes the no-account
	// BYOK path, which must not need a server. The real sign-in is run-qa-account.mjs.
	await page.waitForSelector(".onb .auth-card");
	check("account step", (await heading()).includes("계정"));
	check("signing in is gated until an account exists", await primary.isDisabled());
	await shot("03-account");
	await page.locator(".onb .auth-card .action-row button.secondary").click();
	// smart scan: the AI looks through the preselected folders. This lane has no model, so the
	// analysis fails visibly and the step stays usable (the real run is run-qa-smart-indexing).
	await page.waitForSelector(".onb .si-minimal-scan", { timeout: 6000 });
	check("skipping the account (BYOK) advances to the smart scan", true);
	await page.waitForSelector(".onb .si-scan-error", { timeout: 30_000 });
	check("with no model the scan says it failed and offers a retry", (await page.locator(".onb .si-scan-retry").count()) === 1);
	check("the scan step can still be left", await primary.isEnabled());
	await shot("03b-smart-scan");
	await primary.click();

	// folders: the smart-indexing scope screen; swap the real candidates for fixtures picked through the dialog.
	await page.waitForSelector(".onb .si-dual-panels", { timeout: 6000 });
	check("the scope screen follows the scan", true);
	await app.evaluate(({ dialog }, paths) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
	}, [DESK, DOCS]);
	while ((await page.locator(".onb .si-panel.blue .si-pill-x").count()) > 0) await page.locator(".onb .si-panel.blue .si-pill-x").first().click();
	check("folders gate closes with nothing selected", await primary.isDisabled());
	await page.locator(".onb .si-panel.blue .si-add-pill").click();
	await page.waitForFunction(() => document.querySelectorAll(".onb .si-panel.blue .si-pill").length === 2, null, { timeout: 5000 });
	await page.waitForFunction(() => /\d+\s*개 파일/.test(document.querySelector(".onb .si-panel.blue .si-panel-meta")?.textContent ?? ""), null, { timeout: 15_000 });
	await page.waitForFunction(() => ![...document.querySelectorAll(".onb .si-panel.blue .si-pill-size")].some((el) => el.textContent === "…"), null, { timeout: 15_000 });
	const summary = await page.locator(".onb .si-panel.blue .si-panel-meta").innerText();
	check("pre-scan counts the three supported fixtures (skips node_modules/unsupported)", /(^|\D)3\s*개 파일/.test(summary), summary.replace(/\s+/g, " "));
	check("the red panel says what is always left out when nothing was proposed", (await page.locator(".onb .si-panel.red .si-panel-foot").innerText()).includes("node_modules"));
	await shot("04-folders");
	await primary.click();

	// embedding: the prototype's three cards; the cloud one is disabled while signed out.
	await page.waitForSelector(".onb .em-card");
	check("the three embedding modes are offered", (await page.locator(".onb .em-card").count()) === 3);
	check("cloud embedding is offered as unavailable", (await page.locator(".onb .em-card.disabled").count()) === 1);
	check("keyword-only is the preselected default", (await page.locator(".onb .em-card").nth(0).getAttribute("aria-checked")) === "true");
	await shot("05-embedding");
	await page.locator(".onb .em-card").nth(EMBED_CARD).click();
	check(`the ${EMBED} card is selected`, (await page.locator(".onb .em-card").nth(EMBED_CARD).getAttribute("aria-checked")) === "true");
	// Record the checking line from before the step opens: a machine with no
	// connectors installed (a fresh QA VM) finishes every probe in milliseconds,
	// so polling for the line afterwards races its removal.
	await page.evaluate(() => {
		window.__sources = { sawChecking: false, overlap: false, shrank: false, rows: 0 };
		new MutationObserver(() => {
			const checking = document.querySelector(".onb [data-sources-checking]") !== null;
			if (checking) window.__sources.sawChecking = true;
			if (checking && document.querySelector(".onb .connect-more") !== null) window.__sources.overlap = true;
			const rows = document.querySelectorAll(".onb .source-row").length;
			if (rows < window.__sources.rows) window.__sources.shrank = true;
			window.__sources.rows = rows;
		}).observe(document.body, { childList: true, subtree: true });
	});
	await primary.click();

	// sources: rows stream in as each probe finishes; a spinner line holds the
	// "connect later" row back until every probe is done.
	const sourcesShownAt = Date.now();
	await page.waitForSelector(".onb [data-sources-done]", { timeout: 60_000 });
	const allDoneMs = Date.now() - sourcesShownAt;
	const sourcesSeen = await page.evaluate(() => window.__sources);
	check("a checking line shows while probes run", sourcesSeen.sawChecking);
	check("connect-later row is hidden while probing", !sourcesSeen.overlap);
	console.log(`INFO sources: all probes done after ${allDoneMs}ms`);
	const ids = await page.locator(".onb .source-row").evaluateAll((rows) => rows.map((row) => row.dataset.sourceId));
	check("Spotlight and Apple Mail are never offered", !ids.includes("spotlight") && !ids.includes("mail"), ids.join(", "));
	check("rows only ever grow while probing", !sourcesSeen.shrank, `${ids.length} rows`);
	const doneSnapshot = await page.evaluate(() => window.autorag.onboarding.indexStatus());
	check("detection did not start indexing", doneSnapshot.state === "idle", doneSnapshot.state);
	check("no description editor exists", (await page.locator(".onb .source-description, .onb .source-row textarea").count()) === 0);
	const chips = await page.locator(".onb .more-chips .brand-chip").allInnerTexts();
	check(
		"connect-later chips exclude the detected sources",
		!ids.includes("kakao") || !chips.some((label) => label.includes("KakaoTalk")),
		chips.join(", "),
	);
	await shot("06-sources");
	// Optional source-specific regression lane: enable exactly the requested
	// detected connector. The default lane keeps datasources off.
	const requestedSource = process.env.QA_ONBOARDING_SOURCE?.trim() ?? "";
	if (requestedSource.length > 0) {
		if (!ids.includes(requestedSource)) throw new Error(`requested datasource is not detected: ${requestedSource}`);
		const sourceRow = page.locator(`.onb .source-row[data-source-id="${requestedSource}"]`);
		await sourceRow.locator(".switch").click();
		await page.waitForFunction(
			(sourceId) => document.querySelector(`.onb .source-row[data-source-id="${sourceId}"] .switch.on`) !== null,
			requestedSource,
			{ timeout: 3000 },
		);
		check(`${requestedSource} source is enabled`, await sourceRow.locator(".switch.on").count() === 1);
		check(`${requestedSource} switch is enabled`, await sourceRow.locator(".switch").isEnabled());
	}
	await primary.click();

	// plan: with no account, a paid plan stays gated behind sign-in (no checkout,
	// no charge); BYOK needs no account and keeps the lane offline.
	await page.waitForSelector(".onb .plan-card");
	await shot("07-plan");
	await page.locator(".onb .plan-card").nth(2).click();
	check("a paid plan without an account cannot continue", await primary.isDisabled());
	check("the plan step says to sign in first", (await page.locator(".onb .screen-copy .auth-note").count()) === 1);
	await shot("07b-plan-needs-account");
	// BYOK against the local stub: real verification request, real encrypted
	// key storage, real config write.
	await page.locator(".onb .plan-card").nth(3).click();
	await primary.click();
	await page.waitForSelector(".onb .provider-chips", { timeout: 5000 });
	await shot("07c-model");
	check("model step gates on verification", await primary.isDisabled());
	await page.locator(".onb .provider-chip").last().click();
	await page.locator('.onb .key-row input[type="text"]').fill(stubUrl);
	await page.locator('.onb .key-row input[type="password"]').fill("sk-qa-stub");
	await page.locator(".onb .key-row button.secondary").click();
	await page.waitForFunction(() => !document.querySelector(".onb .footer button.primary")?.disabled, null, { timeout: 10_000 });
	check("stub endpoint verifies with the entered key", stubHits.includes("Bearer sk-qa-stub"), JSON.stringify(stubHits));
	await primary.click();

	// indexing: real first index; gate opens only on success, while subtle bottom button allows background start.
	await page.waitForSelector(".onb.immersive .ix-bar", { timeout: 10_000 });
	check("open button disabled while indexing", await page.locator(".onb .ix-open-btn").first().isDisabled().catch(() => true));
	check("subtle background-start button is visible while indexing", await page.locator(".onb .ix-bg-start").isVisible());
	const phaseLabels = await page.locator(".onb .ix-phases .ix-phase").allInnerTexts();
	check(
		EMBED === "none"
			? "indexing phases of a keyword-only run have no embedding phase (parsed, finalizing)"
			: "indexing phases show only local phases (parsed, minsync, finalizing)",
		phaseLabels.length === (EMBED === "none" ? 2 : 3) && !phaseLabels.some((label) => label.includes("데이터 소스")),
		phaseLabels.join(" | "),
	);
	await shot("08-indexing");
	await page.waitForFunction(
		() => {
			const button = document.querySelector(".onb .ix-open-btn");
			return (button instanceof HTMLButtonElement && !button.disabled) || document.querySelector(".onb .ix-notice.warn") !== null;
		},
		null,
		{ timeout: 600_000 },
	);
	const failed = await page.locator(".onb .ix-notice.warn").count();
	check("first index succeeds", failed === 0, failed ? await page.locator(".onb .ix-notice.warn").innerText() : "");
	check("subtle background-start button hides once indexing finishes", (await page.locator(".onb .ix-bg-start").count()) === 0);
	const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
	check(
		"BYOK model written with base URL and key env name (no key in config)",
		raw.model?.provider === "openai-compatible" &&
			raw.model?.id === "qa-stub-model" &&
			raw.model?.baseUrl === stubUrl &&
			raw.model?.apiKeyEnv === "OPENAI_COMPATIBLE_API_KEY" &&
			!JSON.stringify(raw).includes("sk-qa-stub"),
		JSON.stringify(raw.model),
	);
	if (requestedSource.length > 0) {
		const configured = Object.entries(raw.datasources ?? {}).filter(
			([alias, entry]) => alias === requestedSource || entry?.type === requestedSource || alias.startsWith(`${requestedSource}-`),
		);
		check(`${requestedSource} datasource config written`, configured.length > 0, JSON.stringify(configured));
	}
	check("config searchPaths = selected folders", JSON.stringify(raw.searchPaths) === JSON.stringify([DESK, DOCS]), JSON.stringify(raw.searchPaths));
	if (EMBED === "none") {
		check("keyword-only: semantic search switched off in the config", raw.appIndexing?.semanticSearch === false, JSON.stringify(raw.appIndexing));
		check("keyword-only: no embedder written", raw.minSync?.embedder === undefined, JSON.stringify(raw.minSync));
		check("keyword-only: MinSync never ran (no .minsync index in the workspace)", !existsSync(join(AUTORAG_HOME, "workspace", ".autorag", "minsync")));
		check("keyword-only: the parsed mirror exists", existsSync(join(AUTORAG_HOME, "workspace", ".autorag", "parsed", "index.json")));
	} else {
		check("config local embedder set", raw.minSync?.embedder?.id === "native:Qwen/Qwen3-Embedding-0.6B", JSON.stringify(raw.minSync?.embedder));
		check("semantic search stays on", raw.appIndexing?.semanticSearch === undefined, JSON.stringify(raw.appIndexing));
	}
	check("first index lives in the AutoRAG home, not the app cwd", raw.workspacePath === join(AUTORAG_HOME, "workspace") && !existsSync(join(ROOT, ".autorag")), String(raw.workspacePath));
	const final = await page.evaluate(() => window.autorag.onboarding.indexStatus());
	check(
		"index read exactly the selected folders' pre-scanned files",
		final.state === "success" && final.progress === 100 && final.totalFiles === 3 && final.processedFiles === 3,
		JSON.stringify(final),
	);
	check("recent folder resolves through the realpath", final.recentFolder === "회의" || final.recentFolder === "reports", String(final.recentFolder));
	await shot("09-indexing-done");
	if (failed === 0) {
		await page.locator(".onb .ix-open-btn").click();
		await page.waitForSelector(".onb", { state: "detached", timeout: 10_000 });
		const finder = await windowSize();
		check("AutoRAG opens the Finder at full size", fits(finder, [1440, 900]) && finder.min[0] === Math.min(1360, finder.work[0]), JSON.stringify(finder));
		const state = JSON.parse(readFileSync(join(userDataDir, "onboarding", "state.json"), "utf8"));
		check("onboarding marked completed", state.completed === true);
		if (requestedSource.length > 0) {
			const completedAt = Date.parse(final.finishedAt ?? final.startedAt ?? new Date().toISOString()) - 2_000;
			const deadline = Date.now() + 120_000;
			let matching = [];
			while (Date.now() < deadline) {
				const { activity, snapshot } = await page.evaluate(async () => ({
					activity: await window.autorag.indexActivity.get(),
					snapshot: await window.autorag.settings.sourcesList(),
				}));
				matching = snapshot.sources.filter(
					(row) => row.id === requestedSource || row.type === requestedSource || row.id.startsWith(`${requestedSource}-`),
				);
				const done =
					activity.state !== "running" &&
					matching.length > 0 &&
					matching.every(
						(row) =>
							row.status === "ready" &&
							(row.index.state === "indexed" || row.index.state === "empty") &&
							(row.index.indexedAt === null || Date.parse(row.index.indexedAt) >= completedAt),
					);
				if (done) break;
				await page.waitForTimeout(1_000);
			}
			await page.waitForFunction(() => document.querySelector('.sidebar__activity[data-tone="run"]') === null, null, { timeout: 5_000 });
			check(
				`${requestedSource} datasource finishes indexing in the background`,
				matching.length > 0 && matching.every((row) => row.index.state === "indexed" && (row.index.chunkCount ?? 0) > 0),
				JSON.stringify(matching.map((row) => ({ id: row.id, status: row.status, index: row.index }))),
			);
		}
		await page.screenshot({ path: join(EVIDENCE, "10-finder.png") });
		if (requestedSource.length > 0) {
			await page.locator(".sidebar__item--settings").click();
			await page.waitForSelector(".settings-sidebar", { timeout: 10_000 });
			await page.locator(".settings-sidebar .settings-nav-item", { hasText: "인덱싱" }).click();
			await page.waitForSelector(".settings-sync-row", { timeout: 10_000 });
			await page.screenshot({ path: join(EVIDENCE, "11-settings-indexing.png") });
		}
	}
	check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
	failures.push(String(error));
	console.error(error);
} finally {
	// The first index leaves background helpers pointing into WORK (e.g.
	// fsearch-cli watch); kill them by their command line before deleting it.
	if (process.platform !== "win32") {
		spawnSync("pkill", ["-9", "-f", WORK]);
	}
	await app.close().catch(() => {});
	stub.close();
	rmRetry(WORK);
}
console.log(failures.length === 0 ? "onboarding QA passed" : `onboarding QA FAILED: ${failures.join("; ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
