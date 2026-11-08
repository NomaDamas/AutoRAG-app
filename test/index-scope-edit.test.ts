import { describe, expect, it } from "vitest";
import { addSearchRoots, availableActions, coveringExclusion, excludePath, includePath, removeSearchRoot, type ScopeState } from "../src/shared/index-scope-edit";

const scope = (searchPaths: readonly string[], excludePaths: readonly string[] = []): ScopeState => ({ searchPaths, excludePaths });

describe("addSearchRoots", () => {
	it("adds a new folder after the existing ones", () => {
		expect(addSearchRoots(scope(["/a"]), ["/b"])).toEqual({ searchPaths: ["/a", "/b"], rejected: [] });
	});

	it("adds several picked folders in the order picked", () => {
		expect(addSearchRoots(scope([]), ["/x", "/y"]).searchPaths).toEqual(["/x", "/y"]);
	});

	it("skips a folder that is already a target, and says so", () => {
		expect(addSearchRoots(scope(["/a"]), ["/a", "/b"])).toEqual({ searchPaths: ["/a", "/b"], rejected: [{ path: "/a", reason: "duplicate" }] });
	});

	it("skips a folder already covered by a target above it: indexing it twice would double-count it", () => {
		const result = addSearchRoots(scope(["/a"]), ["/a/sub", "/c"]);
		expect(result.searchPaths).toEqual(["/a", "/c"]);
		expect(result.rejected).toEqual([{ path: "/a/sub", reason: "inside-target" }]);
	});

	it("folds targets a new, wider folder now contains into it instead of keeping both", () => {
		const result = addSearchRoots(scope(["/a/one", "/a/two", "/z"]), ["/a"]);
		expect(result.searchPaths).toEqual(["/z", "/a"]);
		expect(result.rejected).toEqual([]);
	});

	it("does not treat a sibling that merely shares a name prefix as inside", () => {
		expect(addSearchRoots(scope(["/data"]), ["/data-old"]).searchPaths).toEqual(["/data", "/data-old"]);
	});

	it("ignores a trailing separator when comparing", () => {
		expect(addSearchRoots(scope(["/a"]), ["/a/"]).rejected).toEqual([{ path: "/a/", reason: "duplicate" }]);
	});

	it("handles Windows separators and case, which a drive treats as the same folder", () => {
		const result = addSearchRoots(scope(["C:\\Users\\me\\Docs"]), ["c:\\users\\me\\docs\\sub"]);
		expect(result.searchPaths).toEqual(["C:\\Users\\me\\Docs"]);
		expect(result.rejected[0]?.reason).toBe("inside-target");
	});

	it("rejects a path that is not absolute: a relative one would resolve against whatever the app started in", () => {
		expect(addSearchRoots(scope([]), ["relative/dir"]).rejected).toEqual([{ path: "relative/dir", reason: "not-absolute" }]);
	});

	it("never mutates what it was given", () => {
		const before = scope(["/a"], ["/a/x"]);
		addSearchRoots(before, ["/b"]);
		expect(before).toEqual({ searchPaths: ["/a"], excludePaths: ["/a/x"] });
	});
});

describe("removeSearchRoot", () => {
	it("removes exactly that target and keeps the others", () => {
		expect(removeSearchRoot(scope(["/a", "/b", "/c"]), "/b").searchPaths).toEqual(["/a", "/c"]);
	});

	it("drops exclusions that lived under the removed target: they no longer mean anything", () => {
		const result = removeSearchRoot(scope(["/a", "/b"], ["/a/x", "/b/y"]), "/a");
		expect(result).toEqual({ searchPaths: ["/b"], excludePaths: ["/b/y"] });
	});

	it("keeps an exclusion that is still under another remaining target", () => {
		const result = removeSearchRoot(scope(["/a", "/a/inner"], ["/a/inner/x"]), "/a/inner");
		expect(result.excludePaths).toEqual(["/a/inner/x"]);
	});

	it("is a no-op for a path that is not a target", () => {
		const before = scope(["/a"], ["/a/x"]);
		expect(removeSearchRoot(before, "/nope")).toEqual(before);
	});
});

describe("coveringExclusion", () => {
	it("finds the exclusion that is the path itself", () => {
		expect(coveringExclusion(["/a/x"], "/a/x")).toBe("/a/x");
	});

	it("finds the nearest exclusion above a path", () => {
		expect(coveringExclusion(["/a", "/a/b"], "/a/b/c.txt")).toBe("/a/b");
	});

	it("is null when nothing covers the path", () => {
		expect(coveringExclusion(["/a/x"], "/a/y")).toBeNull();
		expect(coveringExclusion(["/a/x"], "/a/xylophone")).toBeNull();
	});
});

describe("excludePath and includePath", () => {
	it("adds an exclusion once: listing the same folder twice would hide it from the include action", () => {
		expect(excludePath(["/a/x"], "/a/y")).toEqual(["/a/x", "/a/y"]);
		expect(excludePath(["/a/x"], "/a/x/")).toEqual(["/a/x"]);
	});

	it("removes only the exclusion that is the path itself, leaving a parent's exclusion in force", () => {
		expect(includePath(["/a", "/a/b"], "/a/b")).toEqual(["/a"]);
		expect(includePath(["/a", "/a/b"], "/a/b/c")).toEqual(["/a", "/a/b"]);
	});

	it("compares Windows paths the way the drive does", () => {
		expect(includePath(["C:\\Users\\Me\\Docs"], "c:/users/me/docs")).toEqual([]);
	});
});

describe("availableActions", () => {
	it("offers exclusion for a folder inside a target", () => {
		expect(availableActions({ path: "/a/docs", kind: "folder", state: "partial", excludePaths: [] })).toEqual({ exclude: true, include: false });
	});

	it("offers inclusion again for an excluded folder that was excluded directly", () => {
		expect(availableActions({ path: "/a/docs", kind: "folder", state: "excluded", excludePaths: ["/a/docs"] })).toEqual({ exclude: false, include: true });
	});

	it("offers neither when only a folder above is what excludes it: that is undone on the folder above", () => {
		const result = availableActions({ path: "/a/docs/deep", kind: "folder", state: "excluded", excludePaths: ["/a/docs"] });
		expect(result).toEqual({ exclude: false, include: false });
	});

	it("offers nothing for a search root: it is a target, removed from the folder list, and cannot be left out of itself", () => {
		expect(availableActions({ path: "/a", kind: "root", state: "partial", excludePaths: [] })).toEqual({ exclude: false, include: false });
	});

	it("offers exclusion for a single file", () => {
		expect(availableActions({ path: "/a/x.txt", kind: "file", state: "unindexed", excludePaths: [] }).exclude).toBe(true);
	});

	it("offers nothing for a folded parcel: it stands for many files and no single path", () => {
		expect(availableActions({ path: "/a/docs", kind: "parcel", state: "unindexed", excludePaths: [] })).toEqual({ exclude: false, include: false });
	});

	it("offers nothing for a folder the refresh never walks (node_modules and the like)", () => {
		const result = availableActions({ path: "/a/node_modules", kind: "folder", state: "excluded", excludePaths: [] });
		expect(result).toEqual({ exclude: false, include: false });
	});
});
