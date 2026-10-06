import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".upstream", "autorag");
const installed = join(root, "node_modules", "@autorag", "librarian");
const remote = "https://github.com/Marker-Inc-Korea/AutoRAG.git";

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function headRevision() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" });
	if (result.status !== 0) process.exit(result.status ?? 1);
	return result.stdout.trim();
}

const hadInstalled = existsSync(installed);
const hasClone = existsSync(join(upstream, ".git"));
const previous = hasClone ? headRevision() : "";
if (!hasClone) {
	run("git", ["clone", "--depth", "1", "--branch", "main", remote, upstream]);
} else {
	run("git", ["fetch", "origin", "main"], upstream);
	run("git", ["merge", "--ff-only", "FETCH_HEAD"], upstream);
}
const revision = headRevision();

if (previous !== revision || !existsSync(join(upstream, "dist", "index.js")) ||
	!existsSync(join(upstream, "dist", "index.d.ts")) || !existsSync(join(upstream, "node_modules"))) {
	run("bun", ["install", "--ignore-scripts"], upstream);
	run("bun", ["run", "build"], upstream);
}

// The `file:` dependency installs a copy, not a symlink: rebuilding upstream
// leaves node_modules/@autorag/librarian stale until the root install re-runs.
// Compare dist mtimes so a rebuilt-but-not-reinstalled dependency is refreshed.
function installedIsStale() {
	const upstreamDist = join(upstream, "dist", "index.js");
	const installedDist = join(installed, "dist", "index.js");
	if (!existsSync(installedDist)) return true;
	try {
		return statSync(installedDist).mtimeMs < statSync(upstreamDist).mtimeMs;
	} catch {
		return true;
	}
}

if (hadInstalled && installedIsStale()) {
	run("bun", ["install", "--ignore-scripts"]);
}

console.log(`[sync-librarian] origin/main ${revision}`);
