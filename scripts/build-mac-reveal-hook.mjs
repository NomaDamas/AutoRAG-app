#!/usr/bin/env node
/**
 * Compiles `src/main/native/mac-reveal-hook.mm` into the N-API addon
 * `src/main/vendor/mac-reveal-hook.node` on macOS.
 *
 * Uses only Node's own N-API headers (`node_api.h`) + Apple Clang + Cocoa/Carbon
 * frameworks, so it is ABI-stable across Node and Electron versions without
 * needing Electron headers or node-gyp downloads.
 *
 * No-op on non-macOS hosts so cross-platform builds stay clean.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src", "main", "native", "mac-reveal-hook.mm");
const OUT_DIR = join(ROOT, "src", "main", "vendor");
const OUTPUT = join(OUT_DIR, "mac-reveal-hook.node");

if (process.platform !== "darwin") {
	process.exit(0);
}

if (!existsSync(SOURCE)) {
	console.error(`[mac-reveal-hook] missing source: ${SOURCE}`);
	process.exit(1);
}

const force = process.argv.includes("--force");
if (!force && existsSync(OUTPUT)) {
	const srcMtime = statSync(SOURCE).mtimeMs;
	const outMtime = statSync(OUTPUT).mtimeMs;
	if (outMtime >= srcMtime) {
		process.exit(0);
	}
}

function findNodeIncludeDir() {
	const candidates = [
		join(dirname(process.execPath), "..", "include", "node"),
		"/opt/homebrew/include/node",
		"/usr/local/include/node",
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "node_api.h"))) return candidate;
	}
	return null;
}

const nodeInclude = findNodeIncludeDir();
if (nodeInclude === null) {
	console.warn("[mac-reveal-hook] node_api.h not found; skipping native reveal hook compile");
	process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
const args = [
	"-std=c++17",
	"-ObjC++",
	"-fobjc-arc",
	"-O2",
	"-shared",
	"-undefined",
	"dynamic_lookup",
	`-I${nodeInclude}`,
	"-framework",
	"Cocoa",
	"-framework",
	"Carbon",
	"-o",
	OUTPUT,
	SOURCE,
];

const res = spawnSync("clang++", args, { stdio: "inherit" });
if (res.status !== 0) {
	console.error(`[mac-reveal-hook] clang++ failed with exit code ${res.status ?? "unknown"}`);
	process.exit(res.status ?? 1);
}
console.log(`[mac-reveal-hook] built ${OUTPUT}`);
