/**
 * Live E2E — the sidebar update control against a real packaged, Developer-ID-signed Dazzi.app updating
 * itself through electron-updater and Squirrel.Mac from a local HTTP feed.
 *
 *   node scripts/manual-qa/run-qa-finder-app-update.mjs <path/to/Dazzi.app>
 *   QA_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"   (default: the first Developer ID in the keychain)
 *
 * The copy gets its own CFBundleIdentifier: Squirrel.Mac's ShipIt keeps its state per bundle id
 * (~/Library/Caches/<id>.ShipIt), so a copy sharing `com.autorag.app` would collide with an installed Dazzi's
 * own pending update.
 *
 * macOS only, and not part of run-all: it needs a packaged build (`electron-builder --mac dir`, signed) and
 * ~10 GB of scratch space. Squirrel.Mac refuses to install over an ad-hoc signed app, so the build must carry
 * a real identity; the lane re-signs its copies with the same identity.
 *
 * What it does:
 *   - copies the app, writes `resources/app-update.yml` pointing at a local feed, and re-signs the copy;
 *   - builds a payload: the same app at version 0.1.1 (Info.plist + package.json), re-signed, zipped;
 *   - serves `latest/latest-mac.yml` + the zip over HTTP (Range supported) from a temp directory;
 *   - launches the copy with "auto-install updates" off and checks the footer button through the states
 *     unsupported-free idle (feed says 0.1.0: disabled, not emphasised) → available (feed says 0.1.1: emphasised,
 *     enabled) → click → downloading → ready → click → the app quits, Squirrel installs, and the relaunched
 *     bundle on disk is 0.1.1.
 *
 * Screenshots of the footer in each state land in the ignored `.omo/` tree.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-app-update");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout;
};

if (process.platform !== "darwin") {
	console.log("SKIP: macOS only");
	process.exit(0);
}
const sourceApp = process.argv[2];
if (sourceApp === undefined || !existsSync(join(sourceApp, "Contents/Info.plist"))) {
	console.error("usage: run-qa-finder-app-update.mjs <path/to/Dazzi.app>");
	process.exit(2);
}
const identity =
	process.env.QA_SIGN_IDENTITY ??
	/"(Developer ID Application: [^"]+)"/.exec(run("security", ["find-identity", "-v", "-p", "codesigning"]))?.[1];
if (identity === undefined) {
	console.error("no Developer ID Application identity in the keychain (Squirrel.Mac needs one)");
	process.exit(2);
}

const PORT = 47_000 + Math.floor(Math.random() * 1000);
const work = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-update-e2e-")));
const feedDir = join(work, "feed");
const userDataDir = join(work, "user-data");
const home = join(work, "home");
mkdirSync(join(feedDir, "latest"), { recursive: true });
mkdirSync(join(feedDir, "v0.1.1"), { recursive: true });
mkdirSync(join(userDataDir, "settings"), { recursive: true });
mkdirSync(home, { recursive: true });
// "Install updates automatically" off: a found update waits for the click instead of downloading by itself.
writeFileSync(join(userDataDir, "settings", "settings-state.json"), JSON.stringify({ settings: { language: "en", autoInstallUpdates: false }, permissions: {} }));

const E2E_BUNDLE_ID = "com.autorag.app.updatee2e";
const entitlements = join(ROOT, "build/entitlements.mac.plist");
const sign = (app) => run("codesign", ["--force", "--options", "runtime", "--entitlements", entitlements, "-s", identity, app]);
const plistSet = (app, key, value) => run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, join(app, "Contents/Info.plist")]);
const bundleVersion = (app) => run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")]).trim();

const requests = [];
const server = createServer((request, response) => {
	const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
	const file = join(feedDir, path);
	requests.push(`${request.method} ${path}${request.headers.range === undefined ? "" : ` [${request.headers.range}]`}`);
	if (!file.startsWith(feedDir) || !existsSync(file) || !statSync(file).isFile()) {
		response.writeHead(404).end();
		return;
	}
	const size = statSync(file).size;
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
	response.setHeader("Accept-Ranges", "bytes");
	response.setHeader("Cache-Control", "no-cache");
	if (range === null) {
		response.writeHead(200, { "Content-Length": size });
		if (request.method === "HEAD") response.end();
		else createReadStream(file).pipe(response);
		return;
	}
	const start = Number(range[1]);
	const end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
	response.writeHead(206, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
	createReadStream(file, { start, end }).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const feedYml = (version, zip) => {
	const bytes = readFileSync(zip);
	const sha512 = createHash("sha512").update(bytes).digest("base64");
	const name = `../v${version}/Dazzi-${version}-arm64.zip`;
	return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-28T00:00:00.000Z'\n`;
};

const installedApp = join(work, "run/Dazzi.app");
const FOOTER = ".side-footer";
const UPDATE = `${FOOTER} [data-action="app-update"]`;
let app;
try {
	console.log(`work dir ${work}, feed http://127.0.0.1:${PORT}/latest/`);
	mkdirSync(join(work, "run"), { recursive: true });
	run("ditto", [sourceApp, installedApp]);
	const currentVersion = bundleVersion(installedApp);
	plistSet(installedApp, "CFBundleIdentifier", E2E_BUNDLE_ID);
	writeFileSync(join(installedApp, "Contents/Resources/app-update.yml"), `provider: generic\nurl: http://127.0.0.1:${PORT}/latest/\nuseMultipleRangeRequest: false\nupdaterCacheDirName: dazzi-update-e2e\n`);
	sign(installedApp);
	check("the signed copy carries a Team ID (Squirrel.Mac requirement)", /TeamIdentifier=(?!not set)\S+/.test(spawnSync("codesign", ["-dv", installedApp], { encoding: "utf8" }).stderr));

	// Payload: the same app, one version up.
	const payloadApp = join(work, "payload/Dazzi.app");
	mkdirSync(join(work, "payload"), { recursive: true });
	run("ditto", [installedApp, payloadApp]);
	plistSet(payloadApp, "CFBundleShortVersionString", "0.1.1");
	plistSet(payloadApp, "CFBundleVersion", "0.1.1");
	// (the payload is a copy of the re-identified app, so it already carries E2E_BUNDLE_ID)
	const pkgPath = join(payloadApp, "Contents/Resources/app/package.json");
	writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace(/"version":\s*"[^"]+"/, '"version": "0.1.1"'));
	sign(payloadApp);
	const zip = join(feedDir, "v0.1.1/Dazzi-0.1.1-arm64.zip");
	run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payloadApp, zip]);
	console.log(`payload ${statSync(zip).size} bytes; installed copy is ${currentVersion}`);

	// Feed starts at the running version: nothing to update.
	writeFileSync(join(feedDir, "latest/latest-mac.yml"), feedYml(currentVersion, zip));

	app = await _electron.launch({ executablePath: join(installedApp, "Contents/MacOS/Dazzi"), args: [`--user-data-dir=${userDataDir}`], env: { ...process.env, HOME: home, AUTORAG_SKIP_ONBOARDING: "1" } });
	app.process().stderr?.on("data", (chunk) => {
		for (const line of String(chunk).split("\n")) if (/app-update|Squirrel|updater|ShipIt/i.test(line)) console.log(`[app stderr] ${line.slice(0, 300)}`);
	});
	let page;
	for (let i = 0; i < 100 && page === undefined; i += 1) {
		page = (app.windows()).find((candidate) => candidate.url().endsWith("/index.html"));
		if (page === undefined) await sleep(300);
	}
	if (page === undefined) throw new Error("Finder window did not open");
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(UPDATE, { timeout: 60_000 });
	const state = () => page.locator(UPDATE).getAttribute("data-state");
	const waitState = async (wanted, timeout) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if ((await state()) === wanted) return true;
			await sleep(250);
		}
		return false;
	};
	const shot = (name) => page.locator(FOOTER).screenshot({ path: join(EVIDENCE, `${name}.png`) });

	// A user-initiated check (what Settings → 앱 업데이트 and the app menu do) against a feed with nothing new.
	const first = await page.evaluate(() => window.autorag.appUpdate.check());
	check("the packaged app reports install mode (not notify, not unsupported)", first.mode === "install", JSON.stringify(first));
	check("feed at the running version → idle, checked", first.state.kind === "idle" && first.state.checkedAt !== null, JSON.stringify(first.state));
	check("up to date: the footer button is a disabled download icon", (await state()) === "idle" && (await page.locator(UPDATE).isDisabled()), await page.locator(UPDATE).getAttribute("title"));
	check("up to date: the button is not emphasised", (await page.locator(`${UPDATE} [data-emphasis="true"]`).count()) === 0);
	await shot("01-up-to-date");

	// The feed publishes 0.1.1.
	writeFileSync(join(feedDir, "latest/latest-mac.yml"), feedYml("0.1.1", zip));
	await page.evaluate(() => window.autorag.appUpdate.check());
	check("new version on the feed → the button becomes available", await waitState("available", 30_000), `state=${await state()}`);
	check("available: enabled and emphasised", !(await page.locator(UPDATE).isDisabled()) && (await page.locator(`${UPDATE} [data-emphasis="true"]`).count()) === 1);
	check("available: tooltip names the new version", /0\.1\.1/.test((await page.locator(UPDATE).getAttribute("title")) ?? ""), await page.locator(UPDATE).getAttribute("title"));
	await shot("02-available");

	// Click → real download through the feed.
	await page.locator(UPDATE).click();
	check("click starts the download", await waitState("downloading", 20_000) || (await state()) === "ready", `state=${await state()}`);
	if ((await state()) === "downloading") {
		check("downloading: button ignores clicks and shows progress", (await page.locator(UPDATE).getAttribute("aria-disabled")) === "true" && /%/.test((await page.locator(UPDATE).getAttribute("title")) ?? ""), await page.locator(UPDATE).getAttribute("title"));
		await shot("03-downloading");
	}
	check("the update downloads and is staged by Squirrel.Mac", await waitState("ready", Number(process.env.QA_READY_TIMEOUT_MS ?? 240_000)), `state=${await state()}`);
	check("the feed server served the zip", requests.some((line) => line.includes("/v0.1.1/Dazzi-0.1.1-arm64.zip")), requests.join(" | "));
	check("ready: tooltip offers the restart", /restart/i.test((await page.locator(UPDATE).getAttribute("title")) ?? ""), await page.locator(UPDATE).getAttribute("title"));
	await shot("04-ready");

	// Click → quit, Squirrel swaps the bundle, the new version relaunches.
	const closed = new Promise((resolve) => app.process().once("exit", resolve));
	await page.locator(UPDATE).click();
	await Promise.race([closed, sleep(60_000)]);
	// ShipIt swaps the bundle after the app quits; validating and copying a multi-GB bundle takes minutes.
	let installed = bundleVersion(installedApp);
	for (let i = 0; i < 900 && installed !== "0.1.1"; i += 1) {
		await sleep(1000);
		installed = bundleVersion(installedApp);
	}
	check("after the click the app on disk is the new version", installed === "0.1.1", `CFBundleShortVersionString=${installed}`);
	let relaunched = false;
	for (let i = 0; i < 120 && !relaunched; i += 1) {
		relaunched = spawnSync("pgrep", ["-f", `${installedApp}/Contents/MacOS/Dazzi`]).status === 0;
		if (!relaunched) await sleep(1000);
	}
	check("the updated app relaunched", relaunched);
	const shipIt = join(process.env.HOME ?? "", "Library/Caches", `${E2E_BUNDLE_ID}.ShipIt`);
	if (installed !== "0.1.1" && existsSync(join(shipIt, "ShipIt_stderr.log"))) console.log(`ShipIt log:\n${readFileSync(join(shipIt, "ShipIt_stderr.log"), "utf8").split("\n").slice(-40).join("\n")}`);
	spawnSync("rm", ["-rf", shipIt]);
	const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", installedApp], { encoding: "utf8" });
	check("the installed bundle's signature verifies", verify.status === 0, verify.stderr.trim());
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 800)}`);
	failures.push("harness error");
} finally {
	await app?.close().catch(() => undefined);
	spawnSync("pkill", ["-f", `${installedApp}/Contents/MacOS/Dazzi`]);
	server.close();
	console.log(`feed requests:\n${requests.join("\n")}`);
	if (process.env.QA_KEEP_WORK !== "1") rmSync(work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
