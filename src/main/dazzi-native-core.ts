import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Lazy loader for the optional Rust N-API core (`vendor/dazzi-core.node`).
 *
 * The native module accelerates CPU- and walk-heavy Dazzi operations identified
 * and verified with `fast-anything`:
 *   - compiled path & glob exclusion matching (`path-exclusion.ts`, `index-map.ts`, `index-status.ts`)
 *   - async (libuv thread pool) BFS directory pre-scan (`onboarding-scan.ts`)
 *   - async (libuv thread pool) folder survey aggregation (`folder-stats.ts`)
 *   - fast directory listing (`fs-service.ts`)
 *
 * Set `FAST_ANYTHING_DISABLE=1` (or `DAZZI_NATIVE_CORE_DISABLE=1`) at any time
 * to force the pure TypeScript fallback for A/B benchmarking or diagnostics.
 */

export interface NativeExclusionMatch {
	readonly kind: "path" | "glob";
	readonly entry: string;
}

export interface NativeCompiledExclusions {
	readonly allNative: boolean;
	find(path: string): NativeExclusionMatch | null;
	isExcluded(path: string): boolean;
}

export interface NativeWalkSnapshot {
	readonly files: number;
	readonly bytes: number;
	readonly onlineOnly: number;
}

export interface NativeWalkControl {
	cancel(): void;
	snapshot(): NativeWalkSnapshot;
}

export interface NativeFolderScanResult {
	readonly files: number;
	readonly bytes: number;
	readonly onlineOnly: number;
	readonly scanned: number;
}

export interface NativeExtensionCount {
	readonly extension: string;
	readonly files: number;
	readonly indexed: boolean;
}

export interface NativeModifiedSpread {
	readonly oldestMs: number;
	readonly newestMs: number;
	readonly spanDays: number;
	readonly sameDayShare: number;
}

export interface NativeSubfolder {
	readonly name: string;
	readonly totalFiles: number;
}

export interface NativeChildStats {
	readonly name: string;
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly extensions: readonly NativeExtensionCount[];
	readonly modified?: NativeModifiedSpread | null;
	readonly sample: readonly string[];
	readonly subfolders: readonly NativeSubfolder[];
}

export interface NativeFolderStats {
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly indexedBytes: number;
	readonly extensions: readonly NativeExtensionCount[];
	readonly children: readonly NativeChildStats[];
	readonly ownFiles: readonly string[];
	readonly sample: readonly string[];
	readonly modified?: NativeModifiedSpread | null;
	readonly truncated: boolean;
}

export interface NativeDirEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "folder" | "file";
	readonly ext: string;
	readonly size: number | null;
	readonly mtimeMs: number;
	readonly birthtimeMs?: number | null;
	readonly flags: number;
}

export interface NativeDirListing {
	readonly entries: NativeDirEntry[];
	readonly hadSkips: boolean;
}

export interface DazziNativeCore {
	canHandleExclusionsNatively(exclusions: readonly string[]): boolean;
	findExclusionBatch(exclusions: readonly string[], paths: readonly string[]): (NativeExclusionMatch | null)[];
	readonly CompiledExclusions: new (exclusions: readonly string[]) => NativeCompiledExclusions;
	readonly WalkControl: new () => NativeWalkControl;
	scanFolderNative(
		root: string,
		supportedExtensions: readonly string[],
		skipDirNames: readonly string[],
		maxSourceBytes: number,
		maxEntries: number,
		datalessPaths: readonly string[] | null,
		control: NativeWalkControl,
	): Promise<NativeFolderScanResult>;
	measureFolderNative(
		folder: string,
		supportedExtensions: readonly string[],
		skipDirNames: readonly string[],
		maxSourceBytes: number,
		maxEntries: number,
		sampleSize: number,
		control: NativeWalkControl,
	): Promise<NativeFolderStats>;
	listDirNative(dirPath: string, platform: string): NativeDirListing;
}

let cachedAddon: DazziNativeCore | null | undefined;

export function isNativeCoreDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.FAST_ANYTHING_DISABLE === "1" || env.DAZZI_NATIVE_CORE_DISABLE === "1";
}

function resolveAddonPath(): string | null {
	const baseDir = import.meta.dirname;
	const candidates = [
		join(baseDir, "vendor", "dazzi-core.node"),
		join(dirname(baseDir), "main", "vendor", "dazzi-core.node"),
		join(dirname(baseDir), "..", "main", "vendor", "dazzi-core.node"),
		join(process.resourcesPath ?? "", "app", "out", "main", "vendor", "dazzi-core.node"),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Load the optional Rust N-API core, or `null` when disabled or not built for this host.
 * Always checks `FAST_ANYTHING_DISABLE` / `DAZZI_NATIVE_CORE_DISABLE` live so A/B tests
 * can toggle it without reloading the process.
 */
export function loadDazziNativeCore(): DazziNativeCore | null {
	if (isNativeCoreDisabled()) return null;
	if (cachedAddon !== undefined) return cachedAddon;
	const addonPath = resolveAddonPath();
	if (addonPath === null) {
		cachedAddon = null;
		return null;
	}
	try {
		const req = createRequire(import.meta.url);
		cachedAddon = req(addonPath) as DazziNativeCore;
		return cachedAddon;
	} catch (error) {
		console.warn("[dazzi-core] could not load native Rust core, falling back to JS:", error instanceof Error ? error.message : error);
		cachedAddon = null;
		return null;
	}
}
