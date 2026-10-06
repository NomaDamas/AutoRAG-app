import { describe, expect, it } from "vitest";
import { backgroundDropDir, dropTransferOp, isSameOrInside, planTransfer } from "../src/renderer/src/state/file-transfer";


describe("backgroundDropDir", () => {
	it("accepts a real listing folder only when the pointer is on its background", () => {
		expect(backgroundDropDir("/a", { searching: false, overRow: false })).toBe("/a");
		expect(backgroundDropDir("", { searching: false, overRow: false })).toBeNull();
		expect(backgroundDropDir("/a", { searching: true, overRow: false })).toBeNull();
		expect(backgroundDropDir("/a", { searching: false, overRow: true })).toBeNull();
	});
});
describe("isSameOrInside", () => {
	it("matches the path itself and its descendants, but not a sibling prefix", () => {
		expect(isSameOrInside("/a/b", "/a/b")).toBe(true);
		expect(isSameOrInside("/a/b/c", "/a/b")).toBe(true);
		expect(isSameOrInside("/a/bc", "/a/b")).toBe(false);
		expect(isSameOrInside("/a/b/c", "/a/b/")).toBe(true);
		expect(isSameOrInside("/anything", "")).toBe(false);
	});
});

describe("dropTransferOp", () => {
	it("moves an in-app row drag by default and copies with the modifier", () => {
		expect(dropTransferOp(true, false)).toBe("move");
		expect(dropTransferOp(true, true)).toBe("copy");
	});

	it("copies an OS file drag by default and moves with the modifier", () => {
		expect(dropTransferOp(false, false)).toBe("copy");
		expect(dropTransferOp(false, true)).toBe("move");
	});
});

describe("planTransfer", () => {
	it("moves rows into the destination folder", () => {
		expect(planTransfer({ paths: ["/a/x.txt"], destDir: "/a/b", op: "move" })).toEqual({
			paths: ["/a/x.txt"],
			destDir: "/a/b",
			op: "move",
		});
	});

	it("drops rows already in the destination folder", () => {
		expect(planTransfer({ paths: ["/a/b/x.txt"], destDir: "/a/b", op: "move" })).toBeNull();
		expect(planTransfer({ paths: ["/a/x.txt", "/a/b/y.txt"], destDir: "/a/b", op: "copy" })).toEqual({
			paths: ["/a/x.txt"],
			destDir: "/a/b",
			op: "copy",
		});
	});

	it("refuses a folder dropped onto itself or its descendant", () => {
		expect(planTransfer({ paths: ["/a/b"], destDir: "/a/b", op: "move" })).toBeNull();
		expect(planTransfer({ paths: ["/a/b"], destDir: "/a/b/c", op: "move" })).toBeNull();
		expect(planTransfer({ paths: ["/a/b"], destDir: "/a/c", op: "move" })?.destDir).toBe("/a/c");
	});

	it("dedupes paths and reports nothing for an empty drag", () => {
		expect(planTransfer({ paths: ["/a/x.txt", "/a/x.txt"], destDir: "/a/b", op: "move" })?.paths).toEqual(["/a/x.txt"]);
		expect(planTransfer({ paths: [], destDir: "/a/b", op: "move" })).toBeNull();
		expect(planTransfer({ paths: ["/a/x.txt"], destDir: "", op: "move" })).toBeNull();
	});
});
