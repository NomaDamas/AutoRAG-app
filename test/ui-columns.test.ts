import { describe, expect, it } from "vitest";
import {
	chooseInColumn,
	columnPanes,
	columnStep,
	MAX_COLUMNS,
	pruneChain,
	slideBack,
} from "../src/renderer/src/state/columns";

const folder = (path: string) => ({ path, kind: "folder" as const });
const file = (path: string) => ({ path, kind: "file" as const });

describe("columnPanes", () => {
	it("shows only the current folder when the chain does not hold it", () => {
		expect(columnPanes("/a", [])).toEqual(["/a"]);
		expect(columnPanes("/x", ["/a", "/a/b"])).toEqual(["/x"]);
	});

	it("shows at most three panes starting at the current folder", () => {
		const chain = ["/a", "/a/b", "/a/b/c", "/a/b/c/d"];
		expect(MAX_COLUMNS).toBe(3);
		expect(columnPanes("/a", chain)).toEqual(["/a", "/a/b", "/a/b/c"]);
		expect(columnPanes("/a/b", chain)).toEqual(["/a/b", "/a/b/c", "/a/b/c/d"]);
		expect(columnPanes("/a/b/c/d", chain)).toEqual(["/a/b/c/d"]);
	});
});

describe("chooseInColumn", () => {
	it("opens a chosen folder in the next pane", () => {
		const first = chooseInColumn("/a", [], 0, folder("/a/b"));
		expect(first).toEqual({ path: "/a", chain: ["/a", "/a/b"] });
		const second = chooseInColumn("/a", first.chain, 1, folder("/a/b/c"));
		expect(columnPanes(second.path, second.chain)).toEqual(["/a", "/a/b", "/a/b/c"]);
	});

	it("replaces the deeper panes when a sibling folder is chosen", () => {
		const chain = ["/a", "/a/b", "/a/b/c"];
		const next = chooseInColumn("/a", chain, 0, folder("/a/z"));
		expect(columnPanes(next.path, next.chain)).toEqual(["/a", "/a/z"]);
	});

	it("closes the panes after a chosen file", () => {
		const chain = ["/a", "/a/b", "/a/b/c"];
		const next = chooseInColumn("/a", chain, 1, file("/a/b/readme.md"));
		expect(next.path).toBe("/a");
		expect(columnPanes(next.path, next.chain)).toEqual(["/a", "/a/b"]);
	});

	it("slides one pane left when a folder is chosen in the third pane", () => {
		const chain = ["/a", "/a/b", "/a/b/c"];
		const next = chooseInColumn("/a", chain, 2, folder("/a/b/c/d"));
		expect(next.path).toBe("/a/b");
		expect(columnPanes(next.path, next.chain)).toEqual(["/a/b", "/a/b/c", "/a/b/c/d"]);
		// Going back to the old current folder restores its three panes.
		expect(columnPanes("/a", next.chain)).toEqual(["/a", "/a/b", "/a/b/c"]);
	});

	it("keeps the ancestors of the current folder in the chain", () => {
		const chain = ["/a", "/a/b", "/a/b/c", "/a/b/c/d"];
		const next = chooseInColumn("/a/b", chain, 0, folder("/a/b/y"));
		expect(next.chain).toEqual(["/a", "/a/b", "/a/b/y"]);
		expect(next.path).toBe("/a/b");
	});
});

describe("pruneChain", () => {
	it("cuts the chain at the first removed folder or anything inside it", () => {
		const chain = ["/a", "/a/b", "/a/b/c"];
		expect(pruneChain(chain, ["/a/b"])).toEqual(["/a"]);
		expect(pruneChain(chain, ["/a/b/c"])).toEqual(["/a", "/a/b"]);
		expect(pruneChain(chain, ["/a/bc"])).toEqual(chain);
		expect(pruneChain(chain, [])).toEqual(chain);
	});
});

describe("columnStep", () => {
	const panes = ["/a", "/a/b"];
	const entries = [
		[folder("/a/b"), file("/a/x.md"), file("/a/y.md")],
		[file("/a/b/1.md"), file("/a/b/2.md")],
	];

	it("moves up and down within the focused pane", () => {
		expect(columnStep(panes, entries, "/a/x.md", "down")).toEqual({ pane: 0, path: "/a/y.md" });
		expect(columnStep(panes, entries, "/a/b/2.md", "up")).toEqual({ pane: 1, path: "/a/b/1.md" });
		expect(columnStep(panes, entries, "/a/y.md", "down")).toBeNull();
		expect(columnStep(panes, entries, "/a/b", "up")).toBeNull();
	});

	it("enters the open folder on the right and returns to it on the left", () => {
		expect(columnStep(panes, entries, "/a/b", "right")).toEqual({ pane: 1, path: "/a/b/1.md" });
		expect(columnStep(panes, entries, "/a/b/2.md", "left")).toEqual({ pane: 0, path: "/a/b" });
	});

	it("does nothing on the right of a file or the left of the first pane", () => {
		expect(columnStep(panes, entries, "/a/x.md", "right")).toBeNull();
		expect(columnStep(panes, entries, "/a/x.md", "left")).toBeNull();
	});

	it("starts at the first entry of the first pane without a focus", () => {
		expect(columnStep(panes, entries, null, "down")).toEqual({ pane: 0, path: "/a/b" });
		expect(columnStep(panes, [[]], null, "down")).toBeNull();
	});
});

describe("slideBack", () => {
	it("moves the panes one step back toward the folder they slid from", () => {
		const chain = ["/a", "/a/b", "/a/b/c", "/a/b/c/d"];
		expect(slideBack("/a/b", chain)).toEqual({ path: "/a", chain: ["/a", "/a/b"], focus: "/a/b" });
	});

	it("has nowhere to go at the start of the chain", () => {
		expect(slideBack("/a", ["/a", "/a/b"])).toBeNull();
		expect(slideBack("/x", ["/a", "/a/b"])).toBeNull();
	});
});
