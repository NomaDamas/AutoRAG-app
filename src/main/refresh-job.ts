/**
 * Entry point of the OS-scheduled background refresh. The OS launches the app's
 * own runtime as plain Node (`ELECTRON_RUN_AS_NODE=1`), so this file and
 * everything it imports must stay free of `electron`.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readRawConfigObject, resolveConfigPath } from "@autorag/librarian/core";
import { createDataSourceStatusService } from "./datasource-status";
import { refreshAutoragIndex } from "./index-refresh";
import { runScheduledRefresh, schedulePaths } from "./refresh-schedule";

/** A tick that has not finished by then is abandoned: the lock must not outlive a hung child CLI. */
const WATCHDOG_MS = 90 * 60_000;

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
	try {
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
	}
}

const watchdog = setTimeout(() => {
	try {
		const configPath = resolveConfigPath({ flags: {}, env: process.env, cwd: process.cwd() }).configPath;
		appendFileSync(schedulePaths(configPath).log, `${new Date().toISOString()} watchdog: abandoned after ${WATCHDOG_MS / 60_000} min\n`);
	} catch {
		// nothing more to do
	}
	process.exit(124);
}, WATCHDOG_MS);
watchdog.unref();

// Exit explicitly: a lingering child-process handle must not keep the job (and its lock) alive.
void main().then((code) => process.exit(code));
