/**
 * Column view (view mode 3): up to three side-by-side panes. The first pane is
 * the tab's current folder; each further pane lists the folder chosen in the
 * pane before it.
 *
 * The tab keeps a `chain` of folders, each the parent of the next. The panes
 * are the chain's window that starts at the current folder, so going back to
 * an ancestor (back button, breadcrumb) restores the panes it had. Choosing a
 * folder in the last pane slides the window one pane to the right: the second
 * pane becomes the current folder.
 */

export const MAX_COLUMNS = 3;

export interface ColumnItem {
	readonly path: string;
	readonly kind: "folder" | "file";
}

export interface ColumnChoice {
	/** The tab's current folder after the choice (it moves when the panes slide). */
	readonly path: string;
	readonly chain: readonly string[];
}

function anchored(path: string, chain: readonly string[]): { readonly chain: readonly string[]; readonly base: number } {
	const base = chain.indexOf(path);
	return base < 0 ? { chain: [path], base: 0 } : { chain, base };
}

/** The folders shown as panes, left to right. */
export function columnPanes(path: string, chain: readonly string[]): readonly string[] {
	const { chain: rooted, base } = anchored(path, chain);
	return rooted.slice(base, base + MAX_COLUMNS);
}

/** Picks `item` in pane `pane`: a folder opens in the next pane, a file closes the panes after it. */
export function chooseInColumn(
	path: string,
	chain: readonly string[],
	pane: number,
	item: ColumnItem,
): ColumnChoice {
	const { chain: rooted, base } = anchored(path, chain);
	const kept = rooted.slice(0, base + pane + 1);
	if (item.kind !== "folder") {
		return { path, chain: kept };
	}
	const next = [...kept, item.path];
	const panes = next.length - base;
	return { path: panes > MAX_COLUMNS ? (next[next.length - MAX_COLUMNS] ?? path) : path, chain: next };
}

/**
 * Left arrow on the first pane after the panes slid: the folder they slid from
 * becomes the first pane again, with the old first pane chosen (and focused).
 */
export function slideBack(
	path: string,
	chain: readonly string[],
): (ColumnChoice & { readonly focus: string }) | null {
	const base = chain.indexOf(path);
	const parent = base > 0 ? chain[base - 1] : undefined;
	return parent === undefined ? null : { path: parent, chain: chain.slice(0, base + 1), focus: path };
}

function within(path: string, removed: string): boolean {
	return path === removed || path.startsWith(`${removed}/`);
}

/** Cuts the chain at the first folder that was removed (trash, rename, move). */
export function pruneChain(chain: readonly string[], removed: readonly string[]): readonly string[] {
	const cut = chain.findIndex((path) => removed.some((gone) => within(path, gone)));
	return cut < 0 ? chain : chain.slice(0, cut);
}

export type ColumnDirection = "up" | "down" | "left" | "right";

export interface ColumnTarget {
	readonly pane: number;
	readonly path: string;
}

/** Arrow-key target in the column view, or null when the key has nowhere to go. */
export function columnStep(
	panes: readonly string[],
	entries: readonly (readonly ColumnItem[])[],
	focus: string | null,
	direction: ColumnDirection,
): ColumnTarget | null {
	const pane = focus === null ? -1 : entries.findIndex((items) => items.some((item) => item.path === focus));
	if (pane < 0) {
		const first = entries[0]?.[0];
		return first === undefined ? null : { pane: 0, path: first.path };
	}
	const items = entries[pane] ?? [];
	const index = items.findIndex((item) => item.path === focus);
	switch (direction) {
		case "up":
		case "down": {
			const next = items[index + (direction === "down" ? 1 : -1)];
			return next === undefined ? null : { pane, path: next.path };
		}
		case "right": {
			const item = items[index];
			if (item?.kind !== "folder" || panes[pane + 1] !== item.path) {
				return null;
			}
			const first = entries[pane + 1]?.[0];
			return first === undefined ? null : { pane: pane + 1, path: first.path };
		}
		case "left": {
			const parent = panes[pane];
			return pane === 0 || parent === undefined ? null : { pane: pane - 1, path: parent };
		}
	}
}
