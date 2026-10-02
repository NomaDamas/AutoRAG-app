import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	buildFolderTree,
	discloseStep,
	expandedFolders,
	flatTreeRows,
	isInsideFolder,
	toggleExpanded,
	type TreeRow,
} from "../src/renderer/src/state/folder-tree";
import type { StackRow } from "../src/renderer/src/state/version-family";

function entry(path: string, kind: "folder" | "file" = "file"): FinderEntry {
	return {
		name: path.split("/").pop() ?? "",
		path,
		kind,
		fileKind: kind === "folder" ? "folder" : "md",
		iconUrl: null,
		dateLabel: "Sep 13, 16:48",
		sizeLabel: kind === "folder" ? "—" : "6 KB",
		kindLabel: kind === "folder" ? "Folder" : "Markdown",
		location: path.slice(0, path.lastIndexOf("/")),
		modifiedValue: 0,
		sizeValue: 0,
	};
}

function row(path: string, kind: "folder" | "file" = "file", child = false): StackRow {
	return { entry: entry(path, kind), stackCount: 0, stackOpen: false, child, relation: child ? "near" : null };
}

const LISTINGS: Record<string, readonly StackRow[]> = {
	"Home/code": [
		row("Home/code/data_multi_page", "folder"),
		row("Home/code/ko_vlm_benchmark", "folder"),
		row("Home/code/run_multi_hop_generate.py"),
	],
	"Home/code/data_multi_page": [row("Home/code/data_multi_page/partial_results.json")],
	"Home/code/ko_vlm_benchmark": [row("Home/code/ko_vlm_benchmark/multi_hop_question", "folder")],
	"Home/code/ko_vlm_benchmark/multi_hop_question": [
		row("Home/code/ko_vlm_benchmark/multi_hop_question/generate.py"),
	],
};

const ROOT = [row("Home/code", "folder"), row("Home/pceo_ceo_bank", "folder"), row("Home/정리본.xlsx")];

const childrenOf = (path: string): readonly StackRow[] | undefined => LISTINGS[path];

const shape = (rows: readonly TreeRow[]): string[] =>
	rows.map((r) => `${"  ".repeat(r.depth)}${r.entry.name}:${r.disclosure}`);

describe("buildFolderTree", () => {
	it("shows only the listed level while nothing is expanded", () => {
		expect(shape(buildFolderTree(ROOT, { expanded: new Set(), childrenOf }))).toEqual([
			"code:collapsed",
			"pceo_ceo_bank:collapsed",
			"정리본.xlsx:leaf",
		]);
	});

	it("nests the children of expanded folders, several levels deep", () => {
		const expanded = new Set(["Home/code", "Home/code/data_multi_page", "Home/code/ko_vlm_benchmark", "Home/code/ko_vlm_benchmark/multi_hop_question"]);
		expect(shape(buildFolderTree(ROOT, { expanded, childrenOf }))).toEqual([
			"code:expanded",
			"  data_multi_page:expanded",
			"    partial_results.json:leaf",
			"  ko_vlm_benchmark:expanded",
			"    multi_hop_question:expanded",
			"      generate.py:leaf",
			"  run_multi_hop_generate.py:leaf",
			"pceo_ceo_bank:collapsed",
			"정리본.xlsx:leaf",
		]);
	});

	it("keeps nested expansion hidden but remembered under a collapsed parent", () => {
		const expanded = new Set(["Home/code/ko_vlm_benchmark"]);
		expect(shape(buildFolderTree(ROOT, { expanded, childrenOf }))).toEqual([
			"code:collapsed",
			"pceo_ceo_bank:collapsed",
			"정리본.xlsx:leaf",
		]);
		const reopened = toggleExpanded(expanded, "Home/code");
		expect(shape(buildFolderTree(ROOT, { expanded: reopened, childrenOf })).slice(0, 5)).toEqual([
			"code:expanded",
			"  data_multi_page:collapsed",
			"  ko_vlm_benchmark:expanded",
			"    multi_hop_question:collapsed",
			"  run_multi_hop_generate.py:leaf",
		]);
	});

	it("marks an expanded folder whose listing has not arrived yet, without children", () => {
		expect(shape(buildFolderTree(ROOT, { expanded: new Set(["Home/pceo_ceo_bank"]), childrenOf }))).toEqual([
			"code:collapsed",
			"pceo_ceo_bank:expanded",
			"정리본.xlsx:leaf",
		]);
	});

	it("never offers a disclosure on version-stack child rows", () => {
		const rows = buildFolderTree([row("Home/a.md"), row("Other/a (1).md", "file", true)], {
			expanded: new Set(),
			childrenOf,
		});
		expect(rows.map((r: TreeRow) => r.disclosure)).toEqual(["leaf", "leaf"]);
		expect(rows[1]?.child).toBe(true);
	});
});

describe("flatTreeRows", () => {
	it("renders search hits flat with no disclosure slot", () => {
		expect(shape(flatTreeRows(ROOT))).toEqual(["code:none", "pceo_ceo_bank:none", "정리본.xlsx:none"]);
	});
});

describe("toggleExpanded", () => {
	it("adds and removes a folder without mutating the input", () => {
		const start = new Set<string>();
		const opened = toggleExpanded(start, "Home/code");
		expect([...opened]).toEqual(["Home/code"]);
		expect(start.size).toBe(0);
		expect([...toggleExpanded(opened, "Home/code")]).toEqual([]);
	});
});

describe("isInsideFolder", () => {
	it("matches descendants at any depth but not the folder itself or a name-prefixed sibling", () => {
		expect(isInsideFolder("Home/code/a/b.py", "Home/code")).toBe(true);
		expect(isInsideFolder("/Users/x/code/a.py", "/Users/x/code")).toBe(true);
		expect(isInsideFolder("C:\\Users\\x\\code\\a.py", "C:\\Users\\x\\code")).toBe(true);
		expect(isInsideFolder("Home/code", "Home/code")).toBe(false);
		expect(isInsideFolder("Home/code2/a.py", "Home/code")).toBe(false);
	});
});

describe("expandedFolders", () => {
	it("lists the folders shown open, which are the listings to load", () => {
		const rows = buildFolderTree(ROOT, { expanded: new Set(["Home/code", "Home/pceo_ceo_bank"]), childrenOf });
		expect(expandedFolders(rows)).toEqual(["Home/code", "Home/pceo_ceo_bank"]);
	});
});

describe("discloseStep", () => {
	const expanded = new Set(["Home/code", "Home/code/ko_vlm_benchmark"]);
	const rows = buildFolderTree(ROOT, { expanded, childrenOf });

	it("expands a collapsed folder on the right arrow", () => {
		expect(discloseStep(rows, "Home/pceo_ceo_bank", "expand")).toEqual({ type: "expand", path: "Home/pceo_ceo_bank" });
	});

	it("does nothing on the right arrow for files and open folders", () => {
		expect(discloseStep(rows, "Home/정리본.xlsx", "expand")).toBeNull();
		expect(discloseStep(rows, "Home/code", "expand")).toBeNull();
	});

	it("collapses an open folder on the left arrow", () => {
		expect(discloseStep(rows, "Home/code/ko_vlm_benchmark", "collapse")).toEqual({
			type: "collapse",
			path: "Home/code/ko_vlm_benchmark",
		});
	});

	it("moves to the enclosing folder on the left arrow from a nested row", () => {
		expect(discloseStep(rows, "Home/code/run_multi_hop_generate.py", "collapse")).toEqual({
			type: "select",
			path: "Home/code",
		});
		expect(discloseStep(rows, "Home/code/ko_vlm_benchmark/multi_hop_question", "collapse")).toEqual({
			type: "select",
			path: "Home/code/ko_vlm_benchmark",
		});
	});

	it("does nothing on the left arrow at the top level or without focus", () => {
		expect(discloseStep(rows, "Home/정리본.xlsx", "collapse")).toBeNull();
		expect(discloseStep(rows, null, "collapse")).toBeNull();
	});
});
