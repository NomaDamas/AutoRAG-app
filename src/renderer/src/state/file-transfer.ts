/**
 * Where an in-app row drag lands, and what it does there.
 *
 * Finder semantics: dragging a row onto a folder (or a tab, or anywhere else in
 * a listing) moves it there and ⌥ copies instead. A drop that would do nothing
 * — the row is already in the target folder, or the target sits inside the
 * dragged folder — is refused here so no filesystem call is made; an ⌥-drop
 * into the rows' own folder duplicates them, as Finder does.
 */

import { dirname } from "./paths";

export interface TransferPlan {
	readonly paths: readonly string[];
	readonly destDir: string;
	readonly op: "copy" | "move";
}

/**
 * The listing folder that takes a drop anywhere a folder row did not claim —
 * empty space and file rows alike — or null when the listing is not a real
 * destination (no folder, or search results drawn from many folders).
 */
export function backgroundDropDir(
	dir: string,
	state: { readonly searching: boolean; readonly claimed: boolean },
): string | null {
	return dir !== "" && !state.searching && !state.claimed ? dir : null;
}

/**
 * The verb a drop performs. An in-app row drag moves by default (⌥ copies,
 * Finder's own convention); a drag from another app copies by default (⌥
 * moves), so pulling a file in from the OS never silently relocates it.
 */
export function dropTransferOp(inAppDrag: boolean, altKey: boolean): "copy" | "move" {
	return inAppDrag === altKey ? "copy" : "move";
}

/** True when `candidate` is `ancestor` or lives inside it (separator-aware). */
export function isSameOrInside(candidate: string, ancestor: string): boolean {
	if (ancestor === "") return false;
	return candidate === ancestor || candidate.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

/**
 * The paths a transfer should actually touch, or null when it would be a
 * no-op: an empty drag, rows already in the destination folder, or a folder
 * dropped onto itself or one of its descendants. `duplicate` lets a copy into
 * the rows' own folder through (Finder's ⌥-drag in place); a paste there stays
 * a no-op.
 */
export function planTransfer(input: {
	readonly paths: readonly string[];
	readonly destDir: string;
	readonly op: "copy" | "move";
	readonly duplicate?: boolean;
}): TransferPlan | null {
	if (input.destDir === "") return null;
	const inPlace = input.op === "copy" && input.duplicate === true;
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const path of input.paths) {
		if (path === "" || seen.has(path)) continue;
		if (isSameOrInside(input.destDir, path)) continue;
		if (!inPlace && dirname(path) === input.destDir) continue;
		seen.add(path);
		paths.push(path);
	}
	return paths.length === 0 ? null : { paths, destDir: input.destDir, op: input.op };
}
