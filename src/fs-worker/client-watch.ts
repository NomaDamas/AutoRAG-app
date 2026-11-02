import type { WorkerHandler } from "../shared/fs-worker-protocol";

/** The worker owns one native watcher; every connected page contributes its own wanted folders. */
export function createClientWatchSets(apply: WorkerHandler): {
	connect(): { readonly setWatchSet: WorkerHandler; close(): Promise<void> };
} {
	const clients = new Map<symbol, readonly string[]>();
	const union = (): string[] => [...new Set([...clients.values()].flat())];

	return {
		connect() {
			const id = Symbol();
			clients.set(id, []);
			return {
				setWatchSet: (args, signal) => {
					const dirs = args[0];
					if (!Array.isArray(dirs) || !dirs.every((dir): dir is string => typeof dir === "string")) {
						throw new TypeError("dirs must be an array of strings");
					}
					if (!clients.has(id)) return;
					clients.set(id, dirs);
					return apply([union()], signal);
				},
				async close() {
					if (!clients.delete(id)) return;
					await apply([union()], new AbortController().signal);
				},
			};
		},
	};
}
