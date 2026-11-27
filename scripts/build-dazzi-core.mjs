#!/usr/bin/env node
/**
 * Compiles `src/main/native/dazzi-core` (Rust napi-rs crate) into
 * `src/main/vendor/dazzi-core.node` (or a cross-target `.node` file).
 *
 * Uses pure N-API (ABI-stable across Node and Electron versions without Electron
 * headers or node-gyp). Every release build (.dmg / .exe) bundles this binary
 * inside `out/main/vendor/dazzi-core.node`, so Rust is the single primary
 * implementation at runtime.
 *
 * Usage:
 *   node scripts/build-dazzi-core.mjs             # build for host platform (skip if up-to-date)
 *   node scripts/build-dazzi-core.mjs --force     # rebuild unconditionally
 *   node scripts/build-dazzi-core.mjs --target x86_64-pc-windows-msvc  # cross-compile via cargo-xwin
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_DIR = join(ROOT, "src", "main", "native", "dazzi-core");
const MANIFEST = join(CRATE_DIR, "Cargo.toml");
const SOURCE_FILES = [
	MANIFEST,
	join(CRATE_DIR, "build.rs"),
	join(CRATE_DIR, "src", "lib.rs"),
	join(CRATE_DIR, "src", "preview.rs"),
	join(CRATE_DIR, "src", "finder_meta.rs"),
];
const OUT_DIR = join(ROOT, "src", "main", "vendor");

const force = process.argv.includes("--force");
const targetIdx = process.argv.indexOf("--target");
const target = targetIdx >= 0 ? process.argv[targetIdx + 1] : undefined;

const outFile = target ? join(OUT_DIR, `dazzi-core.${target}.node`) : join(OUT_DIR, "dazzi-core.node");

if (!existsSync(MANIFEST)) {
	console.error(`[dazzi-core] missing manifest: ${MANIFEST}`);
	process.exit(1);
}

const newestSrcMtime = Math.max(...SOURCE_FILES.filter(existsSync).map((f) => statSync(f).mtimeMs));
if (!force && existsSync(outFile) && statSync(outFile).mtimeMs >= newestSrcMtime) {
	process.exit(0);
}

const cargoCheck = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (cargoCheck.status !== 0) {
	// If a prebuilt host binary is already staged in src/main/vendor/dazzi-core.node, keep it;
	// otherwise fail loudly so a release/dev build never silently ships without the Rust core.
	if (existsSync(outFile)) {
		console.warn(`[dazzi-core] cargo not found; reusing existing ${outFile}`);
		process.exit(0);
	}
	console.error(
		"[dazzi-core] Rust toolchain (`cargo`) is required to build `dazzi-core.node`. Install rustup (https://rustup.rs) and retry.",
	);
	process.exit(1);
}

function resolveCargoTargetDir() {
	const meta = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", MANIFEST], {
		encoding: "utf8",
	});
	if (meta.status === 0 && meta.stdout) {
		try {
			const parsed = JSON.parse(meta.stdout);
			if (typeof parsed.target_directory === "string" && parsed.target_directory.length > 0) {
				return parsed.target_directory;
			}
		} catch {
			// Fall back below.
		}
	}
	return process.env.CARGO_TARGET_DIR || join(CRATE_DIR, "target");
}

function libArtifactName(forTarget) {
	const isWin = forTarget ? forTarget.includes("windows") : process.platform === "win32";
	const isMac = forTarget ? forTarget.includes("apple-darwin") : process.platform === "darwin";
	if (isWin) return "dazzi_native_core.dll";
	if (isMac) return "libdazzi_native_core.dylib";
	return "libdazzi_native_core.so";
}

const useXwin = Boolean(target && target.includes("windows-msvc") && process.platform !== "win32");
const buildCmd = "cargo";
const buildArgs = useXwin
	? ["xwin", "build", "--release", "--target", target, "--manifest-path", MANIFEST]
	: ["build", "--release", ...(target ? ["--target", target] : []), "--manifest-path", MANIFEST];

const env = { ...process.env };
if (target) {
	// Never leak host-specific `-C target-cpu=native` into cross-compilation builds.
	env.RUSTFLAGS = "";
}

const res = spawnSync(buildCmd, buildArgs, { stdio: "inherit", env });
if (res.status !== 0) {
	console.error(`[dazzi-core] cargo build failed with exit code ${res.status ?? "unknown"}`);
	process.exit(res.status ?? 1);
}

const targetDir = resolveCargoTargetDir();
const artifactPath = target
	? join(targetDir, target, "release", libArtifactName(target))
	: join(targetDir, "release", libArtifactName(undefined));

if (!existsSync(artifactPath)) {
	console.error(`[dazzi-core] expected built artifact not found: ${artifactPath}`);
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(artifactPath, outFile);
console.log(`[dazzi-core] built ${outFile}`);
