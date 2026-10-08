import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLatestCallback } from "./useLatestCallback";
import { useFolderListings } from "./useFolderListings";
import { useRowPipeline } from "./useRowPipeline";
import { itemElement, useFinderKeyboard } from "./useFinderKeyboard";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { NO_CAPABILITIES, type ActionAnchor, type ActionCapabilities, type OpenWithApplication } from "../../../shared/actions-contract";
import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import { DUPEY_LAYER_ID, type LiveMessage } from "../../../shared/live-contract";
import type { DirectoryStore } from "../data/directory-store";
import type { FinderEntry } from "../data/entries";
import type { EntrySidecar } from "../data/entry-sidecar";
import { navGroups, type NavGroup, type NavItem } from "../data/places";
import { type FinderLocation, type FinderSource, pickInitialPath } from "../data/source";
import { finderDragEntries } from "../state/attachments";
import { validateName } from "../state/collision";
import {
	chooseInColumn,
	type ColumnDirection,
	columnPanes,
	columnStep,
	pruneChain,
	slideBack,
} from "../state/columns";
import {
	buildBackgroundContextMenu,
	buildContextMenu,
	type FinderMenuAction,
	type FinderMenuEntry,
} from "../state/context-menu";
import type { NewFileFormatId } from "../../../shared/new-file-contract";
import { planTransfer } from "../state/file-transfer";
import type { FileActionTarget } from "../state/file-actions";
import { batchToast, emptyStateText, emptyTrashToast, indexToast } from "../state/format";
import { evidenceSourceUrl, findEvidenceSource } from "../state/evidence";
import type { FocusZone } from "../state/keymap";
import { nearestExistingAncestor, pruneSelection, withoutPaths } from "../state/live";
import {
	adoptInvoke,
	adoptMessage,
	adoptResync,
	EMPTY_LAYER_STORE,
	selectDupey,
	type LayerStore,
} from "../state/layers";
import { activeNavPath, basename, breadcrumbTrail, dirname, type Crumb } from "../state/paths";
import {
	applyRowClick,
	EMPTY_SELECTION,
	moveSelection,
	type SelectionState,
	SCROLL_LEAD,
} from "../state/selection";
import {
	GROUP_STORAGE_KEY,
	groupedRowTop,
	parseGroupKey,
	type GroupKey,
	type GroupSection,
} from "../state/grouping";
import { locationOf } from "../state/entry-values";
import { type SortDirection, type SortKey, type SortState, cycleSort, explicitSort } from "../state/sort";
import {
	expandedFolders,
	isInsideFolder,
	toggleExpanded,
	type TreeRow,
} from "../state/folder-tree";
import {
	buildVersionFamilies,
	EMPTY_VERSION_FAMILIES,
	familyViewFor,
	stackSelectionKeys,
	type VersionFamilies,
	type VersionFamiliesResult,
	type VersionFamilyError,
	type VersionFamilyView,
	type VersionRelation,
} from "../state/version-family";
import {
	activeTab,
	AI_SEARCH_PATH,
	applyColumnChoice,
	exitVirtualTab,
	goBack,
	goForward,
	isVirtualTabPath,
	navigateTab,
	openAiSearchTab,
	openTab,
	openTabAt,
	patchActiveTab,
	selectTab,
	showAiSearchInActiveTab,
	tabTitle,
	type TabsState,
} from "../state/tabs";
import {
	closeWorkspaceTab,
	evacuateWorkspace,
	focusTab,
	focusAiSearchInWorkspace,
	openOrSelectSettingsInWorkspace,
	updatePaneTabs,
	type Pane,
	type Workspace,
} from "../state/workspace";
import type { TabView } from "../components/TabStrip";
import type { ColumnPaneView } from "../components/ColumnBrowser";
import { parseViewMode, VIEW_MODE_STORAGE_KEY, type ViewMode } from "../state/view-mode";

/** --time-flash */
const FLASH_MS = 1800;
/** How long a reveal flash waits for its row to be listed before it is dropped. */
const FLASH_WAIT_MS = 10_000;

interface ContextMenuState {
	readonly cursor: { readonly x: number; readonly y: number };
	/** The row the menu targets; null for the empty-space menu. */
	readonly entry: FinderEntry | null;
	/** The folder a background New / Paste acts on (the pane the menu was opened in). */
	readonly dir: string;
}

function single(path: string): SelectionState {
	return { keys: [path], anchor: path, focus: path };
}

function readStoredViewMode(): ViewMode {
	try {
		return parseViewMode(globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY) ?? null);
	} catch {
		// Storage can be unavailable (sandboxed renderer, tests); the list view is the default.
		return parseViewMode(null);
	}
}

function readStoredGrouping(): GroupKey {
	try {
		return parseGroupKey(globalThis.localStorage?.getItem(GROUP_STORAGE_KEY) ?? null);
	} catch {
		// Storage can be unavailable (sandboxed renderer, tests); grouping stays off.
		return parseGroupKey(null);
	}
}

interface RenameState {
	readonly path: string;
	readonly draft: string;
}

export interface FinderController {
	readonly tabs: readonly TabView[];
	/** The window holds more than one tab, so a close can succeed. */
	readonly canCloseTabs: boolean;
	readonly path: string;
	readonly crumbs: readonly Crumb[];
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly query: string;
	readonly searchFocused: boolean;
	readonly searching: boolean;
	readonly emptyText: string;
	readonly rows: readonly FinderEntry[];
	readonly stackRows: readonly TreeRow[];
	/** The same rows split into the toolbar Group control's visual sections. */
	readonly stackSections: readonly GroupSection<TreeRow>[];
	readonly sort: SortState | null;
	/** The toolbar Group control's active criterion. */
	readonly grouping: GroupKey;
	readonly zone: FocusZone;
	readonly selection: SelectionState;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	/** AutoRAG local-index state for a file path; rows read it from the sidecar directly. */
	indexStatusFor(path: string): IndexStatus | null;
	/** Non-null when dupey is missing or a version-family scan failed. */
	readonly versionFamilyError: VersionFamilyError | null;
	/** Path of the sidebar row that owns the current folder (null when none does). */
	readonly activeNavPath: string | null;
	/** Sidebar groups built from the live OS locations. */
	readonly navGroups: readonly NavGroup[];
	readonly contextMenu: { readonly cursor: { readonly x: number; readonly y: number } } | null;
	readonly contextMenuEntries: readonly FinderMenuEntry[];
	/** The mode the toolbar toggle shows as chosen. */
	readonly viewMode: ViewMode;
	/** The view actually rendered: the column view shows search results as a list. */
	readonly layout: ViewMode;
	/** Search scope: every location, or only the current folder subtree (v7 scope bar). */
	readonly searchScope: SearchScope;
	setSearchScope(scope: SearchScope): void;
	/** The single focused row (null when the selection is empty or multiple). */
	readonly focusedEntry: FinderEntry | null;
	/** Every selected row in visual order — the Inspector summarizes the set when more than one is selected. */
	readonly selectedEntries: readonly FinderEntry[];
	/** The dupey family a path heads or belongs to — the inspector "Versions" section. */
	versionFamilyFor(path: string): VersionFamilyView | null;
	/** Same family with real entries attached — the column view's variants pane. */
	familyEntriesFor(path: string): { readonly head: FinderEntry; readonly members: readonly { readonly entry: FinderEntry; readonly relation: VersionRelation }[] } | null;
	/** Navigate the current tab to the entry's folder and reveal the row (version-member click). */
	revealEntry(entry: FinderEntry): void;
	/** Create an "untitled folder" in the current directory and select it. */
	newFolder(): void;
	/** Create a new file of `format` in the current directory and select it. */
	newFile(format: NewFileFormatId): void;
	/** Trash a single entry (inspector chip). */
	trashEntry(entry: FinderEntry): void;
	/** Copy a single entry's path to the system clipboard (inspector chip). */
	copyEntryPath(entry: FinderEntry): void;
	/** What this machine can run, so the Inspector action bar never offers a dead button. */
	readonly actionCapabilities: ActionCapabilities;
	/** Run one Inspector action (open, share, or an action request). */
	runEntryAction(entry: FinderEntry, target: FileActionTarget, anchor: ActionAnchor | null): void;
	/** The applications the OS registers for `entry`'s type, default first (the "다른 앱으로 열기" menu). */
	loadOpenWithApplications(entry: FinderEntry): Promise<readonly OpenWithApplication[]>;
	/** The rows a drag of `entry` carries: the whole selection when it is selected, else just `entry`. */
	dragEntries(entry: FinderEntry): readonly FinderEntry[];
	/** Copy the current selection to the in-app file clipboard (⌘C). */
	copySelection(): void;
	/** Cut the current selection to the in-app file clipboard (⌘X). */
	cutSelection(): void;
	/** Paste the file clipboard into the current folder (⌘V; `move` is ⌥⌘V). */
	pasteClipboard(move: boolean): void;
	/** Undo the most recent recorded copy/move transfer (⌘Z). */
	undoLastTransfer(): void;
	/** True while the focused tab lists the Trash location itself. */
	readonly inTrashLocation: boolean;
	/** Put the selected trashed rows back where they came from (Trash view). */
	putBackSelection(): void;
	/** Open the destructive confirm for 휴지통 비우기. */
	requestEmptyTrash(): void;
	/** Run the confirmed 휴지통 비우기. */
	confirmEmptyTrash(): void;
	/** Close the 휴지통 비우기 confirm without deleting. */
	cancelEmptyTrash(): void;
	/** Whether the 휴지통 비우기 confirm is showing. */
	readonly emptyTrashConfirm: boolean;
	/** An in-app row drop: ⌥ copies, otherwise the rows move into the target folder. */
	transferDropped(paths: readonly string[], destDir: string, copy: boolean): void;
	/** A drop on another tab: switch to it, then move/copy the rows into its folder. */
	dropOnTab(tabId: number, paths: readonly string[], copy: boolean): void;
	/** Column view panes, left to right (empty outside the column layout). */
	readonly columnPanes: readonly ColumnPaneView[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	navigate(path: string): void;
	navigateNav(item: NavItem): void;
	/** Unmount the volume behind a sidebar row; tabs inside it move out first. */
	ejectNav(item: NavItem): void;
	selectTabId(id: number): void;
	closeTabId(id: number): void;
	newTab(): void;
	openSettings(): void;
	/** Sidebar "AI Search": the focused tab becomes AI Search. */
	showAiSearch(): void;
	/** A new AI Search tab with an empty chat ("AI 요약", content search). */
	openAiSearch(): void;
	/** ⌘K: adopt the nearest AI Search tab, or open one. */
	focusAiSearch(): void;
	/** A filename search from a Settings / AI Search tab returns that tab to its folder. */
	leaveVirtualTab(): void;
	back(): void;
	forward(): void;
	setQuery(value: string): void;
	setSearchFocused(value: boolean): void;
	sortBy(key: SortKey): void;
	/** The toolbar Sort menu: an explicit key and direction (synced with the header cycle). */
	applySort(key: SortKey, direction: SortDirection): void;
	/** The toolbar Group menu: choose the grouping criterion (persisted). */
	setGrouping(key: GroupKey): void;
	showToast(message: string): void;
	/** In-app Quick Look for an arbitrary path (evidence source). */
	quickLookPath(path: string): void;
	/** Arrow keys pressed inside the Quick Look window move the Finder selection. */
	moveSelectionBy(delta: 1 | -1): void;
	/** Open the path's enclosing folder in a NEW tab, revealing the row; a web source opens in the OS browser. */
	revealEvidence(path: string): void;
	focusFinder(): void;
	clickRow(entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	/**
	 * A marquee drag in the icon grid: the tiles it covers become the
	 * selection (`keys` in view order); the last one carries focus.
	 */
	marqueeSelect(keys: readonly string[]): void;
	/** A click in column-view pane `pane`: a folder opens in the next pane. */
	clickColumnRow(pane: number, entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	setViewMode(mode: ViewMode): void;
	openEntry(entry: FinderEntry): void;
	openContextMenu(entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	/** The empty-space menu for `dir` (New / Paste); defaults to the folder in view. */
	openBackgroundContextMenu(event: ReactMouseEvent<HTMLDivElement>, dir?: string): void;
	closeContextMenu(): void;
	runMenuAction(action: FinderMenuAction, format?: NewFileFormatId | null): void;
	toggleIndex(entry: FinderEntry): void;
	toggleStack(entry: FinderEntry): void;
	/** Folder disclosure triangle: nest or hide the folder's contents in place. */
	toggleFolder(entry: FinderEntry): void;
	/** A row/tile mounted without an OS icon; the controller fills it in on scroll. */
	noteVisible(entry: FinderEntry): void;
	retryVersionFamilies(): void;
	setRenameDraft(value: string): void;
	commitRename(): void;
	cancelRename(): void;
}

export interface QuickLookBridge {
	readonly onQuickLook: (target: { readonly path: string; readonly name: string }) => void;
	readonly closeQuickLook: () => void;
	readonly isQuickLookOpen: () => boolean;
}

/**
 * The workspace pane a controller drives: its tab strip comes from the pane,
 * and every tab change is written back through `update` (the App's
 * workspace state), so tab ids stay unique across panes.
 */
export interface PaneBinding {
	readonly pane: Pane;
	/** This pane has the window's focus: it alone answers the keyboard. */
	readonly focused: boolean;
	/** The window holds more than one tab, so a close can succeed. */
	readonly canCloseTabs: boolean;
	readonly update: (change: (workspace: Workspace) => Workspace) => void;
}

/** v7 search scope bar: the whole Mac or only the current folder subtree. */
export type SearchScope = "all" | "current";

export function useFinderController(
	source: FinderSource,
	data: { readonly store: DirectoryStore; readonly sidecar: EntrySidecar },
	binding: PaneBinding,
	options: {
		readonly showHiddenFiles?: boolean;
		readonly quickLook?: QuickLookBridge;
		/** ⌘F: reveal the shell that hosts the search field (it lives in the sidebar). */
		readonly onFocusSearch?: () => void;
		/** ⌘K: show an AI Search tab and focus its composer (owned by the App shell). */
		readonly onFocusComposer?: () => void;
		/** The window's toast: one for every pane. */
		readonly onToast?: (message: string) => void;
	} = {},
): FinderController {
	const { store, sidecar } = data;
	const { t } = useTranslation();
	const showHiddenFiles = options.showHiddenFiles ?? false;
	const quickLookRef = useRef(options.quickLook);
	quickLookRef.current = options.quickLook;
	const focusSearchRef = useRef(options.onFocusSearch);
	focusSearchRef.current = options.onFocusSearch;
	const focusComposerRef = useRef(options.onFocusComposer);
	focusComposerRef.current = options.onFocusComposer;
	const toastRef = useRef(options.onToast);
	toastRef.current = options.onToast;
	const { pane, focused, update: updateWorkspace } = binding;
	const paneId = pane.id;
	const tabsState: TabsState = { tabs: pane.tabs, activeId: pane.activeId, nextId: 0 };
	/** A `state/tabs.ts` transition on this pane's strip. */
	const setTabsState = useCallback(
		(change: (state: TabsState) => TabsState) => updateWorkspace((workspace) => updatePaneTabs(workspace, paneId, change)),
		[updateWorkspace, paneId],
	);
	const [query, setQueryValue] = useState("");
	const [searchScope, setSearchScope] = useState<SearchScope>("all");
	const [sort, setSort] = useState<SortState | null>(null);
	/** The toolbar Group control's criterion; the views render section headers for it. */
	const [grouping, setGroupingValue] = useState<GroupKey>(readStoredGrouping);
	const [zone, setZone] = useState<FocusZone>("finder");
	const [hits, setHits] = useState<readonly FinderEntry[]>([]);
	const [locations, setLocations] = useState<readonly FinderLocation[]>([]);
	/** Bumped when a background AutoRAG refresh settles, so visible rows re-read their state. */
	const [indexRevision, setIndexRevision] = useState(0);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [rename, setRename] = useState<RenameState | null>(null);
	const [clipboardCount, setClipboardCount] = useState(0);
	/** The 휴지통 비우기 confirm: destructive, so it never runs without an explicit click. */
	const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false);
	const [flashPath, setFlashPath] = useState<string | null>(null);
	const [searchFocused, setSearchFocused] = useState(false);
	const [revision, setRevision] = useState(0);
	const [actionCapabilities, setActionCapabilities] = useState<ActionCapabilities>(NO_CAPABILITIES);
	const [layerStore, setLayerStore] = useState<LayerStore>(EMPTY_LAYER_STORE);
	const [stackPinned, setStackPinned] = useState<ReadonlySet<string>>(new Set());
	const [viewMode, setViewModeValue] = useState<ViewMode>(readStoredViewMode);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	/** The expanded folders the tree shows open, joined; set after each render from the rows. */
	const [openFoldersKey, setOpenFoldersKey] = useState("");

	const listRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const scrollTarget = useRef<string | null>(null);
	const pathRef = useRef("");
	const tabsRef = useRef(tabsState.tabs);
	const searchingRef = useRef(false);
	const layerStoreRef = useRef<LayerStore>(EMPTY_LAYER_STORE);
	const resyncTimerRef = useRef<number | null>(null);

	const tab = activeTab(tabsState);
	const path = tab.path;
	const selection = tab.selection;
	const searching = query.trim() !== "";
	const dupey = selectDupey(layerStore);
	layerStoreRef.current = layerStore;
	const families = useMemo<VersionFamilies>(
		() => (dupey.fenced ? EMPTY_VERSION_FAMILIES : buildVersionFamilies(dupey.result.families)),
		[dupey.fenced, dupey.result.families],
	);
	const versionFamilyError = dupey.result.error;
	pathRef.current = path;
	tabsRef.current = tabsState.tabs;
	searchingRef.current = searching;
	const layout: ViewMode = viewMode === "columns" && searching ? "list" : viewMode;
	const chain = tab.chain;
	const panePaths = useMemo(
		() => (layout === "columns" && path !== "" && !isVirtualTabPath(path) ? columnPanes(path, chain) : []),
		[layout, path, chain],
	);
	const openFolders = useMemo(() => (openFoldersKey === "" ? [] : openFoldersKey.split("\u0000")), [openFoldersKey]);

	// One probe per session: main answers with the engines it actually has, so
	// the action bar can omit anything the machine cannot run.
	useEffect(() => {
		let live = true;
		source.actions
			.capabilities()
			.then((capabilities) => {
				if (live) setActionCapabilities(capabilities);
			})
			.catch((error: unknown) => {
				// A failed probe leaves the empty capability set: no dead buttons.
				console.warn("actions: capability probe failed", error);
			});
		return () => {
			live = false;
		};
	}, [source]);

	const showToast = useLatestCallback((message: string) => toastRef.current?.(message));

	/** Failures surface verbatim — the operator sees the real message. */
	const reportError = useCallback(
		(error: unknown) => toastRef.current?.(error instanceof Error ? error.message : String(error)),
		[],
	);

	/** The folder in view is gone from disk: move the tab to its nearest existing ancestor. */
	const navigateToExistingAncestor = useLatestCallback((missingPath: string) => {
		nearestExistingAncestor(missingPath, (candidate) => source.exists(candidate))
			.then((ancestor) => {
				if (pathRef.current !== missingPath || ancestor === null || ancestor === missingPath) return;
				setTabsState((state) => navigateTab(state, ancestor));
				setQueryValue("");
			})
			.catch((error: unknown) => console.error(error));
	});

	/** The folder in view relisted: selection and rename targets it no longer holds drop out. */
	const pruneToListing = useLatestCallback((survives: (path: string) => boolean) => {
		setTabsState((state) => {
			const current = activeTab(state);
			const pruned = pruneSelection(current.selection, survives);
			return pruned === current.selection ? state : patchActiveTab(state, (active) => ({ ...active, selection: pruned }));
		});
		setRename((current) => (current !== null && !survives(current.path) ? null : current));
	});

	const { listing, listingDir, panes, children } = useFolderListings({
		store,
		source,
		path,
		tabId: tab.id,
		panePaths,
		openFolders,
		revision,
		searching,
		reportError,
		onMissing: navigateToExistingAncestor,
		onRelisted: pruneToListing,
	});

	useEffect(() => store.onGone((dir) => dir === pathRef.current && navigateToExistingAncestor(dir)), [store, navigateToExistingAncestor]);

	const refresh = useLatestCallback(() => {
		setRevision((value) => value + 1);
	});

	useEffect(() => {
		let live = true;
		const load = (): void => {
			source
				.locations()
				.then((next) => {
					if (live) setLocations(next);
				})
				.catch(reportError);
		};
		load();
		// A volume mounting or a cloud account connecting re-reads the sidebar.
		const off = source.onLocationsChanged(load);
		return () => {
			live = false;
			off();
		};
		// Refresh recomputes availability, so a drive unplugged mid-session drops out.
	}, [source, reportError, revision]);

	/** The bridge source starts with no path; the first listing needs one. */
	useEffect(() => {
		if (path !== "" || locations.length === 0) {
			return;
		}
		const start = pickInitialPath(locations);
		if (start !== null) {
			setTabsState((state) => navigateTab(state, start));
		}
	}, [path, locations]);

	// Folder changes are applied by the directory store; a pane follows only the
	// live layers (version families) here.
	useEffect(
		() => source.onLive((message: LiveMessage) => setLayerStore((current) => adoptMessage(current, message))),
		[source],
	);
	// A restarted fs worker numbers its layer versions and messages from zero
	// again: drop what the old one published and adopt the new one's snapshot.
	useEffect(
		() =>
			source.onReconnect(() => {
				void source
					.liveLayers()
					.then((result) => setLayerStore(adoptResync(EMPTY_LAYER_STORE, result)))
					.catch((error: unknown) => console.error("live layer resync failed", error));
			}),
		[source],
	);

	useEffect(() => {
		if (!searching) {
			setHits([]);
			return;
		}
		let live = true;
		// A filename search defaults to the whole file-name index; the scope bar's
		// folder pill narrows it to the folder in view. The scope rides to the main
		// process so the index narrows before its result cap, not after.
		source
			.search(query, searchScope === "current" ? { scope: path } : undefined)
			.then((entries) => {
				if (!live) return;
				setHits(entries);
				store.enrich(entries);
			})
			.catch((error: unknown) => {
				if (live) {
					setHits([]);
					reportError(error);
				}
			});
		return () => {
			live = false;
		};
	}, [source, store, query, searching, revision, reportError, searchScope, path]);

	useEffect(() => {
		let live = true;
		const versionAtRequest = layerStoreRef.current.versions[DUPEY_LAYER_ID] ?? 0;
		source
			.versionFamilies()
			.then((result) => {
				if (live) {
					setLayerStore((current) => adoptInvoke(current, DUPEY_LAYER_ID, result, versionAtRequest));
				}
			})
			.catch((error: unknown) => {
				console.error("version families request failed", error);
				if (!live) return;
				const result: VersionFamiliesResult = {
					families: [],
					scannedAt: null,
					error: {
						code: "scan-failed",
						message: error instanceof Error ? error.message : String(error),
						installCommand: null,
					},
				};
				setLayerStore((current) => adoptInvoke(current, DUPEY_LAYER_ID, result, versionAtRequest));
			});
		return () => {
			live = false;
		};
	}, [source]);

	useEffect(() => {
		if (versionFamilyError === null) return;
		console.error(
			versionFamilyError.installCommand === null
				? versionFamilyError.message
				: `${versionFamilyError.message}\nInstall it with: ${versionFamilyError.installCommand}`,
		);
	}, [versionFamilyError]);

	useEffect(() => {
		let live = true;
		const resync = (): void => {
			if (path === "" || isVirtualTabPath(path)) return;
			if (!searchingRef.current) void store.load(path, "silent");
			void source
				.liveLayers()
				.then((result) => {
					if (live) setLayerStore((current) => adoptResync(current, result));
				})
				.catch((error: unknown) => console.error("live layer resync failed", error));
		};
		const queueResync = (): void => {
			if (resyncTimerRef.current !== null) window.clearTimeout(resyncTimerRef.current);
			resyncTimerRef.current = window.setTimeout(() => {
				resyncTimerRef.current = null;
				resync();
			}, 50);
		};
		const onVisibilityChange = (): void => {
			if (document.visibilityState === "visible") queueResync();
		};
		window.addEventListener("focus", queueResync);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			live = false;
			if (resyncTimerRef.current !== null) window.clearTimeout(resyncTimerRef.current);
			resyncTimerRef.current = null;
			window.removeEventListener("focus", queueResync);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [store, path, source]);

	// Only selected stack heads/members change the rows; a plain-row click must
	// not re-run sort → stack → group → tree. The joined key is value-stable
	// across renders, so the memos below see a change only when it matters.
	const stackSelection = stackSelectionKeys(selection.keys, families);
	const stackSelectionKey = stackSelection.join("\u0000");
	const stackSelected = useMemo(
		() => (stackSelectionKey === "" ? [] : stackSelectionKey.split("\u0000")),
		[stackSelectionKey],
	);
	const { stackSections, stackRows, rows, paneViews, paneEntries, viewEntries, orderedKeys } = useRowPipeline({
		sidecar,
		path,
		layout,
		searching,
		searchScope,
		hits,
		listing,
		panePaths,
		panes,
		children,
		expanded,
		sort,
		grouping,
		showHiddenFiles,
		families,
		stackPinned,
		stackSelected,
	});
	/** Every folder shown open needs its listing; the tree rows say which ones are. */
	const shownOpenKey = useMemo(() => expandedFolders(stackRows).join("\u0000"), [stackRows]);
	if (shownOpenKey !== openFoldersKey) setOpenFoldersKey(shownOpenKey);
	// The reveal flash lasts FLASH_MS from when its row is on screen, not from
	// the request: a slow first listing (a new tab on Windows) must not use it
	// up unseen. A row that never shows drops the flash after FLASH_WAIT_MS.
	const flashShown = flashPath !== null && stackRows.some((row) => row.entry.path === flashPath);
	useEffect(() => {
		if (flashPath === null) {
			return;
		}
		const timer = setTimeout(() => setFlashPath(null), flashShown ? FLASH_MS : FLASH_WAIT_MS);
		return () => clearTimeout(timer);
	}, [flashPath, flashShown]);

	/**
	 * The files on screen, as one value-comparable key: `viewEntries` is a new
	 * array on every selection change (version stacks open on selection), but
	 * the set of files only changes when the listing does, so the index-status
	 * read below must key on this, not on the array.
	 */
	const indexStatusKey = useMemo(
		() =>
			viewEntries
				.filter((entry) => entry.kind === "file")
				.map((entry) => entry.path)
				.join("\u0000"),
		[viewEntries],
	);

	/** Every file on screen shows its real AutoRAG index state; a settled refresh re-reads it. */
	useEffect(() => {
		void indexRevision;
		if (indexStatusKey === "") {
			return;
		}
		const paths = indexStatusKey.split("\u0000");
		let live = true;
		source
			.indexStatus(paths)
			.then((statuses) => {
				// Each row re-renders only if its own status moved.
				if (live) sidecar.setIndexStatuses(statuses);
			})
			.catch((error: unknown) => {
				if (live) {
					reportError(error);
				}
			});
		return () => {
			live = false;
		};
	}, [source, sidecar, indexStatusKey, indexRevision, reportError]);

	/** Keyboard movement keeps the focused item in view (list: row height 32, lead 80). */
	useEffect(() => {
		const target = scrollTarget.current;
		if (target === null) {
			return;
		}
		if (layout !== "list") {
			// A pane or a revealed folder may still be loading; keep the target until its item renders.
			const element = itemElement(listRef.current, target);
			if (element !== null) {
				scrollTarget.current = null;
				element.scrollIntoView({ block: "nearest", inline: "nearest" });
			}
			return;
		}
		// The previous folder's rows can still be on screen while a revealed folder
		// loads; the target must only be consumed by the current folder's rows (a
		// search list may come from many folders, so it is exempt).
		const index = orderedKeys.indexOf(target);
		if (index < 0 || (!searchingRef.current && listingDir !== path)) {
			// The target's listing has not landed yet (a revealed folder still
			// loading); keep the target so the next row set scrolls to it.
			return;
		}
		scrollTarget.current = null;
		if (listRef.current !== null) {
			// Group headers add height above a row, so the top comes from the
			// grouped layout (identical to index * ROW_HEIGHT when ungrouped).
			listRef.current.scrollTop = Math.max(0, groupedRowTop(stackSections, index) - SCROLL_LEAD);
		}
	}, [orderedKeys, layout, selection, path, listingDir, stackSections]);

	const patchSelection = useLatestCallback((next: SelectionState) => {
		setTabsState((state) => patchActiveTab(state, (current) => ({ ...current, selection: next })));
	});

	// The Inspector shows the selection with its icon, OS kind, and metadata:
	// resolve those rows through the sidecar, and re-render when one of them
	// (or its index state) changes — only these rows, not the listing.
	const selectionKey = selection.keys.join("\u0000");
	const subscribeSelection = useCallback(
		(listener: () => void) => {
			const offs = selectionKey === "" ? [] : selectionKey.split("\u0000").map((key) => sidecar.subscribe(key, listener));
			return () => {
				for (const off of offs) off();
			};
		},
		[sidecar, selectionKey],
	);
	const selectionRevision = useSyncExternalStore(subscribeSelection, () =>
		selectionKey === "" ? "" : selectionKey.split("\u0000").map((key) => sidecar.revision(key)).join(","),
	);
	const focusedEntry = useMemo(() => {
		void selectionRevision;
		const entry = viewEntries.find((candidate) => candidate.path === selection.focus);
		return entry === undefined ? null : sidecar.resolve(entry);
	}, [viewEntries, selection.focus, sidecar, selectionRevision]);
	const selectedEntries = useMemo(() => {
		void selectionRevision;
		if (selection.keys.length === 0) return [];
		const keys = new Set(selection.keys);
		return viewEntries.filter((entry) => keys.has(entry.path)).map((entry) => sidecar.resolve(entry));
	}, [viewEntries, selection.keys, sidecar, selectionRevision]);

	const pruneColumns = useLatestCallback((removed: readonly string[]) => {
		setTabsState((state) =>
			patchActiveTab(state, (current) => {
				const pruned = pruneChain(current.chain, removed);
				return pruned === current.chain ? current : { ...current, chain: pruned };
			}),
		);
	});

	const chooseColumnEntry = useLatestCallback(
		(pane: number, entry: FinderEntry) => {
			setTabsState((state) => {
				const current = activeTab(state);
				return applyColumnChoice(state, chooseInColumn(current.path, current.chain, pane, entry), single(entry.path));
			});
			scrollTarget.current = entry.path;
		});

	const stepColumns = useLatestCallback(
		(direction: ColumnDirection) => {
			const target = columnStep(panePaths, paneEntries, selection.focus, direction);
			if (target === null) {
				const back = direction === "left" ? slideBack(path, chain) : null;
				if (back !== null) {
					setTabsState((state) => applyColumnChoice(state, back, single(back.focus)));
					scrollTarget.current = back.focus;
				}
				return;
			}
			const entry = paneEntries[target.pane]?.find((candidate) => candidate.path === target.path);
			if (entry !== undefined) {
				chooseColumnEntry(target.pane, entry);
			}
		});

	const setViewMode = useLatestCallback((mode: ViewMode) => {
		setViewModeValue(mode);
		try {
			globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode);
		} catch (error) {
			console.warn("view mode could not be stored", error);
		}
	});

	const setGrouping = useLatestCallback((key: GroupKey) => {
		setGroupingValue(key);
		try {
			globalThis.localStorage?.setItem(GROUP_STORAGE_KEY, key);
		} catch (error) {
			console.warn("grouping could not be stored", error);
		}
	});

	/** The toolbar Sort menu: an explicit key/direction, in the same state the header cycle drives. */
	const applySort = useLatestCallback((key: SortKey, direction: SortDirection) => {
		setSort(explicitSort(key, direction));
	});

	const navigate = useLatestCallback((next: string) => {
		setTabsState((state) => navigateTab(state, next));
		setQueryValue("");
	});

	const navigateNav = useLatestCallback(
		(item: NavItem) => {
			if (!item.available) {
				showToast(`"${item.label}" 위치를 열 수 없습니다.`);
				return;
			}
			navigate(item.path);
		});

	const ejectNav = useLatestCallback(
		(item: NavItem) => {
			// Leave the volume first: an open listing holds a watcher on it, which would block the unmount.
			const fallback = locations.find((location) => location.section === "favorites" && location.icon === "home" && location.available);
			updateWorkspace((workspace) => evacuateWorkspace(workspace, item.path, fallback?.path ?? RECENTS_PATH));
			setLocations((current) => current.filter((location) => location.path !== item.path));
			source
				.ejectLocation(item.path)
				.then(() => showToast(`"${item.label}" 을(를) 추출했습니다.`))
				.catch((error: unknown) => {
					reportError(new Error(`"${item.label}" 추출 실패: ${error instanceof Error ? error.message : String(error)}`));
				})
				.finally(() => {
					// Success or refusal, the sidebar shows what is actually mounted now.
					source.locations().then(setLocations).catch(reportError);
				});
		});

	const revealEntry = useLatestCallback((entry: FinderEntry) => {
		setTabsState((state) =>
			patchActiveTab(navigateTab(state, locationOf(entry)), (current) => ({
				...current,
				selection: { keys: [entry.path], anchor: entry.path, focus: entry.path },
			})),
		);
		setQueryValue("");
		setFlashPath(entry.path);
		scrollTarget.current = entry.path;
	});

	const openEntry = useLatestCallback(
		(entry: FinderEntry) => {
			const location = locationOf(entry);
			if (entry.kind === "folder") {
				// In the column view the click already opened the folder in the next pane.
				if (layout === "columns" && panePaths.includes(location)) {
					return;
				}
				navigate(entry.path);
				return;
			}
			// A Recents row always opens: the view is a history, not a folder to reveal into.
			// Rows nested under an open folder are in view already, so they open too.
			const inView =
				location === path ||
				openFolders.includes(location) ||
				(layout === "columns" && panePaths.includes(location));
			if (searching || (!inView && path !== RECENTS_PATH)) {
				revealEntry(entry);
				return;
			}
			// Double-click / Enter on a file: the OS default application opens it.
			source.open(entry.path).catch(reportError);
		});

	/**
	 * A trash or move just took `removed` out of their folders: drop those rows
	 * everywhere the view holds them, at once, instead of waiting for the
	 * watcher's relist. Failed items are never in `removed`, so they stay on
	 * screen and stay selected.
	 */
	const dropRemoved = useLatestCallback((removed: readonly string[]) => {
		if (removed.length === 0) return;
		const gone = new Set(removed);
		store.drop(removed);
		setHits((current) => withoutPaths(current, removed));
		setTabsState((state) => {
			const current = activeTab(state);
			const selection = pruneSelection(current.selection, (path) => !gone.has(path));
			return selection === current.selection ? state : patchActiveTab(state, (tab) => ({ ...tab, selection }));
		});
		pruneColumns(removed);
	});

	const trashPaths = useLatestCallback(
		(paths: readonly string[]) => {
			if (paths.length === 0) {
				return;
			}
			source
				.trash(paths)
				.then((result) => {
					dropRemoved(result.ok);
					showToast(batchToast("trash", result));
					refresh();
				})
				.catch(reportError);
		});

	/** The sidebar's Trash location, the only folder whose rows restore instead of trash. */
	const trashLocationPath = useMemo(
		() => locations.find((location) => location.icon === "trash")?.path ?? null,
		[locations],
	);
	const inTrashLocation = trashLocationPath !== null && path === trashLocationPath;

	/**
	 * Put trashed rows back where they came from (Trash view "Put Back").
	 * ⌘Z afterwards moves them back into the Trash.
	 */
	const restoreFromTrash = useLatestCallback(
		(paths: readonly string[]) => {
			if (paths.length === 0) {
				return;
			}
			source
				.restoreFromTrash(paths)
				.then((result) => {
					dropRemoved(result.ok);
					showToast(batchToast("putBack", result));
					refresh();
				})
				.catch(reportError);
		});

	const putBackSelection = useLatestCallback(() => restoreFromTrash(selection.keys));

	const requestEmptyTrash = useLatestCallback(() => setEmptyTrashConfirm(true));
	const cancelEmptyTrash = useLatestCallback(() => setEmptyTrashConfirm(false));
	const confirmEmptyTrash = useLatestCallback(() => {
		setEmptyTrashConfirm(false);
		source
			.emptyTrash()
			.then((result) => {
				dropRemoved(result.ok);
				showToast(emptyTrashToast(result));
				refresh();
			})
			.catch(reportError);
	});

	/**
	 * Flips the file's `excludePaths` entry in the shared AutoRAG config. The row
	 * adopts the returned status at once (pending while the index catches up);
	 * the parsed + MinSync refresh runs in main and `onIndexRefreshed` re-reads.
	 */
	const toggleIndex = useLatestCallback(
		(entry: FinderEntry) => {
			const current = sidecar.indexStatus(entry.path);
			if (current === null || !current.toggleable) {
				return;
			}
			const exclude = !current.excluded;
			source
				.setIndexExcluded(entry.path, exclude)
				.then((status) => {
					sidecar.setIndexStatuses([status]);
					showToast(indexToast(entry.name, !exclude));
				})
				.catch(reportError);
		});

	useEffect(
		() =>
			source.onIndexRefreshed((error) => {
				if (error !== null) {
					reportError(new Error(`AutoRAG 인덱스 새로고침 실패: ${error}`));
				}
				setIndexRevision((value) => value + 1);
			}),
		[source, reportError],
	);

	const toggleStack = useLatestCallback((entry: FinderEntry) => {
		setStackPinned((current) => {
			const next = new Set(current);
			if (next.has(entry.path)) {
				next.delete(entry.path);
			} else {
				next.add(entry.path);
			}
			return next;
		});
	});

	/** Collapsing a folder drops the selection it hides, so no key acts on unseen rows. */
	const setFolderOpen = useLatestCallback(
		(folder: string, open: boolean) => {
			setExpanded((current) => (current.has(folder) === open ? current : toggleExpanded(current, folder)));
			if (!open && selection.keys.some((key) => isInsideFolder(key, folder))) {
				patchSelection({ keys: [folder], anchor: folder, focus: folder });
			}
		});

	const toggleFolder = useLatestCallback(
		(entry: FinderEntry) => setFolderOpen(entry.path, !expanded.has(entry.path)));

	const versionFamilyFor = useCallback((target: string) => familyViewFor(target, families), [families]);

	const familyEntriesFor = useCallback(
		(target: string) => {
			const data = families.byHead.get(target) ?? families.memberOf.get(target)?.family;
			if (data === undefined) return null;
			const head = data.entriesByPath[data.head];
			if (head === undefined) return null;
			const members = data.members.flatMap((member) => {
				const entry = data.entriesByPath[member.path];
				return entry === undefined ? [] : [{ entry, relation: member.relation }];
			});
			return { head, members };
		},
		[families],
	);

	/**
	 * After a create, select the new row and start the inline rename, exactly
	 * like Finder's New Folder / New File: the name is editable at once.
	 */
	const revealCreated = useLatestCallback(
		(created: { readonly path: string; readonly name: string }) => {
			scrollTarget.current = created.path;
			patchSelection(single(created.path));
			setRename({ path: created.path, draft: created.name });
			refresh();
		});

	/** Creation targets a real folder, never search results, Recents, or a virtual tab. */
	const canCreateIn = useLatestCallback(
		(dir: string): boolean => !searching && dir !== "" && dir !== RECENTS_PATH && !isVirtualTabPath(dir));

	const createFolderIn = useLatestCallback(
		(dir: string) => {
			if (!canCreateIn(dir)) {
				return;
			}
			source
				.createFolder(dir)
				.then((created) => {
					showToast(`${created.name} — 새 폴더를 만들었습니다`);
					revealCreated(created);
				})
				.catch(reportError);
		});

	const createFileIn = useLatestCallback(
		(dir: string, format: NewFileFormatId) => {
			if (!canCreateIn(dir)) {
				return;
			}
			source
				.createFile(dir, format)
				.then((created) => {
					showToast(`${created.name} — 새 파일을 만들었습니다`);
					revealCreated(created);
				})
				.catch(reportError);
		});

	/** ⇧⌘N and the New menu: mkdir in the folder in view. */
	const newFolder = useLatestCallback(() => createFolderIn(path));

	/** ⌥⌘N and the New menu: create a file in the folder in view. */
	const newFile = useLatestCallback((format: NewFileFormatId) => createFileIn(path, format));

	const trashEntry = useLatestCallback((entry: FinderEntry) => trashPaths([entry.path]));

	const copyEntryPath = useLatestCallback(
		(entry: FinderEntry) => {
			source
				.copyPaths([entry.path])
				.then(() => showToast("경로를 복사했습니다"))
				.catch(reportError);
		});

	/**
	 * Run one Inspector action. "AI 요약" never lands here — the App shell owns
	 * the composer — so this covers only the filesystem and OS actions. A
	 * successful action relists the folder so the new file appears at once.
	 */
	const runEntryAction = useLatestCallback(
		(entry: FinderEntry, target: FileActionTarget, anchor: ActionAnchor | null) => {
			switch (target.kind) {
				case "open":
					source.open(entry.path).catch(reportError);
					return;
				case "share":
					if (anchor === null) {
						showToast("공유 위치를 찾지 못했습니다");
						return;
					}
					source.actions.share([entry.path], anchor).catch(reportError);
					return;
				case "request":
					source.actions
						.run([entry.path], target.request)
						.then((outcome) => {
							showToast(outcome.note);
							if (outcome.output !== null) refresh();
						})
						.catch(reportError);
					return;
				case "openWith":
				case "askAi":
					// Both open UI the caller owns (the application menu, the composer).
					return;
			}
		});

	const loadOpenWithApplications = useLatestCallback((entry: FinderEntry) =>
		source.actions.openWithApplications(entry.path));

	const dragEntries = useLatestCallback(
		(entry: FinderEntry) => finderDragEntries(entry, selection.keys, viewEntries));

	const retryVersionFamilies = useLatestCallback(() => {
		const versionAtRequest = layerStoreRef.current.versions[DUPEY_LAYER_ID] ?? 0;
		source
			.refreshVersionFamilies()
			.then((result) => {
				setLayerStore((current) => adoptInvoke(current, DUPEY_LAYER_ID, result, versionAtRequest));
			})
			.catch((error: unknown) => {
				console.error("version family refresh failed", error);
				const result: VersionFamiliesResult = {
					families: [],
					scannedAt: null,
					error: {
						code: "scan-failed",
						message: error instanceof Error ? error.message : String(error),
						installCommand: null,
					},
				};
				setLayerStore((current) => adoptInvoke(current, DUPEY_LAYER_ID, result, versionAtRequest));
			});
	});

	const presentQuickLook = useLatestCallback(
		(target: { readonly path: string; readonly name: string }) => {
			quickLookRef.current?.onQuickLook(target);
			source.quickLook(target.path).catch(reportError);
		});

	const quickLookSelection = useLatestCallback(() => {
		const entry = focusedEntry;
		if (entry === null) return;
		// Like Finder, Space previews folders too; only files land in Recents.
		if (entry.kind === "folder") {
			quickLookRef.current?.onQuickLook({ path: entry.path, name: entry.name });
			return;
		}
		presentQuickLook({ path: entry.path, name: entry.name });
	});

	const moveSelectionBy = useLatestCallback(
		(delta: 1 | -1) => {
			const next = moveSelection(orderedKeys, selection, delta);
			scrollTarget.current = next.focus;
			patchSelection(next);
		});

	const quickLookPath = useLatestCallback(
		(target: string) => {
			presentQuickLook({ path: target, name: basename(target) });
		});

	// An evidence title opens the enclosing folder in a NEW tab and selects the
	// source file; a web source (the model cited a page) opens in the OS browser.
	const revealEvidence = useLatestCallback(
		(target: string) => {
			const url = evidenceSourceUrl(target);
			if (url !== null) {
				source.openUrl(url).catch(reportError);
				return;
			}
			const folder = dirname(target);
			source
				.list(folder)
				.then((entries) => {
					const entry = findEvidenceSource(entries, target);
					if (entry === undefined) {
						throw new Error(`Evidence source was not found in its folder: ${target}`);
					}
					setTabsState((state) =>
						patchActiveTab(openTabAt(state, folder), (tab) => ({
							...tab,
							selection: single(entry.path),
						})),
					);
					setQueryValue("");
					setFlashPath(entry.path);
					scrollTarget.current = entry.path;
				})
				.catch(reportError);
		});

	const menuTargets = useCallback(
		(entry: FinderEntry): readonly string[] =>
			selection.keys.includes(entry.path) && selection.keys.length > 1 ? selection.keys : [entry.path],
		[selection.keys],
	);

	/**
	 * Copy or move rows into `destDir`. A transfer that would be a no-op (the
	 * rows already live there, or the destination sits inside a dragged folder)
	 * resolves without touching the filesystem.
	 */
	const transferInto = useLatestCallback(
		(paths: readonly string[], destDir: string, op: "copy" | "move", duplicate: boolean = false): void => {
			const plan = planTransfer({ paths, destDir, op, duplicate });
			if (plan === null) {
				return;
			}
			const run =
				plan.op === "copy"
					? source.copyInto(plan.paths, plan.destDir)
					: source.moveInto(plan.paths, plan.destDir);
			run
				.then((result) => {
					if (plan.op === "move") {
						dropRemoved(result.ok);
						if (result.failed.length === 0) setClipboardCount(0);
					}
					showToast(batchToast(plan.op, result));
					refresh();
				})
				.catch(reportError);
		});

	const copyPaths = useLatestCallback(
		(paths: readonly string[]) => {
			if (paths.length === 0) return;
			source
				.clipboardSet({ op: "copy", paths })
				.then(() => setClipboardCount(paths.length))
				.catch(reportError);
		});

	const cutPaths = useLatestCallback(
		(paths: readonly string[]) => {
			if (paths.length === 0) return;
			source
				.clipboardSet({ op: "cut", paths })
				.then(() => setClipboardCount(paths.length))
				.catch(reportError);
		});

	/** ⌘V pastes the clipboard op as-is; ⌥⌘V forces a move. */
	const pasteClipboard = useLatestCallback(
		(move: boolean) => {
			if (path === "" || path === RECENTS_PATH || isVirtualTabPath(path)) return;
			source
				.clipboardGet()
				.then((clipboard) => {
					if (clipboard === null || clipboard.paths.length === 0) return;
					transferInto(clipboard.paths, path, move || clipboard.op === "cut" ? "move" : "copy");
				})
				.catch(reportError);
		});

	/**
	 * ⌘Z: undo the most recent recorded transfer. An empty record is a no-op
	 * (Finder does nothing either); a partially-failed undo reports the first
	 * verbatim reason.
	 */
	const undoLastTransfer = useLatestCallback((): void => {
		source
			.undo()
			.then((outcome) => {
				if (outcome.empty) return;
				if (outcome.failed.length > 0) {
					showToast(`되돌리기 실패: ${outcome.failed[0]?.message ?? "알 수 없는 오류"}`);
					refresh();
					return;
				}
				showToast("마지막 파일 작업을 되돌렸습니다");
				refresh();
			})
			.catch(reportError);
	});

	const copySelection = useLatestCallback(() => copyPaths(selection.keys));
	const cutSelection = useLatestCallback(() => cutPaths(selection.keys));

	/** An in-app row drop: ⌥ copies (into the rows' own folder too, as Finder duplicates), otherwise the rows move. */
	const transferDropped = useLatestCallback(
		(paths: readonly string[], destDir: string, copy: boolean) => {
			if (destDir === "" || destDir === RECENTS_PATH || isVirtualTabPath(destDir)) return;
			transferInto(paths, destDir, copy ? "copy" : "move", copy);
		});

	/** A drop on another tab: show that tab, then move/copy the rows into its folder. */
	const dropOnTab = useLatestCallback(
		(tabId: number, paths: readonly string[], copy: boolean) => {
			const target = tabsRef.current.find((current) => current.id === tabId);
			if (target === undefined) return;
			updateWorkspace((workspace) => focusTab(workspace, tabId));
			setQueryValue("");
			transferDropped(paths, target.path, copy);
		});

	/** The folder a row-menu create lands in: the pane the menu opened in (column view), else the folder in view. */
	const menuCreateDir = useLatestCallback(
		(menu: ContextMenuState): string =>
			menu.entry !== null && layout === "columns" && panePaths.includes(locationOf(menu.entry))
				? locationOf(menu.entry)
				: menu.dir,
	);

	const runMenuAction = useLatestCallback(
		(action: FinderMenuAction, format: NewFileFormatId | null = null) => {
			const menu = contextMenu;
			if (menu === null) {
				return;
			}
			setContextMenu(null);
			if (action === "newFolder") {
				createFolderIn(menuCreateDir(menu));
				return;
			}
			if (action === "newFile") {
				createFileIn(menu.dir, format ?? "text");
				return;
			}
			if (action === "paste") {
				// The column view pastes into the pane the menu was opened in.
				const pasteDir = menuCreateDir(menu);
				source
					.clipboardGet()
					.then((clipboard) => {
						if (clipboard === null || clipboard.paths.length === 0) return;
						transferInto(clipboard.paths, pasteDir, clipboard.op === "cut" ? "move" : "copy");
					})
					.catch(reportError);
				return;
			}
			const entry = menu.entry;

			if (action === "emptyTrash") {
				// The background menu's 휴지통 비우기: destructive, so the confirm opens first.
				requestEmptyTrash();
				return;
			}
			// Every remaining action needs a row; the empty-space menu never offers them.
			if (entry === null) {
				return;
			}
			const targets = menuTargets(entry);
			switch (action) {
				case "quickLook":
					presentQuickLook({ path: entry.path, name: entry.name });
					return;
				case "open":
					navigate(entry.path);
					return;
				case "showInEnclosingFolder": {
					// A new tab opens on the folder that holds the file, with the row revealed.
					setTabsState((state) =>
						patchActiveTab(openTabAt(state, dirname(entry.path)), (tab) => ({
							...tab,
							selection: { keys: [entry.path], anchor: entry.path, focus: entry.path },
						})),
					);
					setQueryValue("");
					setFlashPath(entry.path);
					scrollTarget.current = entry.path;
					return;
				}
				case "toggleIndex":
					toggleIndex(entry);
					return;
				case "retryIndex":
					return;
				case "copy":
					copyPaths(targets);
					return;
				case "cut":
					cutPaths(targets);
					return;
				case "duplicate":
					source
						.duplicate(targets)
						.then((result) => {
							if (result.failed.length > 0) showToast(batchToast("duplicate", result));
							refresh();
						})
						.catch(reportError);
					return;
				case "rename":
					setRename({ path: entry.path, draft: entry.name });
					return;
				case "copyPath":
					source.copyPaths(targets).catch(reportError);
					return;
				case "openWith":
					// The menu's item is the Inspector's "기타…": the OS application
					// chooser, then one launch for the whole selection.
					source.actions
						.run(targets, { kind: "openWith", application: null })
						.then((outcome) => showToast(outcome.note))
						.catch(reportError);
					return;
				case "compress":
				case "extract":
					// One request for the whole selection: compress writes one archive,
					// and extraction is offered for a single archive row only.
					source.actions
						.run(targets, { kind: action })
						.then((outcome) => {
							showToast(outcome.note);
							if (outcome.output !== null) refresh();
						})
						.catch(reportError);
					return;
				case "share":
					// The sheet anchors at the cursor: the menu just closed there, and
					// that is where the user's attention is.
					source.actions
						.share(targets, { x: menu.cursor.x, y: menu.cursor.y, width: 0, height: 0 })
						.catch(reportError);
					return;
				case "trash":
					trashPaths(targets);
					return;
				case "putBack":
					restoreFromTrash(targets);
					return;
			}
		});

	const commitRename = useLatestCallback(() => {
		const editing = rename;
		if (editing === null) {
			return;
		}
		const current = basename(editing.path);
		const folder = dirname(editing.path);
		const siblings = viewEntries.filter((entry) => dirname(entry.path) === folder).map((entry) => entry.name);
		const check = validateName(editing.draft, siblings, current);
		setRename(null);
		if (!check.ok) {
			showToast(check.message);
			return;
		}
		const next = editing.draft.trim();
		if (next === current) {
			return;
		}
		source
			.rename(editing.path, next)
			.then(() => {
				pruneColumns([editing.path]);
				refresh();
			})
			.catch(reportError);
	});

	const openContextMenu = useLatestCallback(
		(entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			setZone("finder");
			if (!selection.keys.includes(entry.path)) {
				patchSelection({ keys: [entry.path], anchor: entry.path, focus: entry.path });
			}
			source
				.clipboardGet()
				.then((clipboard) => setClipboardCount(clipboard?.paths.length ?? 0))
				.catch(reportError);
			setContextMenu({ cursor: { x: event.clientX, y: event.clientY }, entry, dir: path });
		});

	/** Right-click on empty space: New / Paste act on the pane's own folder. */
	const openBackgroundContextMenu = useLatestCallback(
		(event: ReactMouseEvent<HTMLDivElement>, dir?: string) => {
			event.preventDefault();
			setZone("finder");
			patchSelection(EMPTY_SELECTION);
			source
				.clipboardGet()
				.then((clipboard) => setClipboardCount(clipboard?.paths.length ?? 0))
				.catch(reportError);
			setContextMenu({ cursor: { x: event.clientX, y: event.clientY }, entry: null, dir: dir ?? path });
		});

	const dismiss = useLatestCallback(() => {
		if (emptyTrashConfirm) {
			setEmptyTrashConfirm(false);
			return;
		}
		if (contextMenu !== null) {
			setContextMenu(null);
			return;
		}
		if (rename !== null) {
			setRename(null);
			return;
		}
		if (quickLookRef.current?.isQuickLookOpen() === true) {
			quickLookRef.current.closeQuickLook();
			return;
		}
		if (query !== "") {
			setQueryValue("");
		}
	});

	const focusPath = useLatestCallback((target: string) => {
		scrollTarget.current = target;
		patchSelection(single(target));
	});
	const moveTo = useLatestCallback((next: SelectionState) => {
		scrollTarget.current = next.focus;
		patchSelection(next);
	});
	const focusSearch = useLatestCallback(() => {
		focusSearchRef.current?.();
		searchRef.current?.focus();
	});
	const closeActiveTab = useLatestCallback(() =>
		updateWorkspace((workspace) => {
			const current = workspace.panes.find((candidate) => candidate.id === paneId);
			return current === undefined ? workspace : closeWorkspaceTab(workspace, current.activeId);
		}),
	);
	const focusComposer = useLatestCallback(() => {
		updateWorkspace(focusAiSearchInWorkspace);
		focusComposerRef.current?.();
	});
	const newTab = useLatestCallback(() => setTabsState((state) => openTab(state)));
	const openSettings = useLatestCallback(() => updateWorkspace(openOrSelectSettingsInWorkspace));
	// Every member is a stable useLatestCallback, so this object is created once.
	const keyActions = useMemo(
		() => ({
			dismiss,
			focusSearch,
			newTab,
			newFolder,
			newFile,
			closeTab: closeActiveTab,
			openSettings,
			focusComposer,
			quickLookSelection,
			stepColumns,
			focusPath,
			moveTo,
			setViewMode,
			setFolderOpen,
			openEntry,
			trash: trashPaths,
			copySelection,
			cutSelection,
			pasteClipboard,
			undoLastTransfer,
		}),
		[
			dismiss,
			focusSearch,
			newTab,
			newFolder,
			newFile,
			closeActiveTab,
			openSettings,
			focusComposer,
			quickLookSelection,
			stepColumns,
			focusPath,
			moveTo,
			setViewMode,
			setFolderOpen,
			openEntry,
			trashPaths,
			copySelection,
			cutSelection,
			pasteClipboard,
			undoLastTransfer,
		],
	);
	useFinderKeyboard({
		focused,
		zone,
		path,
		layout,
		selection,
		orderedKeys,
		stackRows,
		stackSections,
		focusedEntry,
		listRef,
		actions: keyActions,
	});

	const tabViews = useMemo<readonly TabView[]>(
		() =>
			pane.tabs.map((current) => {
				const active = current.id === pane.activeId;
				return {
					id: current.id,
					title: tabTitle(current, { isActive: active, query }),
					active,
					flash: current.flash,
					aiSearch: current.path === AI_SEARCH_PATH,
				};
			}),
		[pane, query],
	);

	const contextMenuEntries = useMemo<readonly FinderMenuEntry[]>(() => {
		const menu = contextMenu;
		if (menu === null) {
			return [];
		}
		if (menu.entry === null) {
			return buildBackgroundContextMenu({ clipboardCount, inTrash: inTrashLocation }, (k, def) => t(k, { defaultValue: def }));
		}
		const entry = menu.entry;
		return buildContextMenu(
			{
				target: { name: entry.name, kind: entry.kind },
				selectionCount: menuTargets(entry).length,
				indexIncluded: sidecar.indexStatus(entry.path)?.excluded !== true,
				clipboardCount,
				inRecents: path === RECENTS_PATH,
				inTrash: inTrashLocation,
				capabilities: actionCapabilities,
				canCreateFolder: canCreateIn(menuCreateDir(menu)),
			},
			(k, def, opt) => t(k, { defaultValue: def, ...(opt as Record<string, unknown> | undefined) }),
		);
	}, [contextMenu, menuTargets, sidecar, clipboardCount, path, t, inTrashLocation, actionCapabilities, canCreateIn, menuCreateDir, layout, panePaths]);

	const navTargets = useMemo(
		() => (locations.length > 0 ? locations : [{ name: basename(path), path }]),
		[locations, path],
	);
	const activeNav = activeNavPath(path, navTargets);
	const sidebarGroups = useMemo(() => navGroups(locations), [locations]);

	// Handlers handed to the view: one stable identity each (see useLatestCallback),
	// so no closure here keeps an earlier render's rows alive.
	const selectTabId = useLatestCallback((id: number) => updateWorkspace((workspace) => focusTab(workspace, id)));
	const closeTabId = useLatestCallback((id: number) => updateWorkspace((workspace) => closeWorkspaceTab(workspace, id)));
	const showAiSearch = useLatestCallback(() => setTabsState((state) => showAiSearchInActiveTab(state)));
	const openAiSearch = useLatestCallback(() => setTabsState((state) => openAiSearchTab(state)));
	const focusAiSearch = useLatestCallback(() => updateWorkspace(focusAiSearchInWorkspace));
	const leaveVirtualTab = useLatestCallback(() => setTabsState((state) => exitVirtualTab(state)));
	const back = useLatestCallback(() => setTabsState((state) => goBack(state)));
	const forward = useLatestCallback(() => setTabsState((state) => goForward(state)));
	const sortBy = useLatestCallback((key: SortKey) => setSort((current) => cycleSort(current, key)));
	const focusFinder = useLatestCallback(() => setZone("finder"));
	const clickRow = useLatestCallback((entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>) => {
		setZone("finder");
		patchSelection(
			applyRowClick(selection, entry.path, orderedKeys, {
				meta: event.metaKey || event.ctrlKey,
				shift: event.shiftKey,
			}),
		);
	});
	const clickColumnRow = useLatestCallback((pane: number, entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>) => {
		setZone("finder");
		if (event.metaKey || event.ctrlKey || event.shiftKey) {
			// Multi-select stays inside one pane and closes the panes after it.
			const paneKeys = (paneEntries[pane] ?? []).map((candidate) => candidate.path);
			const inPane = { ...selection, keys: selection.keys.filter((key) => paneKeys.includes(key)) };
			const next = applyRowClick(inPane, entry.path, paneKeys, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey });
			setTabsState((state) => {
				const current = activeTab(state);
				const closed = chooseInColumn(current.path, current.chain, pane, { path: entry.path, kind: "file" });
				return applyColumnChoice(state, closed, next);
			});
			return;
		}
		chooseColumnEntry(pane, entry);
	});
	const marqueeSelect = useLatestCallback((keys: readonly string[]) => {
		setZone("finder");
		patchSelection({ keys, anchor: keys[0] ?? null, focus: keys[keys.length - 1] ?? null });
	});
	const closeContextMenu = useLatestCallback(() => setContextMenu(null));
	const setRenameDraft = useLatestCallback((value: string) => setRename((current) => (current === null ? null : { ...current, draft: value })));
	const cancelRename = useLatestCallback(() => setRename(null));
	const indexStatusFor = useCallback((target: string) => sidecar.indexStatus(target), [sidecar]);
	const noteVisible = useCallback((entry: FinderEntry) => store.requestIcon(entry), [store]);

	return {
		tabs: tabViews,
		canCloseTabs: binding.canCloseTabs,
		path,
		crumbs: breadcrumbTrail(path),
		canGoBack: tab.back.length > 0,
		canGoForward: tab.fwd.length > 0,
		query,
		searchFocused,
		searching,
		emptyText: emptyStateText(query, path, (k, def, opt) => t(k, { defaultValue: def, ...(opt as Record<string, unknown> | undefined) })),
		rows,
		stackRows,
		stackSections,
		sort,
		grouping,
		zone,
		selection,
		flashPath,
		renamePath: rename?.path ?? null,
		renameDraft: rename?.draft ?? "",
		indexStatusFor,
		versionFamilyError,
		activeNavPath: activeNav,
		navGroups: sidebarGroups,
		contextMenu: contextMenu === null ? null : { cursor: contextMenu.cursor },
		contextMenuEntries,
		viewMode,
		layout,
		searchScope,
		setSearchScope,
		focusedEntry,
		selectedEntries,
		versionFamilyFor,
		familyEntriesFor,
		revealEntry,
		newFolder,
		newFile,
		trashEntry,
		copyEntryPath,
		actionCapabilities,
		runEntryAction,
		loadOpenWithApplications,
		dragEntries,
		copySelection,
		cutSelection,
		pasteClipboard,
		undoLastTransfer,
		inTrashLocation,
		putBackSelection,
		requestEmptyTrash,
		confirmEmptyTrash,
		cancelEmptyTrash,
		emptyTrashConfirm,
		transferDropped,
		dropOnTab,
		columnPanes: paneViews,
		listRef,
		searchRef,
		navigate,
		navigateNav,
		ejectNav,
		selectTabId,
		closeTabId,
		newTab,
		openSettings,
		showAiSearch,
		openAiSearch,
		focusAiSearch,
		leaveVirtualTab,
		back,
		forward,
		setQuery: setQueryValue,
		setSearchFocused,
		sortBy,
		applySort,
		setGrouping,
		showToast,
		quickLookPath,
		moveSelectionBy,
		revealEvidence,
		focusFinder,
		marqueeSelect,
		clickRow,
		clickColumnRow,
		setViewMode,
		openEntry,
		openContextMenu,
		openBackgroundContextMenu,
		closeContextMenu,
		runMenuAction,
		toggleIndex,
		toggleStack,
		toggleFolder,
		noteVisible,
		retryVersionFamilies,
		setRenameDraft,
		commitRename,
		cancelRename,
	};
}
