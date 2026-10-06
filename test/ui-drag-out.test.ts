import { afterEach, describe, expect, it } from "vitest";
import type { DropData } from "../src/renderer/src/state/attachments";
import { beginOutDrag, endOutDrag, isFinderRowDrag, readFinderRowDragPaths } from "../src/renderer/src/state/drag-out";

interface FakeFile {
	readonly name: string;
	/** "" models a synthetic File with no path on disk. */
	readonly path: string;
}

function nativeDrop(files: readonly FakeFile[], types: readonly string[] = ["Files"]): DropData<FakeFile> {
	return {
		types,
		getData: () => "",
		items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
	};
}

const pathForFile = (file: FakeFile): string => file.path;

afterEach(() => endOutDrag());

describe("isFinderRowDrag", () => {
	it("is false until this window starts a row drag", () => {
		expect(isFinderRowDrag(["Files"])).toBe(false);
		beginOutDrag(["/d/a.txt"]);
		expect(isFinderRowDrag(["Files"])).toBe(true);
	});

	it("ignores a drag that carries no files", () => {
		beginOutDrag(["/d/a.txt"]);
		expect(isFinderRowDrag(["text/plain"])).toBe(false);
	});
});

describe("readFinderRowDragPaths", () => {
	it("returns nothing for a drag this window did not start", () => {
		expect(readFinderRowDragPaths(nativeDrop([{ name: "a.txt", path: "/d/a.txt" }]), pathForFile)).toEqual([]);
	});

	it("returns the recorded rows when the drag carries the same files back", () => {
		beginOutDrag(["/d/a.txt", "/d/c"]);
		expect(
			readFinderRowDragPaths(
				nativeDrop([
					{ name: "a.txt", path: "/d/a.txt" },
					{ name: "c", path: "/d/c" },
				]),
				pathForFile,
			),
		).toEqual(["/d/a.txt", "/d/c"]);
	});

	it("ignores a foreign drag even while a stale record is armed", () => {
		beginOutDrag(["/d/a.txt"]);
		expect(readFinderRowDragPaths(nativeDrop([{ name: "b.txt", path: "/d/other.txt" }]), pathForFile)).toEqual([]);
	});

	it("trusts the record when the drop's files have no path on disk (a synthetic drop)", () => {
		beginOutDrag(["/d/a.txt"]);
		expect(readFinderRowDragPaths(nativeDrop([{ name: "a.txt", path: "" }]), pathForFile)).toEqual(["/d/a.txt"]);
	});
});
