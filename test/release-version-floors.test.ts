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
		expect(() => assertVersionFloor("minsync", "0.4.12", "0.4.12")).not.toThrow();
		expect(() => assertVersionFloor("minsync", "0.5.0", "0.4.12")).not.toThrow();
	});

	it("refuses an older release and names the tool, the version and the floor", () => {
		expect(() => assertVersionFloor("minsync", "0.4.11", "0.4.12")).toThrow(/minsync 0\.4\.11 is below the required 0\.4\.12/u);
	});
});

describe("VERSION_FLOORS", () => {
	it("keeps minsync at 0.4.12 or newer, the first release with the failed-chunk streak fix and the remote context cut", () => {
		expect(compareVersions("0.4.11", VERSION_FLOORS.minsync)).toBeLessThan(0);
		expect(compareVersions("0.4.12", VERSION_FLOORS.minsync)).toBeGreaterThanOrEqual(0);
	});

	it("keeps the floors the embedding daemon already needed", () => {
		expect(VERSION_FLOORS["@nomadamas/mailcrawl"]).toBe("0.2.2");
		expect(VERSION_FLOORS.lazykatok).toBe("0.3.3");
	});
});
