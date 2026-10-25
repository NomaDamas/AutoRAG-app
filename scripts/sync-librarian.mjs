import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, ".upstream", "autorag");
// What the app installs: the librarian as it would be published, without the clone's node_modules.
const staged = join(root, ".upstream", "librarian-package");
const installed = join(root, "node_modules", "@autorag", "librarian");
const remote = "https://github.com/Marker-Inc-Korea/AutoRAG.git";
// A release tag, or a full commit SHA while the librarian has no tag that carries what the app needs.
// v2.12.0 adds the permission gate (ask/auto/full), `ask_user`, and `convert_files` (Filee conversion: `convertWithFilee`, `resolveFileeOptions`, the route matrix) on top of v2.11.1
// (file automations, `autorag automate`, `@autorag/librarian/profiles`), which the app's 자동화 view reads and the agent edits.
const librarianRef = "v2.12.0";

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
	mkdirSync(upstream, { recursive: true });
	run("git", ["init", "--quiet"], upstream);
	run("git", ["remote", "add", "origin", remote], upstream);
}
// `git fetch origin <ref>` takes a tag name and a commit SHA alike (GitHub serves any reachable SHA).
run("git", ["fetch", "--depth", "1", "origin", librarianRef], upstream);
run("git", ["checkout", "--detach", "FETCH_HEAD"], upstream);

const revision = headRevision();

if (previous !== revision || !existsSync(join(upstream, "dist", "index.js")) ||
	!existsSync(join(upstream, "dist", "index.d.ts")) || !existsSync(join(upstream, "node_modules"))) {
	run("bun", ["install", "--ignore-scripts"], upstream);
	run("bun", ["run", "build"], upstream);
}

// A `file:` directory dependency is installed as a copy of the whole directory, node_modules
// included. Pointing it at the build clone gave node_modules/@autorag/librarian its own nested
// node_modules with a second @earendil-works/pi-*: two module instances, two provider
// registries (AutoRAG-app#225). So the app installs a staging directory holding only what
// `npm publish` would ship, and the package manager resolves the librarian's dependencies
// into the app's one node_modules, where pi is shared.
function stagedIsStale() {
	const upstreamDist = join(upstream, "dist", "index.js");
	const stagedDist = join(staged, "dist", "index.js");
	if (!existsSync(stagedDist) || !existsSync(join(staged, "package.json"))) return true;
	return statSync(stagedDist).mtimeMs < statSync(upstreamDist).mtimeMs - 1;
}

function stagePackage() {
	const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(staged, { recursive: true });
	for (const entry of [...manifest.files, "LICENSE"]) {
		const from = join(upstream, entry);
		if (existsSync(from)) cpSync(from, join(staged, entry), { recursive: true, preserveTimestamps: true });
	}
	// Build and test tooling is not part of the package; the installer must not pull it in.
	const { devDependencies: _devDependencies, scripts: _scripts, ...published } = manifest;
	writeFileSync(join(staged, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
}

if (stagedIsStale()) stagePackage();

// The installed dependency is a copy, not a symlink: restaging leaves
// node_modules/@autorag/librarian stale until the root install re-runs.
// Compare dist mtimes so a restaged-but-not-reinstalled dependency is refreshed.
function installedIsStale() {
	const stagedDist = join(staged, "dist", "index.js");
	const installedDist = join(installed, "dist", "index.js");
	if (!existsSync(installedDist)) return true;
	try {
		return statSync(installedDist).mtimeMs < statSync(stagedDist).mtimeMs;
	} catch {
		return true;
	}
}

if (hadInstalled && installedIsStale()) {
	run("bun", ["install", "--ignore-scripts"]);
}

console.log(`[sync-librarian] ${librarianRef} ${revision}`);
