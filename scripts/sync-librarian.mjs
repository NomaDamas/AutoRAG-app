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
// v2.13.5 is the librarian on MinSync 0.6.0: SPLADE sparse retrieval (KURE-Sparse-nano) replaces BM25, Kiwi and
// `minsync init --language` are gone, and `minSync.embedder.id: "none"` builds a sparse-only index (AutoRAG#2080,
// #2081). It carries the required decision model (`jev.backend: "sllm"` makes the small chat LLM the decision model,
// AutoRAG#2091: `jev.fallback` is now a boolean and the sLLM's model is `jev.sllm.model`), opt-in reranking, parallel
// name search, SheetJS/CSV parsing, cloud placeholder handling, and the removal of the Spotlight and rclone datasources.
// Windows cloud-attribute reads quote paths with typographic apostrophes (AutoRAG#2086) and run PowerShell from env so
// stderr is UTF-8 instead of CP949 mojibake (#2087), dupey skips cloud and network roots (#2085), and the CLI honors
// the config file's webSearch section (#2083). The loop guard of file automations states the loop invariant instead of
// banning operations, so an AI rule can rename a file in place when the new name cannot fire the rule (AutoRAG#2092, app #475).
// The decision model is Jev or the small chat LLM: `jev.backend: "sllm"` decides with `jev.sllm.model` and never calls Jev,
// and `jev.fallback: false` fails a session instead of moving to it (AutoRAG#2091).
// v2.13.8 adds `refresh.schedule` (index only on AC power / in local time windows / on chosen weekdays; `checkIndexSchedule`
// is the gate for hosts with their own scheduler, which the app's OS job is, AutoRAG#2104), the agent's exact `calculator`
// tool (#2109, #2110), the record cut that spreads search hits across documents, on by default (#2108), status reads that
// reuse recorded duplicate exclusions instead of scanning (#2124), and CLI refreshes stopped by SIGINT/SIGTERM (#2118).
// v2.13.12 reads an `excludePaths` entry with `*`, `?` or `[` as a glob over the absolute path (kept verbatim by config
// resolution, applied by the refresh walk), unions MinSync dense and SPLADE candidates for a reranker (#2103), adds the
// model-free `autorag lite find` (#2126; the app's ⌘F search has its own implementation) and `AUTORAG_AUTH_MODE=environment`.
// TEMPORARY: the librarian commit that carries `autorag-mcp --http` and `--check` (AutoRAG#2155, #2156), not yet released.
// Replace with the release tag that includes them before this leaves draft.
const librarianRef = "a18565a61aa3681402b9b2267e5608b4fa6a4f6a";

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
