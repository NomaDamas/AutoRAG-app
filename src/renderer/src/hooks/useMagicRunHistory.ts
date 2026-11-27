import { useEffect, useState } from "react";
import type { AutomationRun } from "../../../shared/automation-contract";
import { onMagicActionDone } from "./useMagicAction";

/** Right-click actions' runs from their log, newest first, read again whenever a run finishes. */
export function useMagicRunHistory(ids: readonly string[]): Readonly<Record<string, readonly AutomationRun[]>> {
	const [history, setHistory] = useState<Readonly<Record<string, readonly AutomationRun[]>>>({});
	const [tick, setTick] = useState(0);
	useEffect(() => onMagicActionDone(() => setTick((count) => count + 1)), []);
	const key = ids.join("\n");
	useEffect(() => {
		const bridge = window.autorag?.magicAction;
		if (bridge === undefined || typeof bridge.history !== "function") return;
		let live = true;
		// The log is written as the run ends; a moment later it has the run that just finished.
		const read = (): void => {
			void Promise.all(ids.map(async (id) => [id, await bridge.history(id).catch(() => [] as readonly AutomationRun[])] as const)).then((entries) => {
				if (live) setHistory(Object.fromEntries(entries));
			});
		};
		read();
		const later = tick === 0 ? undefined : setTimeout(read, 400);
		return () => {
			live = false;
			clearTimeout(later);
		};
	}, [key, tick]);
	return history;
}

/** Whether `run` worked on `path` (Windows paths compare without case or slash style). */
export function runTouched(run: AutomationRun, path: string): boolean {
	const key = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
	const want = key(path);
	return (run.files ?? []).some((file) => key(file) === want);
}
