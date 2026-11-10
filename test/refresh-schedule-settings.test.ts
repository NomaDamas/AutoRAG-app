import { describe, expect, it } from "vitest";
import { readScheduleSettings, scheduleUpdates } from "../src/shared/refresh-schedule-settings";

describe("readScheduleSettings", () => {
	it("is off everywhere when the config has no schedule", () => {
		expect(readScheduleSettings({})).toEqual({ acOnly: false, windowEnabled: false, start: "22:00", end: "07:00" });
	});

	it("reads AC-only and the first window", () => {
		const config = { refresh: { schedule: { power: "ac", windows: ["01:30-05:00"] } } };
		expect(readScheduleSettings(config)).toEqual({ acOnly: true, windowEnabled: true, start: "01:30", end: "05:00" });
	});

	it("treats power any and a malformed value as not AC-only", () => {
		expect(readScheduleSettings({ refresh: { schedule: { power: "any" } } }).acOnly).toBe(false);
		expect(readScheduleSettings({ refresh: { schedule: "junk" } }).acOnly).toBe(false);
	});
});

describe("scheduleUpdates", () => {
	it("writes power and windows as leaf updates", () => {
		expect(scheduleUpdates({ acOnly: true, windowEnabled: true, start: "22:00", end: "07:00" })).toEqual([
			{ path: ["refresh", "schedule", "power"], value: "ac" },
			{ path: ["refresh", "schedule", "windows"], value: ["22:00-07:00"] },
		]);
	});

	it("removes the whole schedule block when everything is off, so no empty object is left behind", () => {
		expect(scheduleUpdates({ acOnly: false, windowEnabled: false, start: "22:00", end: "07:00" })).toEqual([
			{ path: ["refresh", "schedule"], remove: true },
		]);
	});

	it("removes only the option that is off while the other stays", () => {
		expect(scheduleUpdates({ acOnly: true, windowEnabled: false, start: "22:00", end: "07:00" })).toEqual([
			{ path: ["refresh", "schedule", "power"], value: "ac" },
			{ path: ["refresh", "schedule", "windows"], remove: true },
		]);
	});

	it("refuses an empty window instead of writing one the librarian rejects", () => {
		expect(() => scheduleUpdates({ acOnly: false, windowEnabled: true, start: "09:00", end: "09:00" })).toThrow(/same/);
	});
});
