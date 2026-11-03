import { describe, expect, it } from "vitest";
import { scanScopeCovers } from "../src/shared/version-scan-scope";

describe("scanScopeCovers", () => {
	const whole = { path: "/icloud", excludeDirs: [] };

	it("covers the folder itself and everything below it", () => {
		expect(scanScopeCovers(whole, "/icloud")).toBe(true);
		expect(scanScopeCovers(whole, "/icloud/Documents/a.txt")).toBe(true);
		expect(scanScopeCovers({ path: "/icloud/", excludeDirs: [] }, "/icloud/Documents")).toBe(true);
	});

	it("does not cover a sibling that only shares the name's prefix, or a parent", () => {
		expect(scanScopeCovers(whole, "/icloud2/a.txt")).toBe(false);
		expect(scanScopeCovers(whole, "/")).toBe(false);
		expect(scanScopeCovers(whole, "Recents")).toBe(false);
	});

	it("leaves out the subfolders the scan skipped, whatever their case", () => {
		const loose = { path: "/icloud", excludeDirs: ["Documents", "Desktop"] };
		expect(scanScopeCovers(loose, "/icloud")).toBe(true);
		expect(scanScopeCovers(loose, "/icloud/notes.txt")).toBe(true);
		expect(scanScopeCovers(loose, "/icloud/Documents")).toBe(false);
		expect(scanScopeCovers(loose, "/icloud/documents/2026/a.txt")).toBe(false);
		expect(scanScopeCovers(loose, "/icloud/Other/Documents/a.txt")).toBe(true);
	});

	it("reads Windows paths with either separator", () => {
		const scope = { path: "C:\\Users\\me\\iCloudDrive", excludeDirs: ["Desktop"] };
		expect(scanScopeCovers(scope, "C:\\Users\\me\\iCloudDrive\\Docs\\a.txt")).toBe(true);
		expect(scanScopeCovers(scope, "C:/Users/me/iCloudDrive/Docs")).toBe(true);
		expect(scanScopeCovers(scope, "C:\\Users\\me\\iCloudDrive\\Desktop\\a.txt")).toBe(false);
	});

	it("covers everything below a filesystem root", () => {
		expect(scanScopeCovers({ path: "/", excludeDirs: [] }, "/home/a.txt")).toBe(true);
	});
});
