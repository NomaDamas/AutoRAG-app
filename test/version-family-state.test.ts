import { describe, expect, it } from "vitest";
import { versionFamilyErrorFor, type VersionFamiliesResult } from "../src/renderer/src/state/version-family";

const result = (overrides: Partial<VersionFamiliesResult> = {}): VersionFamiliesResult => ({
	families: [],
	scannedAt: null,
	error: null,
	scanFailures: [],
	...overrides,
});

describe("versionFamilyErrorFor", () => {
	it("shows a folder failure only for paths covered by that scan", () => {
		const failure = { name: "Desktop", path: "/iCloud", excludeDirs: ["PDF"], reason: "timeout" as const, message: "dupey timed out." };
		const current = result({ scanFailures: [failure] });

		expect(versionFamilyErrorFor(current, "/iCloud/Desktop")).toMatchObject({
			code: "scan-failed",
			scan: { name: "Desktop", reason: "timeout" },
		});
		expect(versionFamilyErrorFor(current, "/iCloud/PDF/report.pdf")).toBeNull();
		expect(versionFamilyErrorFor(current, "/Users/seungwonan/Documents")).toBeNull();
	});

	it("keeps a feature-wide error visible regardless of the viewed path", () => {
		const error = { code: "dupey-missing" as const, message: "missing", installCommand: "cargo install dupey" };
		expect(versionFamilyErrorFor(result({ error }), "/Users/seungwonan/Documents")).toEqual(error);
	});
});
