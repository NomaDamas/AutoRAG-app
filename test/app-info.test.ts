import { describe, expect, it } from "vitest";
import { APP_FULL_NAME, APP_VERSION, formatDevLabel, formatWindowTitle } from "../src/shared/app-info";

describe("formatWindowTitle", () => {
	it("prefixes a bare semver with v", () => {
		expect(formatWindowTitle(APP_FULL_NAME, "1.2.3")).toBe("Dazzi powered by AutoRAG v1.2.3");
	});

	it("does not double the v prefix", () => {
		expect(formatWindowTitle(APP_FULL_NAME, "v1.2.3")).toBe("Dazzi powered by AutoRAG v1.2.3");
	});

	it("appends the clone label for dev runs", () => {
		expect(
			formatWindowTitle(APP_FULL_NAME, APP_VERSION, {
				clonePath: "/clones/autorag",
				branch: "feat/x",
				commit: "612ae5f",
			}),
		).toBe(`${APP_FULL_NAME} v${APP_VERSION} — /clones/autorag (feat/x@612ae5f)`);
	});

	it("treats a null label as a shipped title", () => {
		expect(formatWindowTitle(APP_FULL_NAME, APP_VERSION, null)).toBe(`${APP_FULL_NAME} v${APP_VERSION}`);
	});
});

describe("formatDevLabel", () => {
	it("prints path, branch, and short commit", () => {
		expect(formatDevLabel({ clonePath: "/clones/autorag", branch: "main", commit: "0bfb85a" })).toBe(
			"/clones/autorag (main@0bfb85a)",
		);
	});

	it("marks a detached HEAD", () => {
		expect(formatDevLabel({ clonePath: "/clones/autorag", branch: null, commit: "612ae5f" })).toBe(
			"/clones/autorag (detached@612ae5f)",
		);
	});

	it("prints only the path without git metadata", () => {
		expect(formatDevLabel({ clonePath: "/clones/autorag", branch: null, commit: null })).toBe("/clones/autorag");
	});
});
