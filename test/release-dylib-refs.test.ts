import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRpaths, resolveDylibRef } from "../scripts/release/lib.mjs";

const BREW = join("/opt", "homebrew", "opt", "brotli", "lib");
const REFERRER = join(BREW, "libbrotlidec.1.dylib");

describe("parseRpaths", () => {
	it("reads every LC_RPATH of an `otool -l` listing and nothing else", () => {
		const listing = [
			"Load command 15",
			"          cmd LC_LOAD_DYLIB",
			"         name /usr/lib/libSystem.B.dylib (offset 24)",
			"Load command 16",
			"          cmd LC_RPATH",
			"      cmdsize 32",
			"         path @loader_path/../lib (offset 12)",
			"Load command 17",
			"          cmd LC_RPATH",
			"      cmdsize 48",
			"         path /opt/homebrew/lib (offset 12)",
		].join("\n");

		expect(parseRpaths(listing)).toEqual(["@loader_path/../lib", "/opt/homebrew/lib"]);
	});

	it("returns none for a file without an rpath", () => {
		expect(parseRpaths("Load command 0\n          cmd LC_SEGMENT_64\n")).toEqual([]);
	});
});

describe("resolveDylibRef", () => {
	const exists = (...present: string[]) => (path: string) => present.includes(path);

	it("resolves @rpath through the referrer's rpath, which is how current Homebrew bottles name their siblings", () => {
		const sibling = join(BREW, "..", "lib", "libbrotlicommon.1.dylib");

		expect(resolveDylibRef("@rpath/libbrotlicommon.1.dylib", REFERRER, ["@loader_path/../lib"], exists(sibling))).toBe(sibling);
	});

	it("takes the first rpath that holds the file", () => {
		const second = join("/second", "libz.1.dylib");

		expect(resolveDylibRef("@rpath/libz.1.dylib", REFERRER, ["/first", "/second"], exists(second))).toBe(second);
	});

	it("refuses an @rpath reference that no rpath resolves, instead of leaving a dangling reference in the bundle", () => {
		expect(() => resolveDylibRef("@rpath/libmissing.1.dylib", REFERRER, ["@loader_path/../lib"], exists())).toThrow(/libmissing\.1\.dylib/);
	});

	it("resolves @loader_path against the referrer", () => {
		expect(resolveDylibRef("@loader_path/libicudata.78.dylib", REFERRER, [], exists())).toBe(join(BREW, "libicudata.78.dylib"));
	});

	it("keeps an absolute path and skips @executable_path, which only the main binary uses", () => {
		expect(resolveDylibRef("/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib", REFERRER, [], exists())).toBe("/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib");
		expect(resolveDylibRef("@executable_path/../lib/libx.dylib", REFERRER, [], exists())).toBeNull();
	});
});
