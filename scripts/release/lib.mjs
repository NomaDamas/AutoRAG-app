/**
 * Shared helpers for the release scripts: platform ids, verified downloads,
 * GitHub/crates.io/npm "latest" lookups, and a process runner. Plain Node 24,
 * no dependencies, so it runs the same on a macOS and a Windows runner.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const BUILD_DIR = join(ROOT, "build");
export const CACHE_DIR = join(BUILD_DIR, ".cache");

/** The two shipped targets. Everything else (Intel Mac, Windows on ARM, Linux) is out of scope. */
export const PLATFORMS = {
	"darwin-arm64": { os: "darwin", arch: "arm64", exe: "", nodeSuffix: "darwin-arm64.tar.gz" },
	"win32-x64": { os: "win32", arch: "x64", exe: ".exe", nodeSuffix: "win-x64.zip" },
};

export function hostPlatformId() {
	const id = `${process.platform}-${process.arch}`;
	if (!(id in PLATFORMS)) throw new Error(`Unsupported release host ${id}; supported: ${Object.keys(PLATFORMS).join(", ")}`);
	return id;
}

export function log(message) {
	process.stdout.write(`[release] ${message}\n`);
}

/** Run a command and fail loudly; stdout is returned when `capture` is set. */
export function run(command, args, options = {}) {
	const { capture = false, cwd, env, allowFailure = false } = options;
	const result = spawnSync(command, args, {
		cwd,
		env: env === undefined ? process.env : { ...process.env, ...env },
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		// npm/bun ship as .cmd shims on Windows, which spawn only resolves through a shell.
		shell: process.platform === "win32" && !/\.exe$/i.test(command) && ["npm", "npx", "bun", "bunx"].includes(command),
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
	if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
	return capture ? result.stdout : result.status;
}

export async function sha256File(path) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

function githubHeaders() {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return { accept: "application/vnd.github+json", "user-agent": "autorag-release", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/**
 * `fetch` that retries what a long staging run on a shared runner hits now and
 * then: the connection dropped mid-request (observed: GitHub's API closing the
 * socket, `UND_ERR_SOCKET`) or a 5xx/429. Other HTTP errors return at once.
 */
async function fetchRetrying(url, init, attempts = 4) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			const response = await fetch(url, init);
			if (attempt < attempts && (response.status >= 500 || response.status === 429)) {
				await response.body?.cancel();
				log(`GET ${url} -> HTTP ${response.status}; retry ${attempt}/${attempts - 1}`);
			} else {
				return response;
			}
		} catch (error) {
			if (attempt >= attempts) throw error;
			log(`GET ${url} failed (${error.cause?.code ?? error.message}); retry ${attempt}/${attempts - 1}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** (attempt - 1)));
	}
}

export async function fetchJson(url, headers = {}) {
	const response = await fetchRetrying(url, { headers: { "user-agent": "autorag-release", ...headers } });
	if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	return response.json();
}

export async function fetchText(url) {
	const response = await fetchRetrying(url, { headers: { "user-agent": "autorag-release" } });
	if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	return response.text();
}

/** The repository's latest (non-prerelease) GitHub release: tag plus assets with their server-side sha256 digests. */
export async function latestRelease(repo) {
	return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, githubHeaders());
}

export async function latestCrateVersion(crate) {
	const body = await fetchJson(`https://crates.io/api/v1/crates/${crate}`);
	return body.crate.max_stable_version;
}

export function latestNpmVersion(pkg) {
	return run("npm", ["view", pkg, "version"], { capture: true }).trim();
}

/** Latest Node 24 LTS release (the line mailcrawl's `engines` requires). */
export async function latestNode24() {
	const index = await fetchJson("https://nodejs.org/dist/index.json");
	const entry = index.find((item) => item.version.startsWith("v24.") && item.lts !== false);
	if (entry === undefined) throw new Error("No Node 24 LTS release found in nodejs.org/dist/index.json");
	return entry.version;
}

/**
 * Download `url` into the cache once and verify it. `expected` is a hex sha256
 * (or null when the publisher gives none; the digest is then recorded, not
 * checked). A cached file that no longer matches is re-downloaded.
 */
export async function download(url, filename, expected) {
	mkdirSync(CACHE_DIR, { recursive: true });
	const destination = join(CACHE_DIR, filename);
	if (existsSync(destination) && (expected === null || (await sha256File(destination)) === expected)) {
		return { path: destination, sha256: expected ?? (await sha256File(destination)) };
	}
	log(`download ${url}`);
	const response = await fetchRetrying(url, { headers: { "user-agent": "autorag-release" }, redirect: "follow" });
	if (!response.ok || response.body === null) throw new Error(`GET ${url} -> HTTP ${response.status}`);
	const part = `${destination}.part`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
	const actual = await sha256File(part);
	if (expected !== null && actual !== expected) {
		rmSync(part, { force: true });
		throw new Error(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
	}
	renameSync(part, destination);
	return { path: destination, sha256: actual };
}

/** Extract tar.gz/tgz/zip with the system bsdtar (present on macOS and Windows 10+). */
export function extract(archive, destination) {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	run(systemTar(), ["-xf", archive, "-C", destination]);
}

/** Breadth-first search for a file named `name`; the shallowest match wins. */
export function findFile(root, names) {
	const wanted = new Set(names);
	let level = [root];
	while (level.length > 0) {
		const next = [];
		for (const directory of level) {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const full = join(directory, entry.name);
				if (entry.isDirectory()) next.push(full);
				else if (wanted.has(entry.name)) return full;
			}
		}
		level = next;
	}
	return null;
}

/**
 * npm installs every platform's prebuilt add-ons for packages that ship them in-tree. Drop the
 * ones for other targets; the layouts seen in this dependency set are
 *   prebuilds/<os>-<arch>[.node]      (tree-sitter-*, better-sqlite3)
 *   bin/napi-v<n>/<os>/<arch>         (onnxruntime-node)
 * `onnxruntime-web` is the browser/WASM backend; nothing that runs under Node imports it.
 */
export function pruneNativeForPlatform(root, target) {
	const here = `${target.os}-${target.arch}`;
	const otherOs = ["darwin", "linux", "win32", "android", "freebsd"].filter((os) => os !== target.os);
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (entry.name === "prebuilds") {
				for (const child of readdirSync(full)) {
					const stem = child.replace(/\.node$/, "");
					if (/^(darwin|linux|win32|android|freebsd)-/.test(stem) && stem !== here) rmSync(join(full, child), { recursive: true, force: true });
				}
				continue;
			}
			if (/^napi-v\d+$/.test(entry.name)) {
				for (const os of otherOs) rmSync(join(full, os), { recursive: true, force: true });
				const own = join(full, target.os);
				if (existsSync(own)) for (const arch of readdirSync(own)) if (arch !== target.arch) rmSync(join(own, arch), { recursive: true, force: true });
				continue;
			}
			walk(full);
		}
	};
	walk(root);
	rmSync(join(root, "onnxruntime-web"), { recursive: true, force: true });
	// node-llama-cpp ships one package per backend. Keep the portable ones for this target:
	// Metal on macOS; CPU plus Vulkan on Windows (CUDA needs an NVIDIA toolkit and is 500 MB more).
	const llama = join(root, "@node-llama-cpp");
	if (existsSync(llama)) {
		const keep = target.os === "darwin" ? [`mac-${target.arch}-metal`] : ["win-x64", "win-x64-vulkan"];
		for (const entry of readdirSync(llama)) if (!keep.includes(entry)) rmSync(join(llama, entry), { recursive: true, force: true });
	}
}

/**
 * Delete files that are never read at run time from an installed node_modules tree: source maps,
 * TypeScript declarations and prose docs. They are ~half of the files in these trees, and on
 * Windows the per-file cost is what makes installs slow. LICENSE files stay (MIT/BSD need the notice).
 * Returns the number of files removed.
 */
export function pruneDeadWeight(root) {
	let removed = 0;
	const dead = /(\.map|\.d\.(ts|mts|cts)|\.tsbuildinfo|\.markdown)$|^(readme|changelog|history|contributing|authors)(\.md|\.txt)?$/i;
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && dead.test(entry.name)) {
				rmSync(full, { force: true });
				removed += 1;
			}
		}
	};
	walk(root);
	return removed;
}

/**
 * Rename every non-ASCII name under `root` to its decomposed (NFD) form, deepest entries first, and
 * return how many were renamed. macOS must see the names in the code seal byte for byte, and Finder
 * writes names decomposed when it copies an app out of the dmg (measured on macOS 26.6: kordoc's
 * composed `일반기안문_서식.hwpx` arrived decomposed, the seal reported "file added" + "file missing",
 * and Gatekeeper called the app damaged). Signing names that are already NFD makes Finder's copy a
 * no-op. APFS lookups are normalization-insensitive, so code that opens the composed name still finds it.
 */
export function decomposeNonAsciiNames(root) {
	let renamed = 0;
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			const decomposed = entry.name.normalize("NFD");
			if (decomposed === entry.name) continue;
			renameSync(full, join(directory, decomposed));
			renamed += 1;
		}
	};
	walk(root);
	return renamed;
}

/**
 * The system bsdtar. Windows ships it as System32\\tar.exe, which is also what the installer
 * calls, so building and unpacking use the same tool; a Git-for-Windows `tar` on PATH is GNU tar
 * and cannot read the same flags.
 */
export function systemTar() {
	return process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

export function dirSizeBytes(root) {
	let total = 0;
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) stack.push(full);
			else total += statSync(full).size;
		}
	}
	return total;
}

export function mb(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
