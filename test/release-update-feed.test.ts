import { describe, expect, it } from "vitest";
import { rewriteFeed } from "../scripts/release/update-feed.mjs";

describe("CDN feed rewrite", () => {
	const feed = "version: 1.2.3\nfiles:\n  - url: Dazzi-1.2.3-arm64.zip\n    sha512: abc\n    size: 10\npath: Dazzi-1.2.3-arm64.zip\nsha512: abc\nreleaseDate: '2026-10-13T00:00:00.000Z'\n";

	it("points every file at the versioned prefix, leaving hashes untouched", () => {
		expect(rewriteFeed(feed, "1.2.3")).toBe("version: 1.2.3\nfiles:\n  - url: ../v1.2.3/Dazzi-1.2.3-arm64.zip\n    sha512: abc\n    size: 10\npath: ../v1.2.3/Dazzi-1.2.3-arm64.zip\nsha512: abc\nreleaseDate: '2026-10-13T00:00:00.000Z'\n");
	});

	it("refuses a feed built for another version or already rewritten", () => {
		expect(() => rewriteFeed(feed, "1.2.4")).toThrow(/declares version 1.2.3/);
		expect(() => rewriteFeed(rewriteFeed(feed, "1.2.3"), "1.2.3")).toThrow(/not a bare file name/);
	});
});
