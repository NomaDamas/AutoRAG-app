/**
 * Single source of truth for pinned tool versions, checksums, and librarian-derived
 * version floors. Both the release stager (`stage-tools.mjs`) and the packaged app
 * (`src/main/tool-versions.ts`) read `src/shared/tool-pins.json`.
 *
 * Floors for tools the librarian checks itself (`MINSYNC_MIN_VERSION`, `DUPEY_MIN_VERSION`,
 * `JIKJI_MIN_VERSION`) are derived directly from the installed `@autorag/librarian` package
 * rather than duplicated as separate constants. When `tool-pins.json` carries an additional
 * app floor (for tools the librarian does not publish a constant for, such as mailcrawl and
 * lazykatok), it is merged here — and a conflict where a declared floor is below what the
 * librarian requires fails loudly.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const TOOL_PINS_PATH = join(ROOT, "src", "shared", "tool-pins.json");

/** Compare dotted numeric versions: `a > b` -> positive, `a < b` -> negative, equal -> 0. */
export function compareVersions(a, b) {
	const left = a.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Load and return `src/shared/tool-pins.json`. */
export function loadToolPins(pinsPath = TOOL_PINS_PATH) {
	return JSON.parse(readFileSync(pinsPath, "utf8"));
}

const LIBRARIAN_CONSTANT_FILES = [
	{ tool: "minsync", constant: "MINSYNC_MIN_VERSION", relPath: join("dist", "minsync", "version.d.ts") },
	{ tool: "dupey", constant: "DUPEY_MIN_VERSION", relPath: join("dist", "dupey", "version.d.ts") },
	{ tool: "jikji", constant: "JIKJI_MIN_VERSION", relPath: join("dist", "jikji", "version.d.ts") },
];

/**
 * Extract a string constant (`export declare const NAME = "X.Y.Z";` or `var NAME = "X.Y.Z"`)
 * from the installed `@autorag/librarian` package.
 */
function readConstant(librarianRoot, relPath, constant) {
	const target = join(librarianRoot, relPath);
	if (existsSync(target)) {
		const text = readFileSync(target, "utf8");
		const match = new RegExp(`\\b${constant}\\s*=\\s*"([0-9]+\\.[0-9]+\\.[0-9]+)"`, "u").exec(text);
		if (match !== null) return match[1];
	}
	// Fallback: compiled core bundle carries the same literal.
	const core = join(librarianRoot, "dist", "core.js");
	if (existsSync(core)) {
		const text = readFileSync(core, "utf8");
		const match = new RegExp(`\\b${constant}\\s*=\\s*"([0-9]+\\.[0-9]+\\.[0-9]+)"`, "u").exec(text);
		if (match !== null) return match[1];
	}
	throw new Error(`Could not read ${constant} from ${librarianRoot}; run scripts/sync-librarian.mjs first.`);
}

/**
 * Derive required minimum versions from the installed `@autorag/librarian` package.
 * Returns `{ minsync, dupey, jikji }`.
 */
export function readLibrarianRequirements(librarianRoot = join(ROOT, "node_modules", "@autorag", "librarian")) {
	const requirements = {};
	for (const { tool, constant, relPath } of LIBRARIAN_CONSTANT_FILES) {
		requirements[tool] = readConstant(librarianRoot, relPath, constant);
	}
	return requirements;
}

/**
 * Combine librarian-derived floors with app-level floors in `tool-pins.json`.
 * Fails if a declared floor in `tool-pins.json` is lower than what the librarian requires,
 * preventing stale floors from drifting behind `@autorag/librarian`.
 */
export function deriveVersionFloors(pins = loadToolPins(), librarianRequirements = readLibrarianRequirements()) {
	const floors = { ...librarianRequirements };
	for (const [name, entry] of Object.entries(pins.tools ?? {})) {
		if (typeof entry.floor !== "string") continue;
		const librarianFloor = librarianRequirements[name];
		if (librarianFloor !== undefined && compareVersions(entry.floor, librarianFloor) < 0) {
			throw new Error(
				`${name} floor ${entry.floor} in tool-pins.json disagrees with @autorag/librarian's required ${librarianFloor}. Remove the stale floor or raise it to at least ${librarianFloor}.`,
			);
		}
		floors[name] = librarianFloor !== undefined && compareVersions(librarianFloor, entry.floor) > 0 ? librarianFloor : entry.floor;
	}
	return floors;
}

/** What each floor guarantees, for clear error messages when a pin or stage falls behind. */
const FLOOR_REASONS = {
	minsync: "the pinned @autorag/librarian refuses an older minsync (MINSYNC_MIN_VERSION)",
	dupey: "the pinned @autorag/librarian refuses an older dupey (DUPEY_MIN_VERSION)",
	jikji: "the pinned @autorag/librarian refuses an older jikji (JIKJI_MIN_VERSION)",
	"@nomadamas/mailcrawl": "mailcrawl 0.3.0+ is required for `--source files` local archive support and the shared embedding daemon's OpenAI route",
	lazykatok: "lazykatok 0.3.3+ is required to embed through the shared embedding daemon's OpenAI route",
};

/** Fail when a resolved or pinned tool is older than its floor. */
export function assertVersionFloor(name, version, floor) {
	if (compareVersions(version, floor) < 0) {
		const reason = FLOOR_REASONS[name] ?? "it is the first release this build supports";
		throw new Error(`${name} ${version} is below the required ${floor}: ${reason}. Pin a newer ${name} or wait for its release.`);
	}
}

/** Verify every pinned tool in `tool-pins.json` satisfies its derived floor. */
export function assertPinsMeetFloors(pins = loadToolPins(), floors = deriveVersionFloors(pins)) {
	for (const [name, floor] of Object.entries(floors)) {
		const entry = pins.tools?.[name];
		if (entry === undefined) throw new Error(`tool-pins.json is missing a pin for ${name} (required >= ${floor}).`);
		assertVersionFloor(name, entry.version, floor);
	}
}

/**
 * Compare `tools/manifest.json` against `tool-pins.json` for the manifest's platform.
 * Returns `{ rows, formatted }` when every expected pinned entry matches; throws if
 * any tool differs in version or is missing from a full manifest.
 */
export function assertManifestMatchesPins(manifest, pins = loadToolPins(), options = {}) {
	const platform = manifest.platform;
	const onlySet = options.onlyNames !== undefined ? new Set(options.onlyNames) : null;
	const byName = new Map((manifest.tools ?? []).map((entry) => [entry.name, entry.version]));

	const expected = [];
	if (onlySet === null || onlySet.has("node") || onlySet.has("npm")) {
		expected.push({ name: "node", pinned: pins.node.version });
	}
	if (onlySet === null || onlySet.has("autorag")) {
		expected.push({ name: "autorag", pinned: pins.librarian.version });
	}
	for (const [name, entry] of Object.entries(pins.tools ?? {})) {
		if (Array.isArray(entry.platforms) && !entry.platforms.includes(platform)) continue;
		if (onlySet !== null && !onlySet.has(name) && !(entry.source === "npm" && onlySet.has("npm"))) continue;
		expected.push({ name, pinned: entry.version });
	}

	const rows = expected.map(({ name, pinned }) => {
		const actual = byName.get(name) ?? null;
		return { name, pinned, manifest: actual, ok: actual === pinned };
	});

	const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
	const pinWidth = Math.max(6, ...rows.map((r) => r.pinned.length));
	const lines = [
		`${"TOOL".padEnd(nameWidth)}  ${"PINNED".padEnd(pinWidth)}  MANIFEST`,
		...rows.map((r) => `${r.name.padEnd(nameWidth)}  ${r.pinned.padEnd(pinWidth)}  ${r.manifest ?? "(missing)"} ${r.ok ? "OK" : "MISMATCH"}`),
	];
	const formatted = lines.join("\n");

	const mismatches = rows.filter((r) => !r.ok);
	if (mismatches.length > 0) {
		const summary = mismatches
			.map((r) => (r.manifest === null ? `${r.name}: pinned ${r.pinned}, missing from tools/manifest.json` : `${r.name}: pinned ${r.pinned}, manifest ${r.manifest}`))
			.join("; ");
		throw new Error(`tools/manifest.json disagrees with src/shared/tool-pins.json (${summary}).\n${formatted}`);
	}

	return { rows, formatted };
}

/** Shared release tool source patterns (used by both stage-tools.mjs and refresh-pins.mjs). */
export const GITHUB_ASSET_PATTERNS = {
	minsync: { "darwin-arm64": /aarch64-apple-darwin\.tar\.gz$/, "win32-x64": /x86_64-pc-windows-msvc\.zip$/ },
	rhwp: { "darwin-arm64": /macos-aarch64\.tar\.gz$/, "win32-x64": /windows-x86_64\.zip$/ },
	himalaya: { "darwin-arm64": /aarch64-darwin\.tgz$/, "win32-x64": /x86_64-windows\.zip$/ },
	rclone: { "darwin-arm64": /osx-arm64\.zip$/, "win32-x64": /windows-amd64\.zip$/ },
	"lark-cli": { "darwin-arm64": /darwin-arm64\.tar\.gz$/, "win32-x64": /windows-amd64\.zip$/ },
	discrawl: { "darwin-arm64": /_darwin_arm64\.tar\.gz$/, "win32-x64": /_windows_amd64\.zip$/ },
	telecrawl: { "darwin-arm64": /_darwin_arm64\.tar\.gz$/, "win32-x64": /_windows_amd64\.zip$/ },
	wacrawl: { "darwin-arm64": /_darwin_arm64\.tar\.gz$/, "win32-x64": /_windows_amd64\.zip$/ },
	lazykatok: { "darwin-arm64": /^lazykatok-\d+\.\d+\.\d+-aarch64-apple-darwin\.tar\.gz$/ },
	slacrawl: { "darwin-arm64": /_darwin_arm64\.tar\.gz$/ },
	notcrawl: { "darwin-arm64": /_darwin_arm64\.tar\.gz$/ },
};
