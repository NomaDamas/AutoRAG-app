import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasErrorCode } from "./fs-entry";

/**
 * Where trashed payloads came from, owned by the app so the macOS Trash can
 * offer "Put Back" the way Windows' `$I` records natively do: macOS keeps no
 * per-item origin on disk, so the app records one at trash time. The directory
 * comes from Electron's platform userData path and every entry is stored as
 * the OS-native absolute path, never split or rewritten here.
 */
export interface TrashRecord {
	/** The folder-absolute path the item occupied before it was trashed. */
	readonly sourcePath: string;
	/** The payload's path inside the Trash folder. */
	readonly trashPath: string;
}

export interface TrashStore {
	/** Remember origins for trashed payloads; one payload path keeps only its newest record. */
	record(entries: readonly TrashRecord[]): Promise<void>;
	/** The origin for one payload path in the Trash, or null when the app did not trash it. */
	find(trashPath: string): Promise<TrashRecord | null>;
	/** Forget the records for these payload paths (restored, or permanently deleted). */
	forget(trashPaths: readonly string[]): Promise<void>;
	/** Every record still held, oldest first. */
	list(): Promise<readonly TrashRecord[]>;
}

export interface TrashStoreDeps {
	readonly directory: string;
}

export const TRASH_FILENAME = "trash.json";

/** JSON persistence for trash origins. Writes are serialized and atomic, like the recents store. */
export function createTrashStore(deps: TrashStoreDeps): TrashStore {
	const filePath = join(deps.directory, TRASH_FILENAME);
	/** Insertion-ordered: the payload path in the Trash is the record's identity. */
	const records = new Map<string, TrashRecord>();
	let loaded = false;
	let queue: Promise<void> = Promise.resolve();

	async function load(): Promise<void> {
		if (loaded) return;
		loaded = true;
		try {
			const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
			if (!Array.isArray(parsed)) return;
			for (const value of parsed) {
				if (typeof value !== "object" || value === null) continue;
				const entry = value as Record<string, unknown>;
				if (
					typeof entry.sourcePath !== "string" ||
					typeof entry.trashPath !== "string"
				)
					continue;
				if (entry.sourcePath.length === 0 || entry.trashPath.length === 0)
					continue;
				records.set(entry.trashPath, {
					sourcePath: entry.sourcePath,
					trashPath: entry.trashPath,
				});
			}
		} catch (error) {
			// An unreadable store starts empty: the Trash itself is still on disk.
			if (
				error instanceof SyntaxError ||
				hasErrorCode(error, "ENOENT") ||
				hasErrorCode(error, "ENOTDIR")
			) {
				return;
			}
			throw error;
		}
	}

	async function write(): Promise<void> {
		await mkdir(deps.directory, { recursive: true });
		const temporaryPath = join(
			deps.directory,
			`.${TRASH_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
		);
		try {
			await writeFile(
				temporaryPath,
				`${JSON.stringify([...records.values()], null, 2)}\n`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
			await rename(temporaryPath, filePath);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = queue.then(operation);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	return {
		record: (entries) =>
			enqueue(async () => {
				if (entries.length === 0) {
					await load();
					return;
				}
				await load();
				let changed = false;
				for (const entry of entries) {
					if (entry.sourcePath.length === 0 || entry.trashPath.length === 0)
						continue;
					records.set(entry.trashPath, {
						sourcePath: entry.sourcePath,
						trashPath: entry.trashPath,
					});
					changed = true;
				}
				if (changed) await write();
			}),
		find: (trashPath) =>
			enqueue(async () => {
				await load();
				return records.get(trashPath) ?? null;
			}),
		forget: (trashPaths) =>
			enqueue(async () => {
				if (trashPaths.length === 0) {
					await load();
					return;
				}
				await load();
				let changed = false;
				for (const trashPath of trashPaths) {
					if (records.delete(trashPath)) changed = true;
				}
				if (changed) await write();
			}),
		list: () =>
			enqueue(async () => {
				await load();
				return [...records.values()];
			}),
	};
}
