/**
 * The run log of right-click (magic) actions: what the 자동화 tab's status dot and 실행 기록 read for an action, in
 * the same shape as an automation rule's runs. It listens to the events a run already sends (started → done or
 * error) and keeps the newest runs of each action in one JSON file under the app's data folder. A run the person
 * stopped is not a result, so it is not kept.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AutomationRun } from "../shared/automation-contract";
import type { MagicActionEvent } from "../shared/magic-actions-contract";

/** How many runs each action keeps, newest first. */
export const MAGIC_RUNS_KEPT = 50;
/** A run's result is kept up to this many characters, so fifty runs of a long answer stay a small file. */
export const MAGIC_RUN_OUTPUT_KEPT = 20_000;

export interface MagicActionRunLog {
	/** Feed every event a run sends; finished runs are written to the log. */
	record(event: MagicActionEvent): void;
	/** An action's runs, newest first. */
	history(actionId: string): Promise<readonly AutomationRun[]>;
}

type LogFile = Record<string, readonly AutomationRun[]>;

export function createMagicActionRunLog({ file, now = () => Date.now() }: { readonly file: string; readonly now?: () => number }): MagicActionRunLog {
	const open = new Map<string, { readonly actionId: string; readonly startedAt: number; readonly files: readonly string[] }>();
	let cache: LogFile | null = null;
	// Writes go one after another, so two runs ending together cannot lose each other.
	let queue: Promise<void> = Promise.resolve();

	const load = async (): Promise<LogFile> => {
		if (cache !== null) return cache;
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			cache = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as LogFile) : {};
		} catch {
			cache = {};
		}
		return cache;
	};

	const append = (actionId: string, run: AutomationRun): void => {
		queue = queue
			.then(async () => {
				const log = await load();
				log[actionId] = [run, ...(log[actionId] ?? [])].slice(0, MAGIC_RUNS_KEPT);
				await mkdir(dirname(file), { recursive: true });
				const tmp = `${file}.tmp`;
				await writeFile(tmp, `${JSON.stringify(log)}\n`, "utf8");
				await rename(tmp, file);
			})
			.catch(() => undefined);
	};

	return {
		record(event) {
			if (event.type === "started") {
				open.set(event.runId, { actionId: event.actionId, startedAt: now(), files: event.paths });
				return;
			}
			if (event.type !== "done" && event.type !== "error" && event.type !== "cancelled") return;
			const started = open.get(event.runId);
			open.delete(event.runId);
			if (started === undefined || event.type === "cancelled") return;
			const base = { startedAt: started.startedAt, durationMs: Math.max(0, now() - started.startedAt), eventCount: started.files.length, signal: null, timedOut: false, files: started.files };
			append(
				started.actionId,
				event.type === "done"
					? { ...base, exitCode: event.result.exitCode ?? 0, output: event.result.output.slice(0, MAGIC_RUN_OUTPUT_KEPT) }
					: { ...base, exitCode: null, error: event.message },
			);
		},
		async history(actionId) {
			await queue;
			return (await load())[actionId] ?? [];
		},
	};
}
