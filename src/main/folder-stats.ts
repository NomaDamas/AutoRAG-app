import type { Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { appDataNameOn, type FolderMeasure } from "../shared/smart-indexing-criteria";
import { SCAN_SKIP_DIR_NAMES } from "./onboarding-scan";

/**
 * Counts what is in a folder for the smart-indexing agent: every file by
 * extension, subfolders included, and which of them the index would read. It
 * walks the way the pre-scan does (dot folders and the app's skipped names are
 * never entered, symbolic links are not followed, a file over the size cap is not
 * read), so a number here is the number the index and the folder pre-scan use.
 *
 * Asynchronous and cancellable: a home folder holds hundreds of thousands of
 * entries and the Electron main thread is shared with every window.
 */

export interface FolderStatsOptions {
	/** Lower-case extensions with the dot that the index reads. */
	readonly supportedExtensions: ReadonlySet<string>;
	/** A source over this is not read by the index. */
	readonly maxSourceBytes: number;
	readonly skipDirNames?: Readonly<Record<string, true>>;
	/** Entries visited before the walk stops and the counts are marked partial. */
	readonly maxEntries?: number;
}

export interface ExtensionCount {
	readonly extension: string;
	readonly files: number;
	/** The index reads this extension. */
	readonly indexed: boolean;
}

export interface ChildStats {
	readonly name: string;
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly measure: FolderMeasure;
}

export interface FolderStats {
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly indexedBytes: number;
	/** Every extension with its file count, most files first; files without an extension are listed as "(none)". */
	readonly extensions: readonly ExtensionCount[];
	/** Immediate subfolders, most indexed files first. */
	readonly children: readonly ChildStats[];
	/** The walk was cut short (entry limit or cancel): the counts are a lower bound. */
	readonly truncated: boolean;
	readonly measure: FolderMeasure;
}

const DEFAULT_MAX_ENTRIES = 400_000;

/** Counts for one subfolder, or for the files directly in the folder (`name` null). */
interface Bucket {
	indexedFiles: number;
	totalFiles: number;
	indexedBytes: number;
	readonly extensions: Map<string, number>;
	readonly indexedExtensions: Map<string, number>;
	readonly stems: Set<string>;
}

function newBucket(): Bucket {
	return { indexedFiles: 0, totalFiles: 0, indexedBytes: 0, extensions: new Map(), indexedExtensions: new Map(), stems: new Set() };
}

/** A file name without its extension and with every run of digits as one `#`: "log-07.txt" and "log-8.txt" are the same name. */
function stemOf(fileName: string, extension: string): string {
	return fileName.slice(0, fileName.length - extension.length).toLowerCase().replace(/\d+/gu, "#");
}

function measureOf(buckets: readonly Bucket[], appDataName: string | null): FolderMeasure {
	let indexedFiles = 0;
	let totalFiles = 0;
	const indexedExtensions = new Map<string, number>();
	const stems = new Set<string>();
	for (const bucket of buckets) {
		indexedFiles += bucket.indexedFiles;
		totalFiles += bucket.totalFiles;
		for (const [extension, files] of bucket.indexedExtensions) indexedExtensions.set(extension, (indexedExtensions.get(extension) ?? 0) + files);
		for (const stem of bucket.stems) stems.add(stem);
	}
	let topExtension: string | null = null;
	let top = 0;
	for (const [extension, files] of indexedExtensions) {
		if (files > top || (files === top && topExtension !== null && extension < topExtension)) {
			topExtension = extension;
			top = files;
		}
	}
	return {
		indexedFiles,
		totalFiles,
		topExtension,
		topExtensionShare: indexedFiles === 0 ? 0 : top / indexedFiles,
		stemRatio: indexedFiles === 0 ? 0 : stems.size / indexedFiles,
		appDataName,
	};
}

/**
 * Measures `folder`. `names` are the folder names from the chosen folder (not
 * included) down to `folder` (included), used to spot an app-data name on the
 * way; it is empty for a chosen folder itself.
 */
export async function measureFolder(folder: string, names: readonly string[], options: FolderStatsOptions, signal: AbortSignal): Promise<FolderStats> {
	const skip = options.skipDirNames ?? SCAN_SKIP_DIR_NAMES;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const own = newBucket();
	const children = new Map<string, Bucket>();
	let scanned = 0;
	let truncated = false;

	const queue: { readonly dir: string; readonly bucket: Bucket; readonly isFolder: boolean }[] = [{ dir: folder, bucket: own, isFolder: true }];
	for (let head = 0; head < queue.length; head += 1) {
		if (signal.aborted) {
			truncated = true;
			break;
		}
		const { dir, bucket, isFolder } = queue[head] as (typeof queue)[number];
		let handle: Dir;
		try {
			handle = await opendir(dir);
		} catch {
			continue;
		}
		for await (const entry of handle) {
			if (signal.aborted || scanned >= maxEntries) {
				truncated = true;
				break;
			}
			scanned += 1;
			if (entry.isDirectory()) {
				// The same rule as the pre-scan and the refresh: dot folders and the skipped names are never indexed.
				if (entry.name.startsWith(".") || skip[entry.name.toLowerCase()] === true) continue;
				let child = bucket;
				if (isFolder) {
					child = newBucket();
					children.set(entry.name, child);
				}
				queue.push({ dir: join(dir, entry.name), bucket: child, isFolder: false });
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = extname(entry.name).toLowerCase();
			const label = extension === "" ? "(none)" : extension;
			bucket.totalFiles += 1;
			bucket.extensions.set(label, (bucket.extensions.get(label) ?? 0) + 1);
			if (!options.supportedExtensions.has(extension)) continue;
			let size: number;
			try {
				size = (await stat(join(dir, entry.name))).size;
			} catch {
				continue;
			}
			if (size > options.maxSourceBytes) continue;
			bucket.indexedFiles += 1;
			bucket.indexedBytes += size;
			bucket.indexedExtensions.set(extension, (bucket.indexedExtensions.get(extension) ?? 0) + 1);
			bucket.stems.add(stemOf(entry.name, extension));
		}
		if (truncated && scanned >= maxEntries) break;
	}

	const all = [own, ...children.values()];
	const extensionTotals = new Map<string, number>();
	for (const bucket of all) for (const [extension, files] of bucket.extensions) extensionTotals.set(extension, (extensionTotals.get(extension) ?? 0) + files);
	const extensions = [...extensionTotals]
		.map(([extension, files]): ExtensionCount => ({ extension, files, indexed: options.supportedExtensions.has(extension) }))
		.sort((a, b) => b.files - a.files || a.extension.localeCompare(b.extension));
	const childStats = [...children]
		.map(([name, bucket]): ChildStats => ({ name, indexedFiles: bucket.indexedFiles, totalFiles: bucket.totalFiles, measure: measureOf([bucket], appDataNameOn([...names, name])) }))
		.sort((a, b) => b.indexedFiles - a.indexedFiles || b.totalFiles - a.totalFiles || a.name.localeCompare(b.name));
	const measure = measureOf(all, appDataNameOn(names));
	return {
		indexedFiles: measure.indexedFiles,
		totalFiles: measure.totalFiles,
		indexedBytes: all.reduce((sum, bucket) => sum + bucket.indexedBytes, 0),
		extensions,
		children: childStats,
		truncated,
		measure,
	};
}
