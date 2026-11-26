import { describe, expect, it } from "vitest";
import { parsePsOutput, sampleMinSyncProcesses, terminateMinSyncChildren } from "../src/main/minsync-watchdog";

describe("process listings", () => {
	it("keeps only minsync children of the given parent", () => {
		const ps = [
			"  100     1 /usr/bin/other",
			"  200   100 /Users/x/.cargo/bin/minsync",
			"  201   999 /Users/x/.cargo/bin/minsync",
			"  202   100 /bin/zsh",
		].join("\n");

		expect(parsePsOutput(ps, 100)).toEqual([{ pid: 200 }]);
	});

	it("returns nothing on Windows without spawning tasklist", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(await sampleMinSyncProcesses()).toEqual([]);
		} finally {
			if (platform !== undefined) Object.defineProperty(process, "platform", platform);
		}
	});
});

describe("terminateMinSyncChildren", () => {
	it("stops only minsync children on POSIX and skips Windows", async () => {
		const killed: number[] = [];
		expect(await terminateMinSyncChildren(async () => [{ pid: 7 }, { pid: 8 }], (pid) => void killed.push(pid), "darwin")).toBe(2);
		expect(killed).toEqual([7, 8]);
		killed.length = 0;
		expect(await terminateMinSyncChildren(async () => [{ pid: 9 }], (pid) => void killed.push(pid), "win32")).toBe(0);
		expect(killed).toEqual([]);
	});
});
