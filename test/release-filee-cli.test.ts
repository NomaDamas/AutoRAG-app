import { FILEE_CLI_ASSETS, FILEE_CLI_VERSION, fileeBinaryName, selectFileeAsset } from "@autorag/librarian";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderToolLayout } from "../scripts/release/lib.mjs";

describe("folderToolLayout", () => {
	it("keeps the folder whole and links tools/bin to it on macOS", () => {
		expect(folderToolLayout("darwin", "filee-cli", "filee-cli")).toEqual({
			mode: "symlink",
			folder: "filee-cli",
			linkTarget: join("..", "filee-cli", "filee-cli"),
		});
	});

	it("flattens into tools/bin on Windows, where a file symlink is not dependable", () => {
		expect(folderToolLayout("win32", "filee-cli", "filee-cli.exe")).toEqual({ mode: "flatten" });
	});
});

describe("the staged filee-cli follows the librarian's pin", () => {
	it("selects, for the two shipped targets, the archive the librarian itself would install", () => {
		expect(selectFileeAsset("darwin", "arm64").name).toBe(`filee-cli-${FILEE_CLI_VERSION}-osx-arm64.tar.gz`);
		expect(selectFileeAsset("win32", "x64").name).toBe(`filee-cli-${FILEE_CLI_VERSION}-win-x64.zip`);
	});

	it("names the binary the librarian's PATH scan looks for, per platform", () => {
		expect(fileeBinaryName("darwin")).toBe("filee-cli");
		expect(fileeBinaryName("win32")).toBe("filee-cli.exe");
	});

	it("pins a sha256 for every shipped target's asset", () => {
		for (const key of ["darwin-arm64", "win32-x64"]) {
			expect(FILEE_CLI_ASSETS[key]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
		}
	});
});
