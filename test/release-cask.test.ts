import { describe, expect, it } from "vitest";
import { renderCask } from "../scripts/release/render-cask.mjs";

const sha = "a".repeat(64);

describe("Homebrew cask render", () => {
	it("stamps the version and digest of the release", () => {
		const cask = renderCask("v1.2.3", sha);
		expect(cask).toContain('version "1.2.3"');
		expect(cask).toContain(`sha256 arm: "${sha}"`);
	});

	it("refuses pre-release tags and malformed digests so a bad cask is never pushed", () => {
		expect(() => renderCask("v1.2.3-rc.1", sha)).toThrow(/stable/);
		expect(() => renderCask("v1.2.3", "abc")).toThrow(/sha256/);
	});
});
