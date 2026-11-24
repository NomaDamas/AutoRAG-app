import { app, autoUpdater } from "electron";

/** Hard upper bound on `will-quit` teardown so a hung child or MCP server can never block app exit (or ShipIt). */
export const QUIT_CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Runs `listener` once, when the app starts to quit.
 *
 * A window that hides instead of closing (the quick-search launcher, the Quick Look panels) must stop refusing
 * `close` once the app is quitting. Two events announce that, and an app that only listens to `before-quit` never
 * finishes installing an update on macOS: Squirrel.Mac's `quitAndInstall` closes every window first and waits
 * until all of them are gone, and emits `before-quit-for-update` instead of `before-quit` until then. A window
 * that still refuses to close keeps the install from ever reaching ShipIt.
 */
export function whenQuitting(listener: () => void): void {
	let fired = false;
	const fire = (): void => {
		if (fired) return;
		fired = true;
		listener();
	};
	app.once("before-quit", fire);
	autoUpdater.once("before-quit-for-update", fire);
}

export interface QuitCleanupOptions {
	readonly tasks: readonly Promise<unknown>[];
	readonly timeoutMs?: number;
	readonly onExit: () => void;
	readonly onError?: (error: unknown) => void;
}

/**
 * Waits for every teardown task to settle, bounded by a hard deadline, then calls `onExit`.
 *
 * Using `Promise.allSettled` guarantees one failing teardown does not abort the rest (such as releasing the
 * fs-worker's native file watches), and the hard deadline guarantees a hung teardown (for example an MCP server
 * or subprocess that never exits) cannot keep the windowless process alive and stall Squirrel.Mac's ShipIt.
 */
export async function runQuitCleanup(options: QuitCleanupOptions): Promise<void> {
	const timeoutMs = options.timeoutMs ?? QUIT_CLEANUP_TIMEOUT_MS;
	let timedOut = false;
	const all = Promise.allSettled(options.tasks).then((results) => {
		for (const result of results) {
			if (result.status === "rejected") options.onError?.(result.reason);
		}
	});
	const deadline = Promise.withResolvers<void>();
	const timer: NodeJS.Timeout = setTimeout(() => {
		timedOut = true;
		options.onError?.(new Error(`quit cleanup timed out after ${timeoutMs}ms`));
		deadline.resolve();
	}, timeoutMs);
	timer.unref?.();
	try {
		await Promise.race([all, deadline.promise]);
	} finally {
		clearTimeout(timer);
		if (timedOut) void all.catch(() => undefined);
		options.onExit();
	}
}
