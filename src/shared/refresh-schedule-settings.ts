import type { AutoRagConfigUpdate, JsonObject, JsonValue } from "./settings-contract";
import { isJsonObject } from "./settings-contract";

/** What the Indexing page edits: `refresh.schedule` in the shared config, which the background job reads. */
export interface ScheduleSettings {
	/** Refresh only while plugged in (`refresh.schedule.power: "ac"`). */
	readonly acOnly: boolean;
	readonly windowEnabled: boolean;
	/** Local `HH:MM`. */
	readonly start: string;
	readonly end: string;
}

const DEFAULT_START = "22:00";
const DEFAULT_END = "07:00";

function schedule(config: JsonObject): JsonObject | null {
	const refresh = config.refresh;
	if (refresh === undefined || !isJsonObject(refresh)) return null;
	const value = (refresh as JsonObject).schedule;
	return value !== undefined && isJsonObject(value) ? (value as JsonObject) : null;
}

export function readScheduleSettings(config: JsonObject): ScheduleSettings {
	const current = schedule(config);
	const windows: JsonValue | undefined = current?.windows;
	const first = Array.isArray(windows) && typeof windows[0] === "string" ? /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(windows[0]) : null;
	return {
		acOnly: current?.power === "ac",
		windowEnabled: first !== null,
		start: first?.[1] ?? DEFAULT_START,
		end: first?.[2] ?? DEFAULT_END,
	};
}

/** Leaf updates that make the config match `settings`; a switched-off option is removed, not stored as a default. */
export function scheduleUpdates(settings: ScheduleSettings): AutoRagConfigUpdate[] {
	if (settings.windowEnabled && settings.start === settings.end) throw new Error("The start and end time are the same");
	if (!settings.acOnly && !settings.windowEnabled) return [{ path: ["refresh", "schedule"], remove: true }];
	return [
		settings.acOnly ? { path: ["refresh", "schedule", "power"], value: "ac" } : { path: ["refresh", "schedule", "power"], remove: true },
		settings.windowEnabled
			? { path: ["refresh", "schedule", "windows"], value: [`${settings.start}-${settings.end}`] }
			: { path: ["refresh", "schedule", "windows"], remove: true },
	];
}
