import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Windows cannot check out a path with a backslash, a colon or the other reserved characters, and the release
// workflow checks the repository out on a Windows runner: one such file failed the whole v0.2.0 release.
const WINDOWS_RESERVED = /[<>:"\\|?*\u0000-\u001f]|[. ]$/u;

describe("tracked file names", () => {
	it("are all valid on Windows, where the release checks the repository out", () => {
		const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8", cwd: process.cwd() });
		if (listed.status !== 0) return;

		const invalid = listed.stdout
			.split("\0")
			.filter((path) => path.length > 0)
			.filter((path) => path.split("/").some((part) => WINDOWS_RESERVED.test(part)));

		expect(invalid).toEqual([]);
	});
});
