/**
 * Entry of the librarian thread, a `worker_threads` thread the fs worker starts on its first need of the librarian
 * (`librarian-client.ts`). It is the only place in the worker's process that imports `@autorag/librarian`: the import
 * takes ~2 s on whatever event loop runs it, and the worker's must stay free to answer folder listings.
 *
 * Like the fs worker it must not import `electron`.
 */

import { parentPort, workerData } from "node:worker_threads";
import { scanWithDupey } from "@autorag/librarian";
import { createFileNameSearch } from "../main/file-name-search";
import { createIndexStatusService } from "../main/index-status";
import type { LibrarianThreadData } from "./librarian-contract";
import { serveLibrarian } from "./librarian-serve";
import { adaptNodePort } from "./thread-port";

if (parentPort === null) throw new Error("librarian-thread must run as a worker thread");
const { userDataDir } = workerData as LibrarianThreadData;

serveLibrarian(adaptNodePort(parentPort), {
	services: (host) => ({
		fileNameSearch: createFileNameSearch({ userDataDir, locations: host.locations }),
		scanDuplicates: (dir) => scanWithDupey(dir),
		indexStatus: createIndexStatusService({ env: process.env, cwd: process.cwd(), onRefreshed: host.indexRefreshed }),
	}),
	// The librarian ends the MinSync children it started on `exit`, which a terminated thread never receives.
	onShutdown: () => {
		process.emit("exit", 0);
	},
});
