/**
 * Prove an installed (or staged) tool set works on a machine with nothing else.
 *
 *   node scripts/release/verify-bundle.mjs <tools-dir>
 *
 * Every tool runs from an environment whose PATH holds only `<tools-dir>/bin`
 * plus the OS directories, with no Homebrew, no cargo, no global Node. A tool
 * that only worked because the developer's machine had its dependencies fails
 * here. `<tools-dir>` is `build/stage/<platform>/tools` for the staged tree, or
 * `<resources>/tools` inside an installed app.
 *
 * The SPLADE check needs no model cache of its own: the installer carries that model under `tools/models`.
 *
 * Beyond `--version` it exercises what is easy to break when packaging:
 * Node-based CLIs loading native add-ons (better-sqlite3, lancedb, sharp) and
 * the librarian CLI resolving the other tools by name.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const toolsDir = args[0] === undefined ? null : resolve(args[0]);
if (toolsDir === null) {
	process.stderr.write("usage: verify-bundle.mjs <tools-dir>\n");
	process.exit(2);
}

const win = process.platform === "win32";
const bin = join(toolsDir, "bin");
const exe = win ? ".exe" : "";
const systemPath = win ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** A scrubbed environment: no inherited PATH, and a throwaway HOME so no tool reads real user state. */
function cleanEnv(home) {
	const env = {
		[win ? "Path" : "PATH"]: [bin, ...systemPath].join(win ? ";" : ":"),
		HOME: home,
		USERPROFILE: home,
		TMPDIR: process.env.TMPDIR ?? "",
		TEMP: process.env.TEMP ?? "",
		TMP: process.env.TMP ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		LANG: "C",
	};
	for (const key of Object.keys(env)) if (env[key] === "") delete env[key];
	return env;
}

const home = mkdtempSync(join(tmpdir(), "autorag-verify-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const manifest = JSON.parse(readFileSync(join(toolsDir, "manifest.json"), "utf8"));
const versionOf = (name) => manifest.tools.find((tool) => tool.name === name)?.version;

let failures = 0;
function check(label, command, commandArgs, { expect, input, timeoutMs = 120_000 } = {}) {
	const started = Date.now();
	const result = spawnSync(command, commandArgs, { env: cleanEnv(home), encoding: "utf8", timeout: timeoutMs, input, cwd: home, windowsHide: true });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	const ok = result.status === 0 && (expect === undefined || expect.test(output));
	if (!ok) failures += 1;
	const note = ok ? "" : `  <- exit ${result.status ?? result.error?.message ?? result.signal}: ${output.slice(0, 300).replace(/\s+/g, " ")}`;
	process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label} (${Date.now() - started} ms)${note}\n`);
	return ok ? output : null;
}

// Each tool is invoked by bare name, exactly as the librarian does.
const VERSION_ARGS = {
	autorag: ["--version"],
	minsync: ["--version"],
	jikji: ["--version"],
	dupey: ["--version"],
	clawgallery: ["--version"],
	discrawl: ["--version"],
	telecrawl: ["--version"],
	wacrawl: ["--version"],
	slacrawl: ["--version"],
	notcrawl: ["--version"],
	rhwp: ["--version"],
	himalaya: ["--version"],
	rclone: ["version"],
	"lark-cli": ["--version"],
	lazykatok: ["--help"],
	"fsearch-cli": ["--version"],
	"filee-cli": ["--version"],
	kordoc: ["--version"],
	mailcrawl: ["--help"],
};

// The librarian CLI lives in the app (resources/app), not in tools/: it can only be checked in an installed app.
const hasApp = existsSync(join(toolsDir, "..", "app", "node_modules", "@autorag", "librarian"));
for (const [name, versionArgs] of Object.entries(VERSION_ARGS)) {
	if (name === "autorag" && !hasApp) {
		process.stdout.write("skip autorag (checked against an installed app)\n");
		continue;
	}
	if (!existsSync(join(bin, `${name}${exe}`))) {
		// lazykatok is an Apple Silicon macOS KakaoTalk client; no other platform ships it.
		// lazykatok (KakaoTalk for macOS) and fsearch-cli (macOS file-name index; Windows uses Everything) ship on macOS only.
		if ((name === "lazykatok" || name === "fsearch-cli") && process.platform !== "darwin") continue;
		failures += 1;
		process.stdout.write(`FAIL ${name}: not staged\n`);
		continue;
	}
	check(name, name, versionArgs);
}

// The bundled Node must be the one the npm CLIs run on, and must not be the host's.
const node = join(toolsDir, "node", ...(win ? ["node.exe"] : ["bin", "node"]));
check("node", node, ["--version"], { expect: new RegExp(`^v${(versionOf("node") ?? "").replaceAll(".", "\\.")}$`) });

// Native add-ons the npm CLIs depend on, loaded by the bundled Node itself.
const modules = join(toolsDir, "npm", "node_modules");
const probe = (label, code) => check(label, node, ["-e", code], { expect: /loaded/ });
probe("better-sqlite3 loads", `const D=require(${JSON.stringify(join(modules, "better-sqlite3"))});new D(':memory:').prepare('select 1').get();console.log('loaded')`);
probe("lancedb loads", `require(${JSON.stringify(join(modules, "@lancedb", "lancedb"))});console.log('loaded')`);

// fsearch-cli (macOS): index, search and the live-watch daemon against a real folder, with no Homebrew on PATH.
if (!win) {
	const tree = join(home, "fsearch-tree");
	mkdirSync(join(tree, "sub"), { recursive: true });
	writeFileSync(join(tree, "sub", "quarterly-report.txt"), "x");
	const db = join(home, "fsearch.db");
	const fsearch = join(bin, "fsearch-cli");
	check("fsearch-cli indexes a folder", fsearch, ["index", "--db", db, "--include", tree], { expect: /indexed/ });
	check("fsearch-cli finds a file by name", fsearch, ["search", "--db", db, "quarterly"], { expect: /quarterly-report\.txt/ });
	// It must not depend on Homebrew's libraries: every non-system reference is inside tools/lib.
	const refs = spawnSync("otool", ["-L", fsearch], { encoding: "utf8" }).stdout.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
	const stray = refs.filter((ref) => !ref.startsWith("/usr/lib/") && !ref.startsWith("/System/") && !ref.startsWith("@executable_path/../lib/"));
	if (stray.length > 0) failures += 1;
	process.stdout.write(`${stray.length === 0 ? "ok  " : "FAIL"} fsearch-cli links only system libraries and tools/lib${stray.length === 0 ? "" : `  <- ${stray.join(", ")}`}\n`);
}

// filee-cli: the librarian's `convert_files` backend. `--no-install` forbids an engine download and the
// bundled libraries do the work, so a pass proves the whole self-contained layout runs from `tools/bin`
// (on macOS through the symlink, which .NET resolves to the real publish folder) with no network and no
// engine: Markdown -> HTML uses its Markdig library, and PNG -> BMP loads the bundled Magick.Native engine.
const filee = join(bin, `filee-cli${exe}`);
writeFileSync(join(home, "verify-filee.md"), "# verify\n\nDazzi bundle check.\n");
check("filee-cli converts markdown offline", filee, ["convert", join(home, "verify-filee.md"), "--to", "html", "--no-install"], { expect: /Converted 1 of 1/u });
const pixel = join(home, "verify-filee.png");
writeFileSync(pixel, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
check("filee-cli converts an image with its bundled engine", filee, ["convert", pixel, "--to", "bmp", "--no-install"], { expect: /Converted 1 of 1/u });

// Behaviour, not just version output.
check("kordoc parses a document", join(bin, `kordoc${exe}`), ["--help"], { expect: /kordoc|Usage|usage/i });
check("minsync reports its embedder commands", join(bin, `minsync${exe}`), ["--help"], { expect: /sync|query/i });
// The app starts `minsync serve` itself at launch (the one process that holds the model weights, serving
// every embedding consumer over loopback). Prove the bundled build carries that subcommand and its server.
check("minsync serve is the shared embedding daemon", join(bin, `minsync${exe}`), ["serve", "--help"], { expect: /loopback HTTP[\s\S]*\/v1\/embeddings/ });
if (hasApp) check("autorag runs", join(bin, `autorag${exe}`), ["--help"], { expect: /autorag/i });
probe("transformers.js loads without onnxruntime-web", `import(${JSON.stringify(pathToFileURL(join(modules, "@huggingface", "transformers", "dist", "transformers.node.mjs")).href)}).then((m)=>console.log(typeof m.pipeline==='function'?'loaded':'broken'))`);

// MinSync's SPLADE encoder ships in the installer (`tools/models`): every file at its pinned size and SHA-256, with
// its Apache-2.0 LICENSE. A sparse-only sync and a Korean stem query then run from that copy alone: HF_HUB_OFFLINE
// makes a missing file fail the check instead of being downloaded, and `--embedder none` needs no dense model, so a
// pass proves a fresh machine searches its files offline, low-end machines included. 인증서 must find the note
// written only as 인증서를: that is the stem match MinSync's sparse ranking makes without any tokenizer library.
const sparseModel = JSON.parse(readFileSync(new URL("../../src/shared/sparse-model.json", import.meta.url), "utf8"));
const sparseSnapshot = join(toolsDir, "models", sparseModel.repoDir, "snapshots", sparseModel.revision);
const sparseFiles = sparseModel.files.map((file) => {
	const path = join(sparseSnapshot, file.name);
	return { file, ok: existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === file.sha256 };
});
const sparseComplete = sparseFiles.every((entry) => entry.ok) && existsSync(join(toolsDir, "models", sparseModel.repoDir, "refs", "main"));
if (!sparseComplete) failures += 1;
process.stdout.write(`${sparseComplete ? "ok  " : "FAIL"} the SPLADE model (${sparseModel.repo}) is bundled at its pinned revision and hashes${sparseComplete ? "" : `  <- ${sparseFiles.filter((entry) => !entry.ok).map((entry) => entry.file.name).join(", ") || "refs/main"}`}\n`);
const sparseLicense = existsSync(join(toolsDir, "licenses", "kure-sparse-nano", "LICENSE"));
if (!sparseLicense) failures += 1;
process.stdout.write(`${sparseLicense ? "ok  " : "FAIL"} the SPLADE model's Apache-2.0 LICENSE ships with it${sparseLicense ? "" : "  <- missing"}\n`);
if (sparseComplete) {
	const workspace = join(home, "sparse-workspace");
	mkdirSync(workspace, { recursive: true });
	const minsync = join(bin, `minsync${exe}`);
	cpSync(join(toolsDir, "models"), join(home, "models"), { recursive: true });
	const env = { ...cleanEnv(home), FASTEMBED_CACHE_DIR: join(home, "models"), HF_HUB_OFFLINE: "1" };
	const sh = (commandArgs) => spawnSync(minsync, commandArgs, { env, cwd: workspace, encoding: "utf8", timeout: 240_000, windowsHide: true });
	sh(["init", "--format", "json", "--embedder", "none"]);
	writeFileSync(join(workspace, "certificate.md"), "인증서를 제출해야 환불이 승인됩니다.\n");
	writeFileSync(join(workspace, "unrelated.md"), "The quarterly report covers revenue and hiring.\n");
	const synced = sh(["sync", "--format", "json"]);
	const queried = sh(["query", "--format", "json", "--mode", "sparse", "-k", "1", "인증서"]);
	let top = null;
	try {
		top = JSON.parse(queried.stdout || "[]")[0]?.path ?? null;
	} catch {
		top = null;
	}
	const ok = synced.status === 0 && typeof top === "string" && top.endsWith("certificate.md");
	if (!ok) failures += 1;
	process.stdout.write(`${ok ? "ok  " : "FAIL"} minsync ranks Korean offline with the bundled SPLADE model and no dense model${ok ? "" : `  <- sync exit ${synced.status}, query exit ${queried.status}: ${`${synced.stderr}${queried.stderr}`.slice(0, 200).replace(/\s+/g, " ")}; top hit ${top}`}\n`);
}

process.stdout.write(failures === 0 ? `\nbundle OK (${manifest.tools.length} components, ${manifest.platform})\n` : `\n${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
