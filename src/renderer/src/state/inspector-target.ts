/**
 * What the Info panel is about. With a row selected it is that row. With nothing
 * selected it is empty, like Finder's, except in a folder some file-automation rule
 * watches: there the panel shows that folder, so its rules ("이 폴더의 자동화") are
 * readable without selecting anything. A folder nothing watches keeps the empty
 * panel, so the change stays inside the automations feature.
 */

import type { AutomationRule } from "../../../shared/automation-contract";
import { isVirtualListing } from "../../../shared/fs-contract";
import type { FinderEntry } from "../data/entries";
import { rulesWatching } from "./automations";
import { isFilesystemPath } from "./live";
import { basename } from "./paths";

export interface InspectorTargetInput {
	/** The single focused row; null when the selection is empty or has several rows. */
	readonly focused: FinderEntry | null;
	readonly selectedCount: number;
	/** A search is showing: the rows are results, not the folder's contents. */
	readonly searching: boolean;
	/** The folder the pane shows (or an app tab's virtual path). */
	readonly path: string;
	readonly rules: readonly AutomationRule[];
}

export function inspectorEntryFor({ focused, selectedCount, searching, path, rules }: InspectorTargetInput): FinderEntry | null {
	if (focused !== null) return focused;
	if (selectedCount > 0 || searching) return null;
	if (!isFilesystemPath(path) || isVirtualListing(path)) return null;
	if (rulesWatching(rules, path).length === 0) return null;
	// The folder row's own record is not at hand (it lives in the parent's listing), so what
	// is unknown stays unknown: no size, and an invalid time that formats as a dash.
	return { name: basename(path) || path, path, kind: "folder", ext: "", size: null, mtimeMs: Number.NaN, birthtimeMs: 0 };
}
