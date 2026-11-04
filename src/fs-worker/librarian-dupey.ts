/**
 * The duplicate scan the librarian thread serves: the librarian's `scanWithDupey`, with its dupey process started by
 * the app's own runner (`src/main/dupey-runner.ts`) so the thread can end it. `librarian-thread.ts` is the one caller
 * and cannot be type-checked or tested on its own (it needs a real thread), so everything it decides lives here.
 */

import type { DupeyScanResult, scanWithDupey } from "@autorag/librarian";
import { type DupeyRunner, joinExcludeDirValues } from "../main/dupey-runner";
import type { DupeyScanOptions } from "../shared/version-scan-scope";

export interface DuplicateScans {
	scanDuplicates(dir: string, options?: DupeyScanOptions): Promise<DupeyScanResult>;
	/** Ends the dupey processes a scan has running and refuses further scans. */
	stop(): Promise<void>;
}

export function createDuplicateScans(deps: { readonly scan: typeof scanWithDupey; readonly runner: DupeyRunner }): DuplicateScans {
	const { scan, runner } = deps;
	return {
		scanDuplicates: (dir, options) =>
			scan(dir, {
				run: (args) => runner.run(joinExcludeDirValues(args)),
				...(options?.excludeDirs === undefined ? {} : { excludeDirs: options.excludeDirs }),
			}),
		stop: () => runner.shutdown(),
	};
}
