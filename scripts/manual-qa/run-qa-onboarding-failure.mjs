// A first index that stops (#283), in the built app, with failures made for real:
// no mock inside the app. A fake OpenAI-compatible embedder answers 402 (a refused
// embedder) or is not there at all (connection refused); a selected folder
// disappears and comes back; a workspace that cannot be written. Each scenario
// starts a fresh profile that resumes onboarding at the indexing step (the state a
// relaunch restores), so the walk to the stop is the app's own: preflight, the
// refresh, the classification, the pause screen, and the ways on it offers.
//
// On a first run the app opens two windows: the Finder, usable at once, and the
// onboarding window beside it that runs the first index. The pause screen has no
// exit into the app, so a scenario that wants the Finder's side of a stop closes
// the onboarding window the way a user does: a stop then ends onboarding (the
// Finder gets its keyword index and the problem banner), while a run still going
// is left for the next launch.
//
// AUTORAG_HOME and AUTORAG_CONFIG point inside a temp dir, so the user's own config
// and index are never touched. Screenshots go to QA_OUT (or .omo/evidence/).
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMirrorIndex } from "@autorag/librarian";
import { finderWindow, launchFinder, onboardingWindow, ROOT } from "./launch-finder.mjs";
import { homeDir, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/onboarding-failure");
mkdirSync(EVIDENCE, { recursive: true });
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
// The local embedding card is disabled on a small machine; the lane pretends to be a big one (honored by unpackaged builds only).
const HARDWARE = JSON.stringify({ platform: "darwin", arch: "arm64", cpuModel: "Apple M4 Max", memoryBytes: 64 * 1024 ** 3, gpus: [] });
// Not Dazzi's own cloud id (openai:qwen/qwen3-embedding-0.6b): onboarding replaces that one with the cloud embedder.
const EMBED_ID = "openai:qa/embed-small";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

async function listen(handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}
const refuse = (_request, response) => {
	response.writeHead(402, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: "insufficient balance" } }));
};
/** A port nothing listens on: connection refused. */
async function closedPort() {
	const server = await listen(() => undefined);
	await server.close();
	return server.port;
}

/** Listens on a given port (one a scenario had closed before), to bring a server back. */
async function listenOn(port, handler) {
	const server = createServer(handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

/** A deterministic 1024-dimension vector per text: enough for MinSync to build a real index over it. */
function vectorOf(text) {
	let seed = 0;
	for (const char of text) seed = (seed * 31 + char.codePointAt(0)) >>> 0;
	return Array.from({ length: 1024 }, (_, index) => Math.sin(seed + index * 0.37) / Math.sqrt(512));
}
/** A working OpenAI-compatible embedder; `hits` collects the requests it answered, so a scenario can prove it was really used. */
const embeddingServer = (hits) => (request, response) => {
	let body = "";
	request.on("data", (chunk) => {
		body += chunk;
	});
	request.on("end", () => {
		hits.push(request.url);
		if (!request.url?.endsWith("/embeddings")) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		const parsed = JSON.parse(body || "{}");
		const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ""];
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ object: "list", model: parsed.model, data: inputs.map((text, index) => ({ object: "embedding", index, embedding: vectorOf(String(text)) })) }));
	});
};

/** A 32 MB RAM disk (macOS): a volume that really fills up. */
function ramDisk() {
	const attach = spawnSync("hdiutil", ["attach", "-nomount", "ram://65536"], { encoding: "utf8" });
	const device = attach.stdout.trim().split(/\s+/u)[0] ?? "";
	if (attach.status !== 0 || device === "") throw new Error(`could not create the RAM disk: ${attach.stderr}`);
	const erase = spawnSync("diskutil", ["erasevolume", "HFS+", "QARAM", device], { encoding: "utf8" });
	if (erase.status !== 0) {
		spawnSync("hdiutil", ["detach", device, "-force"]);
		throw new Error(`could not format the RAM disk: ${erase.stdout} ${erase.stderr}`);
	}
	return { device, mount: "/Volumes/QARAM", detach: () => spawnSync("hdiutil", ["detach", device, "-force"]) };
}

/** One fresh profile, resumed at the indexing step with the given choices. */
function profile({ embed, embedder, docs = true, home }) {
	const work = mkdtempSync(join(tmpdir(), "autorag-onb-failure-"));
	const docsDir = join(work, "Projects");
	const autoragHome = home ?? join(work, "autorag-home");
	const config = join(work, "config", "config.json");
	mkdirSync(join(work, "config"), { recursive: true });
	mkdirSync(join(work, "user-data", "onboarding"), { recursive: true });
	if (docs) {
		mkdirSync(docsDir, { recursive: true });
		writeFileSync(join(docsDir, "note.md"), "# Q3 report\n\nOperating cost fell because of the vendor change.\n");
	}
	writeFileSync(config, JSON.stringify(embedder === undefined ? {} : { minSync: { enabled: true, embedder } }));
	const draft = {
		version: 1,
		stepId: "indexing",
		notifications: false,
		network: false,
		launchAtLogin: false,
		folders: [{ path: docsDir, selected: true }],
		embed,
		cloudConsent: false,
		sources: [],
		plan: "byok",
		planConfirmed: true,
		model: null,
	};
	writeFileSync(join(work, "user-data", "onboarding", "state.json"), JSON.stringify({ completed: false, draft }));
	return {
		work,
		docsDir,
		autoragHome,
		userDataDir: join(work, "user-data"),
		env: { AUTORAG_HOME: autoragHome, AUTORAG_CONFIG: config, AUTORAG_SKIP_DUPEY_CHECK: "1", AUTORAG_QA_HARDWARE: HARDWARE },
		app: null,
		page: null,
	};
}

/**
 * Launch the app on the profile and hand back the onboarding window, with the Finder it opened beside it on
 * `state.finder` (a run still unfinished on a relaunch brings the onboarding window back; `onboarding: false`
 * says this launch is expected to have none).
 */
async function start(state, { language = "ko", env = {}, onboarding = true } = {}) {
	state.app = await launchFinder({ userDataDir: state.userDataDir, env: { ...state.env, ...env }, onboarding: true, language });
	state.finder = await finderWindow(state.app, 30_000);
	state.onboarding = onboarding ? await onboardingWindow(state.app, 30_000) : null;
	state.errors = [];
	for (const page of [state.finder, state.onboarding]) page?.on("pageerror", (error) => state.errors.push(error.message));
	return state.onboarding ?? state.finder;
}

/**
 * The app's own index windows that are open (the Finder, and during a first run the onboarding window):
 * a pre-warmed Quick Look page is not one of them.
 */
async function indexWindows(state) {
	const pages = await state.app.windows();
	return pages.filter((page) => !page.isClosed() && page.url().endsWith("/index.html"));
}

/**
 * `onboarding/state.json` as main wrote it: what the next launch resumes from.
 */
function onboardingState(state) {
	const file = join(state.userDataDir, "onboarding", "state.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Close the onboarding window the way a user does — its close button, or Cmd/Ctrl+W. Main owns what that
 * means (`onboarding-window.ts`): a first index that stopped ends onboarding there and gives the Finder its
 * keyword index, one that is still running is left for the next launch, and while the Finder is open the
 * close is never the last window, so no quit confirmation stands in the way.
 */
async function closeOnboarding(state) {
	const page = state.onboarding;
	if (page === null) throw new Error("no onboarding window to close");
	const closed = await state.app.evaluate(async ({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.isDestroyed() || !window.webContents.getURL().endsWith("/index.html")) continue;
			const onboarding = await window.webContents.executeJavaScript("window.autorag?.onboarding?.pending === true").catch(() => false);
			if (onboarding === true) {
				window.close();
				return true;
			}
		}
		return false;
	});
	if (!closed) throw new Error("the onboarding window was not found in main");
	if (!page.isClosed()) await page.waitForEvent("close", { timeout: 20_000 }).catch(() => undefined);
	state.onboarding = null;
}

/**
 * The end of a run that recovered: onboarding completes itself, so the done screen has nothing left to press.
 * The window stays on it until the user closes the window.
 */
async function completedByItself(state, page, label) {
	check(`${label}: the done screen has no button and no links`, (await page.locator(".onb .ix-cta, .onb .ix-links button, .onb .ix-open-btn, .onb .ix-bg-start").count()) === 0);
	check(`${label}: the done screen still says the index finished`, (await page.locator(".onb .ix-notice.ok").count()) === 1);
	await until(() => onboardingState(state)?.completed === true, 20_000, "onboarding to record itself as completed");
	const stored = onboardingState(state);
	check(`${label}: onboarding completed by itself, without opening Dazzi`, stored?.completed === true, JSON.stringify(stored?.completed));
}

async function stop(state) {
	if (state.app === null) return;
	// The first index leaves helpers pointing into the profile; kill them by command line before deleting it.
	spawnSync("pkill", ["-9", "-f", state.work]);
	const pid = state.app.process().pid;
	const closed = await Promise.race([state.app.close().then(() => true, () => true), sleep(30_000).then(() => false)]);
	if (!closed && pid !== undefined) spawnSync("pkill", ["-9", "-P", String(pid)]);
	spawnSync("pkill", ["-9", "-f", state.work]);
	state.app = null;
}

/** `bun run qa script <file> <text>` runs only the scenarios whose name contains <text>. */
const ONLY = process.argv[2]?.trim() ?? "";
async function scenario(name, run) {
	if (ONLY !== "" && !name.includes(ONLY)) return;
	console.log(`\n== ${name}`);
	const state = { work: null, app: null };
	try {
		await run(state);
	} catch (error) {
		failures.push(`${name}: ${error}`);
		console.error(error);
	} finally {
		await stop(state);
		if (state.work) rmRetry(state.work);
	}
}

const settings = (page, patch) => page.evaluate((value) => window.autorag.settings.set(value), patch);
/** A screenshot of the settled screen: the pop-in of the button and the 0.6 s background change are over. */
const shot = async (page, name) => {
	// The floating files animate forever (paused on a stopped run); only finite animations have an end to wait for.
	await page.evaluate(() =>
		Promise.all(
			document
				.getAnimations()
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
				.map((animation) => animation.finished.catch(() => undefined)),
		),
	);
	await sleep(700);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};
const status = (page) => page.evaluate(() => window.autorag.onboarding.indexStatus());
const problem = (page) => page.evaluate(() => window.autorag.indexProblem.get());
const paused = (page, timeout = 90_000) => page.waitForSelector(".onb .ix.paused", { timeout });
const text = (page, selector) => page.locator(selector).innerText();
const links = (page) => page.locator(".onb .ix-links button").allInnerTexts();

/** The shared look of a stopped run: one button, quiet links, nothing of the running screen, no estimate. */
async function checkPausedShape(page, label, { button, link }) {
	const cta = (await text(page, ".onb .ix-cta")).replace("↵", "").trim();
	check(`${label}: the one button is "${button}"`, cta === button, cta);
	const others = await links(page);
	check(`${label}: the links are ${JSON.stringify(link)}`, JSON.stringify(others) === JSON.stringify(link), JSON.stringify(others));
	check(`${label}: no exit into the app is left on the screen`, (await page.locator(".onb .ix-open-btn, .onb .ix-bg-start").count()) === 0 && !(await text(page, ".onb")).includes("Dazzi 열기"));
	check(`${label}: no phases, meta, locked gate or tips`, (await page.locator(".onb .ix-phases, .onb .ix-meta, .onb .ix-gate, .onb .ix-tip").count()) === 0);
	const body = await text(page, ".onb");
	check(`${label}: no "calculating the remaining time"`, !body.includes("계산 중") && !body.includes("남았어요") && !body.includes("남은 시간"), body.slice(0, 200));
	check(`${label}: the raw error never reaches the screen`, !/HTTP 402|fetch failed|ENOENT|minsync:/u.test(body), body.slice(0, 200));
	check(`${label}: the button has focus (Enter presses it)`, await page.evaluate(() => document.activeElement?.classList.contains("ix-cta") === true));
}

/**
 * The same stop in another interface language, on a fresh profile that starts in it (the app follows the stored
 * language at launch; Settings applies a change to the Finder only, not to a running onboarding). The strings are
 * longest in English and Japanese, so these are the ones that can break the layout.
 */
async function languageShots(name, make, { env = {}, ready } = {}) {
	for (const language of ["en", "ja"]) {
		await scenario(`${name} in ${language}`, async (state) => {
			const server = await make(state);
			try {
				const page = await start(state, { language, env: { ...env, ...(server?.env ?? {}) } });
				await paused(page);
				if (ready) await ready(page);
				await shot(page, `${name}-${language}`);
				const overflow = await page.evaluate(() => {
					const box = document.querySelector(".onb .ix.paused")?.getBoundingClientRect();
					return [...document.querySelectorAll(".onb .ix-title, .onb .ix-sub, .onb .ix-cta, .onb .ix-links")].some((element) => {
						const rect = element.getBoundingClientRect();
						return box === undefined || rect.left < box.left - 1 || rect.right > box.right + 1;
					});
				});
				check(`${name}: the copy fits the window in ${language}`, !overflow);
				const body = await text(page, ".onb");
				if (language === "en") check(`${name}: no Korean left on the English screen`, !/[\uac00-\ud7a3]/u.test(body), body.match(/\S*[\uac00-\ud7a3]\S*/u)?.[0] ?? "");
				if (language === "ja") check(`${name}: no Korean left on the Japanese screen`, !/[\uac00-\ud7a3]/u.test(body), body.match(/\S*[\uac00-\ud7a3]\S*/u)?.[0] ?? "");
			} finally {
				await server?.close?.();
			}
		});
	}
}

async function bothAppearances(page, name) {
	await settings(page, { appearance: "dark" });
	await sleep(300);
	await shot(page, `${name}-dark`);
	await settings(page, { appearance: "light" });
	await sleep(400);
	await shot(page, `${name}-light`);
}

// 1. The embedder answers and refuses (HTTP 402): a setting has to change. The way on is the embedding
// choice, reached with one step back, and choosing again returns straight to the index.
await scenario("a refused embedder: change the embedding and the index goes on by itself", async (state) => {
	const server = await listen(refuse);
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: server.url, apiKeyEnv: "OPENAI_API_KEY" } }));
	try {
		const page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
		await paused(page);
		check("title says the embedding cannot be used", (await text(page, ".onb .ix-title")).includes("임베딩을 쓸 수 없어요"), await text(page, ".onb .ix-title"));
		await checkPausedShape(page, "config", { button: "임베딩 방식 바꾸기", link: ["다시 시도"] });
		const run = await status(page);
		check("the app classified it from its own diagnostic", run.state === "failed" && run.failure?.reason === "embedder-config" && run.failure?.code === "embedder-preflight-failed" && run.remainingMinutes === null, JSON.stringify(run.failure));
		check("a refusal is not retried by itself", !(await text(page, ".onb .ix-sub")).includes("자동으로"), await text(page, ".onb .ix-sub"));
		await bothAppearances(page, "01-config-paused");

		await page.keyboard.press("Enter");
		await page.waitForSelector(".onb .em-card", { timeout: 10_000 });
		check("the button opens the embedding choice with a one-line reason", (await page.locator(".onb .plan-callout.warn").count()) === 1, await text(page, ".onb .plan-callout.warn"));
		await shot(page, "02-config-embedding-step");
		await page.locator(".onb .em-card").nth(0).click();
		await page.locator(".onb .footer button.primary").click();
		await page.waitForSelector(".onb .ix.done", { timeout: 120_000 });
		check("choosing again starts the index again and it finishes without leaving the flow", true);
		await shot(page, "03-config-recovered-done");
		await completedByItself(state, page, "config recovery");
		// Nothing to press: the user closes the window, and the Finder is already open with nothing left over.
		await closeOnboarding(state);
		await sleep(1500);
		const after = await problem(state.finder);
		check("a finished run leaves nothing behind in the app", after.failure === null && after.skipped === 0, JSON.stringify(after));
		check("no banner in the Finder", (await state.finder.locator('[role="alert"]').count()) === 0);
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		await server.close();
	}
});

// 2. The embedder cannot be reached: retried by itself with a countdown; closing the onboarding window on the
// stop ends onboarding with the problem still in front of the user (banner, sidebar, Settings), through a
// relaunch, and the keyword index has started so the app is not empty.
await scenario("an offline embedder: it retries itself, and closing the window keeps the problem in view", async (state) => {
	const port = await closedPort();
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "OPENAI_API_KEY" } }));
	const page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
	await paused(page);
	check("title says the connection is gone", (await text(page, ".onb .ix-title")).includes("연결이 끊겼어요"), await text(page, ".onb .ix-title"));
	await checkPausedShape(page, "offline", { button: "지금 다시 시도", link: ["임베딩 방식 바꾸기"] });
	const first = (await status(page)).finishedAt;
	const line = await text(page, ".onb .ix-sub");
	check("the reason line counts down to the next automatic try", /\d+초 뒤 자동으로 다시 시도해요/u.test(line), line);
	await shot(page, "04-offline-paused");
	const retried = await until(async () => (await status(page)).finishedAt !== first && (await status(page)).state === "failed", 40_000, "the automatic retry to stop again");
	check("it tried again by itself without a click", retried === true);
	check("the pause screen stayed up through the retry", (await page.locator(".onb .ix.paused").count()) === 1);

	// The user closes the window the way the screen leaves them to: a stopped first run ends onboarding there.
	await closeOnboarding(state);
	const finder = state.finder;
	await finder.waitForSelector('[role="alert"]', { timeout: 20_000 });
	const banner = await text(finder, '[role="alert"]');
	check("the banner says it plainly, with the one button", banner.includes("연결을 기다리는 중이에요") && banner.includes("지금 다시 시도"), banner);
	const block = await until(async () => finder.locator('.sidebar__activity[data-tone="error"]').first().innerText().catch(() => null), 90_000, "the sidebar block");
	check("the sidebar keeps a block that does not expire", block.includes("연결 기다리는 중"), block);
	const kept = await problem(finder);
	check("the problem record is the same fact the screen showed", kept.failure?.reason === "embedder-offline", JSON.stringify(kept));
	await bothAppearances(finder, "05-offline-in-app");
	const mirror = join(state.autoragHome, "workspace", ".autorag", "parsed", "index.json");
	await until(() => existsSync(mirror) && readFileSync(mirror, "utf8").includes("note.md"), 90_000, "the keyword index to read the folder");
	check("closing on the stop started the keyword index, so the app is not empty", true);
	check("onboarding is over for good", onboardingState(state)?.completed === true);

	// The banner's button retries; the embedder is still gone, so the problem stays (and the clock moves).
	const before = (await problem(finder)).at;
	await finder.locator('[role="alert"] button', { hasText: "지금 다시 시도" }).click();
	await until(async () => {
		const now = await problem(finder);
		return !now.retrying && now.at !== before;
	}, 60_000, "the retry from the banner to end");
	check("a retry that fails again leaves the problem in place", (await problem(finder)).failure?.reason === "embedder-offline");

	// A relaunch brings it back: it is on disk, not in memory. Onboarding is over, so this launch has no
	// onboarding window at all.
	await stop(state);
	await start(state, { env: { OPENAI_API_KEY: "sk-qa" }, onboarding: false });
	const again = state.finder;
	await again.waitForSelector('[role="alert"]', { timeout: 30_000 });
	check("after a relaunch the banner is still there", (await text(again, '[role="alert"]')).includes("연결을 기다리는 중이에요"));
	check("a completed onboarding opens no onboarding window", (await indexWindows(state)).length === 1);
	await again.locator(".sidebar__activity").first().click();
	await again.waitForSelector(".settings-sidebar", { timeout: 10_000 });
	await shot(again, "06-offline-settings-card");
	check("the sidebar block opens Settings with the problem on the indexing card", (await again.locator(".settings-view").innerText()).includes("인덱싱 멈춤"));
	await again.evaluate(() => window.autorag.indexProblem.dismiss());
	await until(async () => (await problem(again)).failure === null, 10_000, "the dismissed problem to clear");
	check("dismissing clears it, for good", true);
	check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
});

// 3. A selected folder is not there (an unplugged drive): looked at again every few seconds, and the
// index goes on by itself the moment it is back. Leaving the folder out is the other way on.
await scenario("an unreadable folder: it goes on by itself when the folder returns", async (state) => {
	Object.assign(state, profile({ embed: "none" }));
	// A root that held documents and now cannot be listed is what the app refuses to refresh over.
	const workspace = join(state.autoragHome, "workspace");
	saveMirrorIndex(workspace, {
		version: 1,
		entries: {
			"/Projects/note.md": {
				virtualPath: "/Projects/note.md",
				sourcePath: join(state.docsDir, "note.md"),
				outputPath: join(workspace, "note.md"),
				parserName: "plain-text",
				sourceMtimeNs: 1,
				sourceSizeBytes: 1,
				updatedAt: new Date(0).toISOString(),
			},
		},
		skipped: {},
	});
	rmSync(state.docsDir, { recursive: true, force: true });
	const page = await start(state);
	await paused(page);
	const title = await text(page, ".onb .ix-title");
	check("the title names the folder", title.includes("‘Projects’") && title.includes("읽을 수 없어요"), title);
	await checkPausedShape(page, "folder", { button: "다시 확인", link: ["‘Projects’ 빼고 계속"] });
	const run = await status(page);
	check("classified as an unreadable folder, naming it", run.failure?.reason === "folder-unreadable" && run.failure.folders.some((folder) => folder.endsWith("Projects")), JSON.stringify(run.failure));
	await bothAppearances(page, "07-folder-paused");
	mkdirSync(state.docsDir, { recursive: true });
	writeFileSync(join(state.docsDir, "note.md"), "# Back again\n");
	await page.waitForSelector(".onb .ix.done", { timeout: 90_000 });
	check("the folder came back and the index finished by itself", true);
	await shot(page, "08-folder-recovered-done");
	await completedByItself(state, page, "folder recovery");
	await closeOnboarding(state);
	await sleep(1500);
	const after = await problem(state.finder);
	check("the recovered run leaves no problem in the Finder", after.failure === null && after.skipped === 0, JSON.stringify(after));
	check("no banner in the Finder", (await state.finder.locator('[role="alert"]').count()) === 0);
	check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
});

await scenario("an unreadable folder: leaving it out goes back to choosing folders when it was the only one", async (state) => {
	Object.assign(state, profile({ embed: "none" }));
	const workspace = join(state.autoragHome, "workspace");
	saveMirrorIndex(workspace, {
		version: 1,
		entries: {
			"/Projects/note.md": {
				virtualPath: "/Projects/note.md",
				sourcePath: join(state.docsDir, "note.md"),
				outputPath: join(workspace, "note.md"),
				parserName: "plain-text",
				sourceMtimeNs: 1,
				sourceSizeBytes: 1,
				updatedAt: new Date(0).toISOString(),
			},
		},
		skipped: {},
	});
	rmSync(state.docsDir, { recursive: true, force: true });
	const page = await start(state);
	await paused(page);
	await page.locator(".onb .ix-links button", { hasText: "빼고 계속" }).click();
	await page.waitForSelector(".onb .folder-grid", { timeout: 10_000 });
	check("with no folder left, the user chooses folders again instead of hitting a dead end", true);
	await shot(page, "09-folder-excluded-back-to-folders");
});

// 4. Nothing the app can tell apart (a workspace it cannot write): a retry that stops again moves the button to
// the setting, and says that it is the same thing again.
await scenario("an unknown cause: a second stop moves the button to the embedding choice", async (state) => {
	Object.assign(state, profile({ embed: "none", home: "/System/qa-autorag-home" }));
	const page = await start(state);
	await paused(page);
	check("title is the generic one", (await text(page, ".onb .ix-title")).includes("임베딩이 멈췄어요"), await text(page, ".onb .ix-title"));
	await checkPausedShape(page, "unknown", { button: "다시 시도", link: ["임베딩 방식 바꾸기"] });
	const run = await status(page);
	check("an unclassified stop is called unknown, with no guess", run.failure?.reason === "unknown", JSON.stringify(run.failure));
	await shot(page, "10-unknown-paused-first");
	const first = run.finishedAt;
	await page.locator(".onb .ix-cta").click();
	await until(async () => (await status(page)).finishedAt !== first && (await status(page)).state === "failed", 60_000, "the second stop");
	await page.waitForFunction(() => document.querySelector(".onb .ix-cta")?.textContent?.includes("임베딩 방식 바꾸기") === true, null, { timeout: 10_000 });
	check("after the second stop the button is the embedding choice", (await text(page, ".onb .ix-cta")).includes("임베딩 방식 바꾸기"));
	check("the line says it is the same reason again", (await text(page, ".onb .ix-sub")).includes("같은 이유로 또 멈췄어요"), await text(page, ".onb .ix-sub"));
	await shot(page, "11-unknown-paused-again");
});

// 5. The on-device model cannot be fetched (its cache folder cannot be written): the download is retried by itself.
await scenario("a model that cannot be downloaded: retried by itself, one way on at hand", async (state) => {
	Object.assign(state, profile({ embed: "local" }));
	const page = await start(state, { env: { FASTEMBED_CACHE_DIR: "/System/qa-model-cache" } });
	await paused(page);
	const run = await status(page);
	check("a failed model download is its own reason", run.failure?.reason === "model-download", JSON.stringify(run.failure));
	check("title says the model could not be downloaded", (await text(page, ".onb .ix-title")).includes("모델을 받지 못했어요"), await text(page, ".onb .ix-title"));
	await checkPausedShape(page, "model", { button: "이어서 받기", link: ["임베딩 방식 바꾸기"] });
	await shot(page, "12-model-paused");
});

// 5b. Recovery, for real: the thing that stopped the index is put right while the app is running, and the
// screens have to notice and carry on without the user redoing anything.

// The embedder is back during the pause: it retries by itself, the pause ends, the index finishes through the
// restored server, and onboarding is over by itself with nothing left over.
await scenario("recovery: the embedder comes back during the pause and the index finishes by itself", async (state) => {
	const port = await closedPort();
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "OPENAI_API_KEY" } }));
	const page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
	await paused(page);
	check("it starts paused on the lost connection", (await text(page, ".onb .ix-title")).includes("연결이 끊겼어요"), await text(page, ".onb .ix-title"));
	const hits = [];
	const server = await listenOn(port, embeddingServer(hits));
	try {
		await page.waitForSelector(".onb .ix.done", { timeout: 90_000 });
		check("the connection came back and the index finished with no click", true);
		check("MinSync really embedded through the restored server", hits.length > 1, `${hits.length} requests`);
		const run = await status(page);
		check("the run ended as a success with nothing recorded as failed", run.state === "success" && run.failure === null, JSON.stringify({ state: run.state, failure: run.failure }));
		await shot(page, "16-recovery-offline-back-done");
		await completedByItself(state, page, "offline recovery");
		await closeOnboarding(state);
		await sleep(1500);
		const after = await problem(state.finder);
		check("nothing is left behind in the app", after.failure === null && after.skipped === 0, JSON.stringify(after));
		check("no banner in the Finder", (await state.finder.locator('[role="alert"]').count()) === 0);
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		await server.close();
	}
});

// The user closed the onboarding window on the stop, which ends onboarding; the embedder comes back later; the
// banner's one button puts everything right.
await scenario("recovery: the banner's button fixes it once the embedder is back", async (state) => {
	const port = await closedPort();
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "OPENAI_API_KEY" } }));
	let page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
	await paused(page);
	await closeOnboarding(state);
	page = state.finder; // the Finder that was open all along, now the app's only window
	await page.waitForSelector('[role="alert"]', { timeout: 20_000 });
	// What a user sees: the keyword index runs first (the sidebar shows progress), then the problem block returns.
	await until(async () => (await page.locator('.sidebar__activity[data-tone="error"]').count()) === 1, 90_000, "the problem block after the keyword index");
	await sleep(1500);
	await shot(page, "17-recovery-banner-before");
	const hits = [];
	const server = await listenOn(port, embeddingServer(hits));
	try {
		await page.locator('[role="alert"] button', { hasText: "지금 다시 시도" }).click();
		await shot(page, "18-recovery-banner-retrying");
		await until(async () => {
			const now = await problem(page);
			return !now.retrying && now.failure === null;
		}, 240_000, "the retry from the banner to clear the problem");
		check("the banner's retry cleared the recorded problem", true);
		check("MinSync really embedded through the restored server", hits.length > 1, `${hits.length} requests`);
		await until(async () => (await page.locator('[role="alert"]').count()) === 0, 10_000, "the banner to leave");
		check("the banner is gone", true);
		await until(async () => (await page.locator('.sidebar__activity[data-tone="error"]').count()) === 0, 10_000, "the problem block to leave");
		check("the sidebar no longer shows an error", true);
		await sleep(5000);
		await shot(page, "19-recovery-banner-after");
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-sidebar", { timeout: 10_000 });
		await page.locator(".settings-sidebar .settings-nav-item", { hasText: "인덱싱" }).click();
		await page.waitForSelector(".settings-sync-row", { timeout: 10_000 });
		check("Settings > indexing no longer says it stopped", !(await page.locator(".settings-view").innerText()).includes("인덱싱 멈춤"));
		await shot(page, "20-recovery-settings-after");
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		await server.close();
	}
});

// A volume that really fills up: the download writes until the OS answers ENOSPC.
await scenario("a real full disk: told apart from every other download failure, and the way on works", async (state) => {
	if (process.platform !== "darwin") {
		console.log("INFO a RAM disk is macOS-only; skipped");
		return;
	}
	const ram = ramDisk();
	try {
		Object.assign(state, profile({ embed: "local" }));
		const page = await start(state, { env: { FASTEMBED_CACHE_DIR: join(ram.mount, "models") } });
		await paused(page, 240_000);
		const run = await status(page);
		check("a volume that is really full is classified as a full disk", run.failure?.reason === "disk-full" && run.failure?.code === "embedding-model-download-failed", JSON.stringify(run.failure));
		check("title says there is not enough storage", (await text(page, ".onb .ix-title")).includes("저장 공간이 부족해요"), await text(page, ".onb .ix-title"));
		await checkPausedShape(page, "disk", { button: "공간 확보했어요, 이어서 받기", link: ["임베딩 방식 바꾸기"] });
		check("a full disk is not retried by itself", !/\d+초 뒤/u.test(await text(page, ".onb .ix-sub")), await text(page, ".onb .ix-sub"));
		await shot(page, "21-disk-full-paused");
		// The way on that needs no space: keyword-only search.
		await page.locator(".onb .ix-links button", { hasText: "임베딩 방식 바꾸기" }).click();
		await page.waitForSelector(".onb .em-card", { timeout: 10_000 });
		check("the embedding choice opens with the reason", (await page.locator(".onb .plan-callout.warn").innerText()).includes("저장 공간"), await text(page, ".onb .plan-callout.warn"));
		await shot(page, "22-disk-full-embedding-step");
		await page.locator(".onb .em-card").nth(0).click();
		await page.locator(".onb .footer button.primary").click();
		await page.waitForSelector(".onb .ix.done", { timeout: 120_000 });
		check("choosing keyword-only finishes the index on the same full disk", true);
		await shot(page, "23-disk-full-keyword-done");
		await completedByItself(state, page, "disk-full recovery");
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		await stop(state);
		ram.detach();
	}
});

// A model whose download was never finished: the pause says so, the user closes the onboarding window, and the
// banner's "resume" completes the model and runs the real on-device embedding.
await scenario("recovery: an unfinished model is completed from the banner and the real local index runs", async (state) => {
	const cached = process.env.FASTEMBED_CACHE_DIR?.trim() || join(homeDir(), ".cache", "minsync", "models");
	if (!existsSync(join(cached, "models--Qwen--Qwen3-Embedding-0.6B", "refs", "main"))) throw new Error(`no cached model at ${cached}; the runner copies the host's cache into the guest`);
	Object.assign(state, profile({ embed: "local" }));
	const models = join(state.work, "models");
	cpSync(cached, models, { recursive: true, dereference: true });
	const refs = join(models, "models--Qwen--Qwen3-Embedding-0.6B", "refs");
	rmSync(join(refs, "main"));
	chmodSync(refs, 0o555);
	let page = await start(state, { env: { FASTEMBED_CACHE_DIR: models } });
	try {
		await paused(page, 300_000);
		const run = await status(page);
		check("a model that cannot be completed is a model-download stop", run.failure?.reason === "model-download", JSON.stringify(run.failure));
		check("title says the model could not be downloaded", (await text(page, ".onb .ix-title")).includes("모델을 받지 못했어요"), await text(page, ".onb .ix-title"));
		await closeOnboarding(state);
		page = state.finder; // the Finder that was open all along, now the app's only window
		await page.waitForSelector('[role="alert"]', { timeout: 20_000 });
		check("the banner offers to resume the download", (await text(page, '[role="alert"]')).includes("이어서 받기"), await text(page, '[role="alert"]'));
		await until(async () => (await page.locator('.sidebar__activity[data-tone="error"]').count()) === 1, 120_000, "the problem block after the keyword index");
		await shot(page, "24-model-banner-before");
		// What the user does to fix it, then the one button.
		chmodSync(refs, 0o755);
		await page.locator('[role="alert"] button', { hasText: "이어서 받기" }).click();
		await until(async () => {
			const now = await problem(page);
			return !now.retrying && now.failure === null;
		}, 600_000, "the resumed download and the local index to finish");
		check("the banner's resume cleared the problem", true);
		check("the model was completed on disk", existsSync(join(refs, "main")));
		const minsyncDir = join(state.autoragHome, "workspace", ".autorag", "minsync", ".minsync");
		const cursor = existsSync(join(minsyncDir, "cursor.json")) ? readFileSync(join(minsyncDir, "cursor.json"), "utf8") : "";
		check("MinSync synced with the on-device Qwen3 model (its own cursor names it)", cursor.includes("Qwen/Qwen3-Embedding-0.6B"), cursor.slice(0, 200));
		check("the vector store holds the document", existsSync(join(minsyncDir, "store", "documents.lance")), minsyncDir);
		await until(async () => (await page.locator('[role="alert"]').count()) === 0, 10_000, "the banner to leave");
		await sleep(5000);
		await shot(page, "25-model-banner-after");
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		try {
			chmodSync(refs, 0o755);
		} catch {
			// The folder may already be gone.
		}
	}
});

// 7. A run still going when the window closes: with the Finder open this is not the last window, so the close
// asks nothing and the index keeps going in main — and because it never finished, onboarding is unfinished
// again on the next launch, the same run resumed.
await scenario("a first index still running: closing the onboarding window leaves onboarding for the next launch", async (state) => {
	// An embedder that accepts the connection and never answers holds the run open, so the window can be closed
	// while the index is really going.
	const holding = await listen(() => undefined);
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: holding.url, apiKeyEnv: "OPENAI_API_KEY" } }));
	try {
		const page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
		await until(async () => (await status(page))?.state === "running", 120_000, "the first index to start running");
		check("the run is going, not stopped", (await page.locator(".onb .ix.paused").count()) === 0);
		const atClose = await status(page);
		await closeOnboarding(state);
		await sleep(2000);
		check("the index was still running when the window closed", atClose.state === "running", atClose.state);
		check("closing it left the Finder, not a quit", (await indexWindows(state)).length === 1 && !state.finder.isClosed());
		check("the Finder window is still the app's own window", (await state.finder.locator(".sidebar").count()) === 1);
		check("a run that never finished leaves onboarding unfinished", onboardingState(state)?.completed === false, JSON.stringify(onboardingState(state)?.completed));
		// The next launch is the one the unfinished first run was kept for: the window comes back on it.
		await stop(state);
		const again = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
		await again.waitForSelector(".onb .ix", { timeout: 120_000 });
		check("the next launch brings the onboarding window back on the same run", true);
		check("and onboarding is still unfinished there", onboardingState(state)?.completed === false);
	} finally {
		await holding.close();
	}
});

// 6. The same stops in English and Japanese (the longest strings), on fresh profiles that start in them.
const unreadableFolder = (state) => {
	Object.assign(state, profile({ embed: "none" }));
	const workspace = join(state.autoragHome, "workspace");
	saveMirrorIndex(workspace, {
		version: 1,
		entries: {
			"/Projects/note.md": { virtualPath: "/Projects/note.md", sourcePath: join(state.docsDir, "note.md"), outputPath: join(workspace, "note.md"), parserName: "plain-text", sourceMtimeNs: 1, sourceSizeBytes: 1, updatedAt: new Date(0).toISOString() },
		},
		skipped: {},
	});
	rmSync(state.docsDir, { recursive: true, force: true });
	return null;
};
await languageShots("13-config", async (state) => {
	const server = await listen(refuse);
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: server.url, apiKeyEnv: "OPENAI_API_KEY" } }));
	return { env: { OPENAI_API_KEY: "sk-qa" }, close: server.close };
});
await languageShots("14-folder", unreadableFolder);
await languageShots("15-unknown", (state) => {
	Object.assign(state, profile({ embed: "none", home: "/System/qa-autorag-home" }));
	return null;
});

console.log(failures.length === 0 ? "onboarding failure QA passed" : `onboarding failure QA FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
