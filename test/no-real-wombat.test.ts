import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("the suite never points wombat at a real data directory", () => {
	it("gives every test a throwaway wombat data dir and config", () => {
		const dataDir = process.env.WOMBAT_DATA_DIR ?? "";
		expect(dataDir).not.toBe("");
		expect(dataDir.startsWith(join(homedir(), ".wombat"))).toBe(false);
		expect(dataDir.startsWith(homedir())).toBe(false);
		expect(process.env.WOMBAT_CONFIG ?? "").not.toBe("");
	});
});
