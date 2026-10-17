/**
 * Install the built installer the way a user would, then prove the install works.
 *
 *   node scripts/release/smoke-installed.mjs [path/to/Dazzi.dmg|Dazzi-Setup.exe]
 *
 * Without an argument the newest installer in dist/ is used. Steps:
 *   1. install: mount the .dmg and copy the app, or run the NSIS installer silently
 *   2. run scripts/release/verify-bundle.mjs against the INSTALLED tools directory
 *   3. launch the installed app on a throwaway profile and check, from inside
 *      its main process, that the bundled tools lead PATH and that the native
 *      embedding model was seeded into the MinSync model cache
 *   4. uninstall
 * The profile, HOME and AUTORAG_HOME are temporary; nothing of the real user is read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { ROOT, log, run } from "./lib.mjs";

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

/**
 * Install budget: the time from running the installer to a usable app, download excluded. The first
 * number is the installer itself; the second is how long after launch the native embedding model
 * is in place (the app copies it in the background and can already be used meanwhile).
 */
const BUDGET_SECONDS = Number(process.env.AUTORAG_INSTALL_BUDGET_SECONDS ?? 300);
const installStarted = Date.now();

let installSeconds = 0;
let appRoot; // directory holding the executable
let resources; // <resources>
let executable;
let uninstall = () => undefined;

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
	expect(existsSync(join(resources, "seed", "manifest.json")), "seed installed");

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

	// 2. The installed tools, on a bare PATH.
	const verify = spawnSync(process.execPath, [join(ROOT, "scripts", "release", "verify-bundle.mjs"), join(resources, "tools"), "--seed", join(resources, "seed")], { stdio: "inherit" });
	expect(verify.status === 0, "installed tools pass verify-bundle");

	// 3. Launch the installed app on a throwaway profile.
	const home = join(work, "home");
	const autoragHome = join(home, ".autorag");
	const localAppData = join(home, "AppData", "Local");
	const profile = join(work, "profile");
	mkdirSync(home, { recursive: true });
	const launched = Date.now();
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

		// The seed copy runs in the background after launch.
		const cacheRoot = win ? join(localAppData, "minsync", "models") : join(home, ".cache", "minsync", "models");
		const model = join(
			cacheRoot,
			"models--Qwen--Qwen3-Embedding-0.6B",
			"snapshots",
			"97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
			"model.safetensors",
		);
		const deadline = Date.now() + 180_000;
		while (!existsSync(model) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
		expect(existsSync(model), "native embedding model seeded into the MinSync cache", model);
		const seedSeconds = (Date.now() - launched) / 1000;
		const totalSeconds = installSeconds + seedSeconds;
		process.stdout.write(`time install=${installSeconds.toFixed(0)}s  launch->model seeded=${seedSeconds.toFixed(0)}s  total=${totalSeconds.toFixed(0)}s  budget=${BUDGET_SECONDS}s\n`);
		expect(totalSeconds <= BUDGET_SECONDS, `install + first-launch seeding within ${BUDGET_SECONDS}s`, `${totalSeconds.toFixed(0)}s`);
		writeFileSync(join(outDir, "installed-app.json"), `${JSON.stringify(inside, null, 2)}\n`);
	} finally {
		await app.close().catch(() => undefined);
	}
} finally {
	uninstall();
	rmSync(work, { recursive: true, force: true });
}

process.stdout.write(failures.length === 0 ? "\ninstalled app OK\n" : `\n${failures.length} check(s) FAILED: ${failures.join("; ")}\n`);
process.exit(failures.length === 0 ? 0 : 1);
