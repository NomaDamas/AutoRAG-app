/**
 * Build the standalone plain-Node runtime for `@autorag/librarian` under `<tools>/librarian/`.
 *
 * Why this exists:
 *   The Electron app packs its own JS and `node_modules` into `app.asar` (`asar: true`), which collapses ~29,000
 *   loose files into one archive so Squirrel.Mac ShipIt, codesign, and Windows installs stay fast and reliable.
 *   Two features still run under plain Node (`tools/node`), which cannot read inside `app.asar`:
 *     1. The `autorag` CLI & background automation daemon (`com.autorag.automate`), and
 *     2. Dazzi's stdio MCP server for external agents (Claude Code, Codex, Gemini CLI, Cursor, …).
 *
 *   Rather than unpacking all of `app/node_modules` (which would bring back tens of thousands of files), this
 *   script bundles the librarian's CLI, MCP server, and isolated parse worker with esbuild (ESM code splitting,
 *   sharing chunks across all three entrypoints) and copies only the tiny closure of native/WASM/runtime-data
 *   packages that plain Node must load from disk (`@parcel/watcher`, `@bubblyworld/xgboost-ts`, `tesseract.js`,
 *   `pdfjs-dist`, `sharp`, `pi-ask-user`, and their platform-matched transitive deps), plus the librarian's
 *   `package.json`, `skills/`, `internal-skills/`, `licenses/`, and (on Windows) `vendor/everything/`.
 *
 * Output layout (`<outDir>`, i.e. `build/stage/<platform>/tools/librarian/`):
 *   package.json                minimal ESM manifest carrying the librarian's version
 *   dist/cli/index.js           bundled `autorag` CLI & automation daemon entry
 *   dist/mcp/index.js           bundled librarian MCP server entry
 *   dist/mcp-server.js          Dazzi stdio MCP launcher (prepends AUTORAG_TOOLS_DIR to PATH, then runs dist/mcp/index.js)
 *   dist/parser/parse-worker.js bundled isolated parser worker
 *   dist/*.js                   shared esbuild chunks
 *   skills/, internal-skills/   packaged SKILL.md assets loaded by librarian
 *   licenses/                   upstream notices
 *   vendor/everything/          Windows Everything assets (only on win32)
 *   node_modules/               minimal native/WASM external closure (pruned to target platform, deadweight stripped)
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORMS, ROOT, dirSizeBytes, hostPlatformId, log, mb, pruneDeadWeight, pruneNativeForPlatform, run } from "./lib.mjs";

/**
 * Packages kept external from the esbuild bundle because they load native `.node`/`.dylib`/`.dll` binaries,
 * sibling `.wasm` binaries via `import.meta.url`, worker scripts by path, or raw `.ts` extensions via jiti.
 */
export const LIBRARIAN_BUNDLE_EXTERNALS = [
	"@parcel/watcher",
	"@parcel/watcher-*",
	"@bubblyworld/xgboost-ts",
	"tesseract.js",
	"tesseract.js-core",
	"pdfjs-dist",
	"sharp",
	"@img/*",
	"@napi-rs/canvas",
	"@napi-rs/canvas-*",
	"onnxruntime-node",
	"fsevents",
	"pi-ask-user",
	"puppeteer-core",
	"oxc-parser",
	"@oxc-parser/*",
	"Foundation",
	"*.node",
];

/**
 * Root packages copied (with their platform-matching transitive dependency closure) into
 * `<tools>/librarian/node_modules`. Keep this list minimal: every package here ships as real files on disk.
 */
export const LIBRARIAN_EXTERNAL_SEEDS = [
	"@parcel/watcher",
	"@bubblyworld/xgboost-ts",
	"tesseract.js",
	"pdfjs-dist",
	"sharp",
	"pi-ask-user",
	"cfb",
	"quickjs-wasi",
];

const OTHER_OS_MARKERS = {
	darwin: ["-linux", "-win32", "-freebsd", "-android", "-openbsd", "-sunos"],
	win32: ["-darwin", "-linux", "-freebsd", "-android", "-openbsd", "-sunos"],
};

const OTHER_ARCH_MARKERS = {
	arm64: ["-x64", "-ia32", "-arm-", "-armv7", "-s390x", "-ppc64", "-riscv64", "-loong64", "-mips", "wasm32"],
	x64: ["-arm64", "-ia32", "-arm-", "-armv7", "-s390x", "-ppc64", "-riscv64", "-loong64", "-mips", "wasm32"],
};

/** Whether an optional/platform package name belongs to a different OS or CPU architecture than `target`. */
export function isForeignPlatformPackage(name, target) {
	const lower = name.toLowerCase();
	const osMarkers = OTHER_OS_MARKERS[target.os] ?? [];
	const archMarkers = OTHER_ARCH_MARKERS[target.arch] ?? [];
	if (osMarkers.some((marker) => lower.includes(marker))) return true;
	if (archMarkers.some((marker) => lower.includes(marker))) return true;
	if (target.os !== "linux" && (lower.includes("musl") || lower.includes("-gnu"))) return true;
	if (target.os !== "darwin" && lower === "fsevents") return true;
	return false;
}

/**
 * Resolve the minimal transitive dependency package names rooted at `seeds` inside `nodeModulesDir`,
 * filtering out packages for other platforms/architectures.
 */
export function collectExternalClosure(nodeModulesDir, seeds, target) {
	const seen = new Set();
	const queue = [...seeds];
	while (queue.length > 0) {
		const pkg = queue.pop();
		if (pkg === undefined || seen.has(pkg)) continue;
		if (isForeignPlatformPackage(pkg, target)) continue;
		const manifestPath = join(nodeModulesDir, pkg, "package.json");
		if (!existsSync(manifestPath)) continue;
		seen.add(pkg);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			continue;
		}
		const deps = {
			...(manifest.dependencies ?? {}),
			...(manifest.optionalDependencies ?? {}),
		};
		for (const dep of Object.keys(deps)) {
			if (!seen.has(dep) && !isForeignPlatformPackage(dep, target)) {
				queue.push(dep);
			}
		}
	}
	return [...seen].sort();
}

/** Resolve the esbuild CLI binary installed in the repository's `node_modules`. */
function esbuildBin(root = ROOT) {
	const win = process.platform === "win32";
	const candidate = join(root, "node_modules", ".bin", win ? "esbuild.cmd" : "esbuild");
	if (existsSync(candidate)) return candidate;
	const archBin = join(root, "node_modules", "@esbuild", `${process.platform}-${process.arch}`, win ? "esbuild.exe" : "bin/esbuild");
	if (existsSync(archBin)) return archBin;
	throw new Error(`esbuild binary not found under ${join(root, "node_modules")}`);
}

/** Copy a directory resolving symlinked package roots, skipping broken symlinks. */
function copyPackageDir(from, to) {
	const realFrom = lstatSync(from).isSymbolicLink() ? realpathSync(from) : from;
	mkdirSync(dirname(to), { recursive: true });
	cpSync(realFrom, to, { recursive: true, dereference: true });
}

/**
 * Self-contained Dazzi MCP server launcher written to `<tools>/librarian/dist/mcp-server.js`.
 *
 * Mirrors `src/main/mcp-server.ts` without importing `electron` or touching `app.asar`:
 * prepends `<tools>/bin` (from `AUTORAG_TOOLS_DIR` or relative to this file) onto `PATH`,
 * appends standard POSIX user tool paths, and runs `./mcp/index.js`.
 */
const STANDALONE_MCP_LAUNCHER = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { delimiter, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inferredTools = join(here, "..", "..");
const toolsRoot = process.env.AUTORAG_TOOLS_DIR?.trim() || inferredTools;
const toolsBin = join(toolsRoot, "bin");
const pathKey = process.platform === "win32"
\t? (Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path")
\t: "PATH";

const existing = (process.env[pathKey] ?? "").split(delimiter).filter((entry) => entry.length > 0);
if (process.platform !== "win32") {
\tconst home = process.env.HOME;
\tconst extra = [
\t\t...(home ? [posix.join(home, ".cargo", "bin"), posix.join(home, ".local", "bin")] : []),
\t\t"/opt/homebrew/bin",
\t\t"/usr/local/bin",
\t\t"/usr/bin",
\t\t"/bin",
\t\t"/usr/sbin",
\t\t"/sbin",
\t];
\tfor (const dir of extra) {
\t\tif (!existing.includes(dir)) existing.push(dir);
\t}
}
if (existsSync(toolsBin)) {
\tconst filtered = existing.filter((entry) =>
\t\tprocess.platform === "win32" ? entry.toLowerCase() !== toolsBin.toLowerCase() : entry !== toolsBin,
\t);
\tprocess.env[pathKey] = [toolsBin, ...filtered].join(delimiter);
} else {
\tprocess.env[pathKey] = existing.join(delimiter);
}

try {
\tconst { main } = await import("./mcp/index.js");
\tawait main();
} catch (error) {
\tprocess.stderr.write(\`\${error instanceof Error ? (error.stack ?? error.message) : String(error)}\\n\`);
\tprocess.exitCode = 1;
}
`;

/**
 * Bundle `@autorag/librarian`'s plain-Node entrypoints into `outDir`.
 * Returns `{ version, files, bytes }`.
 */
export function bundleLibrarian({ outDir, platformId = hostPlatformId(), root = ROOT }) {
	const target = PLATFORMS[platformId];
	if (target === undefined) throw new Error(`Unknown platform ${platformId}`);

	const nodeModules = join(root, "node_modules");
	const librarianDir = join(nodeModules, "@autorag", "librarian");
	const librarianManifestPath = join(librarianDir, "package.json");
	if (!existsSync(librarianManifestPath)) {
		throw new Error(`@autorag/librarian is not installed at ${librarianDir}; run \`node scripts/sync-librarian.mjs\` and \`bun install\` first`);
	}
	const librarianManifest = JSON.parse(readFileSync(librarianManifestPath, "utf8"));
	const cliEntry = join(librarianDir, "dist", "cli", "index.js");
	const mcpEntry = join(librarianDir, "dist", "mcp", "index.js");
	const parseWorkerEntry = join(librarianDir, "dist", "parser", "parse-worker.js");
	for (const required of [cliEntry, mcpEntry, parseWorkerEntry]) {
		if (!existsSync(required)) throw new Error(`Missing librarian build artifact: ${required}`);
	}

	rmSync(outDir, { recursive: true, force: true });
	const distDir = join(outDir, "dist");
	mkdirSync(distDir, { recursive: true });

	// 1. Bundle CLI, MCP server, and isolated parse worker with code splitting so shared code lands once.
	// Define `PI_BUNDLED_NODE=true` so `@earendil-works/pi-coding-agent`'s extension loader resolves
	// `typebox` and `@earendil-works/pi-*` through its built-in `VIRTUAL_MODULES` map instead of
	// probing sibling workspace paths on disk.
	const externalFlags = LIBRARIAN_BUNDLE_EXTERNALS.map((pkg) => `--external:${pkg}`);
	const banner = 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);';
	const bin = esbuildBin(root);
	run(bin, [
		cliEntry,
		mcpEntry,
		parseWorkerEntry,
		"--bundle",
		"--splitting",
		"--platform=node",
		"--target=node24",
		"--format=esm",
		"--define:PI_BUNDLED_NODE=true",
		`--outdir=${distDir}`,
		...externalFlags,
		`--banner:js=${banner}`,
		"--log-level=error",
	]);

	// 2. Write minimal package.json (so Node treats `dist/` as ESM and librarian reads its version) + MCP launcher.
	writeFileSync(
		join(outDir, "package.json"),
		`${JSON.stringify({ name: librarianManifest.name, version: librarianManifest.version, type: "module", private: true }, null, 2)}\n`,
	);
	writeFileSync(join(distDir, "mcp-server.js"), STANDALONE_MCP_LAUNCHER);

	// 3. Copy runtime data directories (`skills`, `internal-skills`, `licenses`, and on Windows `vendor/everything`).
	for (const assetDir of ["skills", "internal-skills", "licenses"]) {
		const src = join(librarianDir, assetDir);
		if (existsSync(src)) cpSync(src, join(outDir, assetDir), { recursive: true, dereference: true });
	}
	if (target.os === "win32") {
		const everything = join(librarianDir, "vendor", "everything");
		if (existsSync(everything)) cpSync(everything, join(outDir, "vendor", "everything"), { recursive: true, dereference: true });
	}

	// 4. Copy minimal external native/WASM closure into `<outDir>/node_modules`.
	const closure = collectExternalClosure(nodeModules, LIBRARIAN_EXTERNAL_SEEDS, target);
	const outModules = join(outDir, "node_modules");
	mkdirSync(outModules, { recursive: true });
	for (const pkg of closure) {
		copyPackageDir(join(nodeModules, pkg), join(outModules, pkg));
	}
	// Prune foreign native prebuilds and non-runtime files from the copied closure.
	pruneNativeForPlatform(outModules, target);
	// Drop unused pdfjs-dist subdirectories (web viewer, types, modern build — kordoc only loads legacy/ + cmaps/ + standard_fonts/ + wasm/ + iccs/).
	const pdfjsDir = join(outModules, "pdfjs-dist");
	if (existsSync(pdfjsDir)) {
		for (const unused of ["web", "types", "build", "image_decoders"]) {
			rmSync(join(pdfjsDir, unused), { recursive: true, force: true });
		}
	}
	pruneDeadWeight(outModules);

	// Count resulting files.
	let files = 0;
	const count = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) count(full);
			else files += 1;
		}
	};
	count(outDir);
	const bytes = dirSizeBytes(outDir);
	log(`bundled standalone librarian ${librarianManifest.version} (${files} files, ${mb(bytes)}, ${closure.length} external pkgs) -> ${outDir}`);
	return { version: librarianManifest.version, files, bytes, externals: closure };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const option = (name) => {
		const idx = args.indexOf(name);
		return idx >= 0 ? args[idx + 1] : undefined;
	};
	const platformId = option("--platform") ?? hostPlatformId();
	const outDir = resolve(option("--out") ?? join(ROOT, "build", "stage", platformId, "tools", "librarian"));
	bundleLibrarian({ outDir, platformId });
}
