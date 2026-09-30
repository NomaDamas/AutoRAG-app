/**
 * Folder disclosure for the list view (macOS Finder "List" view).
 *
 * A folder row carries a disclosure triangle; expanding it nests the folder's
 * own listing right below it, one indent deeper, any number of levels down.
 * Expansion is keyed by folder path, so a nested folder stays open while its
 * parent is collapsed and reappears open when the parent opens again.
 */

import type { StackRow } from "./version-family";

/** `none` while searching (flat hits), `leaf` for files, stack children, and aligned slots. */
export type Disclosure = "none" | "leaf" | "collapsed" | "expanded";

export interface TreeRow extends StackRow {
	/** 0 for the listed folder's own rows. */
	readonly depth: number;
	readonly disclosure: Disclosure;
	/** The expanded folder row this row is nested under; null at the top level. */
	readonly parent: string | null;
}

export interface FolderTreeOptions {
	readonly expanded: ReadonlySet<string>;
	/** The prepared rows of an expanded folder; undefined until its listing arrives. */
	readonly childrenOf: (path: string) => readonly StackRow[] | undefined;
}

export function buildFolderTree(rows: readonly StackRow[], options: FolderTreeOptions): TreeRow[] {
	const out: TreeRow[] = [];
	const visit = (level: readonly StackRow[], depth: number, parent: string | null): void => {
		for (const row of level) {
			const folder = row.entry.kind === "folder" && !row.child;
			const open = folder && options.expanded.has(row.entry.path);
			out.push({ ...row, depth, parent, disclosure: folder ? (open ? "expanded" : "collapsed") : "leaf" });
			if (open) {
				const children = options.childrenOf(row.entry.path);
				if (children !== undefined) visit(children, depth + 1, row.entry.path);
			}
		}
	};
	visit(rows, 0, null);
	return out;
}

export function flatTreeRows(rows: readonly StackRow[]): TreeRow[] {
	return rows.map((row) => ({ ...row, depth: 0, parent: null, disclosure: "none" }));
}

export function toggleExpanded(expanded: ReadonlySet<string>, path: string): ReadonlySet<string> {
	const next = new Set(expanded);
	if (next.has(path)) {
		next.delete(path);
	} else {
		next.add(path);
	}
	return next;
}

export function isInsideFolder(path: string, folder: string): boolean {
	return path.length > folder.length + 1 && path.startsWith(folder) && (path[folder.length] === "/" || path[folder.length] === "\\");
}

/** Folders currently shown open: exactly the listings the view needs loaded. */
export function expandedFolders(rows: readonly TreeRow[]): string[] {
	return rows.filter((row) => row.disclosure === "expanded").map((row) => row.entry.path);
}

export type DiscloseStep =
	| { readonly type: "expand"; readonly path: string }
	| { readonly type: "collapse"; readonly path: string }
	| { readonly type: "select"; readonly path: string };

/**
 * Finder's arrow keys in list view: right opens a closed folder; left closes an
 * open folder, otherwise moves the selection up to the enclosing folder row.
 */
export function discloseStep(
	rows: readonly TreeRow[],
	focus: string | null,
	direction: "expand" | "collapse",
): DiscloseStep | null {
	const row = rows.find((candidate) => candidate.entry.path === focus);
	if (row === undefined) return null;
	if (direction === "expand") {
		return row.disclosure === "collapsed" ? { type: "expand", path: row.entry.path } : null;
	}
	if (row.disclosure === "expanded") return { type: "collapse", path: row.entry.path };
	return row.parent === null ? null : { type: "select", path: row.parent };
}
