/**
 * Entry point of the OS-scheduled background refresh. The OS launches the app's
 * own runtime as plain Node (`ELECTRON_RUN_AS_NODE=1`), so this file and
 * everything it imports must stay free of `electron`.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly } from "@autorag/librarian/core";
import { applyBundledTools } from "./bundled-tools";
import { createDataSourceStatusService } from "./datasource-status";
import { refreshAutoragIndex } from "./index-refresh";
import { createJobWatchdog, type JobWatchdog, latestModification, progressFiles } from "./job-watchdog";
import { terminateMinSyncChildren } from "./minsync-watchdog";
import { runScheduledRefresh, schedulePaths } from "./refresh-schedule";

// The job runs the app's own executable, so an installed build finds the bundled CLIs exactly as the app does,
// and the OS job definition never carries the directory (Task Scheduler caps `/TR` at 261 characters).
applyBundledTools({ resourcesPath: process.resourcesPath, env: process.env, augmentUserPaths: true });

async function main(): Promise<number> {
	const env = process.env;
	const cwd = process.cwd();
	const configPath = resolveConfigPath({ flags: {}, env, cwd }).configPath;
	const paths = schedulePaths(configPath);
	mkdirSync(dirname(paths.log), { recursive: true });
	const log = (line: string): void => {
		try {
			appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// logging must never fail the job
		}
	};
	if (!existsSync(configPath)) {
		log("skip: no AutoRAG config");
		return 0;
	}
	const dataSources = createDataSourceStatusService({ env, cwd });
	let watchdog: JobWatchdog | null = null;
	try {
		// A run that stops producing progress is abandoned; one that keeps going is not, however long it takes.
		// The activity journal moves between datasource syncs, which touch none of the workspace files.
		const files = [...progressFiles(resolveConfigReadOnly({ flags: {}, env, cwd }).workspacePath), paths.activity];
		watchdog = createJobWatchdog({
			latestSignal: () => latestModification(files),
			onExpire: (reason, idleMs) => {
				log(`watchdog: abandoned (${reason}) after ${Math.round(idleMs / 60_000)} min without progress`);
				// minsync outlives its parent and keeps its lock; stop it so the next tick can resume.
				void terminateMinSyncChildren().finally(() => process.exit(124));
			},
		});
		watchdog.start();
		const outcome = await runScheduledRefresh({
			paths,
			log,
			readRaw: () => readRawConfigObject(configPath),
			refreshLocal: () => refreshAutoragIndex({ env, cwd }),
			syncSource: (id) => dataSources.sync(id),
		});
		if (outcome.kind === "ran") log(`done: local=${outcome.local} sources=${outcome.sourceIds.join(",") || "-"} failures=${outcome.failures}`);
		return outcome.kind === "ran" && outcome.failures > 0 ? 1 : 0;
	} catch (error) {
		log(`crash: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return 2;
	} finally {
		watchdog?.stop();
	}
}

// Exit explicitly: a lingering child-process handle must not keep the job (and its lock) alive.
void main().then((code) => terminateMinSyncChildren().finally(() => process.exit(code)));
