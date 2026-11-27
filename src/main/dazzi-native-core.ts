import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Loader for Dazzi's bundled Rust N-API core (`vendor/dazzi-core.node`).
 *
 * The compiled native binary ships inside every `.dmg` and `.exe` build as the
 * single primary implementation of Dazzi's hot paths:
 *   - compiled path & glob exclusion matching (`path-exclusion.ts`, `index-status.ts`)
 *   - async libuv thread-pool index-map tree scan (`index-map.ts`)
 *   - async libuv thread-pool directory pre-scan (`onboarding-scan.ts`)
 *   - async libuv thread-pool folder survey (`folder-stats.ts`)
 *   - fast directory listing & recursive filename walk (`fs-service.ts`)
 *
 * There is no global env-var toggle; TypeScript fallbacks exist solely as a
 * safety net when the native binary fails to load or throws a runtime error.
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

export interface NativeMirrorEntry {
	readonly sourcePath: string;
	readonly stagedPath: string;
	readonly sourceMtimeNs: number;
	readonly sourceSizeBytes: number;
}

export interface NativeIndexMapCounts {
	readonly indexed: number;
	readonly stale: number;
	readonly unindexed: number;
	readonly excluded: number;
	readonly unindexable: number;
}

export interface NativeScanFile {
	readonly name: string;
	readonly path: string;
	readonly state: "indexed" | "stale" | "unindexed" | "excluded" | "unindexable";
}

export interface NativeScanDir {
	readonly name: string;
	readonly path: string;
	readonly files: NativeScanFile[];
	readonly dirs: NativeScanDir[];
	readonly sealed?: NativeIndexMapCounts | null;
}

export interface NativeIndexScopeResult {
	readonly roots: NativeScanDir[];
	readonly truncated: boolean;
}

export interface NativeSearchRoot {
	readonly path: string;
	readonly location: string;
}

export interface NativeSearchHit {
	readonly entry: NativeDirEntry;
	readonly location: string;
}

export interface NativeSheetPreview {
	readonly names: readonly string[];
	readonly rows: readonly (readonly string[])[];
	readonly sheetsRead: readonly string[];
	readonly scannedRows: number;
	readonly namesPass: boolean;
	readonly handled: boolean;
}

export interface NativeArchiveEntry {
	readonly name: string;
	readonly size: number;
	readonly modified: number | null;
}

export interface NativeArchiveListResult {
	readonly status: "ok" | "encrypted" | "corrupt" | "tooLarge" | "tooManyEntries" | "unsupported";
	readonly entries: readonly NativeArchiveEntry[];
}

export interface NativeFinderXattrs {
	readonly tags?: readonly string[] | null;
	readonly comment?: string | null;
	readonly tagsError?: string | null;
	readonly commentError?: string | null;
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
	scanIndexScopeNative(
		roots: readonly string[],
		exclusions: readonly string[],
		supportedExtensions: readonly string[],
		productArtifacts: readonly string[],
		mirrorEntries: readonly NativeMirrorEntry[],
		unindexablePaths: readonly string[],
		maxEntries: number,
	): Promise<NativeIndexScopeResult>;
	walkSearchNative(
		roots: readonly NativeSearchRoot[],
		needle: string,
		platform: string,
		maxDepth: number,
		maxResults: number,
		discordRoots: readonly string[],
		control: NativeWalkControl,
	): Promise<NativeSearchHit[]>;
	previewSheetNative(
		path: string,
		sheetIndex: number,
		maxScanRows: number,
		maxRows: number,
		maxCols: number,
	): Promise<NativeSheetPreview>;
	downscaleAndEncodePngNative(rgba: Uint8Array, width: number, height: number, maxSide: number): Buffer;
	decodeTiffPreviewNative(path: string, maxSide: number): Promise<Buffer | null>;
	findPdfAnchorPagesNative(path: string, excerpts: readonly string[], maxCandidates: number): Promise<number[]>;
	listArchiveNative(path: string, maxOutputBytes: number, maxEntries: number): Promise<NativeArchiveListResult>;
	listTarBytesNative(bytes: Uint8Array, maxEntries: number): NativeArchiveListResult;
	readFinderXattrsNative(path: string): NativeFinderXattrs;
	readFinderTagsNative(path: string): string[];
	writeFinderTagsNative(path: string, stored: readonly string[]): void;
	decodePlistToJsonNative(bytes: Uint8Array): string;
	encodeBinaryPlistStringsNative(values: readonly string[]): Buffer;
	decodePlistStringsNative(bytes: Uint8Array): string[] | null;
	lookupWindowsFileKindsNative(extensions: readonly string[]): (string | null)[] | null;
}

let cachedAddon: DazziNativeCore | null | undefined;
let loadErrorLogged = false;

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
 * Load Dazzi's bundled Rust N-API core.
 * Returns `null` only if loading the native binary fails (e.g. corrupt or incompatible binary),
 * allowing callers to degrade safely to their emergency TypeScript fallback.
 */
export function loadDazziNativeCore(): DazziNativeCore | null {
	if (cachedAddon !== undefined) return cachedAddon;
	const addonPath = resolveAddonPath();
	if (addonPath === null) {
		if (!loadErrorLogged) {
			loadErrorLogged = true;
			console.error("[dazzi-core] native Rust binary not found; falling back to TypeScript");
		}
		cachedAddon = null;
		return null;
	}
	try {
		const req = createRequire(import.meta.url);
		cachedAddon = req(addonPath) as DazziNativeCore;
		return cachedAddon;
	} catch (error) {
		if (!loadErrorLogged) {
			loadErrorLogged = true;
			console.error("[dazzi-core] failed to load native Rust binary, falling back to TypeScript:", error instanceof Error ? error.message : error);
		}
		cachedAddon = null;
		return null;
	}
}
