import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What the shared refresh lock cannot say: which items the holder is working on.
 * The librarian's `refresh-progress.json` covers the local-folder refresh, but a
 * datasource sync (`skill.index()`) writes nothing, and the scheduled job syncs a
 * queue of them. Whoever holds the refresh lock (this app's manual buttons, the
 * OS-scheduled job) records its plan here so every window can show it.
 *
 * Node-only: `refresh-job.ts` imports this and must stay free of `electron`.
 */

export type ActivityItemState = "queued" | "running" | "done" | "failed";

export interface ActivityItemSeed {
	/** `local` or `source:<id>`. */
	readonly key: string;
	readonly kind: "local" | "source";
	readonly id: string | null;
}

export interface ActivityItemRecord extends ActivityItemSeed {
	readonly state: ActivityItemState;
	readonly error: string | null;
}

export interface ActivityRecord {
	readonly version: 1;
	readonly pid: number;
	/** The refresh lock's `owner`: `manual-refresh`, `manual-sync`, `scheduled-job`. */
	readonly owner: string;
	readonly startedAt: string;
	/** Set once the run ended; a record without it is live only while `pid` is. */
	readonly finishedAt: string | null;
	readonly items: readonly ActivityItemRecord[];
}

export interface ActivityJournal {
	/** Start a run with every planned item queued. */
	begin(items: readonly ActivityItemSeed[]): void;
	start(key: string): void;
	finish(key: string, ok: boolean, error: string | null): void;
	/** Close the run; unfinished items are failed so a thrown run never reads as "running". */
	end(): void;
}

export interface ActivityJournalOptions {
	readonly owner: string;
	readonly pid?: number;
	readonly now?: () => number;
}

export function createActivityJournal(path: string, options: ActivityJournalOptions): ActivityJournal {
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	let record: ActivityRecord | null = null;

	const write = (next: ActivityRecord): void => {
		record = next;
		// Progress display must never fail the refresh it describes.
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.${pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(next)}\n`);
			renameSync(temporary, path);
		} catch {
			rmSync(`${path}.${pid}.tmp`, { force: true });
		}
	};
	const update = (key: string, patch: Partial<Pick<ActivityItemRecord, "state" | "error">>): void => {
		if (record === null) return;
		write({ ...record, items: record.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) });
	};

	return {
		begin: (items) =>
			write({
				version: 1,
				pid,
				owner: options.owner,
				startedAt: new Date(now()).toISOString(),
				finishedAt: null,
				items: items.map((item) => ({ ...item, state: "queued", error: null })),
			}),
		start: (key) => update(key, { state: "running", error: null }),
		finish: (key, ok, error) => update(key, { state: ok ? "done" : "failed", error: ok ? null : error }),
		end: () => {
			if (record === null) return;
			write({
				...record,
				finishedAt: new Date(now()).toISOString(),
				items: record.items.map((item) =>
					item.state === "done" || item.state === "failed" ? item : { ...item, state: "failed", error: item.error ?? "중단되었습니다" },
				),
			});
		},
	};
}

function isItem(value: unknown): value is ActivityItemRecord {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.key === "string" &&
		(item.kind === "local" || item.kind === "source") &&
		(item.id === null || typeof item.id === "string") &&
		(item.state === "queued" || item.state === "running" || item.state === "done" || item.state === "failed") &&
		(item.error === null || typeof item.error === "string")
	);
}

/** The last journal on disk, or `null` when absent or unreadable. */
export function readActivity(path: string): ActivityRecord | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (
			record.version !== 1 ||
			typeof record.pid !== "number" ||
			typeof record.owner !== "string" ||
			typeof record.startedAt !== "string" ||
			(record.finishedAt !== null && typeof record.finishedAt !== "string") ||
			!Array.isArray(record.items) ||
			!record.items.every(isItem)
		) {
			return null;
		}
		return {
			version: 1,
			pid: record.pid,
			owner: record.owner,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			items: record.items,
		};
	} catch {
		return null;
	}
}

/**
 * Journal one manual run: the item is queued, running, then done or failed by
 * the result's own `ok`/`error`; a throw fails it and is rethrown.
 */
export async function journalSingleRun<T extends { readonly ok: boolean; readonly error: string | null }>(
	journal: ActivityJournal,
	item: ActivityItemSeed,
	work: () => Promise<T>,
): Promise<T> {
	journal.begin([item]);
	journal.start(item.key);
	try {
		const result = await work();
		journal.finish(item.key, result.ok, result.error);
		return result;
	} catch (error) {
		journal.finish(item.key, false, error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		journal.end();
	}
}

export const LOCAL_ITEM: ActivityItemSeed = { key: "local", kind: "local", id: null };

export function sourceItem(id: string): ActivityItemSeed {
	return { key: `source:${id}`, kind: "source", id };
}
