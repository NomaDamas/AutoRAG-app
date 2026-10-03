import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import { DUPEY_LAYER_ID, type FsDirChange, type LiveMessage } from "../../../shared/live-contract";
import type { FinderEntry } from "../data/entries";
import type { NavItem } from "../data/places";
import { isMissingPathFailure, type FinderLocation, type FinderSource, pickInitialPath } from "../data/source";
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
	buildContextMenu,
	type FinderMenuAction,
	type FinderMenuEntry,
} from "../state/context-menu";
import { emptyStateText, indexToast, trashToast } from "../state/format";
import { type FocusZone, resolveKeyAction } from "../state/keymap";
import {
	applyEntryEnrichmentPatch,
	applyEntryPatch,
	applyOptimisticDeletes,
	createIncrementalListing,
	createListingLoader,
	nearestExistingAncestor,
	listingSurvivor,
	pruneSelection,
	reconcileListing,
	watchSetFor,
	type IncrementalListing,
	type ListingScope,
} from "../state/live";
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
	moveInGrid,
	moveSelection,
	type SelectionState,
	scrollTopForIndex,
} from "../state/selection";
import { type SortKey, type SortState, cycleSort, sortEntries } from "../state/sort";
import { visibleEntries } from "../state/visibility";
import {
	buildFolderTree,
	discloseStep,
	expandedFolders,
	flatTreeRows,
	isInsideFolder,
	toggleExpanded,
	type TreeRow,
} from "../state/folder-tree";
import {
	applyVersionStacks,
	buildVersionFamilies,
	EMPTY_VERSION_FAMILIES,
	familyViewFor,
	type StackRow,
	type VersionFamilies,
	type VersionFamiliesResult,
	type VersionFamilyError,
	type VersionFamilyView,
	type VersionRelation,
} from "../state/version-family";
import {
	activeTab,
	applyColumnChoice,
	canCloseTab,
	closeTab,
	CONTACTS_PATH,
	createTabsState,
	goBack,
	goForward,
	navigateTab,
	openOrSelectSettingsTab,
	openTab,
	openTabAt,
	patchActiveTab,
	selectTab,
	SETTINGS_PATH,
	tabTitle,
	type TabsState,
} from "../state/tabs";
import type { TabView } from "../components/TabStrip";
import type { ColumnPaneView } from "../components/ColumnBrowser";
import { parseViewMode, VIEW_MODE_STORAGE_KEY, type ViewMode } from "../state/view-mode";
import { needsThumbnail, takeThumbnailBatch, thumbnailKey } from "../state/thumbnails";

/** --time-toast */
const TOAST_MS = 2400;
/** --time-flash */
const FLASH_MS = 1800;
/** Coalescing window for viewport-visible thumbnail requests, so a scroll burst is one batch. */
const THUMBNAIL_FLUSH_MS = 60;

interface ContextMenuState {
	readonly cursor: { readonly x: number; readonly y: number };
	readonly entry: FinderEntry;
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

/** The tile or column row that renders `path` (the list view scrolls by row index instead). */
function itemElement(root: HTMLElement | null, path: string): HTMLElement | null {
	const selector = `[data-path="${CSS.escape(path)}"]`;
	return root?.querySelector<HTMLElement>(`.icon-tile${selector}, .column-row${selector}`) ?? null;
}

/** Tiles per row in the icon grid, read from the laid-out DOM. */
function gridColumns(root: HTMLElement | null): number {
	const tiles = root?.querySelectorAll<HTMLElement>(".icon-tile");
	const first = tiles?.[0];
	if (tiles === undefined || first === undefined) {
		return 1;
	}
	let count = 0;
	for (const tile of tiles) {
		if (tile.offsetTop !== first.offsetTop) break;
		count += 1;
	}
	return Math.max(1, count);
}

interface RenameState {
	readonly path: string;
	readonly draft: string;
}

/** An expanded folder's listing, tagged with the refresh revision it was read at. */
interface ChildListing {
	readonly revision: number;
	readonly entries: readonly FinderEntry[];
}

export interface FinderController {
	readonly tabs: readonly TabView[];
	readonly canCloseTabs: boolean;
	readonly path: string;
	readonly crumbs: readonly Crumb[];
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly query: string;
	readonly searchPlaceholder: string;
	readonly searchFocused: boolean;
	readonly searching: boolean;
	readonly emptyText: string;
	readonly rows: readonly FinderEntry[];
	readonly stackRows: readonly TreeRow[];
	readonly sort: SortState | null;
	readonly zone: FocusZone;
	readonly selection: SelectionState;
	readonly toast: string | null;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	/** AutoRAG local-index state per file path, read from the parsed mirror and MinSync staging. */
	readonly indexStatus: Readonly<Record<string, IndexStatus>>;
	/** Non-null when dupey is missing or a version-family scan failed. */
	readonly versionFamilyError: VersionFamilyError | null;
	readonly activeNavLabel: string | null;
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
	/** The dupey family a path heads or belongs to — the inspector "Versions" section. */
	versionFamilyFor(path: string): VersionFamilyView | null;
	/** Same family with real entries attached — the column view's variants pane. */
	familyEntriesFor(path: string): { readonly head: FinderEntry; readonly members: readonly { readonly entry: FinderEntry; readonly relation: VersionRelation }[] } | null;
	/** Navigate the current tab to the entry's folder and reveal the row (version-member click). */
	revealEntry(entry: FinderEntry): void;
	/** Create an "untitled folder" in the current directory and select it. */
	newFolder(): void;
	/** Trash a single entry (inspector action bar). */
	trashEntry(entry: FinderEntry): void;
	/** Copy a single entry's path to the system clipboard (inspector action bar). */
	copyEntryPath(entry: FinderEntry): void;
	/** Column view panes, left to right (empty outside the column layout). */
	readonly columnPanes: readonly ColumnPaneView[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	navigate(path: string): void;
	navigateNav(item: NavItem): void;
	selectTabId(id: number): void;
	closeTabId(id: number): void;
	newTab(): void;
	openSettings(): void;
	back(): void;
	forward(): void;
	setQuery(value: string): void;
	setSearchFocused(value: boolean): void;
	sortBy(key: SortKey): void;
	showToast(message: string): void;
	/** In-app Quick Look for an arbitrary path (evidence source). */
	quickLookPath(path: string): void;
	/** Arrow keys pressed inside the Quick Look window move the Finder selection. */
	moveSelectionBy(delta: 1 | -1): void;
	/** Open the path's enclosing folder in a NEW tab, revealing the row. */
	revealEvidence(path: string): void;
	focusFinder(): void;
	clickRow(entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	/** A click in column-view pane `pane`: a folder opens in the next pane. */
	clickColumnRow(pane: number, entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	setViewMode(mode: ViewMode): void;
	openEntry(entry: FinderEntry): void;
	openContextMenu(entry: FinderEntry, event: ReactMouseEvent<HTMLDivElement>): void;
	closeContextMenu(): void;
	runMenuAction(action: FinderMenuAction): void;
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

/** v7 search scope bar: the whole Mac or only the current folder subtree. */
export type SearchScope = "all" | "current";

export function useFinderController(
	source: FinderSource,
	options: {
		readonly showHiddenFiles?: boolean;
		readonly quickLook?: QuickLookBridge;
		/** ⌘K: open the AI dock and focus its composer (owned by the App shell). */
		readonly onFocusComposer?: () => void;
		/** Esc: close the inspector's evidence half; return true when consumed. */
		readonly onDismissEvidence?: () => boolean;
	} = {},
): FinderController {
	const showHiddenFiles = options.showHiddenFiles ?? false;
	const quickLookRef = useRef(options.quickLook);
	quickLookRef.current = options.quickLook;
	const focusComposerRef = useRef(options.onFocusComposer);
	focusComposerRef.current = options.onFocusComposer;
	const dismissEvidenceRef = useRef(options.onDismissEvidence);
	dismissEvidenceRef.current = options.onDismissEvidence;
	const [tabsState, setTabsState] = useState<TabsState>(() => createTabsState(source.initialPath));
	const [query, setQueryValue] = useState("");
	const [searchScope, setSearchScope] = useState<SearchScope>("all");
	const [sort, setSort] = useState<SortState | null>(null);
	const [zone, setZone] = useState<FocusZone>("finder");
	const [listing, setListing] = useState<readonly FinderEntry[]>([]);
	/** The tab whose folder `listing` was last switched to; see the swap below. */
	const [listingTabId, setListingTabId] = useState(tabsState.activeId);
	const [hits, setHits] = useState<readonly FinderEntry[]>([]);
	const [locations, setLocations] = useState<readonly FinderLocation[]>([]);
	const [indexStatus, setIndexStatus] = useState<Readonly<Record<string, IndexStatus>>>({});
	/** Bumped when a background AutoRAG refresh settles, so visible rows re-read their state. */
	const [indexRevision, setIndexRevision] = useState(0);
	const [toast, setToast] = useState<string | null>(null);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [rename, setRename] = useState<RenameState | null>(null);
	const [clipboardCount, setClipboardCount] = useState(0);
	const [flashPath, setFlashPath] = useState<string | null>(null);
	const [searchFocused, setSearchFocused] = useState(false);
	const [revision, setRevision] = useState(0);
	const [layerStore, setLayerStore] = useState<LayerStore>(EMPTY_LAYER_STORE);
	const [stackPinned, setStackPinned] = useState<ReadonlySet<string>>(new Set());
	const [viewMode, setViewModeValue] = useState<ViewMode>(readStoredViewMode);
	/** Column view: listings by folder path, for every pane. */
	const [paneListings, setPaneListings] = useState<Readonly<Record<string, readonly FinderEntry[]>>>({});
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [childListings, setChildListings] = useState<Readonly<Record<string, ChildListing>>>({});

	const listRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const scrollTarget = useRef<string | null>(null);
	const generationRef = useRef(0);
	const pathRef = useRef("");
	const activeTabIdRef = useRef(0);
	const tabsRef = useRef(tabsState.tabs);
	const searchingRef = useRef(false);
	const listingRef = useRef<readonly FinderEntry[]>([]);
	/** The folder whose rows `listing` currently holds; gates scroll-to-target. */
	const listingDirRef = useRef("");
	const layerStoreRef = useRef<LayerStore>(EMPTY_LAYER_STORE);
	const staleTabsRef = useRef(new Set<number>());
	/** Each tab's last adopted listing, so switching back paints it at once. */
	const tabListingsRef = useRef(new Map<number, { readonly dir: string; readonly entries: readonly FinderEntry[] }>());
	const previousPathRef = useRef<string | null>(null);
	const previousTabIdRef = useRef<number | null>(null);
	const incrementalRef = useRef<{ source: FinderSource; listing: IncrementalListing } | null>(null);
	const resyncTimerRef = useRef<number | null>(null);
	const previousRevisionRef = useRef(revision);
	const previousSourceRef = useRef(source);
	/**
	 * Viewport-driven thumbnail requests. Both views are virtualized, so a row
	 * only calls `noteVisible` while it is near the viewport; requests coalesce
	 * here and drain through `source.enrich`, so a folder larger than the
	 * provider's per-call icon cap fills in as the user scrolls instead of
	 * going iconless past the first batch. Keyed by `(path, modifiedAt)`.
	 */
	const thumbRequestsRef = useRef(new Set<string>());
	const thumbQueueRef = useRef(new Map<string, FinderEntry>());
	const thumbTimerRef = useRef<number | null>(null);

	const tab = activeTab(tabsState);
	const path = tab.path;
	const selection = tab.selection;
	// A tab switch shows that tab's last listing in the same render that
	// switches tabs, so the first frame after the click is already the target
	// folder — not the previous tab's rows, then bare rows, then icons. The
	// reload the switch starts revalidates it underneath (`reconcileListing`).
	if (listingTabId !== tab.id) {
		setListingTabId(tab.id);
		const snapshot = tabListingsRef.current.get(tab.id);
		if (snapshot !== undefined && snapshot.dir === path) {
			listingDirRef.current = snapshot.dir;
			setListing(snapshot.entries);
			setPaneListings((current) =>
				current[path] === snapshot.entries ? current : { ...current, [path]: snapshot.entries },
			);
		}
	}
	const searching = query.trim() !== "";
	const dupey = selectDupey(layerStore);
	layerStoreRef.current = layerStore;
	const families = useMemo<VersionFamilies>(
		() => (dupey.fenced ? EMPTY_VERSION_FAMILIES : buildVersionFamilies(dupey.result.families)),
		[dupey.fenced, dupey.result.families],
	);
	const versionFamilyError = dupey.result.error;
	pathRef.current = path;
	activeTabIdRef.current = tab.id;
	tabsRef.current = tabsState.tabs;
	searchingRef.current = searching;
	listingRef.current = listing;
	const layout: ViewMode = viewMode === "columns" && searching ? "list" : viewMode;
	const chain = tab.chain;
	const panePaths = useMemo(
		() => (layout === "columns" && path !== "" ? columnPanes(path, chain) : []),
		[layout, path, chain],
	);

	const showToast = useCallback((message: string) => setToast(message), []);

	/** Failures surface verbatim — the operator sees the real message. */
	const reportError = useCallback(
		(error: unknown) => setToast(error instanceof Error ? error.message : String(error)),
		[],
	);

	const listingLoader = useMemo(
		() =>
			createListingLoader<FinderEntry>(
				(nextPath) => source.list(nextPath),
				(request) =>
					request.path === pathRef.current && request.generation === generationRef.current,
			),
		[source],
	);

	/**
	 * Start a navigation scope: bump the generation and tell the incremental
	 * coordinator its baseline full listing is pending. Old work is orphaned.
	 */
	const beginScope = useCallback((): ListingScope => {
		generationRef.current += 1;
		const scope: ListingScope = {
			generation: generationRef.current,
			path: pathRef.current,
			tabId: activeTabIdRef.current,
		};
		incrementalRef.current?.listing.begin(scope);
		return scope;
	}, []);

	const navigateToExistingAncestor = useCallback(
		async (missingPath: string, requestGeneration: number): Promise<void> => {
			try {
				const ancestor = await nearestExistingAncestor(missingPath, (candidate) => source.exists(candidate));
				if (pathRef.current !== missingPath || generationRef.current !== requestGeneration || ancestor === null) {
					return;
				}
				beginScope();
				setTabsState((state) => navigateTab(state, ancestor));
				setQueryValue("");
			} catch (error: unknown) {
				console.error(error);
			}
		},
		[beginScope, source],
	);

	/**
	 * The listing for `dir` (the tab's folder) lands: it also feeds the first
	 * column pane, and drops selection and rename targets it no longer holds.
	 */
	const adoptListing = useCallback((dir: string, entries: readonly FinderEntry[]): void => {
		listingDirRef.current = dir;
		const snapshots = tabListingsRef.current;
		snapshots.set(activeTabIdRef.current, { dir, entries });
		for (const id of snapshots.keys()) {
			if (!tabsRef.current.some((current) => current.id === id)) snapshots.delete(id);
		}
		const previous = listingRef.current;
		const survives = listingSurvivor(dir, previous, entries);
		listingRef.current = entries;
		if (previous !== entries) {
			setListing(entries);
		}
		setPaneListings((current) => (current[dir] === entries ? current : { ...current, [dir]: entries }));
		setTabsState((state) => {
			const current = activeTab(state);
			const selection = pruneSelection(current.selection, survives);
			return selection === current.selection ? state : patchActiveTab(state, (tab) => ({ ...tab, selection }));
		});
		setRename((current) => (current !== null && !survives(current.path) ? null : current));
	}, []);

	const loadListing = useCallback(
		(
			requestedPath: string,
			mode: "navigate" | "silent",
			requestGeneration: number,
		): void => {
			// A fresh listing invalidates which identities the viewport has asked
			// for, so the next mounted rows request their icons again.
			thumbRequestsRef.current.clear();
			thumbQueueRef.current.clear();
			if (thumbTimerRef.current !== null) {
				window.clearTimeout(thumbTimerRef.current);
				thumbTimerRef.current = null;
			}
			const scope: ListingScope = {
				generation: requestGeneration,
				path: requestedPath,
				tabId: activeTabIdRef.current,
			};
			// A full load is in flight: live patches wait for its baseline.
			incrementalRef.current?.listing.fullStarted(scope);
			const request = {
				path: requestedPath,
				generation: requestGeneration,
				mode,
				previous: listingRef.current,
			} as const;
			void listingLoader(request).then(async (result) => {
				if (result.kind === "stale" || result.kind === "superseded") {
					// A newer scope or request owns the baseline now.
					return;
				}
				if (result.kind === "error") {
					if (mode === "silent") {
						let missing = false;
						try {
							missing = await isMissingPathFailure(source, requestedPath);
						} catch (error: unknown) {
							console.error(error);
						}
						if (missing) {
							await navigateToExistingAncestor(requestedPath, requestGeneration);
						} else {
							console.error(result.error);
						}
						incrementalRef.current?.listing.fullAdopted(scope);
						return;
					}
					adoptListing(requestedPath, []);
					incrementalRef.current?.listing.fullAdopted(scope);
					reportError(result.error);
					return;
				}
				// Rows unchanged on disk keep their icons and identity: a tab
				// switch or focus resync that finds nothing new paints nothing.
				const entries = reconcileListing(listingRef.current, result.entries);
				adoptListing(requestedPath, entries);
				void source.enrich(requestedPath, entries).then((enriched) => {
					if (pathRef.current === requestedPath && generationRef.current === requestGeneration) {
						adoptListing(requestedPath, applyEntryEnrichmentPatch(listingRef.current, enriched));
						return;
					}
					// The user switched tabs before the icons landed: finish that
					// tab's snapshot anyway, unless it has moved on since.
					const snapshot = tabListingsRef.current.get(scope.tabId);
					if (snapshot?.entries === entries) {
						tabListingsRef.current.set(scope.tabId, {
							dir: requestedPath,
							entries: applyEntryEnrichmentPatch(snapshot.entries, enriched),
						});
					}
				}).catch((error: unknown) => console.error("background listing enrichment failed", error));
				incrementalRef.current?.listing.fullAdopted(scope);
			});
		},
		[adoptListing, listingLoader, navigateToExistingAncestor, reportError, source],
	);

	/**
	 * Drain the coalesced viewport requests as one enrichment batch, then patch
	 * the visible entries so their tiles pick up the icon. Mirrors the background
	 * enrichment guards: search hits patch `hits`, a folder listing patches the
	 * current listing only while that scope is still active.
	 */
	const flushThumbnails = useCallback((): void => {
		thumbTimerRef.current = null;
		if (thumbQueueRef.current.size === 0) {
			return;
		}
		const searchingNow = searchingRef.current;
		const dir = pathRef.current;
		const generation = generationRef.current;
		const batch = takeThumbnailBatch(
			thumbQueueRef.current,
			thumbRequestsRef.current,
			(location) => searchingNow || location === dir,
		);
		if (batch.length === 0) {
			return;
		}
		void source
			.enrich(searchingNow ? "search" : dir, batch)
			.then((enriched) => {
				if (searchingNow) {
					if (searchingRef.current) setHits((current) => applyEntryPatch(current, { entries: enriched, removed: [] }));
					return;
				}
				if (pathRef.current !== dir || generationRef.current !== generation || searchingRef.current) return;
				adoptListing(dir, applyEntryEnrichmentPatch(listingRef.current, enriched));
			})
			.catch((error: unknown) => console.error("viewport thumbnail enrichment failed", error));
	}, [adoptListing, source]);

	/**
	 * One row/tile reported itself as mounted without an OS icon. Coalesce it
	 * with the other visible requests, then drain a batch through the same
	 * `source.enrich` the background pass uses and patch the icon in place.
	 */
	const noteVisible = useCallback(
		(entry: FinderEntry): void => {
			if (!needsThumbnail(entry)) {
				return;
			}
			const key = thumbnailKey(entry);
			if (thumbRequestsRef.current.has(key) || thumbQueueRef.current.has(key)) {
				return;
			}
			thumbQueueRef.current.set(key, entry);
			if (thumbTimerRef.current === null) {
				thumbTimerRef.current = window.setTimeout(flushThumbnails, THUMBNAIL_FLUSH_MS);
			}
		},
		[flushThumbnails],
	);

	const currentIncremental = incrementalRef.current;
	let incremental: IncrementalListing;
	if (currentIncremental !== null && currentIncremental.source === source) {
		incremental = currentIncremental.listing;
	} else {
		currentIncremental?.listing.cancel();
		incremental = createIncrementalListing({
			read: (dir, paths) => source.readEntries(dir, paths),
			apply: (dir, patch) => {
				adoptListing(dir, applyEntryPatch(listingRef.current, patch));
				const generation = generationRef.current;
				void source.enrich(dir, patch.entries).then((enriched) => {
					if (pathRef.current !== dir || generationRef.current !== generation || searchingRef.current) return;
					adoptListing(dir, applyEntryEnrichmentPatch(listingRef.current, enriched));
				}).catch((error: unknown) => console.error("background live enrichment failed", error));
			},
			isCurrent: (scope) =>
				scope.path === pathRef.current &&
				scope.generation === generationRef.current &&
				scope.tabId === activeTabIdRef.current &&
				!searchingRef.current,
			onError: (error) => {
				console.error("live incremental listing failed", error);
				loadListing(pathRef.current, "silent", generationRef.current);
			},
		});
		incrementalRef.current = { source, listing: incremental };
	}

	const refresh = useCallback(() => {
		setRevision((value) => value + 1);
	}, []);

	useEffect(() => {
		let live = true;
		source
			.locations()
			.then((next) => {
				if (live) {
					setLocations(next);
				}
			})
			.catch(reportError);
		return () => {
			live = false;
		};
	}, [source, reportError]);

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

	useEffect(() => {
		if (path === "" || path === SETTINGS_PATH) {
			previousPathRef.current = path;
			previousTabIdRef.current = tab.id;
			previousRevisionRef.current = revision;
			return;
		}
		const pathChanged = previousPathRef.current !== path;
		const tabChanged = previousTabIdRef.current !== tab.id;
		const revisionChanged = previousRevisionRef.current !== revision;
		const sourceChanged = previousSourceRef.current !== source;
		if (pathChanged || tabChanged || revisionChanged || sourceChanged) {
			beginScope();
		}
		previousPathRef.current = path;
		previousTabIdRef.current = tab.id;
		previousRevisionRef.current = revision;
		previousSourceRef.current = source;
		if (searching && !pathChanged && !tabChanged) {
			return;
		}
		const stale = staleTabsRef.current.has(tab.id);
		const mode = pathChanged && !stale ? "navigate" : "silent";
		loadListing(path, mode, generationRef.current);
		if (stale) {
			staleTabsRef.current.delete(tab.id);
		}
	}, [beginScope, loadListing, path, revision, searching, source, tab.id]);

	const tabPathsKey = tabsState.tabs.map((current) => current.path).join("\u0000");

	useEffect(() => {
		void source.setWatchSet(watchSetFor(tabsState.tabs)).catch((error: unknown) => console.error(error));
	}, [source, tabPathsKey]);

	useEffect(() => {
		return () => {
			void source.setWatchSet([]).catch((error: unknown) => console.error(error));
		};
	}, [source]);

	useEffect(() => {
		const unsubscribe = source.onLive((message: LiveMessage) => {
			setLayerStore((current) => adoptMessage(current, message));
			const activeTabId = activeTabIdRef.current;
			const activePath = pathRef.current;
			const activeChanges: FsDirChange[] = [];
			for (const dirChange of message.dirs) {
				const tabsForDir = tabsRef.current.filter((current) => current.path === dirChange.dir);
				if (tabsForDir.length === 0) {
					continue;
				}
				for (const current of tabsForDir) {
					if (current.id === activeTabId) {
						activeChanges.push(dirChange);
					} else {
						staleTabsRef.current.add(current.id);
					}
				}
			}
			if (activeChanges.length === 0) {
				return;
			}
			if (searchingRef.current) {
				staleTabsRef.current.add(activeTabId);
				return;
			}
			if (activeChanges.some((change) => change.dirGone || change.overflow)) {
				const scope = beginScope();
				let optimistic = listingRef.current;
				for (const change of activeChanges) optimistic = applyOptimisticDeletes(optimistic, change);
				adoptListing(activePath, optimistic);
				if (activeChanges.some((change) => change.dirGone)) {
					const { generation } = scope;
					void navigateToExistingAncestor(activePath, generation).then(() => {
						// The folder never moved (no existing ancestor): relist so the
						// scope settles and patches stop waiting on a missing baseline.
						if (pathRef.current === activePath && generationRef.current === generation) {
							loadListing(activePath, "silent", generation);
						}
					});
					return;
				}
				loadListing(activePath, "silent", scope.generation);
				return;
			}
			const changedPaths = [...new Set(activeChanges.flatMap((change) => change.changes.map(({ path }) => path)))];
			if (changedPaths.length === 0) return;
			incremental.changed(changedPaths);
		});
		return () => {
			unsubscribe();
			incremental.cancel();
		};
	}, [adoptListing, beginScope, incremental, loadListing, navigateToExistingAncestor, source]);

	/** Column view: the panes after the first list the folders chosen along the chain. */
	useEffect(() => {
		const targets = panePaths.filter((target) => target !== path);
		if (targets.length === 0) {
			return;
		}
		let live = true;
		for (const target of targets) {
			source
				.list(target)
				.then((entries) => {
					if (!live) return;
					setPaneListings((current) => {
						const reconciled = reconcileListing(current[target] ?? [], entries);
						return reconciled === current[target] ? current : { ...current, [target]: reconciled };
					});
					void source.enrich(target, entries).then((enriched) => {
						if (!live) return;
						setPaneListings((current) => {
							const patched = applyEntryEnrichmentPatch(current[target] ?? [], enriched);
							return patched === current[target] ? current : { ...current, [target]: patched };
						});
					}).catch((error: unknown) => console.error("background pane enrichment failed", error));
				})
				.catch((error: unknown) => {
					if (live) {
						setPaneListings((current) => ({ ...current, [target]: [] }));
						reportError(error);
					}
				});
		}
		return () => {
			live = false;
		};
	}, [source, path, panePaths, revision, reportError]);

	useEffect(() => {
		if (!searching) {
			setHits([]);
			return;
		}
		// Search results are a new viewport; let their visible rows ask fresh.
		thumbRequestsRef.current.clear();
		thumbQueueRef.current.clear();
		let live = true;
		source
			.search(query)
			.then((entries) => {
				if (!live) return;
				setHits(entries);
				void source.enrich("search", entries).then((enriched) => {
					if (live) setHits(enriched);
				}).catch((error: unknown) => console.error("background search enrichment failed", error));
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
	}, [source, query, searching, revision, reportError]);

	useEffect(() => {
		if (toast === null) {
			return;
		}
		const timer = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(timer);
	}, [toast]);

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
			if (path === "") return;
			const scope = beginScope();
			void source.setWatchSet(watchSetFor(tabsRef.current)).catch((error: unknown) =>
				console.error("live watch resync failed", error),
			);
			if (!searchingRef.current) loadListing(path, "silent", scope.generation);
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
	}, [beginScope, loadListing, path, source]);

	useEffect(() => {
		if (flashPath === null) {
			return;
		}
		const timer = setTimeout(() => setFlashPath(null), FLASH_MS);
		return () => clearTimeout(timer);
	}, [flashPath]);

	const stackRows = useMemo(() => {
		const prepare = (entries: readonly FinderEntry[]): readonly StackRow[] =>
			applyVersionStacks(sortEntries(visibleEntries(entries, showHiddenFiles), sort), {
				families,
				manualOpen: stackPinned,
				selectedKeys: selection.keys,
			});
		if (searching) {
			const scoped =
				searchScope === "current" ? hits.filter((hit) => hit.path === path || hit.path.startsWith(`${path}/`)) : hits;
			return flatTreeRows(prepare(scoped));
		}
		return buildFolderTree(prepare(listing), {
			expanded,
			childrenOf: (folder) => {
				const loaded = childListings[folder];
				return loaded === undefined ? undefined : prepare(loaded.entries);
			},
		});
	}, [searching, hits, listing, sort, showHiddenFiles, families, stackPinned, selection.keys, expanded, childListings, searchScope, path]);

	const paneViews = useMemo<readonly ColumnPaneView[]>(
		() =>
			panePaths.map((panePath) => {
				const entries = paneListings[panePath];
				return {
					path: panePath,
					loaded: entries !== undefined,
					rows: applyVersionStacks(sortEntries(visibleEntries(entries ?? [], showHiddenFiles), sort), {
						families,
						manualOpen: stackPinned,
						selectedKeys: selection.keys,
					}),
				};
			}),
		[panePaths, paneListings, showHiddenFiles, sort, families, stackPinned, selection.keys],
	);
	const paneEntries = useMemo(() => paneViews.map((pane) => pane.rows.map((row) => row.entry)), [paneViews]);

	/** Every folder shown open needs its listing; stale ones re-read after a refresh. */
	const openFolders = useMemo(() => expandedFolders(stackRows), [stackRows]);
	const requestedListings = useRef(new Set<string>());
	useEffect(() => {
		for (const folder of openFolders) {
			const request = `${revision}\u0000${folder}`;
			if (childListings[folder]?.revision === revision || requestedListings.current.has(request)) {
				continue;
			}
			requestedListings.current.add(request);
			const settle = (entries: readonly FinderEntry[]): void => {
				requestedListings.current.delete(request);
				setChildListings((current) =>
					(current[folder]?.revision ?? -1) > revision ? current : { ...current, [folder]: { revision, entries } },
				);
				void source.enrich(folder, entries).then((enriched) => {
					setChildListings((current) =>
						(current[folder]?.revision ?? -1) > revision ? current : { ...current, [folder]: { revision, entries: enriched } },
					);
				}).catch((error: unknown) => console.error("background child enrichment failed", error));
			};
			source
				.list(folder)
				.then(settle)
				.catch((error: unknown) => {
					settle([]);
					reportError(error);
				});
		}
	}, [openFolders, childListings, revision, source, reportError]);
	const rows = useMemo(() => stackRows.map((row) => row.entry), [stackRows]);
	/** Every entry on screen: all panes in the column view, the listing otherwise. */
	const viewEntries = useMemo(() => (layout === "columns" ? paneEntries.flat() : rows), [layout, paneEntries, rows]);
	const orderedKeys = useMemo(() => viewEntries.map((entry) => entry.path), [viewEntries]);

	/** Every file on screen shows its real AutoRAG index state; a settled refresh re-reads it. */
	useEffect(() => {
		void indexRevision;
		const paths = viewEntries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
		if (paths.length === 0) {
			return;
		}
		let live = true;
		source
			.indexStatus(paths)
			.then((statuses) => {
				if (live) {
					setIndexStatus((current) => ({
						...current,
						...Object.fromEntries(statuses.map((status) => [status.path, status])),
					}));
				}
			})
			.catch((error: unknown) => {
				if (live) {
					reportError(error);
				}
			});
		return () => {
			live = false;
		};
	}, [source, viewEntries, indexRevision, reportError]);

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
	// The previous tab's rows can still be on screen while a revealed folder
	// loads; the target must only be consumed by the current folder's rows (a
	// search list may come from many folders, so it is exempt).
	const index = orderedKeys.indexOf(target);
	if (index < 0 || (!searchingRef.current && listingDirRef.current !== path)) {
		// The target's listing has not landed yet (a revealed folder still
		// loading); keep the target so the next row set scrolls to it.
		return;
	}
	scrollTarget.current = null;
	if (listRef.current !== null) {
		listRef.current.scrollTop = scrollTopForIndex(index);
	}
	}, [orderedKeys, layout, selection, path]);

	const patchSelection = useCallback((next: SelectionState) => {
		setTabsState((state) => patchActiveTab(state, (current) => ({ ...current, selection: next })));
	}, []);

	const focusedEntry = useMemo(
		() => viewEntries.find((entry) => entry.path === selection.focus) ?? null,
		[viewEntries, selection.focus],
	);

	const pruneColumns = useCallback((removed: readonly string[]) => {
		setTabsState((state) =>
			patchActiveTab(state, (current) => {
				const pruned = pruneChain(current.chain, removed);
				return pruned === current.chain ? current : { ...current, chain: pruned };
			}),
		);
	}, []);

	const chooseColumnEntry = useCallback(
		(pane: number, entry: FinderEntry) => {
			setTabsState((state) => {
				const current = activeTab(state);
				return applyColumnChoice(state, chooseInColumn(current.path, current.chain, pane, entry), single(entry.path));
			});
			scrollTarget.current = entry.path;
		},
		[],
	);

	const stepColumns = useCallback(
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
		},
		[panePaths, paneEntries, selection.focus, path, chain, chooseColumnEntry],
	);

	const setViewMode = useCallback((mode: ViewMode) => {
		setViewModeValue(mode);
		try {
			globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode);
		} catch (error) {
			console.warn("view mode could not be stored", error);
		}
	}, []);

	const navigate = useCallback((next: string) => {
		setTabsState((state) => navigateTab(state, next));
		setQueryValue("");
	}, []);

	const navigateNav = useCallback(
		(item: NavItem) => {
			const match = locations.find((location) => location.name === item.label);
			if (match === undefined) {
				showToast(`"${item.label}" 위치는 아직 연결되지 않았습니다.`);
				return;
			}
			navigate(match.path);
		},
		[locations, navigate, showToast],
	);

	const revealEntry = useCallback((entry: FinderEntry) => {
		setTabsState((state) =>
			patchActiveTab(navigateTab(state, entry.location), (current) => ({
				...current,
				selection: { keys: [entry.path], anchor: entry.path, focus: entry.path },
			})),
		);
		setQueryValue("");
		setFlashPath(entry.path);
		scrollTarget.current = entry.path;
	}, []);

	const openEntry = useCallback(
		(entry: FinderEntry) => {
			if (entry.kind === "folder") {
				// In the column view the click already opened the folder in the next pane.
				if (layout === "columns" && panePaths.includes(entry.location)) {
					return;
				}
				navigate(entry.path);
				return;
			}
			// A Recents row always opens: the view is a history, not a folder to reveal into.
			// Rows nested under an open folder are in view already, so they open too.
			const inView =
				entry.location === path ||
				openFolders.includes(entry.location) ||
				(layout === "columns" && panePaths.includes(entry.location));
			if (searching || (!inView && path !== RECENTS_PATH)) {
				revealEntry(entry);
				return;
			}
			// Double-click / Enter on a file: the OS default application opens it.
			source.open(entry.path).catch(reportError);
		},
		[navigate, path, layout, panePaths, openFolders, revealEntry, searching, source, reportError],
	);

	const trashPaths = useCallback(
		(paths: readonly string[]) => {
			if (paths.length === 0) {
				return;
			}
			source
				.trash(paths)
				.then(() => {
					patchSelection(EMPTY_SELECTION);
					pruneColumns(paths);
					showToast(trashToast(paths));
					refresh();
				})
				.catch(reportError);
		},
		[source, patchSelection, pruneColumns, showToast, refresh, reportError],
	);

	/**
	 * Flips the file's `excludePaths` entry in the shared AutoRAG config. The row
	 * adopts the returned status at once (pending while the index catches up);
	 * the parsed + MinSync refresh runs in main and `onIndexRefreshed` re-reads.
	 */
	const toggleIndex = useCallback(
		(entry: FinderEntry) => {
			const current = indexStatus[entry.path];
			if (current === undefined || !current.toggleable) {
				return;
			}
			const exclude = !current.excluded;
			source
				.setIndexExcluded(entry.path, exclude)
				.then((status) => {
					setIndexStatus((statuses) => ({ ...statuses, [status.path]: status }));
					showToast(indexToast(entry.name, !exclude));
				})
				.catch(reportError);
		},
		[indexStatus, source, showToast, reportError],
	);

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

	const toggleStack = useCallback((entry: FinderEntry) => {
		setStackPinned((current) => {
			const next = new Set(current);
			if (next.has(entry.path)) {
				next.delete(entry.path);
			} else {
				next.add(entry.path);
			}
			return next;
		});
	}, []);

	/** Collapsing a folder drops the selection it hides, so no key acts on unseen rows. */
	const setFolderOpen = useCallback(
		(folder: string, open: boolean) => {
			setExpanded((current) => (current.has(folder) === open ? current : toggleExpanded(current, folder)));
			if (!open && selection.keys.some((key) => isInsideFolder(key, folder))) {
				patchSelection({ keys: [folder], anchor: folder, focus: folder });
			}
		},
		[selection.keys, patchSelection],
	);

	const toggleFolder = useCallback(
		(entry: FinderEntry) => setFolderOpen(entry.path, !expanded.has(entry.path)),
		[expanded, setFolderOpen],
	);

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

	/** Sidebar "New folder": real mkdir in the current folder, then select the row. */
	const newFolder = useCallback(() => {
		if (searching || path === "" || path === RECENTS_PATH || path === SETTINGS_PATH || path === CONTACTS_PATH) {
			return;
		}
		source
			.createFolder(path)
			.then((created) => {
				showToast(`${created.name} — 새 폴더를 만들었습니다`);
				scrollTarget.current = created.path;
				patchSelection({ keys: [created.path], anchor: created.path, focus: created.path });
				refresh();
			})
			.catch(reportError);
	}, [source, searching, path, showToast, patchSelection, refresh, reportError]);

	const trashEntry = useCallback((entry: FinderEntry) => trashPaths([entry.path]), [trashPaths]);

	const copyEntryPath = useCallback(
		(entry: FinderEntry) => {
			source
				.copyPaths([entry.path])
				.then(() => showToast("경로를 복사했습니다"))
				.catch(reportError);
		},
		[source, showToast, reportError],
	);

	const retryVersionFamilies = useCallback(() => {
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
	}, [source]);

	const presentQuickLook = useCallback(
		(target: { readonly path: string; readonly name: string }) => {
			quickLookRef.current?.onQuickLook(target);
			source.quickLook(target.path).catch(reportError);
		},
		[source, reportError],
	);

	const quickLookSelection = useCallback(() => {
		const entry = focusedEntry;
		if (entry === null || entry.kind === "folder") return;
		presentQuickLook({ path: entry.path, name: entry.name });
	}, [focusedEntry, presentQuickLook]);

	const moveSelectionBy = useCallback(
		(delta: 1 | -1) => {
			const next = moveSelection(orderedKeys, selection, delta);
			scrollTarget.current = next.focus;
			patchSelection(next);
		},
		[orderedKeys, selection, patchSelection],
	);

	const quickLookPath = useCallback(
		(target: string) => {
			presentQuickLook({ path: target, name: basename(target) });
		},
		[presentQuickLook],
	);

	// An evidence crumb opens the enclosing folder in a NEW tab, with the source row revealed.
	const revealEvidence = useCallback(
		(target: string) => {
			const folder = dirname(target);
			source
				.list(folder)
				.then(() => {
					setTabsState((state) =>
						patchActiveTab(openTabAt(state, folder), (tab) => ({
							...tab,
							selection: { keys: [target], anchor: target, focus: target },
						})),
					);
					setQueryValue("");
					setFlashPath(target);
					scrollTarget.current = target;
				})
				.catch(reportError);
		},
		[source, reportError],
	);

	const menuTargets = useCallback(
		(entry: FinderEntry): readonly string[] =>
			selection.keys.includes(entry.path) && selection.keys.length > 1 ? selection.keys : [entry.path],
		[selection.keys],
	);

	const runMenuAction = useCallback(
		(action: FinderMenuAction) => {
			const menu = contextMenu;
			if (menu === null) {
				return;
			}
			const entry = menu.entry;
			const targets = menuTargets(entry);
			// The column view pastes into the pane the menu was opened in.
			const pasteDir = layout === "columns" && panePaths.includes(entry.location) ? entry.location : path;
			setContextMenu(null);
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
					source
						.clipboardSet({ op: "copy", paths: targets })
						.then(() => setClipboardCount(targets.length))
						.catch(reportError);
					return;
				case "cut":
					source
						.clipboardSet({ op: "cut", paths: targets })
						.then(() => setClipboardCount(targets.length))
						.catch(reportError);
					return;
				case "paste":
					source
						.clipboardGet()
						.then(async (clipboard) => {
							if (clipboard === null || clipboard.paths.length === 0) {
								return;
							}
							if (clipboard.op === "copy") {
								await source.copyInto(clipboard.paths, pasteDir);
							} else {
								await source.moveInto(clipboard.paths, pasteDir);
								pruneColumns(clipboard.paths);
								setClipboardCount(0);
							}
							refresh();
						})
						.catch(reportError);
					return;
				case "duplicate":
					source
						.duplicate(targets)
						.then(refresh)
						.catch(reportError);
					return;
				case "rename":
					setRename({ path: entry.path, draft: entry.name });
					return;
				case "copyPath":
					source.copyPaths(targets).catch(reportError);
					return;
				case "trash":
					trashPaths(targets);
					return;
			}
		},
		[contextMenu, menuTargets, navigate, path, layout, panePaths, presentQuickLook, pruneColumns, refresh, reportError, source, toggleIndex, trashPaths],
	);

	const commitRename = useCallback(() => {
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
	}, [rename, viewEntries, showToast, source, pruneColumns, refresh, reportError]);

	const openContextMenu = useCallback(
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
			setContextMenu({ cursor: { x: event.clientX, y: event.clientY }, entry });
		},
		[selection.keys, patchSelection, source, reportError],
	);

	const dismiss = useCallback(() => {
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
		if (dismissEvidenceRef.current?.() === true) {
			return;
		}
		if (query !== "") {
			setQueryValue("");
		}
	}, [contextMenu, rename, query]);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			const action = resolveKeyAction(
				{
					key: event.key,
					meta: event.metaKey || event.ctrlKey,
					shift: event.shiftKey,
					alt: event.altKey,
				},
				{ zone, typing, viewMode: layout },
			);
			if (action === null) {
				return;
			}
			switch (action.type) {
				case "dismiss":
					dismiss();
					return;
				case "focusSearch":
					event.preventDefault();
					searchRef.current?.focus();
					return;
				case "newTab":
					event.preventDefault();
					setTabsState((state) => openTab(state));
					return;
				case "closeTab":
					event.preventDefault();
					setTabsState((state) => closeTab(state, state.activeId));
					return;
				case "openSettings":
					event.preventDefault();
					setTabsState((state) => openOrSelectSettingsTab(state));
					return;
				case "focusComposer":
					event.preventDefault();
					focusComposerRef.current?.();
					return;
				case "quickLook":
					event.preventDefault();
					quickLookSelection();
					return;
				case "moveSelection": {
					event.preventDefault();
					if (layout === "columns") {
						stepColumns(action.delta === 1 ? "down" : "up");
						return;
					}
					const next =
						layout === "icons"
							? moveInGrid(orderedKeys, selection, { dx: 0, dy: action.delta }, gridColumns(listRef.current))
							: moveSelection(orderedKeys, selection, action.delta);
					scrollTarget.current = next.focus;
					patchSelection(next);
					return;
				}
				case "moveSelectionSideways": {
					event.preventDefault();
					if (layout === "columns") {
						stepColumns(action.delta === 1 ? "right" : "left");
						return;
					}
					const next = moveInGrid(orderedKeys, selection, { dx: action.delta, dy: 0 }, gridColumns(listRef.current));
					scrollTarget.current = next.focus;
					patchSelection(next);
					return;
				}
				case "setViewMode":
					event.preventDefault();
					setViewMode(action.mode);
					return;
				case "moveEvidence":
					return;
				case "disclose": {
					const step = discloseStep(stackRows, selection.focus, action.direction);
					if (step === null) {
						return;
					}
					event.preventDefault();
					if (step.type === "select") {
						scrollTarget.current = step.path;
						patchSelection({ keys: [step.path], anchor: step.path, focus: step.path });
						return;
					}
					setFolderOpen(step.path, step.type === "expand");
					return;
				}
				case "open":
					event.preventDefault();
					if (layout === "columns" && focusedEntry?.kind === "folder") {
						stepColumns("right");
						return;
					}
					if (focusedEntry !== null) {
						openEntry(focusedEntry);
					}
					return;
				case "trash":
					event.preventDefault();
					trashPaths(selection.keys);
					return;
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		zone,
		layout,
		stepColumns,
		setViewMode,
		dismiss,
		orderedKeys,
		stackRows,
		setFolderOpen,
		selection,
		quickLookSelection,
		focusedEntry,
		openEntry,
		trashPaths,
	]);

	const tabViews = useMemo<readonly TabView[]>(
		() =>
			tabsState.tabs.map((current) => {
				const active = current.id === tabsState.activeId;
				return {
					id: current.id,
					title: tabTitle(current, { isActive: active, query }),
					active,
					flash: current.flash,
				};
			}),
		[tabsState, query],
	);

	const contextMenuEntries = useMemo<readonly FinderMenuEntry[]>(() => {
		const entry = contextMenu?.entry;
		if (entry === undefined) {
			return [];
		}
		return buildContextMenu({
			target: { name: entry.name, kind: entry.kind },
			selectionCount: menuTargets(entry).length,
			indexIncluded: indexStatus[entry.path]?.excluded !== true,
			clipboardCount,
			inRecents: path === RECENTS_PATH,
		});
	}, [contextMenu, menuTargets, indexStatus, clipboardCount, path]);

	const navTargets = useMemo(
		() => (locations.length > 0 ? locations : [{ name: basename(path), path }]),
		[locations, path],
	);
	const activeNav = activeNavPath(path, navTargets);
	const activeNavLabel =
		navTargets.find((target) => target.path === activeNav)?.name ?? (path === "" ? null : basename(path));

	return {
		tabs: tabViews,
		canCloseTabs: canCloseTab(tabsState),
		path,
		crumbs: breadcrumbTrail(path),
		canGoBack: tab.back.length > 0,
		canGoForward: tab.fwd.length > 0,
		query,
		searchPlaceholder:
			path === CONTACTS_PATH ? "Search contacts" : path === SETTINGS_PATH ? "Search settings" : "Search files, contents…",
		searchFocused,
		searching,
		emptyText: emptyStateText(query, path),
		rows,
		stackRows,
		sort,
		zone,
		selection,
		toast,
		flashPath,
		renamePath: rename?.path ?? null,
		renameDraft: rename?.draft ?? "",
		indexStatus,
		versionFamilyError,
		activeNavLabel,
		contextMenu: contextMenu === null ? null : { cursor: contextMenu.cursor },
		contextMenuEntries,
		viewMode,
		layout,
		searchScope,
		setSearchScope,
		focusedEntry,
		versionFamilyFor,
		familyEntriesFor,
		revealEntry,
		newFolder,
		trashEntry,
		copyEntryPath,
		columnPanes: paneViews,
		listRef,
		searchRef,
		navigate,
		navigateNav,
		selectTabId: (id) => setTabsState((state) => selectTab(state, id)),
		closeTabId: (id) => setTabsState((state) => closeTab(state, id)),
		newTab: () => setTabsState((state) => openTab(state)),
		openSettings: () => setTabsState((state) => openOrSelectSettingsTab(state)),
		back: () => setTabsState((state) => goBack(state)),
		forward: () => setTabsState((state) => goForward(state)),
		setQuery: setQueryValue,
		setSearchFocused,
		sortBy: (key) => setSort((current) => cycleSort(current, key)),
		showToast,
		quickLookPath,
		moveSelectionBy,
		revealEvidence,
		focusFinder: () => setZone("finder"),
		clickRow: (entry, event) => {
			setZone("finder");
			patchSelection(
				applyRowClick(selection, entry.path, orderedKeys, {
					meta: event.metaKey || event.ctrlKey,
					shift: event.shiftKey,
				}),
			);
		},
		clickColumnRow: (pane, entry, event) => {
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
		},
		setViewMode,
		openEntry,
		openContextMenu,
		closeContextMenu: () => setContextMenu(null),
		runMenuAction,
		toggleIndex,
		toggleStack,
		toggleFolder,
		noteVisible,
		retryVersionFamilies,
		setRenameDraft: (value) => setRename((current) => (current === null ? null : { ...current, draft: value })),
		commitRename,
		cancelRename: () => setRename(null),
	};
}
