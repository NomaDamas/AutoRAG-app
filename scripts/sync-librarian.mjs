import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".upstream", "autorag");
const remote = "https://github.com/Marker-Inc-Korea/AutoRAG.git";

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const hasClone = existsSync(join(upstream, ".git"));
const previous = hasClone
	? spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).stdout.trim()
	: "";
if (!hasClone) {
	run("git", ["clone", "--depth", "1", "--branch", "main", remote, upstream]);
} else {
	run("git", ["fetch", "origin", "main"], upstream);
	run("git", ["merge", "--ff-only", "FETCH_HEAD"], upstream);
}
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" });
if (head.status !== 0) process.exit(head.status ?? 1);
const revision = head.stdout.trim();

if (previous !== revision || !existsSync(join(upstream, "dist", "index.js")) ||
	!existsSync(join(upstream, "dist", "index.d.ts")) || !existsSync(join(upstream, "node_modules"))) {
	run("bun", ["install", "--ignore-scripts"], upstream);
	run("bun", ["run", "build"], upstream);
}
console.log(`[sync-librarian] origin/main ${revision}`);
