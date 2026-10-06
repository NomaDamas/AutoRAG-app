import { describe, expect, it } from "vitest";
import { backgroundDropDir, isSameOrInside, planTransfer } from "../src/renderer/src/state/file-transfer";


describe("backgroundDropDir", () => {
	it("takes a drop anywhere in a real listing that a folder row did not claim", () => {
		expect(backgroundDropDir("/a", { searching: false, claimed: false })).toBe("/a");
		expect(backgroundDropDir("", { searching: false, claimed: false })).toBeNull();
		expect(backgroundDropDir("/a", { searching: true, claimed: false })).toBeNull();
		expect(backgroundDropDir("/a", { searching: false, claimed: true })).toBeNull();
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

	it("lets an ⌥-drop duplicate rows into their own folder, but never a paste or a move", () => {
		expect(planTransfer({ paths: ["/a/x.txt"], destDir: "/a", op: "copy", duplicate: true })).toEqual({
			paths: ["/a/x.txt"],
			destDir: "/a",
			op: "copy",
		});
		expect(planTransfer({ paths: ["/a/x.txt"], destDir: "/a", op: "copy" })).toBeNull();
		expect(planTransfer({ paths: ["/a/x.txt"], destDir: "/a", op: "move", duplicate: true })).toBeNull();
	});

	it("never copies a folder into itself, even as a duplicate", () => {
		expect(planTransfer({ paths: ["/a/b"], destDir: "/a/b", op: "copy", duplicate: true })).toBeNull();
		expect(planTransfer({ paths: ["/a/b"], destDir: "/a/b/c", op: "copy", duplicate: true })).toBeNull();
	});
});
