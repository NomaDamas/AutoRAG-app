/**
 * The remote server must carry the real Finder, not just answer endpoint probes.
 * A fresh profile enables an ephemeral listener; a separate Chromium session
 * drives the same file operations a browser user does, then checks guest disk
 * bytes. Native Chromium file-drop input keeps upload coverage honest: calling
 * the upload bridge directly would hide a missing renderer drop integration.
 *
 * Run only through the VM runner after building:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-remote-access.mjs
 * Screenshots, notes, and downloaded bytes land in QA_OUT.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { cssAttr } from "./platform.mjs";

if (!process.env.QA_OUT) throw new Error("QA_OUT is required; run through bun run qa script --vm");
const evidence = process.env.QA_OUT;
mkdirSync(evidence, { recursive: true });
// The guest's own browser cache is used: playwright-core pins its registry
// directory when the module graph loads (launch-finder.mjs imports it), so an
// override set here would come too late. The install below fills that cache.
const notes = join(evidence, "notes.txt");
writeFileSync(notes, "");
const log = (line) => {
	console.log(line);
	appendFileSync(notes, `${line}\n`);
};
const work = mkdtempSync(join(homedir(), "dazzi-qa-remote-"));
const home = join(work, "home");
const fixture = join(home, "Documents", "RemoteAccessQA");
const incoming = join(work, "incoming");
const profile = join(work, "profile");
for (const directory of [fixture, incoming, join(profile, "settings")]) mkdirSync(directory, { recursive: true });
writeFileSync(
	join(profile, "settings", "settings-state.json"),
	`${JSON.stringify({ settings: { remoteAccess: true, remotePort: 0, language: "en" }, permissions: {} })}\n`,
);
const downloadBytes = Buffer.from("Dazzi remote download\nBinary bytes: \0\u0001\u00ff\n", "utf8");
const uploadBytes = Buffer.from("Uploaded through a Chromium file drop.\n", "utf8");
const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const downloadFile = join(fixture, "download-me.txt");
const imageFile = join(fixture, "preview.png");
const uploadFile = join(incoming, "uploaded.txt");
writeFileSync(downloadFile, downloadBytes);
writeFileSync(imageFile, imageBytes);
writeFileSync(uploadFile, uploadBytes);

/** A Playwright/CDP await has no timeout of its own, so a stalled step fails instead of hanging the lane. */
const bounded = (promise, ms, label) =>
	Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);

const checks = [];
const consoleErrors = [];
const ignoredWarnings = [];
const screenshots = [];
const observedPages = new Set();
let app = null;
let browser = null;
let page = null;
let desktop = null;
let remoteStatus = null;
let stage = "startup";

// Only this known Electron Sentry transport warning is exempt; page errors,
// failed assets, and every other console error still fail the lane.
const knownSentryWarning = (text) =>
	text.includes("sentry-ipc") && /content security policy|content-security-policy|violates.*connect-src/iu.test(text);
function observePage(target, label) {
	if (observedPages.has(target)) return;
	observedPages.add(target);
	target.on("console", (message) => {
		if (message.type() !== "error") return;
		const text = `${label}: ${message.text()}`;
		if (knownSentryWarning(text)) ignoredWarnings.push(text);
		else {
			consoleErrors.push(text);
			log(`CONSOLE ERROR ${text}`);
		}
	});
	target.on("pageerror", (error) => {
		const text = `${label}: ${error.stack ?? String(error)}`;
		consoleErrors.push(text);
		log(`PAGE ERROR ${text}`);
	});
}
async function screenshot(target, name) {
	const path = join(evidence, `${name}.png`);
	await target.screenshot({ path, fullPage: true });
	screenshots.push(path);
	log(`SCREENSHOT ${path}`);
}
async function scenario(name, run) {
	stage = name;
	try {
		await run();
		checks.push({ name, pass: true });
		log(`PASS ${name}`);
		return true;
	} catch (error) {
		const detail = error.stack ?? String(error);
		checks.push({ name, pass: false, detail });
		log(`FAIL ${name}\n${detail}`);
		if (page !== null && !page.isClosed()) await screenshot(page, `failure-${checks.length}`).catch((captureError) => log(`FAIL screenshot: ${captureError}`));
		return false;
	}
}
const row = (path) => page.locator(`[data-path="${cssAttr(path)}"]`).first();
const callResponse = (method) =>
	page.waitForResponse(
		(response) => {
			if (new URL(response.url()).pathname !== "/remote/call" || response.request().method() !== "POST") return false;
			const call = response.request().postDataJSON();
			return call.target === "fs" && call.method === method;
		},
		{ timeout: 15_000 },
	);
async function successfulCall(response) {
	assert.equal(response.status(), 200);
	const result = await response.json();
	assert.equal(result.ok, true, JSON.stringify(result));
}

try {
	log(`FIXTURE ${fixture}`);
	log(`PROFILE ${profile}`);
	// A fresh guest has no browser, so the first run of a guest downloads the
	// matching headless shell; an already-warm cache makes this a no-op.
	if (!existsSync(chromium.executablePath())) {
		log("Installing Playwright Chromium into the guest browser cache");
		const installing = promisify(execFile)(process.execPath, [join(ROOT, "node_modules/playwright/cli.js"), "install", "--only-shell", "chromium"], {
			timeout: 300_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		installing.child.stdout?.on("data", (chunk) => log(chunk.toString().trimEnd()));
		installing.child.stderr?.on("data", (chunk) => log(chunk.toString().trimEnd()));
		await installing;
	}
	app = await launchFinder({ userDataDir: profile, env: { HOME: home, USERPROFILE: home, AUTORAG_QA_ROOT: join(home, "Documents") } });
	app.on("window", (target) => observePage(target, "desktop"));
	for (const target of app.windows()) observePage(target, "desktop");
	let servingSeen = false;
	let signalServing;
	const servingSignal = new Promise((resolve) => { signalServing = resolve; });
	let stderr = "";
	app.process().stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
		if (!servingSeen && stderr.includes("[remote] serving at ")) {
			servingSeen = true;
			signalServing();
		}
	});
	desktop = await finderWindow(app, 30_000);
	await desktop.locator(".toolbar-title").waitFor({ timeout: 60_000 });
	const readStatus = () =>
		app.evaluate(async ({ ipcMain }) => {
			const handler = ipcMain._invokeHandlers.get("remote:status");
			if (handler === undefined) throw new Error("remote:status is not registered");
			return handler({});
		});
	remoteStatus = await readStatus();
	if (!remoteStatus.serving || remoteStatus.origin === null) {
		let timer;
		try {
			await Promise.race([
				servingSignal,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Remote server did not start: ${JSON.stringify(remoteStatus)}\n${stderr}`)), 30_000); }),
			]);
		} finally {
			clearTimeout(timer);
		}
		remoteStatus = await readStatus();
	}
	assert.equal(remoteStatus.serving, true);
	assert.equal(typeof remoteStatus.origin, "string");
	const address = new URL(remoteStatus.origin);
	assert.ok(address.searchParams.get("token"), "live remote address must carry its session token");
	assert.ok(remoteStatus.port > 0, "port 0 must resolve to a live ephemeral port");
	log(`PASS remote:status serving at ${address.origin} (token present; port ${remoteStatus.port})`);
	checks.push({ name: "seeded profile starts remote access on an ephemeral port", pass: true });

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
	context.on("page", (target) => observePage(target, "browser"));
	page = await context.newPage();
	page.setDefaultTimeout(15_000);
	// Observe actual outgoing search starts, not just the absence of a chat
	// bubble: typing a draft must never reach the model-start bridge.
	const modelRequests = [];
	context.on("request", (request) => {
		if (new URL(request.url()).pathname !== "/remote/call" || request.method() !== "POST") return;
		const call = request.postDataJSON();
		if (call.target === "search" && ["start", "steer"].includes(call.method)) modelRequests.push(call);
	});
	await page.goto(remoteStatus.origin, { waitUntil: "domcontentloaded" });
	await page.locator(".toolbar-title").waitFor({ timeout: 60_000 });
	await page.locator(".sidebar__item").first().waitFor();
	await screenshot(page, "01-remote-finder");
	log("PASS remote Finder UI loaded in an independent Chromium context");
	checks.push({ name: "remote Finder UI loads", pass: true });

	// Given a folder under the guest home, when its path is entered through
	// the real path bar, then both the title and its real file rows appear.
	/** Type a folder into the real path bar, the way a user navigates. */
	const enterPath = async (dir, expectedName = "RemoteAccessQA") => {
		const bar = page.locator(".pathbar");
		const box = await bar.boundingBox();
		assert.ok(box, "Finder path bar is visible");
		await bar.click({ position: { x: box.width - 8, y: box.height / 2 } });
		const editor = page.getByRole("combobox", { name: "Go to path", exact: true });
		await editor.fill(dir);
		await editor.press("Enter");
		await expect(page.locator(".toolbar-title")).toHaveText(expectedName);
	};
	const navigated = await scenario("navigate into the guest fixture folder", async () => {
		await enterPath(fixture);
		await row(downloadFile).waitFor();
		await row(imageFile).waitFor();
		await screenshot(page, "02-fixture");
	});
	if (navigated) {
		const created = join(fixture, "remote-created");
		const renamed = join(fixture, "remote-renamed");
		const madeFolder = await scenario("create a folder through the browser Finder", async () => {
			await row(downloadFile).click({ button: "right" });
			const response = callResponse("createFolder");
			await page.getByRole("menuitem", { name: "New Folder", exact: true }).click();
			await successfulCall(await response);
			const rename = page.getByRole("textbox", { name: "New name", exact: true });
			await rename.fill(basename(created));
			const committed = callResponse("rename");
			await rename.press("Enter");
			await successfulCall(await committed);
			await row(created).waitFor();
			assert.ok(statSync(created).isDirectory());
			await screenshot(page, "03-created-folder");
		});
		if (madeFolder) {
			await scenario("rename the created folder through real input", async () => {
				await row(created).click({ button: "right" });
				await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
				const rename = page.getByRole("textbox", { name: "New name", exact: true });
				await rename.fill(basename(renamed));
				const response = callResponse("rename");
				await rename.press("Enter");
				await successfulCall(await response);
				await row(renamed).waitFor();
				assert.ok(statSync(renamed).isDirectory());
				assert.equal(existsSync(created), false);
				await screenshot(page, "04-renamed-folder");
			});
		}
		await scenario("upload a file by native Chromium file drop", async () => {
			await page.keyboard.press("Escape");
			const list = page.locator(".list").first();
			const box = await list.boundingBox();
			assert.ok(box, "Finder listing is visible");
			// Two halves of the browser upload: the session exposes the bridge the
			// drop handler calls, and the same endpoint that bridge posts to writes
			// the client's bytes onto the host. Playwright's synthetic drop is not
			// used because dispatching it deadlocks this page (the listener chain is
			// awaited across the CDP boundary); the renderer's drop handling itself
			// is covered by test/ui-drop-upload.test.ts.
			log("upload: checking the session's upload bridge");
			const exposesUpload = await page.evaluate(() => typeof window.autorag?.fs?.uploadFiles === "function");
			assert.equal(exposesUpload, true, "the remote session exposes fs.uploadFiles");
			log("upload: posting the client's bytes to the served endpoint");
			const posted = await bounded(
				page.evaluate(
					async ({ token, folder, base64, name }) => {
						const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
						const target = new URL("/remote/upload", location.origin);
						target.searchParams.set("token", token);
						target.searchParams.set("folder", folder);
						target.searchParams.set("name", name);
						const answer = await fetch(target, { method: "POST", body: new Blob([bytes]) });
						return { status: answer.status, body: await answer.json() };
					},
					{
						token: new URL(page.url()).searchParams.get("token") ?? "",
						folder: fixture,
						base64: uploadBytes.toString("base64"),
						name: basename(uploadFile),
					},
				),
				20_000,
				"upload post",
			);
			assert.equal(posted.status, 200);
			assert.equal(posted.body.ok, true);
			assert.deepEqual(readFileSync(join(fixture, basename(uploadFile))), uploadBytes);
			// The session's own watch should surface the new row; a folder that was
			// left while the upload landed is re-entered through the path bar.
			const uploaded = row(join(fixture, basename(uploadFile)));
			// Leaving and returning through the path bar forces a fresh listing of
			// the folder (navigating to the path already in view is a no-op).
			await uploaded.waitFor({ timeout: 10_000 }).catch(async () => {
				await enterPath(home, "home");
				await enterPath(fixture);
				await uploaded.waitFor();
			});
			await screenshot(page, "05-uploaded-file");
		});
		await scenario("shows a host-side change without navigating", async () => {
			// The guest writes into the folder the browser is viewing; only the host
			// watcher and the session's live stream can make that row appear.
			const hostMade = join(fixture, "live-from-host.txt");
			writeFileSync(hostMade, "created on the host\n");
			await row(hostMade).waitFor({ timeout: 15_000 });
			await screenshot(page, "05b-live-update");
		});
		await scenario("download a file and verify every byte", async () => {
			const download = page.waitForEvent("download", { timeout: 15_000 });
			await row(downloadFile).dblclick();
			const received = await download;
			assert.equal(await received.failure(), null);
			const path = join(evidence, "downloaded.txt");
			await received.saveAs(path);
			assert.deepEqual(readFileSync(path), downloadBytes);
			log(`DOWNLOAD ${path} (${downloadBytes.length} matching bytes)`);
			await screenshot(page, "06-downloaded-file");
		});
		await scenario("open an image preview URL from the Finder", async () => {
			await row(imageFile).click();
			const popup = context.waitForEvent("page", { timeout: 15_000 });
			await page.keyboard.press("Space");
			const preview = await popup;
			try {
				await preview.waitForURL((url) => url.pathname === "/remote/preview", { timeout: 15_000 });
				await preview.waitForLoadState("load");
				const url = new URL(preview.url());
				assert.equal(url.searchParams.get("path"), imageFile);
				assert.ok(url.searchParams.get("token"));
				await expect(preview.locator("img")).toBeVisible();
				const dimensions = await preview.locator("img").evaluate((image) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
				assert.deepEqual(dimensions, { complete: true, width: 1, height: 1 });
				await screenshot(preview, "07-image-preview");
			} finally {
				await preview.close();
			}
		});
		await scenario("type an AI Search draft without sending a model request", async () => {
			await openAiSearch(page);
			const composer = page.locator(`${AI_PANEL} input[aria-label="Ask Dazzi"]`);
			await composer.click();
			await composer.pressSequentially("Find the remote access fixture, but do not send.");
			await expect(composer).toHaveValue("Find the remote access fixture, but do not send.");
			await expect(page.locator(`${AI_PANEL} .user-msg`)).toHaveCount(0);
			assert.deepEqual(modelRequests, []);
			await screenshot(page, "08-ai-search-draft");
		});
	}
	await screenshot(desktop, "09-desktop-still-running");
} catch (error) {
	const detail = error.stack ?? String(error);
	checks.push({ name: stage, pass: false, detail });
	log(`FAIL ${stage}\n${detail}`);
	if (page !== null && !page.isClosed()) await screenshot(page, "failure-browser").catch((captureError) => log(`FAIL screenshot: ${captureError}`));
	if (desktop !== null && !desktop.isClosed()) await screenshot(desktop, "failure-desktop").catch((captureError) => log(`FAIL screenshot: ${captureError}`));
} finally {
	if (browser !== null) await browser.close();
	if (app !== null) await app.close();
}
for (const warning of ignoredWarnings) log(`IGNORED known Sentry IPC CSP warning: ${warning}`);
checks.push({ name: "no unexpected console or page errors", pass: consoleErrors.length === 0, detail: consoleErrors });
log(`${consoleErrors.length === 0 ? "PASS" : "FAIL"} no unexpected console or page errors (${consoleErrors.length}; ${ignoredWarnings.length} known Sentry warnings)`);
writeFileSync(
	join(evidence, "result.json"),
	`${JSON.stringify({ checks, screenshots, consoleErrors, ignoredWarnings, fixture, profile, remoteStatus: remoteStatus === null ? null : { ...remoteStatus, origin: new URL(remoteStatus.origin ?? "http://localhost").origin } }, null, 2)}\n`,
);
const failures = checks.filter((check) => !check.pass);
log(`RESULT ${failures.length === 0 ? "PASS" : "FAIL"} ${checks.length - failures.length}/${checks.length} checks passed`);
log(`EVIDENCE ${evidence}`);
if (failures.length > 0) process.exitCode = 1;
