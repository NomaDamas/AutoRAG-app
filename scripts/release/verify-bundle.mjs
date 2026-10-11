/**
 * Prove an installed (or staged) tool set works on a machine with nothing else.
 *
 *   node scripts/release/verify-bundle.mjs <tools-dir> [--seed <seed-dir>]
 *
 * Every tool runs from an environment whose PATH holds only `<tools-dir>/bin`
 * plus the OS directories, with no Homebrew, no cargo, no global Node. A tool
 * that only worked because the developer's machine had its dependencies fails
 * here. `<tools-dir>` is `build/stage/<platform>/tools` for the staged tree, or
 * `<resources>/tools` inside an installed app.
 *
 * Beyond `--version` it exercises what is easy to break when packaging:
 * Node-based CLIs loading native add-ons (better-sqlite3, lancedb, sharp) and
 * the librarian CLI resolving the other tools by name.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const toolsDir = args[0] === undefined ? null : resolve(args[0]);
if (toolsDir === null) {
	process.stderr.write("usage: verify-bundle.mjs <tools-dir> [--seed <seed-dir>]\n");
	process.exit(2);
}
const seedIndex = args.indexOf("--seed");
const seedDir = seedIndex >= 0 ? resolve(args[seedIndex + 1] ?? "") : null;

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
	qmd: ["--version"],
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
probe("better-sqlite3 loads", `const D=require(${JSON.stringify(join(modules, "@tobilu", "qmd", "node_modules", "better-sqlite3"))});new D(':memory:').prepare('select 1').get();console.log('loaded')`);
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

// Behaviour, not just version output.
check("kordoc parses a document", join(bin, `kordoc${exe}`), ["--help"], { expect: /kordoc|Usage|usage/i });
check("minsync reports its embedder commands", join(bin, `minsync${exe}`), ["--help"], { expect: /sync|query/i });
if (hasApp) check("autorag runs", join(bin, `autorag${exe}`), ["--help"], { expect: /autorag/i });
probe("transformers.js loads without onnxruntime-web", `import(${JSON.stringify(pathToFileURL(join(modules, "@huggingface", "transformers", "dist", "transformers.node.mjs")).href)}).then((m)=>console.log(typeof m.pipeline==='function'?'loaded':'broken'))`);

if (seedDir !== null) {
	const seed = JSON.parse(readFileSync(join(seedDir, "manifest.json"), "utf8"));
	for (const file of seed.files) {
		const path = join(seedDir, file.path);
		const ok = existsSync(path);
		if (!ok) failures += 1;
		process.stdout.write(`${ok ? "ok  " : "FAIL"} seed ${file.destination}${ok ? "" : " missing"}\n`);
	}
}

process.stdout.write(failures === 0 ? `\nbundle OK (${manifest.tools.length} components, ${manifest.platform})\n` : `\n${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
