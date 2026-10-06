/**
 * Where an in-app row drag lands, and what it does there.
 *
 * Finder semantics: dragging a row onto a folder (or a tab, or the window
 * background) moves it there and ⌥ copies instead. A drop that would do
 * nothing — the row is already in the target folder, or the target sits inside
 * the dragged folder — is refused here so no filesystem call is made.
 */

import { dirname } from "./paths";

export interface TransferPlan {
	readonly paths: readonly string[];
	readonly destDir: string;
	readonly op: "copy" | "move";
}

/**
 * The listing folder that accepts a drop on empty space, or null when the
 * pointer is over a row or the listing is not a real destination.
 */
export function backgroundDropDir(
	dir: string,
	state: { readonly searching: boolean; readonly overRow: boolean },
): string | null {
	return dir !== "" && !state.searching && !state.overRow ? dir : null;
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
 * dropped onto itself or one of its descendants.
 */
export function planTransfer(input: {
	readonly paths: readonly string[];
	readonly destDir: string;
	readonly op: "copy" | "move";
}): TransferPlan | null {
	if (input.destDir === "") return null;
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const path of input.paths) {
		if (path === "" || seen.has(path)) continue;
		if (isSameOrInside(input.destDir, path)) continue;
		if (dirname(path) === input.destDir) continue;
		seen.add(path);
		paths.push(path);
	}
	return paths.length === 0 ? null : { paths, destDir: input.destDir, op: input.op };
}
