/**
 * Stage everything the installer carries besides the app itself.
 *
 *   node scripts/release/stage-tools.mjs [--platform darwin-arm64|win32-x64]
 *                                        [--skip-seed] [--only name,name]
 *
 * Output (build/stage/<platform>/):
 *   tools/bin/        the dependency CLIs, each a real executable
 *   tools/node/       Node 24 LTS + npm (also the runtime of the npm-based CLIs)
 *   tools/npm/        mailcrawl, qmd, kordoc and their node_modules
 *   tools/manifest.json   what was staged: name, version, source, sha256
 *   seed/             native Qwen3-Embedding-0.6B checkpoint for first launch
 *
 * Versions are resolved at run time from the publishers' "latest" (GitHub
 * releases, crates.io, npm, nodejs.org), so every release ships the newest
 * dependencies; manifest.json records exactly what that was. The native
 * embedding model is the exception: it is pinned by commit revision and sha256
 * so the bundled weights never drift silently.
 *
 * Each platform is staged on a matching host (native compiles, native npm
 * prebuilds): the macOS stage on an Apple Silicon Mac, the Windows stage on a
 * Windows x64 machine.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	BUILD_DIR,
	CACHE_DIR,
	PLATFORMS,
	ROOT,
	dirSizeBytes,
	pruneNativeForPlatform,
	pruneDeadWeight,
	download,
	extract,
	fetchText,
	findFile,
	hostPlatformId,
	latestCrateVersion,
	latestNode24,
	latestRelease,
	log,
	mb,
	run,
} from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};

const platformId = option("--platform") ?? hostPlatformId();
const target = PLATFORMS[platformId];
if (target === undefined) throw new Error(`Unknown platform ${platformId}; supported: ${Object.keys(PLATFORMS).join(", ")}`);
if (platformId !== hostPlatformId()) throw new Error(`Stage ${platformId} on a ${platformId} host (this one is ${hostPlatformId()}): crates and npm native modules build per platform.`);

const only = option("--only")?.split(",");
const wanted = (name) => only === undefined || only.includes(name);

const STAGE = join(BUILD_DIR, "stage", platformId);
const TOOLS = join(STAGE, "tools");
const BIN = join(TOOLS, "bin");
const SEED = join(STAGE, "seed");
const exe = target.exe;

/** Entries of tools/manifest.json. */
const staged = [];

function record(entry) {
	staged.push(entry);
	log(`staged ${entry.name} ${entry.version}${entry.source ? ` (${entry.source})` : ""}`);
}

function installBinary(from, name) {
	mkdirSync(BIN, { recursive: true });
	const destination = join(BIN, `${name}${exe}`);
	copyFileSync(from, destination);
	if (target.os !== "win32") chmodSync(destination, 0o755);
	return destination;
}

/** Newest GitHub release asset matching `pattern`; the server-side sha256 digest verifies the download. */
async function githubAsset(repo, pattern) {
	const release = await latestRelease(repo);
	const asset = release.assets.find((candidate) => pattern.test(candidate.name));
	if (asset === undefined) throw new Error(`${repo} ${release.tag_name}: no asset matches ${pattern}`);
	const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : null;
	return { release, asset, digest };
}

/** Prebuilt CLIs published as GitHub release archives: download, verify, pull the executable out. */
async function stageReleaseBinary({ name, repo, pattern, binary = name }) {
	const { release, asset, digest } = await githubAsset(repo, pattern);
	const file = await download(asset.browser_download_url, `${repo.replace("/", "__")}-${asset.name}`, digest);
	const directory = join(CACHE_DIR, "x", `${name}-${release.tag_name}`);
	extract(file.path, directory);
	const found = findFile(directory, [`${binary}${exe}`]);
	if (found === null) throw new Error(`${name}: ${binary}${exe} not found in ${asset.name}`);
	installBinary(found, name);
	record({ name, version: release.tag_name.replace(/^v/, ""), source: `github.com/${repo} ${asset.name}`, sha256: file.sha256, verifiedAgainstPublisherDigest: digest !== null });
}

/** Go CLIs that publish no archive for this platform: build the newest tag from source. */
async function stageGoBinary({ name, repo }) {
	const release = await latestRelease(repo);
	const tag = release.tag_name;
	log(`go install ${repo}@${tag}`);
	const goBin = join(CACHE_DIR, "go-bin", `${name}-${tag}`);
	rmSync(goBin, { recursive: true, force: true });
	mkdirSync(goBin, { recursive: true });
	run("go", ["install", "-trimpath", "-ldflags=-s -w", `github.com/${repo}/cmd/${name}@${tag}`], { env: { GOBIN: goBin, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" } });
	installBinary(join(goBin, `${name}${exe}`), name);
	record({ name, version: tag.replace(/^v/, ""), source: `go install github.com/${repo}@${tag}` });
}

/** Rust crates: compile the newest crates.io version (or a git HEAD) into the shared cache. */
async function stageCargoBinary({ name, crate = name, git }) {
	const cargoRoot = join(CACHE_DIR, "cargo", name);
	const targetDir = join(CACHE_DIR, "cargo-target");
	let version;
	let source;
	let installArgs;
	if (git === undefined) {
		version = await latestCrateVersion(crate);
		source = `crates.io ${crate}@${version}`;
		installArgs = ["install", crate, "--version", version, "--locked"];
	} else {
		const head = run("git", ["ls-remote", git, "HEAD"], { capture: true }).split(/\s/)[0];
		version = head.slice(0, 12);
		source = `${git}#${head}`;
		installArgs = ["install", "--git", git, "--rev", head, "--locked", "--bin", name];
	}
	const installed = join(cargoRoot, "bin", `${name}${exe}`);
	const stamp = join(cargoRoot, "version.txt");
	if (!(existsSync(installed) && existsSync(stamp) && readFileSync(stamp, "utf8") === version)) {
		log(`cargo ${installArgs.join(" ")}`);
		rmSync(cargoRoot, { recursive: true, force: true });
		run("cargo", [...installArgs, "--root", cargoRoot, "--target-dir", targetDir]);
		writeFileSync(stamp, version);
	}
	installBinary(installed, name);
	record({ name, version, source });
}

/**
 * fsearch-cli (macOS): NomaDamas/fsearch-mac, built by its own Homebrew tap. The Homebrew binary
 * links glib/pango/ICU by absolute /opt/homebrew paths, so it is copied together with its dylib
 * closure into tools/{bin,lib} and re-pointed at @executable_path/../lib; it then runs on a Mac
 * that has no Homebrew. Windows has no fsearch: it uses the Everything bundle the librarian ships.
 */
async function stageFsearch() {
	const formula = "nomadamas/fsearch-mac/fsearch-mac";
	if (run("brew", ["list", "--versions", "fsearch-mac"], { capture: true, allowFailure: true }).trim() === "") {
		log(`brew install ${formula}`);
		run("brew", ["install", formula]);
	}
	const version = run("brew", ["list", "--versions", "fsearch-mac"], { capture: true }).trim().split(/\s+/).pop();
	const prefix = run("brew", ["--prefix", "fsearch-mac"], { capture: true }).trim();
	const source = realpathSync(join(prefix, "bin", "fsearch-cli"));

	const libDir = join(TOOLS, "lib");
	rmSync(libDir, { recursive: true, force: true });
	mkdirSync(libDir, { recursive: true });
	const binary = installBinary(source, "fsearch-cli");

	const linked = (file) =>
		run("otool", ["-L", file], { capture: true })
			.split("\n")
			.slice(1)
			.map((line) => line.trim().split(" ")[0])
			.filter((name) => name.length > 0);
	const isSystem = (name) => name.startsWith("/usr/lib/") || name.startsWith("/System/");
	// @loader_path references (ICU's data library) resolve against the file that names them.
	const resolveRef = (name, referrer) => (name.startsWith("@loader_path/") ? join(dirname(referrer), name.slice("@loader_path/".length)) : name.startsWith("@") ? null : name);

	const copied = new Map(); // real source path -> staged file name
	const queue = [source];
	while (queue.length > 0) {
		const file = queue.pop();
		for (const name of linked(file)) {
			if (isSystem(name)) continue;
			const resolved = resolveRef(name, file);
			if (resolved === null) continue;
			const real = realpathSync(resolved);
			if (copied.has(real)) continue;
			copied.set(real, basename(name));
			copyFileSync(real, join(libDir, basename(name)));
			chmodSync(join(libDir, basename(name)), 0o755);
			queue.push(real);
		}
	}
	const repoint = (file, prefixRef) => {
		for (const name of linked(file)) {
			if (isSystem(name) || name.startsWith("@executable_path/")) continue;
			run("install_name_tool", ["-change", name, `${prefixRef}/${basename(name)}`, file]);
		}
	};
	for (const name of readdirSync(libDir)) {
		const file = join(libDir, name);
		run("install_name_tool", ["-id", `@loader_path/${name}`, file]);
		repoint(file, "@loader_path");
	}
	repoint(binary, "@executable_path/../lib");
	// install_name_tool invalidates the signature, and Apple Silicon refuses unsigned code;
	// electron-builder re-signs everything with the release identity later.
	for (const file of [binary, ...readdirSync(libDir).map((name) => join(libDir, name))]) run("codesign", ["--force", "--sign", "-", file]);

	// GPL-2.0-or-later: ship the license and notice beside the binary.
	const licenseDir = join(TOOLS, "licenses", "fsearch-mac");
	mkdirSync(licenseDir, { recursive: true });
	for (const name of ["LICENSE", "NOTICE.md"]) if (existsSync(join(prefix, name))) copyFileSync(join(prefix, name), join(licenseDir, name));
	record({ name: "fsearch-cli", version, source: `homebrew ${formula} (+${copied.size} relocated dylibs)` });
}

async function stageNode() {
	const version = await latestNode24();
	const base = `https://nodejs.org/dist/${version}`;
	const archive = `node-${version}-${target.nodeSuffix}`;
	const sums = await fetchText(`${base}/SHASUMS256.txt`);
	const line = sums.split("\n").find((entry) => entry.endsWith(`  ${archive}`));
	if (line === undefined) throw new Error(`SHASUMS256.txt has no ${archive}`);
	const file = await download(`${base}/${archive}`, archive, line.split(/\s+/)[0]);
	const directory = join(CACHE_DIR, "x", `node-${version}`);
	extract(file.path, directory);
	const [inner] = readdirSync(directory);
	const destination = join(TOOLS, "node");
	rmSync(destination, { recursive: true, force: true });
	cpSync(join(directory, inner), destination, { recursive: true, verbatimSymlinks: true });
	for (const junk of ["include", "share", "CHANGELOG.md", "README.md"]) rmSync(join(destination, junk), { recursive: true, force: true });
	record({ name: "node", version: version.replace(/^v/, ""), source: `nodejs.org ${archive}`, sha256: file.sha256, verifiedAgainstPublisherDigest: true });
	return target.os === "win32" ? join(destination, "node.exe") : join(destination, "bin", "node");
}

/** The npm-installed CLIs, installed with the bundled Node so native add-ons match its ABI. */
async function stageNpmCli(nodePath, packages) {
	const prefix = join(TOOLS, "npm");
	rmSync(prefix, { recursive: true, force: true });
	mkdirSync(prefix, { recursive: true });
	// npm blocks dependency install scripts unless the project allows them. better-sqlite3 fetches its
	// prebuilt addon in one (run under the bundled Node, so the ABI matches); everything else stays blocked.
	writeFileSync(join(prefix, "package.json"), `${JSON.stringify({ name: "autorag-bundled-clis", private: true, version: "0.0.0", allowScripts: { "better-sqlite3": true } })}\n`);
	const npmCli = target.os === "win32" ? join(TOOLS, "node", "node_modules", "npm", "bin", "npm-cli.js") : join(TOOLS, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	const npmEnv = { npm_config_cache: join(CACHE_DIR, "npm"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
	// Node must be first on PATH for postinstall scripts that spawn `node`.
	const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const nodeDir = join(TOOLS, "node", ...(target.os === "win32" ? [] : ["bin"]));
	const env = { ...npmEnv, [pathKey]: `${nodeDir}${target.os === "win32" ? ";" : ":"}${process.env[pathKey] ?? ""}` };
	// better-sqlite3 fetches its prebuilt addon in an install script; every other install script is left blocked.
	run(nodePath, [npmCli, "install", "--prefix", prefix, "--omit=dev", "--no-package-lock", ...packages], { env });
	const nodeModules = join(prefix, "node_modules");
	pruneNativeForPlatform(nodeModules, target);
	const pruned = pruneDeadWeight(nodeModules);
	log(`removed ${pruned} map/declaration/doc files from the npm tree`);
	// lancedb nests its own onnxruntime/transformers for embedding functions none of these CLIs call;
	// verify-bundle proves lancedb and transformers.js still load without them.
	for (const nested of ["onnxruntime-node", "onnxruntime-web", "@huggingface"]) {
		rmSync(join(nodeModules, "@lancedb", "lancedb", "node_modules", nested), { recursive: true, force: true });
	}
	const shim = await buildShim();
	for (const pkg of packages.map((spec) => spec.replace(/@latest$/, ""))) {
		const manifest = JSON.parse(readFileSync(join(nodeModules, pkg, "package.json"), "utf8"));
		const bins = typeof manifest.bin === "string" ? { [basename(pkg)]: manifest.bin } : manifest.bin;
		for (const [binName, entry] of Object.entries(bins ?? {})) {
			if (binName === "kordoc-mcp") continue;
			const entryRel = relative(TOOLS, join(nodeModules, pkg, entry)).replaceAll("\\", "/");
			installBinary(shim, binName);
			writeFileSync(join(BIN, `${binName}.shim`), `${entryRel}\n`);
		}
		record({ name: pkg, version: manifest.version, source: `npm ${pkg}` });
	}
}

let shimPath;
async function buildShim() {
	if (shimPath !== undefined) return shimPath;
	const crate = join(ROOT, "scripts", "release", "shim");
	const targetDir = join(CACHE_DIR, "shim-target");
	run("cargo", ["build", "--release", "--locked", "--manifest-path", join(crate, "Cargo.toml"), "--target-dir", targetDir]);
	shimPath = join(targetDir, "release", `autorag-shim${exe}`);
	return shimPath;
}

/** `autorag`: the librarian CLI the app already ships in app/node_modules, launched by the bundled Node. */
async function stageAutoragCli() {
	const librarian = join(ROOT, "node_modules", "@autorag", "librarian");
	const manifest = JSON.parse(readFileSync(join(librarian, "package.json"), "utf8"));
	installBinary(await buildShim(), "autorag");
	writeFileSync(join(BIN, "autorag.shim"), "../app/node_modules/@autorag/librarian/dist/cli/index.js\n");
	record({ name: "autorag", version: manifest.version, source: "@autorag/librarian (public origin/main, built by scripts/sync-librarian.mjs)" });
}

/**
 * Native Qwen3 embedding model (`Qwen/Qwen3-Embedding-0.6B`), pinned by commit
 * and SHA-256 in the Hugging Face Hub cache layout that `minsync` (`fastembed` /
 * `hf-hub`) and `mailcrawl` read directly without network access.
 */
const NATIVE_QWEN3_REPO_DIR = "models--Qwen--Qwen3-Embedding-0.6B";
const NATIVE_QWEN3_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3";
const NATIVE_QWEN3_BASE_URL = `https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/${NATIVE_QWEN3_REVISION}`;
const NATIVE_QWEN3_FILES = [
	{ name: "config.json", sha256: "b5bf1f51fc45be473a54718cef92448d90a1be001bf9b9a44b8c7f10a19feaa9" },
	{ name: "tokenizer.json", sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a" },
	{ name: "model.safetensors", sha256: "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd" },
];

async function stageSeed() {
	rmSync(SEED, { recursive: true, force: true });
	const refsDir = join(SEED, NATIVE_QWEN3_REPO_DIR, "refs");
	const snapshotDir = join(SEED, NATIVE_QWEN3_REPO_DIR, "snapshots", NATIVE_QWEN3_REVISION);
	mkdirSync(refsDir, { recursive: true });
	mkdirSync(snapshotDir, { recursive: true });
	const refRel = `${NATIVE_QWEN3_REPO_DIR}/refs/main`;
	const refContent = Buffer.from(NATIVE_QWEN3_REVISION, "utf8");
	writeFileSync(join(SEED, refRel), refContent);
	const refSha256 = createHash("sha256").update(refContent).digest("hex");
	const files = [
		{ path: refRel, destination: refRel, sha256: refSha256, bytes: refContent.length },
	];
	for (const asset of NATIVE_QWEN3_FILES) {
		const url = `${NATIVE_QWEN3_BASE_URL}/${asset.name}`;
		const downloaded = await download(url, `Qwen3-Embedding-0.6B-${NATIVE_QWEN3_REVISION.slice(0, 12)}-${asset.name}`, asset.sha256);
		const rel = `${NATIVE_QWEN3_REPO_DIR}/snapshots/${NATIVE_QWEN3_REVISION}/${asset.name}`;
		const destination = join(SEED, rel);
		copyFileSync(downloaded.path, destination);
		files.push({ path: rel, destination: rel, sha256: asset.sha256, bytes: statSync(destination).size });
	}
	writeFileSync(join(SEED, "manifest.json"), `${JSON.stringify({ schema: 1, files }, null, 2)}\n`);
	record({
		name: "qwen3-embedding-0.6b-native",
		version: NATIVE_QWEN3_REVISION.slice(0, 12),
		source: `${NATIVE_QWEN3_BASE_URL}/model.safetensors`,
		sha256: NATIVE_QWEN3_FILES[2].sha256,
		verifiedAgainstPublisherDigest: true,
	});
}

// --------------------------------------------------------------------------

const RELEASE_BINARIES = [
	{ name: "minsync", repo: "NomaDamas/MinSync", pattern: target.os === "win32" ? /x86_64-pc-windows-msvc\.zip$/ : /aarch64-apple-darwin\.tar\.gz$/ },
	{ name: "rhwp", repo: "edwardkim/rhwp", pattern: target.os === "win32" ? /windows-x86_64\.zip$/ : /macos-aarch64\.tar\.gz$/ },
	{ name: "himalaya", repo: "pimalaya/himalaya", pattern: target.os === "win32" ? /x86_64-windows\.zip$/ : /aarch64-darwin\.tgz$/ },
	{ name: "rclone", repo: "rclone/rclone", pattern: target.os === "win32" ? /windows-amd64\.zip$/ : /osx-arm64\.zip$/ },
	{ name: "lark-cli", repo: "larksuite/cli", pattern: target.os === "win32" ? /windows-amd64\.zip$/ : /darwin-arm64\.tar\.gz$/ },
	...["discrawl", "telecrawl", "wacrawl"].map((name) => ({ name, repo: `openclaw/${name}`, pattern: target.os === "win32" ? /_windows_amd64\.zip$/ : /_darwin_arm64\.tar\.gz$/ })),
];

// openclaw/slacrawl and openclaw/notcrawl publish macOS archives but no Windows one: build the newest tag from source there.
const GO_CRAWLERS = [
	{ name: "slacrawl", repo: "openclaw/slacrawl", pattern: /_darwin_arm64\.tar\.gz$/ },
	{ name: "notcrawl", repo: "openclaw/notcrawl", pattern: /_darwin_arm64\.tar\.gz$/ },
];

const CARGO_BINARIES = [
	{ name: "dupey" },
	{ name: "jikji", crate: "jikji-cli" },
	{ name: "clawgallery" },
	// lazykatok is an Apple Silicon macOS KakaoTalk client and has no crates.io release.
	...(target.os === "darwin" ? [{ name: "lazykatok", git: "https://github.com/changeroa/lazykatok" }] : []),
];

const NPM_PACKAGES = ["@nomadamas/mailcrawl", "@tobilu/qmd", "kordoc"];

// A full run starts clean; a partial run (--only) touches just the tools it names and keeps the rest.
if (only === undefined) rmSync(TOOLS, { recursive: true, force: true });
mkdirSync(BIN, { recursive: true });

if (wanted("node") || wanted("npm")) {
	const nodePath = await stageNode();
	if (wanted("npm")) await stageNpmCli(nodePath, NPM_PACKAGES);
}
if (wanted("autorag")) await stageAutoragCli();
for (const item of RELEASE_BINARIES) if (wanted(item.name)) await stageReleaseBinary(item);
for (const item of GO_CRAWLERS) {
	if (!wanted(item.name)) continue;
	if (target.os === "win32") await stageGoBinary(item);
	else await stageReleaseBinary(item);
}
for (const item of CARGO_BINARIES) if (wanted(item.name)) await stageCargoBinary(item);
if (target.os === "darwin" && wanted("fsearch-cli")) await stageFsearch();
if (!flag("--skip-seed") && wanted("seed")) await stageSeed();

const manifestPath = join(TOOLS, "manifest.json");
const kept = only !== undefined && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).tools.filter((tool) => !staged.some((entry) => entry.name === tool.name)) : [];
writeFileSync(manifestPath, `${JSON.stringify({ schema: 1, platform: platformId, generatedAt: new Date().toISOString(), tools: [...kept, ...staged] }, null, 2)}\n`);
log(`tools ${mb(dirSizeBytes(TOOLS))}, seed ${existsSync(SEED) ? mb(dirSizeBytes(SEED)) : "skipped"} -> ${STAGE}`);
