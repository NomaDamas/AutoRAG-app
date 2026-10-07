import { useMemo } from "react";
import type { DirectorySnapshot } from "../data/directory-store";
import type { FinderEntry } from "../data/entries";
import type { EntrySidecar } from "../data/entry-sidecar";
import type { ColumnPaneView } from "../components/ColumnBrowser";
import { buildFolderTree, flatTreeRows, type TreeRow } from "../state/folder-tree";
import { groupRows, type GroupKey, type GroupSection } from "../state/grouping";
import { sortEntries, type SortKey, type SortState } from "../state/sort";
import { applyVersionStacks, type StackRow, type VersionFamilies } from "../state/version-family";
import type { ViewMode } from "../state/view-mode";
import { visibleEntries } from "../state/visibility";
import { useSidecarVersion } from "./useDirectoryData";

/** Orders that read only what a listing already holds; every other key needs the sidecar's enrichment. */
const LISTED_SORT_KEYS: ReadonlySet<SortKey> = new Set(["name", "extension", "date", "size", "where"]);
const LISTED_GROUP_KEYS: ReadonlySet<GroupKey> = new Set(["none", "name", "extension", "date", "size"]);

export interface RowPipelineInput {
	readonly sidecar: EntrySidecar;
	readonly path: string;
	readonly layout: ViewMode;
	readonly searching: boolean;
	readonly searchScope: "all" | "current";
	readonly hits: readonly FinderEntry[];
	/** The folder in view. */
	readonly listing: DirectorySnapshot | undefined;
	/** Column panes, left to right, with their snapshots. */
	readonly panePaths: readonly string[];
	readonly panes: readonly (DirectorySnapshot | undefined)[];
	/** Expanded folders' snapshots, by folder path. */
	readonly children: ReadonlyMap<string, DirectorySnapshot | undefined>;
	readonly expanded: ReadonlySet<string>;
	readonly sort: SortState | null;
	readonly grouping: GroupKey;
	readonly showHiddenFiles: boolean;
	readonly families: VersionFamilies;
	readonly stackPinned: ReadonlySet<string>;
	/** Selected stack heads/members only: a plain-row click must not re-run the pipeline. */
	readonly stackSelected: readonly string[];
}

export interface RowPipeline {
	readonly stackSections: readonly GroupSection<TreeRow>[];
	readonly stackRows: readonly TreeRow[];
	readonly rows: readonly FinderEntry[];
	readonly paneViews: readonly ColumnPaneView[];
	/** Each pane's entries in visual (section) order. */
	readonly paneEntries: readonly (readonly FinderEntry[])[];
	/** Every entry on screen: all panes in the column view, the listing otherwise. */
	readonly viewEntries: readonly FinderEntry[];
	readonly orderedKeys: readonly string[];
}

/**
 * The view pipeline: hidden-file filter → sort → version stacks → group →
 * folder tree, for the folder in view and for each column pane.
 *
 * Listings are the arrays the directory store holds, so this re-runs only when
 * a folder really changed. Icons, OS kinds, and Finder metadata never touch
 * those arrays; they only matter here when the chosen sort or group reads
 * them, and only then does the pipeline resolve rows through the sidecar and
 * re-run when an enrichment batch lands.
 */
export function useRowPipeline(input: RowPipelineInput): RowPipeline {
	const { sidecar, path, layout, searching, searchScope, hits, listing, panePaths, panes, children, expanded } = input;
	const { sort, grouping, showHiddenFiles, families, stackPinned, stackSelected } = input;
	const enrichedOrder = (sort !== null && !LISTED_SORT_KEYS.has(sort.key)) || !LISTED_GROUP_KEYS.has(grouping);
	const sidecarVersion = useSidecarVersion(sidecar, enrichedOrder);

	const stackSections = useMemo<readonly GroupSection<TreeRow>[]>(() => {
		void sidecarVersion;
		const prepare = (entries: readonly FinderEntry[]): readonly StackRow[] => {
			const shown = visibleEntries(entries, showHiddenFiles);
			return applyVersionStacks(sortEntries(enrichedOrder ? shown.map((entry) => sidecar.resolve(entry)) : shown, sort), {
				families,
				manualOpen: stackPinned,
				selectedKeys: stackSelected,
			});
		};
		// Grouping partitions only the top level: an expanded folder's nested
		// rows stay with their parent, and an open version stack's members stay
		// with their head (`groupRows` carries child rows along).
		const grouped = (rows: readonly StackRow[]): readonly GroupSection<StackRow>[] => groupRows(rows, grouping, Date.now());
		if (searching) {
			// The main process already narrows "current" to the folder in view;
			// this keeps the same guarantee for the fixture source. Both
			// separators match so a Windows path still scopes correctly.
			const scoped =
				searchScope === "current"
					? hits.filter((hit) => hit.path === path || hit.path.startsWith(`${path}/`) || hit.path.startsWith(`${path}\\`))
					: hits;
			return grouped(prepare(scoped)).map((section) => ({ ...section, rows: flatTreeRows(section.rows) }));
		}
		return grouped(prepare(listing?.entries ?? [])).map((section) => ({
			...section,
			rows: buildFolderTree(section.rows, {
				expanded,
				childrenOf: (folder) => {
					const loaded = children.get(folder);
					return loaded?.loaded === true ? prepare(loaded.entries) : undefined;
				},
			}),
		}));
	}, [searching, hits, listing, sort, grouping, showHiddenFiles, families, stackPinned, stackSelected, expanded, children, searchScope, path, sidecar, enrichedOrder, sidecarVersion]);
	const stackRows = useMemo(() => stackSections.flatMap((section) => section.rows), [stackSections]);

	const paneViews = useMemo<readonly ColumnPaneView[]>(() => {
		void sidecarVersion;
		return panePaths.map((panePath, index) => {
			const snapshot = panes[index];
			const shown = visibleEntries(snapshot?.entries ?? [], showHiddenFiles);
			const rows = applyVersionStacks(sortEntries(enrichedOrder ? shown.map((entry) => sidecar.resolve(entry)) : shown, sort), {
				families,
				manualOpen: stackPinned,
				selectedKeys: stackSelected,
			});
			return { path: panePath, loaded: snapshot?.loaded === true, rows, sections: groupRows(rows, grouping, Date.now()) };
		});
	}, [panePaths, panes, showHiddenFiles, sort, grouping, families, stackPinned, stackSelected, sidecar, enrichedOrder, sidecarVersion]);
	// Keyboard and shift-range order inside a pane is the visual section order
	// (each section's rows, sections flattened), not the pre-group sort order.
	const paneEntries = useMemo(
		() => paneViews.map((pane) => pane.sections.flatMap((section) => section.rows.map((row) => row.entry))),
		[paneViews],
	);
	const rows = useMemo(() => stackRows.map((row) => row.entry), [stackRows]);
	const viewEntries = useMemo(() => (layout === "columns" ? paneEntries.flat() : rows), [layout, paneEntries, rows]);
	const orderedKeys = useMemo(() => viewEntries.map((entry) => entry.path), [viewEntries]);
	return { stackSections, stackRows, rows, paneViews, paneEntries, viewEntries, orderedKeys };
}
