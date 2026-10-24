// A first index that stops (#283), in the built app, with failures made for real:
// no mock inside the app. A fake OpenAI-compatible embedder answers 402 (a refused
// embedder) or is not there at all (connection refused); a selected folder
// disappears and comes back; a workspace that cannot be written. Each scenario
// starts a fresh profile that resumes onboarding at the indexing step (the state a
// relaunch restores), so the walk to the stop is the app's own: preflight, the
// refresh, the classification, the paused screen, then every way out of it.
//
// AUTORAG_HOME and AUTORAG_CONFIG point inside a temp dir, so the user's own config
// and index are never touched. Screenshots go to QA_OUT (or .omo/evidence/).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMirrorIndex } from "@autorag/librarian";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

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

async function start(state, { language = "ko", env = {} } = {}) {
	state.app = await launchFinder({ userDataDir: state.userDataDir, env: { ...state.env, ...env }, onboarding: true, language });
	state.page = await finderWindow(state.app, 30_000);
	state.errors = [];
	state.page.on("pageerror", (error) => state.errors.push(error.message));
	return state.page;
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

async function scenario(name, run) {
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
		await checkPausedShape(page, "config", { button: "임베딩 방식 바꾸기", link: ["다시 시도", "일단 Dazzi 열기"] });
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
		await page.locator(".onb .ix-open-btn").click();
		await page.waitForSelector(".onb", { state: "detached", timeout: 15_000 });
		await sleep(1500);
		const after = await problem(page);
		check("a finished run leaves nothing behind in the app", after.failure === null && after.skipped === 0, JSON.stringify(after));
		check("no banner in the Finder", (await page.locator('[role="alert"]').count()) === 0);
		check("no renderer errors", state.errors.length === 0, state.errors.slice(0, 3).join(" | "));
	} finally {
		await server.close();
	}
});

// 2. The embedder cannot be reached: retried by itself with a countdown; "open Dazzi anyway" lands in the app
// with the problem still in front of the user (banner, sidebar, Settings), through a relaunch, and the keyword
// index has started so the app is not empty.
await scenario("an offline embedder: it retries itself, and opening Dazzi anyway keeps the problem in view", async (state) => {
	const port = await closedPort();
	Object.assign(state, profile({ embed: "local", embedder: { id: EMBED_ID, dimension: 1024, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: "OPENAI_API_KEY" } }));
	const page = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
	await paused(page);
	check("title says the connection is gone", (await text(page, ".onb .ix-title")).includes("연결이 끊겼어요"), await text(page, ".onb .ix-title"));
	await checkPausedShape(page, "offline", { button: "지금 다시 시도", link: ["일단 Dazzi 열기"] });
	const first = (await status(page)).finishedAt;
	const line = await text(page, ".onb .ix-sub");
	check("the reason line counts down to the next automatic try", /\d+초 뒤 자동으로 다시 시도해요/u.test(line), line);
	await shot(page, "04-offline-paused");
	const retried = await until(async () => (await status(page)).finishedAt !== first && (await status(page)).state === "failed", 40_000, "the automatic retry to stop again");
	check("it tried again by itself without a click", retried === true);
	check("the pause screen stayed up through the retry", (await page.locator(".onb .ix.paused").count()) === 1);

	await page.locator(".onb .ix-links button", { hasText: "일단 Dazzi 열기" }).click();
	await page.waitForSelector(".onb", { state: "detached", timeout: 15_000 });
	await page.waitForSelector('[role="alert"]', { timeout: 20_000 });
	const banner = await text(page, '[role="alert"]');
	check("the banner says it plainly, with the one button", banner.includes("연결을 기다리는 중이에요") && banner.includes("지금 다시 시도"), banner);
	const block = await until(async () => page.locator('.sidebar__activity[data-tone="error"]').first().innerText().catch(() => null), 20_000, "the sidebar block");
	check("the sidebar keeps a block that does not expire", block.includes("연결 기다리는 중"), block);
	const kept = await problem(page);
	check("the problem record is the same fact the screen showed", kept.failure?.reason === "embedder-offline", JSON.stringify(kept));
	await bothAppearances(page, "05-offline-in-app");
	const mirror = join(state.autoragHome, "workspace", ".autorag", "parsed", "index.json");
	await until(() => existsSync(mirror) && readFileSync(mirror, "utf8").includes("note.md"), 90_000, "the keyword index to read the folder");
	check("opening anyway started the keyword index, so the app is not empty", true);

	// The banner's button retries; the embedder is still gone, so the problem stays (and the clock moves).
	const before = (await problem(page)).at;
	await page.locator('[role="alert"] button', { hasText: "지금 다시 시도" }).click();
	await until(async () => {
		const now = await problem(page);
		return !now.retrying && now.at !== before;
	}, 60_000, "the retry from the banner to end");
	check("a retry that fails again leaves the problem in place", (await problem(page)).failure?.reason === "embedder-offline");

	// A relaunch brings it back: it is on disk, not in memory.
	await stop(state);
	const again = await start(state, { env: { OPENAI_API_KEY: "sk-qa" } });
	await again.waitForSelector('[role="alert"]', { timeout: 30_000 });
	check("after a relaunch the banner is still there", (await text(again, '[role="alert"]')).includes("연결을 기다리는 중이에요"));
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
	await checkPausedShape(page, "folder", { button: "다시 확인", link: ["‘Projects’ 빼고 계속", "일단 Dazzi 열기"] });
	const run = await status(page);
	check("classified as an unreadable folder, naming it", run.failure?.reason === "folder-unreadable" && run.failure.folders.some((folder) => folder.endsWith("Projects")), JSON.stringify(run.failure));
	await bothAppearances(page, "07-folder-paused");
	mkdirSync(state.docsDir, { recursive: true });
	writeFileSync(join(state.docsDir, "note.md"), "# Back again\n");
	await page.waitForSelector(".onb .ix.done", { timeout: 90_000 });
	check("the folder came back and the index finished by itself", true);
	await shot(page, "08-folder-recovered-done");
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
	await checkPausedShape(page, "unknown", { button: "다시 시도", link: ["임베딩 방식 바꾸기", "일단 Dazzi 열기"] });
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
	await checkPausedShape(page, "model", { button: "이어서 받기", link: ["임베딩 방식 바꾸기", "일단 Dazzi 열기"] });
	await shot(page, "12-model-paused");
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
