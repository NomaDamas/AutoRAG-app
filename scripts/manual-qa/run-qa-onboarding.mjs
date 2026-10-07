// Drives first-run onboarding end to end in the built app: every step, the real
// Full Disk Access probe, folder pre-scan, the shared-config write, a real first
// index (local embedder), and the hand-off to the Finder.
//
// AUTORAG_HOME and AUTORAG_CONFIG point inside a temp dir, so the user's own
// config and index are never touched. Electron resolves the home folder from
// the OS (not $HOME), so the lane deselects the real Desktop/Documents
// candidates and adds two fixture folders through a stubbed folder dialog. The
// local embedding model and llama runtime are linked in from the real AutoRAG
// home when cached (otherwise the first index downloads them).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
const realHome = process.env.AUTORAG_HOME?.trim() || join(homeDir(), ".autorag");
for (const dir of ["models", "runtime"]) {
	if (existsSync(join(realHome, dir))) symlinkSync(join(realHome, dir), join(AUTORAG_HOME, dir), "dir");
}

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
const env = { AUTORAG_HOME, AUTORAG_CONFIG: CONFIG, AUTORAG_SKIP_DUPEY_CHECK: "1" };
const userDataDir = join(WORK, "user-data");
const app = await launchFinder({ userDataDir, env, onboarding: true });
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

	// account (placeholder sign-in)
	await page.waitForSelector(".onb .auth-card");
	check("account step", (await heading()).includes("계정"));
	await shot("03-account");
	await page.locator(".onb .auth-btn.google").click();
	await page.waitForSelector(".onb .folder-grid", { timeout: 6000 });
	check("placeholder sign-in advances to folders", true);

	// folders: swap the real candidates for fixtures picked through the dialog.
	await app.evaluate(({ dialog }, paths) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
	}, [DESK, DOCS]);
	while ((await page.locator(".onb .folder-card.selected").count()) > 0) await page.locator(".onb .folder-card.selected").first().click();
	check("folders gate closes with nothing selected", await primary.isDisabled());
	await page.locator(".onb .folder-card.add").click();
	await page.waitForFunction(() => document.querySelectorAll(".onb .folder-card.selected").length === 2, null, { timeout: 5000 });
	await page.waitForFunction(() => !document.querySelector(".onb .folder-summary")?.textContent?.includes("세는 중"), null, { timeout: 15_000 });
	const summary = await page.locator(".onb .folder-summary").innerText();
	check("pre-scan counts the three supported fixtures (skips node_modules/unsupported)", /(^|\D)3\s*개/.test(summary), summary.replace(/\s+/g, " "));
	await shot("04-folders");
	await primary.click();

	// embedding: local only; cloud card disabled.
	await page.waitForSelector(".onb .embed-card");
	check("cloud embedding is offered as unavailable", (await page.locator(".onb .embed-card.disabled").count()) === 1);
	await shot("05-embedding");
	await primary.click();

	// sources: exactly the connectors main detects (Spotlight always on macOS).
	const detection = await page.evaluate(() => window.autorag.onboarding.detectSources());
	const ids = detection.sources.map((source) => source.id);
	if (process.platform === "darwin") check("Spotlight is detected on macOS", ids.includes("spotlight"), JSON.stringify(ids));
	await page.waitForFunction((count) => document.querySelectorAll(".onb .source-row").length === count, ids.length, { timeout: 15_000 });
	check("sources lists only detected connectors", true, ids.join(", "));
	await shot("06-sources");
	// Spotlight indexes up to 300 of the machine's real documents (into the temp
	// workspace, ~20 min), so the datasources refresh only runs on request.
	const withSpotlight = process.env.QA_ONBOARDING_SPOTLIGHT === "1" && ids.includes("spotlight");
	if (withSpotlight) {
		await page.locator(".onb .source-row").first().locator(".switch").click();
		await page.waitForFunction(() => document.querySelector(".onb .source-row .switch.on") !== null, null, { timeout: 3000 });
	}
	await primary.click();

	// plan: Pro opens the placeholder checkout (no charge); Free keeps the lane offline.
	await page.waitForSelector(".onb .plan-card");
	await shot("07-plan");
	await page.locator(".onb .plan-card").nth(2).click();
	await primary.click();
	await page.waitForSelector(".onb .scrim .pay-grid", { timeout: 3000 });
	check("paid plan opens the placeholder checkout", true);
	await shot("07b-plan-pay");
	await page.keyboard.press("Escape");
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

	// indexing: real first index; gate opens only on success.
	await page.waitForSelector(".onb.immersive .ix-bar", { timeout: 10_000 });
	check("open button disabled while indexing", await page.locator(".onb .ix-open-btn").first().isDisabled().catch(() => true));
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
	if (withSpotlight) {
		check(
			"Spotlight datasource and its access tag written",
			raw.datasources?.spotlight?.type === "spotlight" && raw.datasourceAccess?.allowedTags?.includes("spotlight") === true,
			JSON.stringify({ ds: raw.datasources?.spotlight?.type, tags: raw.datasourceAccess?.allowedTags }),
		);
	}
	check("config searchPaths = selected folders", JSON.stringify(raw.searchPaths) === JSON.stringify([DESK, DOCS]), JSON.stringify(raw.searchPaths));
	check("config local embedder set", raw.minSync?.embedder?.profile === "qwen3-embedding-0.6b", JSON.stringify(raw.minSync?.embedder));
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
		await page.screenshot({ path: join(EVIDENCE, "10-finder.png") });
	}
	check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
	failures.push(String(error));
	console.error(error);
} finally {
	await app.close().catch(() => {});
	stub.close();
	rmRetry(WORK);
}
console.log(failures.length === 0 ? "onboarding QA passed" : `onboarding QA FAILED: ${failures.join("; ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
