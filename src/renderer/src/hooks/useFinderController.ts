import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { FinderEntry } from "../data/entries";
import type { NavItem } from "../data/places";
import { type FinderLocation, type FinderSource, pickInitialPath } from "../data/source";
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
import { emptyStateText, indexToast, searchSummaryText, statusBarText, trashToast } from "../state/format";
import { type FocusZone, resolveKeyAction } from "../state/keymap";
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
	applyVersionStacks,
	buildVersionFamilies,
	defaultIndexIncluded,
	EMPTY_VERSION_FAMILIES,
	type StackRow,
	type VersionFamilies,
	type VersionFamiliesResult,
	type VersionFamilyError,
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
	openTab,
	openTabAt,
	patchActiveTab,
	selectTab,
	tabTitle,
	type TabsState,
} from "../state/tabs";
import type { TabView } from "../components/TabStrip";
import type { ColumnPaneView } from "../components/ColumnBrowser";
import { parseViewMode, VIEW_MODE_STORAGE_KEY, type ViewMode } from "../state/view-mode";

/** --time-toast */
const TOAST_MS = 2400;
/** --time-flash */
const FLASH_MS = 1800;

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
	readonly searchSummary: string;
	readonly emptyText: string;
	readonly rows: readonly FinderEntry[];
	readonly stackRows: readonly StackRow[];
	readonly sort: SortState | null;
	readonly zone: FocusZone;
	readonly selection: SelectionState;
	readonly statusText: string;
	readonly toast: string | null;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly indexOverrides: Readonly<Record<string, boolean>>;
	/** Non-null when dupey is missing or a version-family scan failed. */
	readonly versionFamilyError: VersionFamilyError | null;
	readonly activeNavLabel: string | null;
	readonly contextMenu: { readonly cursor: { readonly x: number; readonly y: number } } | null;
	readonly contextMenuEntries: readonly FinderMenuEntry[];
	/** The mode the toolbar toggle shows as chosen. */
	readonly viewMode: ViewMode;
	/** The view actually rendered: the column view shows search results as a list. */
	readonly layout: ViewMode;
	/** Column view panes, left to right (empty outside the column layout). */
	readonly columnPanes: readonly ColumnPaneView[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	navigate(path: string): void;
	navigateNav(item: NavItem): void;
	selectTabId(id: number): void;
	closeTabId(id: number): void;
	newTab(): void;
	back(): void;
	forward(): void;
	setQuery(value: string): void;
	setSearchFocused(value: boolean): void;
	onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void;
	sortBy(key: SortKey): void;
	showToast(message: string): void;
	/** Native Quick Look for an arbitrary path (evidence source). Errors toast verbatim. */
	quickLookPath(path: string): void;
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
	retryVersionFamilies(): void;
	setRenameDraft(value: string): void;
	commitRename(): void;
	cancelRename(): void;
}

export function useFinderController(
	source: FinderSource,
	options: { readonly showHiddenFiles?: boolean } = {},
): FinderController {
	const showHiddenFiles = options.showHiddenFiles ?? false;
	const [tabsState, setTabsState] = useState<TabsState>(() => createTabsState(source.initialPath));
	const [query, setQueryValue] = useState("");
	const [sort, setSort] = useState<SortState | null>(null);
	const [zone, setZone] = useState<FocusZone>("finder");
	const [listing, setListing] = useState<readonly FinderEntry[]>([]);
	const [hits, setHits] = useState<readonly FinderEntry[]>([]);
	const [locations, setLocations] = useState<readonly FinderLocation[]>([]);
	const [indexOverrides, setIndexOverrides] = useState<Readonly<Record<string, boolean>>>({});
	const [toast, setToast] = useState<string | null>(null);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [rename, setRename] = useState<RenameState | null>(null);
	const [clipboardCount, setClipboardCount] = useState(0);
	const [flashPath, setFlashPath] = useState<string | null>(null);
	const [searchFocused, setSearchFocused] = useState(false);
	const [revision, setRevision] = useState(0);
	const [families, setFamilies] = useState<VersionFamilies>(EMPTY_VERSION_FAMILIES);
	const [versionFamilyError, setVersionFamilyError] = useState<VersionFamilyError | null>(null);
	const [stackPinned, setStackPinned] = useState<ReadonlySet<string>>(new Set());
	const [viewMode, setViewModeValue] = useState<ViewMode>(readStoredViewMode);
	/** Column view: listings by folder path, for every pane. */
	const [paneListings, setPaneListings] = useState<Readonly<Record<string, readonly FinderEntry[]>>>({});

	const listRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const scrollTarget = useRef<string | null>(null);

	const tab = activeTab(tabsState);
	const path = tab.path;
	const selection = tab.selection;
	const searching = query.trim() !== "";
	const layout: ViewMode = viewMode === "columns" && searching ? "list" : viewMode;
	const chain = tab.chain;
	const panePaths = useMemo(
		() => (layout === "columns" && path !== "" ? columnPanes(path, chain) : []),
		[layout, path, chain],
	);

	const refresh = useCallback(() => setRevision((value) => value + 1), []);

	const showToast = useCallback((message: string) => setToast(message), []);

	/** Failures surface verbatim — the operator sees the real message. */
	const reportError = useCallback(
		(error: unknown) => setToast(error instanceof Error ? error.message : String(error)),
		[],
	);

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
		if (path === "") {
			return;
		}
		let live = true;
		source
			.list(path)
			.then((entries) => {
				if (live) {
					setListing(entries);
					setPaneListings((current) => ({ ...current, [path]: entries }));
				}
			})
			.catch((error: unknown) => {
				if (live) {
					setListing([]);
					reportError(error);
				}
			});
		return () => {
			live = false;
		};
	}, [source, path, revision, reportError]);

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
					if (live) {
						setPaneListings((current) => ({ ...current, [target]: entries }));
					}
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
		let live = true;
		source
			.search(query)
			.then((entries) => {
				if (live) {
					setHits(entries);
				}
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
		const adopt = (result: VersionFamiliesResult): void => {
			if (!live) return;
			setFamilies(buildVersionFamilies(result.families));
			setVersionFamilyError(result.error);
			if (result.error !== null) {
				console.error(
					result.error.installCommand === null
						? result.error.message
						: `${result.error.message}\nInstall it with: ${result.error.installCommand}`,
				);
			}
		};
		const unsubscribe = source.onVersionFamiliesUpdated(adopt);
		source
			.versionFamilies()
			.then(adopt)
			.catch((error: unknown) => {
				console.error("version families request failed", error);
				if (!live) return;
				setFamilies(EMPTY_VERSION_FAMILIES);
				setVersionFamilyError({
					code: "scan-failed",
					message: error instanceof Error ? error.message : String(error),
					installCommand: null,
				});
			});
		return () => {
			live = false;
			unsubscribe();
		};
	}, [source]);

	useEffect(() => {
		if (flashPath === null) {
			return;
		}
		const timer = setTimeout(() => setFlashPath(null), FLASH_MS);
		return () => clearTimeout(timer);
	}, [flashPath]);

	const stackRows = useMemo(
		() =>
			applyVersionStacks(sortEntries(visibleEntries(searching ? hits : listing, showHiddenFiles), sort), {
				families,
				manualOpen: stackPinned,
				selectedKeys: selection.keys,
			}),
		[searching, hits, listing, sort, showHiddenFiles, families, stackPinned, selection.keys],
	);
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
	const rows = useMemo(() => stackRows.map((row) => row.entry), [stackRows]);
	/** Every entry on screen: all panes in the column view, the listing otherwise. */
	const viewEntries = useMemo(() => (layout === "columns" ? paneEntries.flat() : rows), [layout, paneEntries, rows]);
	const orderedKeys = useMemo(() => viewEntries.map((entry) => entry.path), [viewEntries]);

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
		scrollTarget.current = null;
		const index = orderedKeys.indexOf(target);
		if (index >= 0 && listRef.current !== null) {
			listRef.current.scrollTop = scrollTopForIndex(index);
		}
	}, [orderedKeys, layout, selection]);

	const patchSelection = useCallback((next: SelectionState) => {
		setTabsState((state) => patchActiveTab(state, (current) => ({ ...current, selection: next })));
	}, []);

	const selectedEntries = useMemo(
		() => viewEntries.filter((entry) => selection.keys.includes(entry.path)),
		[viewEntries, selection.keys],
	);
	const focusedEntry = useMemo(
		() => viewEntries.find((entry) => entry.path === selection.focus) ?? null,
		[viewEntries, selection.focus],
	);
	/** The status bar counts the pane that holds the focus in the column view. */
	const statusCount = useMemo(() => {
		if (layout !== "columns") {
			return rows.length;
		}
		const focused = paneEntries.find((entries) => entries.some((entry) => entry.path === selection.focus));
		return (focused ?? paneEntries[0] ?? []).length;
	}, [layout, rows, paneEntries, selection.focus]);

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
			const shown = entry.location === path || (layout === "columns" && panePaths.includes(entry.location));
			if (searching || (!shown && path !== RECENTS_PATH)) {
				revealEntry(entry);
				return;
			}
			// Double-click / Enter on a file: the OS default application opens it.
			source.open(entry.path).catch(reportError);
		},
		[navigate, path, layout, panePaths, revealEntry, searching, source, reportError],
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

	const toggleIndex = useCallback(
		(entry: FinderEntry) => {
			const included = indexOverrides[entry.path] ?? defaultIndexIncluded(entry.path, families);
			setIndexOverrides((current) => ({ ...current, [entry.path]: !included }));
			showToast(indexToast(entry.name, !included));
		},
		[indexOverrides, families, showToast],
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

	const retryVersionFamilies = useCallback(() => {
		source
			.refreshVersionFamilies()
			.then((result) => {
				setFamilies(buildVersionFamilies(result.families));
				setVersionFamilyError(result.error);
			})
			.catch((error: unknown) => {
				console.error("version family refresh failed", error);
				setVersionFamilyError({
					code: "scan-failed",
					message: error instanceof Error ? error.message : String(error),
					installCommand: null,
				});
			});
	}, [source]);

	/** Stack members default to index-excluded; explicit toggles win. */
	const effectiveIndexOverrides = useMemo(() => {
		const defaults: Record<string, boolean> = {};
		for (const path of families.memberOf.keys()) {
			defaults[path] = false;
		}
		return { ...defaults, ...indexOverrides };
	}, [families, indexOverrides]);

	const quickLookSelection = useCallback(() => {
		const entry = focusedEntry;
		if (entry === null || entry.kind === "folder") {
			return;
		}
		source.quickLook(entry.path).catch(reportError);
	}, [focusedEntry, source, reportError]);

	const quickLookPath = useCallback(
		(target: string) => {
			source.quickLook(target).catch(reportError);
		},
		[source, reportError],
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
					source.quickLook(entry.path).catch(reportError);
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
		[contextMenu, menuTargets, navigate, path, layout, panePaths, pruneColumns, refresh, reportError, source, toggleIndex, trashPaths],
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
		selection,
		patchSelection,
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
			indexIncluded: effectiveIndexOverrides[entry.path] ?? true,
			clipboardCount,
			inRecents: path === RECENTS_PATH,
		});
	}, [contextMenu, menuTargets, effectiveIndexOverrides, clipboardCount, path]);

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
		searchPlaceholder: path === CONTACTS_PATH ? "Search contacts" : "Instant search",
		searchFocused,
		searching,
		searchSummary: searchSummaryText(rows.length),
		emptyText: emptyStateText(query, path),
		rows,
		stackRows,
		sort,
		zone,
		selection,
		statusText: statusBarText(statusCount, selectedEntries.length),
		toast,
		flashPath,
		renamePath: rename?.path ?? null,
		renameDraft: rename?.draft ?? "",
		indexOverrides: effectiveIndexOverrides,
		versionFamilyError,
		activeNavLabel,
		contextMenu: contextMenu === null ? null : { cursor: contextMenu.cursor },
		contextMenuEntries,
		viewMode,
		layout,
		columnPanes: paneViews,
		listRef,
		searchRef,
		navigate,
		navigateNav,
		selectTabId: (id) => setTabsState((state) => selectTab(state, id)),
		closeTabId: (id) => setTabsState((state) => closeTab(state, id)),
		newTab: () => setTabsState((state) => openTab(state)),
		back: () => setTabsState((state) => goBack(state)),
		forward: () => setTabsState((state) => goForward(state)),
		setQuery: setQueryValue,
		setSearchFocused,
		onSearchKeyDown: (event) => {
			if (event.key === "Enter") {
				const first = rows[0];
				if (first !== undefined) {
					openEntry(first);
				}
			}
			if (event.key === "Escape") {
				setQueryValue("");
				event.currentTarget.blur();
			}
		},
		sortBy: (key) => setSort((current) => cycleSort(current, key)),
		showToast,
		quickLookPath,
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
		retryVersionFamilies,
		setRenameDraft: (value) => setRename((current) => (current === null ? null : { ...current, draft: value })),
		commitRename,
		cancelRename: () => setRename(null),
	};
}
