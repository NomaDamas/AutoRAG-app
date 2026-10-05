/**
 * `make setup` entry point: turn a fresh clone into a checkout where
 * `bun run dev`, `make run`, `bun run test`, and `bun run build` all work.
 *
 * A fresh clone has no `node_modules`, so `make run` used to fail inside the
 * `predev` hook with `[ensure-electron] node_modules/electron is not
 * installed.` (and, before that, a missing `electron-vite`). This script
 * closes that gap:
 *
 *   1. verifies the toolchain the app requires (bun, Node 24+, dupey),
 *   2. runs `bun install --frozen-lockfile`, whose `preinstall` clones and
 *      builds `.upstream/autorag` and whose `postinstall` downloads the
 *      Electron binary,
 *   3. re-checks the Electron binary so an existing checkout self-heals,
 *   4. prints the next commands. The install's sync prints the exact upstream
 *      HEAD that the app resolves against.
 *
 * `--ensure` is the lightweight form `make run` uses as a preflight: it only
 * installs when `node_modules` is missing and otherwise stays a fast no-op, so
 * `make run` works from a fresh clone without paying for a full install on
 * every launch. Both forms are idempotent.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MIN_NODE_MAJOR = 24;
const ensureOnly = process.argv.includes("--ensure");

const die = (lines) => {
	process.stderr.write(`${lines.join("\n")}\n`);
	process.exit(1);
};

const probe = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) return { ok: false, detail: result.error.message };
	if (result.status !== 0) return { ok: false, detail: (result.stderr || "").trim() || `${command} exited ${result.status}` };
	return { ok: true, detail: (result.stdout || "").trim() };
};

const run = (command, args) => {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
};

const depsInstalled = () => existsSync(join(root, "node_modules", "electron-vite", "package.json"));

const checkToolchain = () => {
	const bun = probe("bun", ["--version"]);
	if (!bun.ok) {
		die([
			"[setup] bun is required but was not found on PATH.",
			"  Install: https://bun.sh",
			`  Detail: ${bun.detail}`,
			"",
		]);
	}
	process.stdout.write(`[setup] bun ${bun.detail}\n`);

	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
		die([
			`[setup] Node.js ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}).`,
			"  The package scripts run through `node`, so the app cannot build or start on an older runtime.",
			"  Install: https://nodejs.org",
			"",
		]);
	}
	process.stdout.write(`[setup] node ${process.versions.node}\n`);

	const dupey = probe("dupey", ["--version"]);
	if (!dupey.ok) {
		if (process.env.AUTORAG_SKIP_DUPEY_CHECK === "1") {
			process.stdout.write("[setup] dupey missing (AUTORAG_SKIP_DUPEY_CHECK=1: continuing).\n");
		} else {
			die([
				"[setup] The dupey CLI is required by the Dazzi desktop app.",
				`  Detail: ${dupey.detail}`,
				"  Install: cargo install dupey --locked   (Rust toolchain: https://rustup.rs)",
				"  Set AUTORAG_SKIP_DUPEY_CHECK=1 only for an intentional degraded run.",
				"",
			]);
		}
	} else {
		process.stdout.write(`[setup] ${dupey.detail}\n`);
	}
	process.stdout.write("\n");
};

const install = () => run("bun", ["install", "--frozen-lockfile"]);

const ensureElectron = () => run("node", [join(root, "scripts", "ensure-electron.mjs")]);

if (!ensureOnly) checkToolchain();

if (!depsInstalled()) {
	process.stdout.write("[setup] node_modules is missing; installing dependencies.\n");
	install();
} else {
	process.stdout.write("[setup] dependencies already installed.\n");
}

ensureElectron();

process.stdout.write(
	[
		"",
		"[setup] Ready. Next commands:",
		"  make run            # dev app on free ports with debugging enabled",
		"  bun run test        # unit tests",
		"  bun run typecheck   # type checking",
		"  bun run build       # production build",
		"",
	].join("\n"),
);
