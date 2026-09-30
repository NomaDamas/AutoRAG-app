/**
 * Ensure the Electron binary is downloaded before the app runs.
 *
 * Electron 44 dropped its `postinstall` hook and now downloads `dist/` lazily
 * from `require("electron")`. `electron-vite` does not go through that entry
 * point: it reads `node_modules/electron/path.txt` directly and throws
 * `Error: Electron uninstall` when the file is missing, so a plain
 * `bun install` leaves `make run` broken.
 *
 * Runs as `postinstall` (so an install is complete) and as part of `predev`
 * (so an existing checkout self-heals the next time the app is launched).
 * `node_modules/electron/install.js` is idempotent: it exits 0 when the
 * matching `dist/version` and `path.txt` are already in place.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const electronDir = join(root, "node_modules", "electron");
const installer = join(electronDir, "install.js");

if (!existsSync(installer)) {
	process.stderr.write(
		[
			"[ensure-electron] node_modules/electron is not installed.",
			"  Run `bun install --frozen-lockfile` from the repository root first.",
			"",
		].join("\n"),
	);
	process.exit(1);
}

const isInstalled = () => {
	try {
		const { version } = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"));
		const distVersion = readFileSync(join(electronDir, "dist", "version"), "utf8").replace(/^v/, "");
		const pathFile = readFileSync(join(electronDir, "path.txt"), "utf8");
		return distVersion === version && existsSync(join(electronDir, "dist", pathFile));
	} catch {
		return false;
	}
};

if (isInstalled()) {
	process.stdout.write("[ensure-electron] Electron binary present.\n");
	process.exit(0);
}

process.stdout.write("[ensure-electron] Electron binary missing; downloading (Electron 44 dropped its postinstall hook).\n");
const result = spawnSync(process.execPath, [installer], { cwd: root, stdio: "inherit" });

if (result.status !== 0) {
	process.stderr.write(
		[
			"[ensure-electron] Failed to download the Electron binary.",
			"  Retry manually: node node_modules/electron/install.js",
			"",
		].join("\n"),
	);
	process.exit(result.status ?? 1);
}
