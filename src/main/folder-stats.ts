import type { Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { SCAN_SKIP_DIR_NAMES } from "./onboarding-scan";

/**
 * Collects what is in a folder for the smart-indexing agent: counts by extension,
 * subfolders included, when the files were last changed, and a spread of file
 * names. These are facts about names and times; no file is opened, and nothing here
 * decides what should be indexed. That judgment is the agent's.
 *
 * It walks the way the folder pre-scan does (dot folders and the app's skipped
 * names are never entered, symbolic links are not followed, a file over the size
 * cap is not read by the index), so the counts match what the index would take.
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
	/** File names kept as a spread sample per folder; default {@link DEFAULT_SAMPLE_NAMES}. */
	readonly sampleNames?: number;
}

export interface ExtensionCount {
	readonly extension: string;
	readonly files: number;
	/** The index reads this extension. */
	readonly indexed: boolean;
}

/** When the files in a folder were last changed. */
export interface ModifiedSpread {
	readonly oldest: Date;
	readonly newest: Date;
	/** Days between the oldest and the newest file. */
	readonly spanDays: number;
	/** Share of the files changed within one day of the median: near 1 means they were all written together. */
	readonly sameDayShare: number;
}

/** A folder directly inside a subfolder, with every file under it. */
export interface Subfolder {
	readonly name: string;
	readonly totalFiles: number;
}

export interface ChildStats {
	readonly name: string;
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly extensions: readonly ExtensionCount[];
	readonly modified: ModifiedSpread | null;
	/** A spread of file names from anywhere under the subfolder. */
	readonly sample: readonly string[];
	/** The folders directly inside it, most files first: a mixed folder shows its parts here. */
	readonly subfolders: readonly Subfolder[];
}

export interface FolderStats {
	readonly indexedFiles: number;
	readonly totalFiles: number;
	readonly indexedBytes: number;
	/** Every extension with its file count, most files first; files without an extension are listed as "(none)". */
	readonly extensions: readonly ExtensionCount[];
	/** Immediate subfolders, most files first. */
	readonly children: readonly ChildStats[];
	/** Names of the files directly in the folder (not in subfolders), up to the sample size. */
	readonly ownFiles: readonly string[];
	/** A spread of file names from anywhere under the folder. */
	readonly sample: readonly string[];
	readonly modified: ModifiedSpread | null;
	/** The walk was cut short (entry limit or cancel): the counts are a lower bound. */
	readonly truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 400_000;
const DEFAULT_SAMPLE_NAMES = 12;
const DAY_MS = 86_400_000;

interface Bucket {
	indexedFiles: number;
	totalFiles: number;
	indexedBytes: number;
	readonly extensions: Map<string, number>;
	/** Modification times (ms) of every file; a folder of a million files holds a million numbers, so only counts of days are kept past this. */
	readonly times: number[];
	/** Every file name, kept in walk order to take an even spread from. */
	readonly names: string[];
	/** Files per folder directly inside this one; filled only for a subfolder of the surveyed folder. */
	readonly below: Map<string, number>;
}

function newBucket(): Bucket {
	return { indexedFiles: 0, totalFiles: 0, indexedBytes: 0, extensions: new Map(), times: [], names: [], below: new Map() };
}

/** `count` names spread evenly over `names`, in their original order. */
function spread(names: readonly string[], count: number): string[] {
	if (names.length <= count) return [...names];
	const picked: string[] = [];
	for (let i = 0; i < count; i += 1) picked.push(names[Math.floor((i * names.length) / count)] as string);
	return picked;
}

function modifiedOf(times: readonly number[]): ModifiedSpread | null {
	if (times.length === 0) return null;
	const sorted = [...times].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] as number;
	const together = sorted.filter((time) => Math.abs(time - median) <= DAY_MS).length;
	const oldest = sorted[0] as number;
	const newest = sorted[sorted.length - 1] as number;
	return { oldest: new Date(oldest), newest: new Date(newest), spanDays: (newest - oldest) / DAY_MS, sameDayShare: together / sorted.length };
}

function extensionsOf(buckets: readonly Bucket[], supported: ReadonlySet<string>): ExtensionCount[] {
	const totals = new Map<string, number>();
	for (const bucket of buckets) for (const [extension, files] of bucket.extensions) totals.set(extension, (totals.get(extension) ?? 0) + files);
	return [...totals]
		.map(([extension, files]): ExtensionCount => ({ extension, files, indexed: supported.has(extension) }))
		.sort((a, b) => b.files - a.files || a.extension.localeCompare(b.extension));
}

/** Gathers the facts about `folder`; `signal` stops the walk early, marking the result partial. */
export async function measureFolder(folder: string, options: FolderStatsOptions, signal: AbortSignal): Promise<FolderStats> {
	const skip = options.skipDirNames ?? SCAN_SKIP_DIR_NAMES;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const sampleSize = options.sampleNames ?? DEFAULT_SAMPLE_NAMES;
	const own = newBucket();
	const children = new Map<string, Bucket>();
	let scanned = 0;
	let truncated = false;

	const queue: { readonly dir: string; readonly bucket: Bucket; readonly isFolder: boolean; readonly part: string | null; readonly depth: number }[] = [{ dir: folder, bucket: own, isFolder: true, part: null, depth: 0 }];
	for (let head = 0; head < queue.length; head += 1) {
		if (signal.aborted) {
			truncated = true;
			break;
		}
		const { dir, bucket, isFolder, part, depth } = queue[head] as (typeof queue)[number];
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
				// `part` is the folder directly inside the subfolder that a file belongs to: depth 1 is the subfolder's own entries.
				queue.push({ dir: join(dir, entry.name), bucket: child, isFolder: false, part: depth === 1 ? entry.name : part, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = extname(entry.name).toLowerCase();
			const label = extension === "" ? "(none)" : extension;
			bucket.totalFiles += 1;
			bucket.extensions.set(label, (bucket.extensions.get(label) ?? 0) + 1);
			bucket.names.push(entry.name);
			if (part !== null) bucket.below.set(part, (bucket.below.get(part) ?? 0) + 1);
			let size: number;
			try {
				const info = await stat(join(dir, entry.name));
				size = info.size;
				bucket.times.push(info.mtimeMs);
			} catch {
				continue;
			}
			if (!options.supportedExtensions.has(extension) || size > options.maxSourceBytes) continue;
			bucket.indexedFiles += 1;
			bucket.indexedBytes += size;
		}
		if (truncated && scanned >= maxEntries) break;
	}

	const all = [own, ...children.values()];
	const childStats = [...children]
		.map(
			([name, bucket]): ChildStats => ({
				name,
				indexedFiles: bucket.indexedFiles,
				totalFiles: bucket.totalFiles,
				extensions: extensionsOf([bucket], options.supportedExtensions),
				modified: modifiedOf(bucket.times),
				sample: spread(bucket.names, sampleSize),
				subfolders: [...bucket.below]
					.map(([folderName, totalFiles]): Subfolder => ({ name: folderName, totalFiles }))
					.sort((a, b) => b.totalFiles - a.totalFiles || a.name.localeCompare(b.name)),
			}),
		)
		.sort((a, b) => b.totalFiles - a.totalFiles || b.indexedFiles - a.indexedFiles || a.name.localeCompare(b.name));
	return {
		indexedFiles: all.reduce((sum, bucket) => sum + bucket.indexedFiles, 0),
		totalFiles: all.reduce((sum, bucket) => sum + bucket.totalFiles, 0),
		indexedBytes: all.reduce((sum, bucket) => sum + bucket.indexedBytes, 0),
		extensions: extensionsOf(all, options.supportedExtensions),
		children: childStats,
		ownFiles: spread(own.names, sampleSize),
		sample: spread(all.flatMap((bucket) => bucket.names), sampleSize),
		modified: modifiedOf(all.flatMap((bucket) => bucket.times)),
		truncated,
	};
}
