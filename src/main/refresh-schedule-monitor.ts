import type { RefreshScheduleStatus } from "../shared/settings-contract";
import type { RefreshScheduler } from "./refresh-scheduler";

/** How often the main process automatically audits the OS background refresh job. */
export const REFRESH_SCHEDULE_AUDIT_INTERVAL_MS = 10 * 60_000;

export interface RefreshScheduleMonitorDeps {
	readonly scheduler: RefreshScheduler;
	/** Called whenever the status changes (including the initial check and each reconcile). */
	readonly onStatus: (status: RefreshScheduleStatus) => void;
	/** Audit cadence; defaults to {@link REFRESH_SCHEDULE_AUDIT_INTERVAL_MS}. */
	readonly intervalMs?: number;
	readonly log?: (message: string, error?: unknown) => void;
}

export interface RefreshScheduleMonitor {
	/** Run an immediate audit (reconciling when the OS job is missing or outdated), returning the fresh status. */
	check(): Promise<RefreshScheduleStatus>;
	/** Run an explicit reconcile (e.g. from Settings or Notification Center) and broadcast the result. */
	apply(): Promise<RefreshScheduleStatus>;
	/** Return the latest status and broadcast if it changed since the last known snapshot. */
	status(): Promise<RefreshScheduleStatus>;
	/** Begin periodic background audits; returns a stop function. */
	start(): () => void;
}

function statusKey(status: RefreshScheduleStatus): string {
	return JSON.stringify(status);
}

/**
 * Keeps Dazzi's OS-level refresh schedule healthy while the app is open:
 *  - On startup and every {@link REFRESH_SCHEDULE_AUDIT_INTERVAL_MS}, inspects the
 *    OS job and `state.json`.
 *  - If the config asks for automatic refresh (`wanted`) and the OS job is missing
 *    (`!installed`), or if an installed job needs re-timing/removal (e.g. after an
 *    app update or config change), reconciles automatically.
 *  - Pushes any status change to the renderer so the Notification Center lights up
 *    immediately when automatic refresh is broken, overdue, failing, or conflicting.
 */
export function createRefreshScheduleMonitor(deps: RefreshScheduleMonitorDeps): RefreshScheduleMonitor {
	const intervalMs = deps.intervalMs ?? REFRESH_SCHEDULE_AUDIT_INTERVAL_MS;
	const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));
	let lastKey: string | null = null;
	let inFlight: Promise<RefreshScheduleStatus> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	const broadcast = (next: RefreshScheduleStatus): RefreshScheduleStatus => {
		const key = statusKey(next);
		if (key !== lastKey) {
			lastKey = key;
			deps.onStatus(next);
		}
		return next;
	};

	const check = (): Promise<RefreshScheduleStatus> => {
		if (inFlight !== null) return inFlight;
		const run = (async (): Promise<RefreshScheduleStatus> => {
			let current = await deps.scheduler.status();
			// Self-heal: if the config asks for a schedule but the OS job disappeared (unloaded/deleted),
			// or if an installed job needs to be updated/removed, reconcile automatically.
			if (current.supported && (current.wanted || current.installed)) {
				if (!current.installed || !current.wanted) {
					current = await deps.scheduler.reconcile();
				} else if (lastKey === null) {
					// First audit at app launch: re-write the job so an upgraded app path or changed interval takes effect.
					current = await deps.scheduler.reconcile();
				}
			}
			if (current.error !== null) {
				log("AutoRAG background refresh scheduling check failed", current.error);
			}
			return broadcast(current);
		})().finally(() => {
			inFlight = null;
		});
		inFlight = run;
		return run;
	};

	const apply = async (): Promise<RefreshScheduleStatus> => {
		const next = await deps.scheduler.reconcile();
		return broadcast(next);
	};

	const status = async (): Promise<RefreshScheduleStatus> => {
		const next = await deps.scheduler.status();
		return broadcast(next);
	};

	const start = (): (() => void) => {
		if (timer !== null) return () => undefined;
		void check().catch((error: unknown) => log("AutoRAG background refresh check threw", error));
		timer = setInterval(() => {
			void check().catch((error: unknown) => log("AutoRAG background refresh check threw", error));
		}, intervalMs);
		timer.unref();
		return () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
	};

	return { check, apply, status, start };
}
