import { describe, expect, it } from "vitest";
import { assertVersionFloor, compareVersions, VERSION_FLOORS } from "../scripts/release/version-floors.mjs";

describe("compareVersions", () => {
	it("orders dotted versions by number, not by text", () => {
		expect(compareVersions("0.4.12", "0.4.9")).toBeGreaterThan(0);
		expect(compareVersions("0.4.9", "0.4.12")).toBeLessThan(0);
		expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
	});

	it("treats a missing part as zero and equal versions as equal", () => {
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("0.4.12", "0.4.12")).toBe(0);
	});
});

describe("assertVersionFloor", () => {
	it("accepts the floor itself and anything newer", () => {
		expect(() => assertVersionFloor("minsync", "0.5.1", "0.5.1")).not.toThrow();
		expect(() => assertVersionFloor("minsync", "0.6.0", "0.5.1")).not.toThrow();
	});

	it("refuses an older release and names the tool, the version and the floor", () => {
		expect(() => assertVersionFloor("minsync", "0.5.0", "0.5.1")).toThrow(/minsync 0\.5\.0 is below the required 0\.5\.1/u);
	});
});

describe("VERSION_FLOORS", () => {
	it("keeps minsync at 0.5.1 or newer, the first release with durable stage protocol v2 and JSONL sync progress", () => {
		expect(compareVersions("0.5.0", VERSION_FLOORS.minsync)).toBeLessThan(0);
		expect(compareVersions("0.5.1", VERSION_FLOORS.minsync)).toBeGreaterThanOrEqual(0);
	});

	it("keeps mailcrawl at 0.3.0+ for local mail archive indexing and lazykatok at 0.3.3+ for the embedding daemon", () => {
		expect(VERSION_FLOORS["@nomadamas/mailcrawl"]).toBe("0.3.0");
		expect(VERSION_FLOORS.lazykatok).toBe("0.3.3");
	});
});
