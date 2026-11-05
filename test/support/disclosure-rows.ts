import type { FinderEntry } from "../../src/renderer/src/data/entries";
import { buildFolderTree, type TreeRow } from "../../src/renderer/src/state/folder-tree";
import type { GroupSection } from "../../src/renderer/src/state/grouping";
import type { StackRow } from "../../src/renderer/src/state/version-family";

export function entry(path: string, kind: "folder" | "file" = "file"): FinderEntry {
	return {
		name: path.split("/").pop() ?? "",
		path,
		kind,
		ext: kind === "folder" ? "" : "md",
		size: kind === "folder" ? null : 6144,
		mtimeMs: 0,
		birthtimeMs: 0,
	};
}

export function row(path: string, kind: "folder" | "file" = "file"): StackRow {
	return { entry: entry(path, kind), stackCount: 0, stackOpen: false, child: false, relation: null };
}

export const files = (dir: string, count: number): StackRow[] =>
	Array.from({ length: count }, (_, index) => row(`${dir}/f${String(index).padStart(5, "0")}.md`));

/**
 * A listing of `top` rows (plain files, the folder `/r/b` at `folderAt`) whose folder holds a `size`-row listing,
 * as the tree rows with the folder closed, with it open, and with it open but its listing not arrived yet.
 */
export function listWithFolder(
	size: number,
	top = 60,
	folderAt = 1,
): { collapsed: TreeRow[]; expanded: TreeRow[]; waiting: TreeRow[]; sections: GroupSection<TreeRow>[] } {
	const rows: StackRow[] = Array.from({ length: top }, (_, index) =>
		index === folderAt ? row("/r/b", "folder") : row(`/r/f${String(index).padStart(5, "0")}.md`),
	);
	const listings = { "/r/b": files("/r/b", size) };
	const childrenOf = (path: string): readonly StackRow[] | undefined => listings[path as "/r/b"];
	const collapsed = buildFolderTree(rows, { expanded: new Set(), childrenOf });
	const expanded = buildFolderTree(rows, { expanded: new Set(["/r/b"]), childrenOf });
	const waiting = buildFolderTree(rows, { expanded: new Set(["/r/b"]), childrenOf: () => undefined });
	return { collapsed, expanded, waiting, sections: [{ label: null, rows: expanded }] };
}
