import type { DataSourceStatusService } from "./datasource-status";
import { createActivityJournal, journalSingleRun, sourceItem } from "./index-activity-journal";
import type { RefreshLockHolder } from "./refresh-lock";
import { withRefreshLock, type SchedulePaths } from "./refresh-schedule";

/** Why a manual sync did not start: another refresh holds the shared lock. */
export function busyMessage(holder: RefreshLockHolder): string {
	return holder.owner === "scheduled-job" ? "백그라운드 새로 고침이 실행 중입니다. 끝난 뒤 다시 시도하세요." : "다른 새로 고침이 실행 중입니다. 끝난 뒤 다시 시도하세요.";
}

/**
 * Every datasource sync this app starts — the Settings buttons and the embedding
 * rebuild alike — runs under the shared refresh lock (so it never overlaps the
 * scheduled job) and is journaled (so the sidebar progress block shows it).
 * Hand this, never the raw service, to anything that calls `sync`.
 */
export function lockDataSources(dataSources: DataSourceStatusService, paths: SchedulePaths): DataSourceStatusService {
	return {
		...dataSources,
		sync: (id) =>
			withRefreshLock(
				paths.lock,
				"manual-sync",
				() => journalSingleRun(createActivityJournal(paths.activity, { owner: "manual-sync" }), sourceItem(id), () => dataSources.sync(id)),
				(holder) => ({ id, ok: false, state: "failed", chunkCount: null, indexedAt: null, durationMs: 0, diagnostics: [], error: busyMessage(holder) }),
			),
	};
}
