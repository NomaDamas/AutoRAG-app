import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { baseName, chord, repoRoot } from "../scripts/manual-qa/platform.mjs";

/**
 * The QA helper is plain ESM (not typechecked); these cover the cross-platform
 * primitives that issues #55/#57 depend on.
 */
describe("manual-qa platform helper", () => {
	it("takes basenames across separators", () => {
		expect(baseName("C:\\Users\\me\\Documents\\a.txt")).toBe("a.txt");
		expect(baseName("/Users/me/Documents/a.txt")).toBe("a.txt");
		expect(baseName("a.txt")).toBe("a.txt");
	});

	it("chords the platform's shortcut modifier (meta || ctrl binding)", () => {
		const expected = process.platform === "darwin" ? "Meta+Shift+H" : "Control+Shift+H";
		expect(chord("Shift", "H")).toBe(expected);
	});

	it("resolves the repository root from a script URL", () => {
		const scriptUrl = pathToFileURL(join(process.cwd(), "scripts", "manual-qa", "run.mjs")).href;
		expect(repoRoot(scriptUrl)).toBe(process.cwd().replace(/[\\/]$/, ""));
	});
});
