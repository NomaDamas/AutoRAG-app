import { t } from "../shared/i18n/core";
import type { DataSourceStatusService } from "./datasource-status";
import { sourceItem } from "./index-activity-journal";
import type { RefreshLockHolder } from "./refresh-lock";
import { createRefreshQueue, type RefreshQueue } from "./refresh-queue";
import type { SchedulePaths } from "./refresh-schedule";
/** Why a manual sync did not start: another refresh holds the shared lock. */
export function busyMessage(holder: RefreshLockHolder): string {
	return holder.owner === "scheduled-job" ? t("main.lock.scheduledBusy") : t("main.lock.otherBusy");
}

/**
 * Every datasource sync this app starts — the Settings buttons and the embedding
 * rebuild alike — runs under the shared refresh lock (so it never overlaps the
 * scheduled job) and is journaled (so the sidebar progress block shows it).
 * Hand this, never the raw service, to anything that calls `sync`.
 */
export function lockDataSources(
	dataSources: DataSourceStatusService,
	paths: SchedulePaths,
	queue: RefreshQueue = createRefreshQueue(paths),
): DataSourceStatusService {
	return {
		...dataSources,
		sync: (id) =>
			queue.enqueue({
				item: sourceItem(id),
				owner: "manual-sync",
				work: () => dataSources.sync(id),
				onBusy: (holder) => ({ id, ok: false, state: "failed", chunkCount: null, indexedAt: null, durationMs: 0, diagnostics: [], error: busyMessage(holder) }),
			}),
	};
}
