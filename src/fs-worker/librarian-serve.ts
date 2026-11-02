/**
 * The librarian thread's side: answers the worker's requests with the services that need `@autorag/librarian`.
 * Everything that imports the librarian is reached from here and from nowhere else in the fs worker's module graph,
 * which is what keeps the worker itself free of the ~2 s the librarian takes to load.
 *
 * `serveLibrarian` takes its services from a factory so a test can stand in for them; `librarian-thread.ts` is the
 * thread entry that builds the real ones.
 */

import type { DupeyScanResult } from "@autorag/librarian";
import { createWorkerClient, serveWorkerPort, type WorkerClient, type WorkerHandler, type WorkerPort } from "../shared/fs-worker-protocol";
import { setAppLanguage } from "../shared/i18n/core";
import { isAppLanguage } from "../shared/language-contract";
import type { FsLocation } from "../shared/fs-contract";
import type { IndexStatus } from "../shared/index-contract";
import { installErrorReporter } from "../main/error-report-core";
import type { FileNameSearchBackend } from "../main/file-name-search";
import { LIBRARIAN_OP, LIBRARIAN_PUSH, LIBRARIAN_REQUEST } from "./librarian-contract";

export interface LibrarianServices {
	readonly fileNameSearch: FileNameSearchBackend;
	scanDuplicates(dir: string): Promise<DupeyScanResult>;
	readonly indexStatus: {
		indexStatus(paths: readonly string[]): Promise<readonly IndexStatus[]>;
		setIndexExcluded(path: string, excluded: boolean): Promise<IndexStatus>;
	};
}

/** What the thread can ask of the worker that started it. */
export interface LibrarianHost {
	locations(): Promise<readonly FsLocation[]>;
	/** An index refresh a toggle started has settled. */
	indexRefreshed(error: string | null): void;
}

export interface ServeLibrarianOptions {
	readonly services: (host: LibrarianHost) => LibrarianServices;
	/**
	 * Runs on `shutdown`, after the file-name index stopped. The real thread raises the process `exit` event here, which is
	 * how the librarian ends the MinSync children an index refresh started; a test leaves it out.
	 */
	readonly onShutdown?: () => void;
}

function stringArg(args: readonly unknown[], index: number, label: string): string {
	const value = args[index];
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function stringsArg(args: readonly unknown[], index: number, label: string): readonly string[] {
	const value = args[index];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${label} must be an array of strings`);
	return value;
}

/** Answer the worker on `port`; resolves nothing, it serves until the port closes. */
export function serveLibrarian(port: WorkerPort, options: ServeLibrarianOptions): void {
	const worker: WorkerClient = createWorkerClient();
	worker.attach(port);
	// One port carries both directions: requests this side answers, and the ones it makes (`locations`).
	const push = (name: string, payload: unknown): void => port.postMessage({ push: name, payload });
	const services = options.services({
		locations: () => worker.call<readonly FsLocation[]>(LIBRARIAN_REQUEST.locations),
		indexRefreshed: (error) => push(LIBRARIAN_PUSH.indexRefreshed, error),
	});
	// The thread has no Sentry of its own: a report raised here is handed to the worker, which has one.
	installErrorReporter((report) => push(LIBRARIAN_PUSH.report, report));

	const handlers: Record<string, WorkerHandler> = {
		[LIBRARIAN_OP.fileNameSearch]: (args) => services.fileNameSearch.search(stringArg(args, 0, "query"), typeof args[1] === "string" ? args[1] : undefined),
		[LIBRARIAN_OP.fileNameEnsureDaemon]: () => services.fileNameSearch.ensureDaemon(),
		[LIBRARIAN_OP.fileNameStop]: () => services.fileNameSearch.stop(),
		[LIBRARIAN_OP.scanDuplicates]: (args) => services.scanDuplicates(stringArg(args, 0, "dir")),
		[LIBRARIAN_OP.indexStatus]: (args) => services.indexStatus.indexStatus(stringsArg(args, 0, "paths")),
		[LIBRARIAN_OP.setIndexExcluded]: (args) => {
			if (typeof args[1] !== "boolean") throw new TypeError("excluded must be a boolean");
			return services.indexStatus.setIndexExcluded(stringArg(args, 0, "path"), args[1]);
		},
		[LIBRARIAN_OP.shutdown]: async () => {
			await services.fileNameSearch.stop();
			options.onShutdown?.();
		},
		[LIBRARIAN_OP.setLanguage]: async (args) => {
			if (!isAppLanguage(args[0])) throw new TypeError("language must be ko, en, ja, or zh");
			await setAppLanguage(args[0]);
		},
	};
	serveWorkerPort(port, handlers);
}
