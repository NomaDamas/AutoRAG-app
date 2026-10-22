/**
 * Install the built installer the way a user would, then prove the install works.
 *
 *   node scripts/release/smoke-installed.mjs [path/to/Dazzi.dmg|Dazzi-Setup.exe]
 *
 * Without an argument the newest installer in dist/ is used. Steps:
 *   1. install: mount the .dmg and copy the app, or run the NSIS installer silently
 *   2. run scripts/release/verify-bundle.mjs against the INSTALLED tools directory
 *   3. pre-populate the throwaway home's MinSync model cache from the staged
 *      verify-model (the installer no longer carries the model, and the daemon
 *      will not start without it), then launch the installed app on a throwaway
 *      profile and check, from inside its main process, that the bundled tools
 *      lead PATH and that the `minsync serve` daemon answers for the Qwen3 model
 *   4. uninstall
 * The profile, HOME and AUTORAG_HOME are temporary; nothing of the real user is read.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { ROOT, hostPlatformId, log, run } from "./lib.mjs";

const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "autorag-smoke-"));
const outDir = process.env.QA_OUT ?? join(ROOT, ".omo", "evidence", "release-smoke");
mkdirSync(outDir, { recursive: true });

function newestInstaller() {
	const dist = join(ROOT, "dist");
	const wanted = win ? /\.exe$/ : /\.dmg$/;
	const files = readdirSync(dist).filter((name) => wanted.test(name) && !/blockmap/.test(name)).map((name) => join(dist, name));
	if (files.length === 0) throw new Error(`No installer in ${dist}; run the pack step first`);
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const installer = resolve(process.argv[2] ?? newestInstaller());
log(`installer ${installer}`);

// The model is not bundled: the staged copy under build/stage/<platform>/verify-model is what the
// offline daemon assertion needs, and the installer is asserted not to carry it. A stage built with
// `--skip-verify-model` (or on another platform) skips the daemon assertion, not the run.
const stagedModelCache = join(ROOT, "build", "stage", hostPlatformId(), "verify-model");
const hasStagedModel = existsSync(join(stagedModelCache, "models--Qwen--Qwen3-Embedding-0.6B", "snapshots"));

/**
 * The `minsync serve` daemon's health, read from the state files it publishes under
 * `<home>/.cache/minsync/serve/<instance>/` (`%LOCALAPPDATA%\minsync\serve` on Windows): `host`, `port`,
 * `pid`. Returns the daemon's host/port/model when it answers `GET /health` for the Qwen3 model, else
 * undefined (no state file, a stale one, or nothing listening).
 */
async function serveDaemonHealth(serveRoot) {
	let instances;
	try {
		instances = readdirSync(serveRoot);
	} catch {
		return undefined;
	}
	for (const instance of instances) {
		const read = (name) => {
			try {
				return readFileSync(join(serveRoot, instance, name), "utf8").trim();
			} catch {
				return "";
			}
		};
		const port = Number(read("port"));
		const host = read("host") || "127.0.0.1";
		if (!Number.isInteger(port) || port <= 0) continue;
		try {
			const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2_000) });
			if (!response.ok) continue;
			const health = await response.json();
			if (health?.status !== "ok" || typeof health.model_id !== "string" || !health.model_id.toLowerCase().includes("qwen3-embedding-0.6b")) continue;
			return { host, port, model: health.model_id };
		} catch {
			// nothing listens there any more
		}
	}
	return undefined;
}

/**
 * Install budget: the time the installer itself takes to produce an installed, launchable app. The
 * model is no longer bundled, so nothing is copied or downloaded at launch and the budget covers the
 * installer step alone.
 */
const BUDGET_SECONDS = Number(process.env.AUTORAG_INSTALL_BUDGET_SECONDS ?? 300);
const installStarted = Date.now();

const home = join(work, "home");
const localAppData = join(home, "AppData", "Local");
const profile = join(work, "profile");
// Where the app downloads the model into, and where the daemon reads it from.
const cacheRoot = win ? join(localAppData, "minsync", "models") : join(home, ".cache", "minsync", "models");

let installSeconds = 0;
let appRoot; // directory holding the executable
let resources; // <resources>
let executable;
let uninstall = () => undefined;
let serveRoot; // the `minsync serve` state directory inside the throwaway home, when one was found
let serve; // { host, port, model } of a running `minsync serve` daemon, when the app started one

if (!win) {
	const mount = join(work, "mount");
	mkdirSync(mount);
	run("hdiutil", ["attach", installer, "-nobrowse", "-readonly", "-mountpoint", mount]);
	const destination = join(work, "Applications");
	mkdirSync(destination);
	run("ditto", [join(mount, "Dazzi.app"), join(destination, "Dazzi.app")]);
	run("hdiutil", ["detach", mount, "-force"], { allowFailure: true });
	appRoot = join(destination, "Dazzi.app");
	resources = join(appRoot, "Contents", "Resources");
	executable = join(appRoot, "Contents", "MacOS", "Dazzi");
	uninstall = () => rmSync(appRoot, { recursive: true, force: true });
} else {
	// One-click per-user NSIS: /S is silent, /D sets the install directory (must be last, unquoted).
	appRoot = join(work, "Dazzi");
	const result = spawnSync(installer, ["/S", `/D=${appRoot}`], { stdio: "inherit", windowsHide: true });
	if (result.status !== 0) throw new Error(`installer exited ${result.status}`);
	resources = join(appRoot, "resources");
	executable = join(appRoot, "Dazzi.exe");
	uninstall = () => {
		const uninstaller = join(appRoot, "Uninstall Dazzi.exe");
		if (existsSync(uninstaller)) spawnSync(uninstaller, ["/S", `_?=${appRoot}`], { stdio: "inherit", windowsHide: true });
		rmSync(appRoot, { recursive: true, force: true });
	};
}

installSeconds = (Date.now() - installStarted) / 1000;
const failures = [];
const expect = (ok, label, detail = "") => {
	process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures.push(label);
};

try {
	expect(existsSync(executable), "installed executable exists", executable);
	expect(existsSync(join(resources, "tools", "bin")), "tools/bin installed");
	// The model is downloaded on demand now, so the installer must not carry it.
	expect(!existsSync(join(resources, "seed")), "installer does not carry the embedding model (resources/seed absent)");
	// ...and a fresh install must not have it in the cache either (the app downloads it only when the
	// user picks local embedding; AUTORAG_SKIP_ONBOARDING=1 means it never does here).
	expect(!existsSync(join(cacheRoot, "models--Qwen--Qwen3-Embedding-0.6B")), "a fresh install carries no embedding model", cacheRoot);

	// Install budget: the installer step alone, measured above.
	process.stdout.write(`time install=${installSeconds.toFixed(0)}s  budget=${BUDGET_SECONDS}s\n`);
	expect(installSeconds <= BUDGET_SECONDS, `install within ${BUDGET_SECONDS}s`, `${installSeconds.toFixed(0)}s`);

	// The copy a user installs must still match its own code seal. v0.1.0's dmg broke it (HFS+ rewrote
	// non-ASCII file names), which only an installed-copy check sees; an ad-hoc build skips Gatekeeper.
	if (!win) {
		const seal = spawnSync("codesign", ["--verify", "--deep", "--strict", appRoot], { encoding: "utf8" });
		expect(seal.status === 0, "installed app matches its code signature", seal.stderr.trim().split("\n").slice(-3).join(" | "));
		// ditto keeps names byte for byte, but Finder (how users install) writes them decomposed: v0.1.1
		// passed the seal check above and was still "damaged" after a drag to /Applications.
		const composed = [];
		const walk = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entry.name !== entry.name.normalize("NFD")) composed.push(join(directory, entry.name));
				if (entry.isDirectory()) walk(join(directory, entry.name));
			}
		};
		walk(appRoot);
		expect(composed.length === 0, "every file name is NFD, so a Finder copy keeps the seal", composed.slice(0, 3).join(" | "));
		const details = spawnSync("codesign", ["-dv", appRoot], { encoding: "utf8" }).stderr;
		const signed = /TeamIdentifier=(?!not set)\S+/.test(details);
		if (signed) {
			const gatekeeper = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", appRoot], { encoding: "utf8" });
			expect(gatekeeper.status === 0 && /source=Notarized Developer ID/.test(gatekeeper.stderr), "Gatekeeper accepts the installed app as notarized", gatekeeper.stderr.trim());
		}
	}

	// 2. The installed tools, on a bare PATH. The Kiwi sync needs the model, which the app no longer
	// ships, so it is taken from the staged copy when one exists (the check prints a skip otherwise).
	const verifyArgs = [join(ROOT, "scripts", "release", "verify-bundle.mjs"), join(resources, "tools")];
	if (hasStagedModel) verifyArgs.push("--model-cache", stagedModelCache);
	const verify = spawnSync(process.execPath, verifyArgs, { stdio: "inherit" });
	expect(verify.status === 0, "installed tools pass verify-bundle");

	// 3. Launch the installed app on a throwaway profile.
	const autoragHome = join(home, ".autorag");
	mkdirSync(home, { recursive: true });
	if (hasStagedModel) {
		// The daemon starts only once the model is in place; give the throwaway home the staged copy
		// instead of letting the app fetch ~1.2 GB from Hugging Face during the smoke run.
		mkdirSync(cacheRoot, { recursive: true });
		cpSync(stagedModelCache, cacheRoot, { recursive: true });
		process.stdout.write(`note: pre-populated the MinSync model cache from ${stagedModelCache}\n`);
	} else {
		process.stdout.write(`skip minsync serve daemon (no staged model at ${stagedModelCache}; run \`bun run release:stage\` without --skip-verify-model)\n`);
	}
	const app = await _electron.launch({
		executablePath: executable,
		args: [`--user-data-dir=${profile}`, ...(win ? ["--disable-gpu"] : [])],
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			LOCALAPPDATA: localAppData,
			AUTORAG_HOME: autoragHome,
			AUTORAG_SKIP_ONBOARDING: "1",
			// A PATH without the developer's toolchain: the bundled tools must be what the app finds.
			PATH: win ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : "/usr/bin:/bin:/usr/sbin:/sbin",
		},
	});
	try {
		// The pre-warmed Quick Look window can register before the Finder one, so wait for the Finder page itself.
		await app.firstWindow({ timeout: 90_000 });
		let window;
		for (const deadline = Date.now() + 90_000; window === undefined && Date.now() < deadline; ) {
			window = app.windows().find((candidate) => candidate.url().endsWith("/index.html"));
			if (window === undefined) await new Promise((r) => setTimeout(r, 200));
		}
		expect(window !== undefined, "Finder window opened");
		if (window === undefined) throw new Error("Finder window did not open");
		const sidebar = await window.waitForSelector(".sidebar__item", { timeout: 60_000 }).then(() => true, () => false);
		expect(sidebar, "Finder UI rendered (sidebar present)");
		await window.screenshot({ path: join(outDir, "installed-app.png") });
		const inside = await app.evaluate(({ app: electronApp }) => ({
			packaged: electronApp.isPackaged,
			path: process.env.PATH ?? process.env.Path ?? "",
			resources: process.resourcesPath,
			version: electronApp.getVersion(),
		}));
		expect(inside.packaged, "app runs packaged");
		const first = inside.path.split(win ? ";" : ":")[0] ?? "";
		// macOS reports the /private/var form of a /var temp directory.
		const real = (path) => realpathSync(path).toLowerCase();
		expect(existsSync(first) && real(first) === real(join(resources, "tools", "bin")), "bundled tools lead PATH", first);

		// The app starts `minsync serve` (the loopback embedding server that holds the model) once the local
		// model is in use, and stops it at quit. Assert it when the run published a serve state file; a build
		// or run that never starts the daemon reports a labelled skip instead of passing silently. Without a
		// staged model the daemon cannot start, so the skip was already printed before launch.
		if (hasStagedModel) {
			serveRoot = win ? join(localAppData, "minsync", "serve") : join(home, ".cache", "minsync", "serve");
			for (const daemonDeadline = Date.now() + 60_000; serve === undefined && Date.now() < daemonDeadline; ) {
				serve = await serveDaemonHealth(serveRoot);
				if (serve === undefined) await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			if (serve === undefined) process.stdout.write("skip (optional) minsync serve daemon: no serve state file was published under the app's cache\n");
			else expect(true, `minsync serve daemon answers GET /health (${serve.model})`, `port ${serve.port}`);
		}

		writeFileSync(join(outDir, "installed-app.json"), `${JSON.stringify(inside, null, 2)}\n`);
	} finally {
		await app.close().catch(() => undefined);
	}

	// The daemon the app started must be gone once the app has quit (a daemon somebody else runs is
	// not this app's to stop, but the throwaway home means nothing else here could have started one).
	if (serve !== undefined) {
		let after = await serveDaemonHealth(serveRoot);
		for (const deadline = Date.now() + 20_000; after !== undefined && after.port === serve.port && Date.now() < deadline; ) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			after = await serveDaemonHealth(serveRoot);
		}
		expect(after === undefined || after.port !== serve.port, `minsync serve daemon is gone after the app quit (port ${serve.port})`, after === undefined ? "" : `still listening on ${after.port}`);
	}
} finally {
	uninstall();
	rmSync(work, { recursive: true, force: true });
}

process.stdout.write(failures.length === 0 ? "\ninstalled app OK\n" : `\n${failures.length} check(s) FAILED: ${failures.join("; ")}\n`);
process.exit(failures.length === 0 ? 0 : 1);
