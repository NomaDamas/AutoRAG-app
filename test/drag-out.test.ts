import { describe, expect, it } from "vitest";
import { dragOutPaths } from "../src/main/drag-out";

describe("dragOutPaths", () => {
	it("keeps a non-empty list of absolute paths in order", () => {
		expect(dragOutPaths(["/d/a.txt", "/d/Sub"])).toEqual(["/d/a.txt", "/d/Sub"]);
	});

	it("rejects anything that is not a list of non-empty absolute strings", () => {
		expect(dragOutPaths(undefined)).toBeNull();
		expect(dragOutPaths([])).toBeNull();
		expect(dragOutPaths("/d/a.txt")).toBeNull();
		expect(dragOutPaths(["/d/a.txt", ""])).toBeNull();
		expect(dragOutPaths(["/d/a.txt", 7])).toBeNull();
		expect(dragOutPaths(["/d/a.txt", "relative.txt"])).toBeNull();
	});
});
