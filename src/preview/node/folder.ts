import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FolderItem, FolderSize, FolderSummary } from "../shared/contract";

/**
 * Stats in flight at once. Kept small so a long walk leaves libuv's thread
 * pool free for the Finder's own listings and thumbnails between batches.
 */
const STAT_BATCH = 64;

function isUnreadable(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM" || error.code === "ELOOP";
}

/**
 * A folder's direct children, Finder-style: dot entries are hidden, and the
 * `limit` most recently modified come back newest first. Children that vanish
 * or refuse a stat between the listing and the stat are skipped.
 */
export async function summarizeFolder(path: string, limit: number): Promise<FolderSummary> {
	const [own, entries] = await Promise.all([stat(path), readdir(path, { withFileTypes: true })]);
	const visible = entries.filter((entry) => !entry.name.startsWith("."));
	const dated: { readonly entry: Dirent; readonly modified: number }[] = [];
	for (let start = 0; start < visible.length; start += STAT_BATCH) {
		const batch = visible.slice(start, start + STAT_BATCH);
		const stats = await Promise.all(
			batch.map((entry) =>
				lstat(join(path, entry.name)).catch((error: unknown) => {
					if (isUnreadable(error)) return null;
					throw error;
				}),
			),
		);
		stats.forEach((info, index) => {
			const entry = batch[index];
			if (info !== null && entry !== undefined) dated.push({ entry, modified: info.mtimeMs });
		});
	}
	dated.sort((left, right) => right.modified - left.modified);
	const recent: FolderItem[] = dated.slice(0, limit).map(({ entry, modified }) => {
		const folder = entry.isDirectory();
		return {
			name: entry.name,
			folder,
			ext: folder ? "" : extname(entry.name).slice(1).toLowerCase(),
			modifiedAt: new Date(modified).toISOString(),
		};
	});
	return { name: basename(path), path, modifiedAt: own.mtime.toISOString(), itemCount: visible.length, recent };
}

export interface FolderBudget {
	/** Directory entries visited before the walk gives up. */
	readonly maxEntries: number;
	readonly maxMs: number;
	/** Polled between directories; true abandons the walk (the preview moved on). */
	readonly stopped?: () => boolean;
}

/**
 * Total bytes of every file below `path`, hidden files included, without
 * following symlinks. The walk stops at the budget and reports a lower bound,
 * so a home folder never pins the main process.
 */
export async function measureFolder(path: string, budget: FolderBudget): Promise<FolderSize> {
	const deadline = Date.now() + budget.maxMs;
	const pending = [path];
	let bytes = 0;
	let visited = 0;
	let complete = true;
	while (pending.length > 0) {
		const dir = pending.pop();
		if (dir === undefined) break;
		if (budget.stopped?.() === true) return { bytes, complete: false };
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isUnreadable(error)) throw error;
			complete = false;
			continue;
		}
		const files: string[] = [];
		for (const entry of entries) {
			visited += 1;
			if (visited > budget.maxEntries) return { bytes, complete: false };
			const child = join(dir, entry.name);
			if (entry.isDirectory()) pending.push(child);
			else if (entry.isFile()) files.push(child);
		}
		for (let start = 0; start < files.length; start += STAT_BATCH) {
			const sizes = await Promise.all(
				files.slice(start, start + STAT_BATCH).map((file) =>
					lstat(file).then(
						(info) => info.size,
						(error: unknown) => {
							if (isUnreadable(error)) return 0;
							throw error;
						},
					),
				),
			);
			for (const size of sizes) bytes += size;
		}
		if (Date.now() > deadline) return { bytes, complete: pending.length === 0 && complete };
	}
	return { bytes, complete };
}
