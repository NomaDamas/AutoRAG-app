import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { RECENTS_PATH, type FsLocation } from "../../../shared/fs-contract";
import { entryFromFs, entryFromSearchHit, type FinderEntry } from "../data/entries";
import { createDirectoryStore, type DirectorySource } from "../data/directory-store";
import { createEntrySidecar } from "../data/entry-sidecar";
import { navGroups, type NavItem } from "../data/places";
import { DirectoryDataContext, useDirectoryData } from "../hooks/useDirectoryData";
import { useSidebarSettings } from "../hooks/useSidebarSettings";
import { useTagCatalog } from "../hooks/useTagCatalog";
import { cn } from "../lib/cn";
import {
	DEFAULT_LIST_COLUMNS,
	listFixedWidth,
	resetListColumns,
	setListColumnWidth,
	toggleListColumn,
	type ListColumnKey,
	type ListColumnsState,
} from "../state/list-columns";
import { basename, breadcrumbTrail, dirname } from "../state/paths";
import { cycleSort, sortEntries, type SortKey, type SortState } from "../state/sort";
import type { TreeRow } from "../state/folder-tree";
import type { ViewMode } from "../state/view-mode";
import { ColumnBrowser, type ColumnPaneView } from "./ColumnBrowser";
import { ColumnHeader } from "./ColumnHeader";
import { FileList } from "./FileList";
import type { BackgroundDropHandlers, RowCallbacks } from "./FileRow";
import { IconGrid } from "./IconGrid";
import { HEADER_VIEWPORT_CLASS, LIST_COLUMN_CLASS, followScrollLeft } from "./list-scroll";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { PathBar } from "./PathBar";
import { placeGroupLabel, placeItemLabel } from "./Sidebar";
import { SidebarSearch } from "./SidebarSearch";
import { TagDotMark } from "./primitives/TagDot";
import { ViewModeToggle } from "./ViewModeToggle";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic", "heif", "tiff", "tif"]);

function isSelectableForMode(entry: FinderEntry, mode: "image" | "pdf", excludePath?: string): boolean {
	if (entry.kind !== "file") return false;
	if (excludePath !== undefined && entry.path === excludePath) return false;
	const ext = entry.ext.toLowerCase();
	return mode === "image" ? IMAGE_EXTENSIONS.has(ext) : ext === "pdf";
}

/**
 * Loads a local image path through Dazzi's `autorag-preview://` stream protocol
 * and converts it into a bounded crisp PNG data URL for `pdf-lib` embedding.
 * Never opens a native OS Finder file picker.
 */
export async function loadLocalImageAsPngDataUrl(
	filePath: string,
	maxDim = 1600,
): Promise<{ readonly dataUrl: string; readonly aspect: number }> {
	const response = await fetch(previewStreamUrl(filePath));
	if (!response.ok) throw new Error(`Could not read image (${response.status}).`);
	const blob = await response.blob();
	const objectUrl = URL.createObjectURL(blob);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("Could not decode image."));
			el.src = objectUrl;
		});
		const natW = Math.max(1, img.naturalWidth);
		const natH = Math.max(1, img.naturalHeight);
		const scale = Math.min(1, maxDim / Math.max(natW, natH));
		const w = Math.max(1, Math.round(natW * scale));
		const h = Math.max(1, Math.round(natH * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
		return { dataUrl: canvas.toDataURL("image/png"), aspect: w / Math.max(1, h) };
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

/** Fallback DirectoryData when the modal renders outside a FinderPane (e.g. unit tests). */
function useFallbackDirectoryData(): ReturnType<typeof useDirectoryData> {
	return useMemo(() => {
		const sidecar = createEntrySidecar();
		const noopSource: DirectorySource = {
			list: async () => [],
			readEntries: async () => ({ entries: [], removed: [] }),
			enrich: async () => [],
			finderMetadata: async () => [],
			onLive: () => () => undefined,
			onReconnect: () => () => undefined,
		};
		return { store: createDirectoryStore({ source: noopSource, sidecar }), sidecar };
	}, []);
}

const NOOP_BG: BackgroundDropHandlers = {
	onDragOver: () => undefined,
	onDrop: () => undefined,
	onDragLeave: () => undefined,
	onContextMenu: () => undefined,
};

const PICKER_LIST_COLUMNS: ListColumnsState = {
	...DEFAULT_LIST_COLUMNS,
	visible: {
		...DEFAULT_LIST_COLUMNS.visible,
		index: false,
	},
};

export interface DazziFilePickerModalProps {
	readonly mode: "image" | "pdf";
	readonly initialDir: string;
	/** Optional path to exclude from selectable results (e.g. the currently open PDF). */
	readonly excludePath?: string;
	readonly multiple?: boolean;
	readonly onPick: (paths: readonly string[]) => void;
	readonly onClose: () => void;
}

/**
 * Real Dazzi Finder modal for choosing local images or PDFs without opening the OS Finder.
 * Reuses Dazzi's actual Finder components directly:
 * - Left sidebar with `SidebarSearch` (real live `fs.search` across the machine!) + live Places (`navGroups`)
 * - Main Finder list view (2nd view mode `"list"` by default, with `ColumnHeader` + `FileList` + `FileRow`,
 *   plus switchable `"icons"` `IconGrid` via `ViewModeToggle`)
 * - Real `PathBar`, back/forward history, and OS thumbnails/icons via `DirectoryDataContext`
 */
function DazziFilePickerInner({
	mode,
	initialDir,
	excludePath,
	multiple = false,
	onPick,
	onClose,
}: DazziFilePickerModalProps): ReactElement {
	const { t } = useTranslation();
	const fsApi = window.autorag?.fs;
	const { sidecar } = useDirectoryData();
	const { catalog: tagCatalog } = useTagCatalog();
	const sidebarSettings = useSidebarSettings();

	// Navigation history (back/forward just like main Finder)
	const [history, setHistory] = useState<readonly string[]>(() => [initialDir]);
	const [historyIdx, setHistoryIdx] = useState(0);
	const currentDir = history[historyIdx] ?? initialDir;

	// Default to 2nd view mode: List ("list") as requested; user can also toggle Icons ("icons")
	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [sort, setSort] = useState<SortState | null>({ key: "name", dir: 1, flipped: false });
	const [listColumns, setListColumns] = useState<ListColumnsState>(PICKER_LIST_COLUMNS);

	// Sidebar places & real SidebarSearch
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchFocused, setSearchFocused] = useState(false);
	const searchInputRef = useRef<HTMLInputElement | null>(null);

	// Listing / search results
	const [entries, setEntries] = useState<readonly FinderEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<readonly string[]>([]);

	const listRef = useRef<HTMLDivElement | null>(null);
	const headerViewportRef = useRef<HTMLDivElement | null>(null);
	const requestSeqRef = useRef(0);
	const enrichedRef = useRef<Set<string>>(new Set());

	const searching = searchQuery.trim() !== "";

	// Sync horizontal scroll between ColumnHeader and FileList
	useEffect(() => {
		if (viewMode !== "list") return;
		const list = listRef.current;
		const header = headerViewportRef.current;
		if (list === null || header === null) return;
		return followScrollLeft(list, header);
	}, [viewMode, entries.length]);

	// Load real OS sidebar locations
	useEffect(() => {
		if (fsApi?.locations === undefined) return;
		let cancelled = false;
		void fsApi
			.locations()
			.then((list) => {
				if (!cancelled) setLocations(list);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [fsApi]);

	const groups = useMemo(() => {
		const raw = navGroups(locations, tagCatalog.tags, sidebarSettings);
		return raw
			.map((group) => ({
				...group,
				// Exclude virtual app views (AI Agent / Automations) that aren't file folders
				items: group.items.filter((item) => item.view === undefined),
			}))
			.filter((group) => group.items.length > 0);
	}, [locations, tagCatalog.tags, sidebarSettings]);

	const navigate = useCallback((nextPath: string) => {
		setSearchQuery("");
		setSelected([]);
		setHistory((prev) => {
			const trimmed = prev.slice(0, historyIdx + 1);
			if (trimmed.at(-1) === nextPath) return prev;
			return [...trimmed, nextPath];
		});
		setHistoryIdx((idx) => idx + 1);
	}, [historyIdx]);

	const goBack = useCallback(() => {
		setSearchQuery("");
		setSelected([]);
		setHistoryIdx((idx) => Math.max(0, idx - 1));
	}, []);

	const goForward = useCallback(() => {
		setSearchQuery("");
		setSelected([]);
		setHistoryIdx((idx) => Math.min(history.length - 1, idx + 1));
	}, [history.length]);

	// Enrich visible entries with real OS icons/thumbnails through Dazzi's shared sidecar
	const enrichVisible = useCallback(
		(entry: FinderEntry) => {
			if (fsApi?.enrichEntries === undefined) return;
			const key = `${entry.path}\0${entry.mtimeMs}`;
			if (enrichedRef.current.has(key)) return;
			enrichedRef.current.add(key);
			void fsApi
				.enrichEntries([{ path: entry.path, kind: entry.kind, mtimeMs: entry.mtimeMs, ext: entry.ext }], true)
				.then((result) => {
					if (result.length > 0) sidecar.applyEnrichment(result);
				})
				.catch(() => undefined);
		},
		[fsApi, sidecar],
	);

	// Load folder listing OR execute real Dazzi `fs.search` when searchQuery is committed
	useEffect(() => {
		const seq = ++requestSeqRef.current;
		let cancelled = false;
		setLoading(true);
		setError(null);

		const run = async (): Promise<void> => {
			try {
				if (searching) {
					const trimmed = searchQuery.trim();
					const lower = trimmed.toLowerCase();
					const seen = new Set<string>();
					const combined: FinderEntry[] = [];
					const add = (entry: FinderEntry): void => {
						if (seen.has(entry.path)) return;
						if (!isSelectableForMode(entry, mode, excludePath)) return;
						seen.add(entry.path);
						combined.push(entry);
					};
					// Real whole-machine Finder search (omitting `scope` searches the entire index)
					const [globalHits, localListing] = await Promise.all([
						typeof fsApi?.search === "function" ? fsApi.search(trimmed).catch(() => []) : Promise.resolve([]),
						typeof fsApi?.listDir === "function" ? fsApi.listDir(currentDir).catch(() => null) : Promise.resolve(null),
					]);
					if (cancelled || seq !== requestSeqRef.current) return;
					for (const hit of globalHits) add(entryFromSearchHit(hit));
					if (localListing !== null) {
						for (const raw of localListing.entries) {
							if (raw.name.toLowerCase().includes(lower)) add(entryFromFs(raw));
						}
					}
					setEntries(combined);
					return;
				}
				if (typeof fsApi?.listDir !== "function") {
					setEntries([]);
					return;
				}
				const listing = await fsApi.listDir(currentDir);
				if (cancelled || seq !== requestSeqRef.current) return;
				const filtered = listing.entries
					.map(entryFromFs)
					.filter((entry) => !entry.name.startsWith(".") && (entry.kind === "folder" || isSelectableForMode(entry, mode, excludePath)));
				setEntries(filtered);
			} catch (err: unknown) {
				if (cancelled || seq !== requestSeqRef.current) return;
				setError(err instanceof Error ? err.message : String(err));
				setEntries([]);
			} finally {
				if (!cancelled && seq === requestSeqRef.current) setLoading(false);
			}
		};

		void run();
		return () => {
			cancelled = true;
		};
	}, [currentDir, excludePath, fsApi, mode, searchQuery, searching]);

	// Escape closes modal, Cmd/Ctrl+F focuses modal sidebar search (capture phase so PDF editor behind doesn't steal it)
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				if (document.activeElement === searchInputRef.current && searchQuery !== "") return;
				event.preventDefault();
				event.stopPropagation();
				onClose();
			} else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
				event.preventDefault();
				event.stopPropagation();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onClose, searchQuery]);

	const sortedEntries = useMemo(() => {
		if (sort === null) return entries;
		const folders = entries.filter((e) => e.kind === "folder");
		const files = entries.filter((e) => e.kind !== "folder");
		return [...sortEntries(folders, sort), ...sortEntries(files, sort)];
	}, [entries, sort]);

	const treeSections = useMemo(
		() => [
			{
				label: "",
				rows: sortedEntries.map<TreeRow>((entry) => ({
					entry,
					stackCount: 0,
					stackOpen: false,
					child: false,
					relation: null,
					depth: 0,
					parent: null,
					disclosure: "none",
				})),
			},
		],
		[sortedEntries],
	);

	const selectableSelected = useMemo(
		() => selected.filter((p) => sortedEntries.some((e) => e.path === p && isSelectableForMode(e, mode, excludePath))),
		[excludePath, mode, selected, sortedEntries],
	);

	const handleRowClick = useCallback(
		(entry: FinderEntry, event: React.MouseEvent<HTMLDivElement>) => {
			if (entry.kind === "folder") {
				setSelected([entry.path]);
				return;
			}
			if (!isSelectableForMode(entry, mode, excludePath)) return;
			if (multiple && (event.metaKey || event.ctrlKey)) {
				setSelected((curr) => (curr.includes(entry.path) ? curr.filter((p) => p !== entry.path) : [...curr, entry.path]));
			} else {
				setSelected([entry.path]);
			}
		},
		[excludePath, mode, multiple],
	);

	const handleRowOpen = useCallback(
		(entry: FinderEntry) => {
			if (entry.kind === "folder") {
				navigate(entry.path);
				return;
			}
			if (isSelectableForMode(entry, mode, excludePath)) {
				onPick([entry.path]);
			}
		},
		[excludePath, mode, navigate, onPick],
	);

	const rowCallbacks = useMemo<RowCallbacks>(
		() => ({
			onClick: handleRowClick,
			onOpen: handleRowOpen,
			onContextMenu: (entry, event) => {
				event.preventDefault();
				handleRowClick(entry, event);
			},
			onToggleIndex: () => undefined,
			onPointerDown: () => undefined,
			onDragOver: () => undefined,
			onDrop: () => undefined,
			dropTargetPath: null,
			onToggleStack: () => undefined,
			onToggleFolder: (entry) => {
				if (entry.kind === "folder") navigate(entry.path);
			},
			onRenameChange: () => undefined,
			onRenameCommit: () => undefined,
			onRenameCancel: () => undefined,
			onVisible: enrichVisible,
		}),
		[enrichVisible, handleRowClick, handleRowOpen, navigate],
	);

	const title = mode === "image" ? t("documentEditor.pdf.pickerImageTitle") : t("documentEditor.pdf.pickerPdfTitle");
	const confirmLabel =
		mode === "image"
			? t("documentEditor.pdf.pickerInsert")
			: t("documentEditor.pdf.pickerMergeCount", { count: Math.max(1, selectableSelected.length) });
	const emptyText =
		error !== null
			? error
			: searching
				? t("quickSearch.noResults")
				: mode === "image"
					? t("documentEditor.pdf.pickerEmptyImages")
					: t("documentEditor.pdf.pickerEmptyPdfs");

	const focusedEntry = useMemo(
		() => (selected.length === 1 ? (sortedEntries.find((e) => e.path === selected[0]) ?? null) : null),
		[selected, sortedEntries],
	);

	const onSidebarNavigate = (item: NavItem): void => {
		if (!item.available) return;
		navigate(item.path);
	};

	const columnPanes = useMemo<readonly ColumnPaneView[]>(
		() => [
			{
				path: currentDir,
				loaded: !loading,
				rows: treeSections[0]?.rows ?? [],
				sections: treeSections,
			},
		],
		[currentDir, loading, treeSections],
	);

	const currentTitle = searching ? t("finderComponents.searchTitle", { query: searchQuery }) : basename(currentDir) || currentDir;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			data-dazzi-file-picker={mode}
			data-picker-view-mode={viewMode}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="flex h-[620px] max-h-[86vh] w-[920px] max-w-[92vw] overflow-hidden rounded-12 border border-border bg-window shadow-2xl">
				{/* Left Dazzi Finder Sidebar with live SidebarSearch + Places */}
				<aside
					className="sidebar flex w-[204px] flex-none flex-col min-h-0 border-r border-border bg-sidebar backdrop-blur-[18px]"
					aria-label={t("finderComponents.sidebar")}
				>
					<div className="flex h-40 flex-none items-center px-12 text-body font-semibold text-ink">
						<span className="truncate">{title}</span>
					</div>
					<SidebarSearch
						query={searchQuery}
						inputRef={searchInputRef}
						focused={searchFocused}
						showHotkeys={false}
						onFocus={() => setSearchFocused(true)}
						onBlur={() => setSearchFocused(false)}
						onSubmit={(text) => {
							setSearchQuery(text.trim());
							setSelected([]);
						}}
					/>
					<div className="side-scroll flex min-h-0 flex-1 flex-col gap-10 overflow-auto px-10 pt-4 pb-12">
						{groups.map((group) => (
							<div key={group.label} className="side-group flex flex-col gap-1">
								<div className="side-label px-8 pt-4 pb-4 text-badge font-semibold tracking-label text-ink-muted">
									{placeGroupLabel(t, group.label)}
								</div>
								{group.items.map((item) => {
									const active = !searching && item.path === currentDir;
									const Icon = item.icon;
									return (
										<button
											key={item.path}
											type="button"
											className={cn(
												"sidebar__item flex h-icon-sm w-full items-center gap-8 rounded-6 border-0 bg-transparent px-8 text-left text-meta text-ink-body transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover",
												!item.available && "text-ink-faint",
												active && "sidebar__item--active bg-selected-nav text-ink",
											)}
											title={item.path}
											aria-current={active ? "true" : undefined}
											onClick={() => onSidebarNavigate(item)}
										>
											{item.tag === undefined ? (
												<Icon
													className={cn("sidebar__item-icon flex-none", active ? "text-ink" : "text-ink-muted")}
													size={14}
													strokeWidth={1.8}
												/>
											) : (
												<span className="sidebar__item-icon flex size-14 flex-none items-center justify-center">
													<TagDotMark color={item.tag.color} size={10} />
												</span>
											)}
											<span className="sidebar__item-label min-w-0 flex-1 truncate">{placeItemLabel(t, item)}</span>
										</button>
									);
								})}
							</div>
						))}
					</div>
				</aside>

				{/* Right Main Finder Column (Toolbar + List/Icon view + PathBar + Action Footer) */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-window">
					{/* Finder Toolbar: Back/Forward + Folder Title + ViewModeToggle (Icons / List) + Close */}
					<header className="flex h-44 flex-none items-center gap-8 border-b border-divider bg-chrome px-12">
						<div className="flex flex-none items-center gap-2">
							<button
								type="button"
								disabled={historyIdx <= 0}
								aria-label={t("toolbar.back")}
								className="flex size-28 items-center justify-center rounded-6 border-0 bg-transparent text-ink-body enabled:hover:bg-hover-icon disabled:text-ink-faint"
								onClick={goBack}
							>
								<ChevronLeftIcon />
							</button>
							<button
								type="button"
								disabled={historyIdx >= history.length - 1}
								aria-label={t("toolbar.forward")}
								className="flex size-28 items-center justify-center rounded-6 border-0 bg-transparent text-ink-body enabled:hover:bg-hover-icon disabled:text-ink-faint"
								onClick={goForward}
							>
								<ChevronRightIcon />
							</button>
						</div>
						<div className="min-w-0 flex-1 truncate text-body font-semibold text-ink" title={currentDir}>
							{currentTitle}
						</div>
						<ViewModeToggle mode={viewMode} onChange={setViewMode} />
						<button
							type="button"
							aria-label={t("common.close")}
							className="flex size-28 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink"
							onClick={onClose}
						>
							<X size={15} />
						</button>
					</header>

					{/* Main Finder View: 2nd view mode (List: ColumnHeader + FileList) by default, plus Icons & Columns */}
					<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-window">
						{loading ? (
							<div className="flex flex-1 items-center justify-center gap-8 text-meta text-ink-muted">
								<Loader2 size={15} className="animate-spin" />
								<span>{t("documentEditor.loading")}</span>
							</div>
						) : viewMode === "icons" ? (
							<IconGrid
								sections={treeSections}
								listRef={listRef}
								searching={searching}
								emptyText={emptyText}
								selectedKeys={selected}
								focusedZone
								flashPath={null}
								renamePath={null}
								renameDraft=""
								versionFamilyError={null}
								onRetryVersionFamilies={() => undefined}
								background={NOOP_BG}
								dropBackground={false}
								callbacks={rowCallbacks}
								onMarqueeSelect={(keys) => {
									const valid = keys.filter((k) => sortedEntries.some((e) => e.path === k && isSelectableForMode(e, mode, excludePath)));
									setSelected(multiple ? valid : valid.slice(0, 1));
								}}
							/>
						) : viewMode === "columns" ? (
							<ColumnBrowser
								panes={columnPanes}
								listRef={listRef}
								emptyText={emptyText}
								selectedKeys={selected}
								focusedZone
								flashPath={null}
								renamePath={null}
								renameDraft=""
								versionFamilyError={null}
								onRetryVersionFamilies={() => undefined}
								variantColumn={null}
								onSelectVariant={() => undefined}
								columnCallbacks={{
									onClick: (_pane, entry, event) => {
										if (entry.kind === "folder") navigate(entry.path);
										else handleRowClick(entry, event);
									},
								}}
								paneBackground={() => NOOP_BG}
								dropBackgroundDir={null}
								callbacks={rowCallbacks}
							/>
						) : (
							<div className={LIST_COLUMN_CLASS}>
								<div ref={headerViewportRef} className={HEADER_VIEWPORT_CLASS}>
									<ColumnHeader
										sort={sort}
										searching={searching}
										onSort={(key: SortKey) => setSort((curr) => cycleSort(curr, key))}
										columns={listColumns}
										minWidth={listFixedWidth(listColumns)}
										onToggleColumn={(key: ListColumnKey) => setListColumns((curr) => toggleListColumn(curr, key))}
										onResetColumns={() => setListColumns(() => ({ ...resetListColumns(), visible: { ...PICKER_LIST_COLUMNS.visible } }))}
										onResizeColumn={(key: string, px: number) => setListColumns((curr) => setListColumnWidth(curr, key, px))}
									/>
								</div>
								<FileList
									sections={treeSections}
									listPath={currentDir}
									columns={listColumns}
									minWidth={listFixedWidth(listColumns)}
									versionFamilyError={null}
									onRetryVersionFamilies={() => undefined}
									listRef={listRef}
									searching={searching}
									{...(searching ? { highlight: searchQuery } : {})}
									emptyText={emptyText}
									selectedKeys={selected}
									focusedZone
									flashPath={null}
									renamePath={null}
									renameDraft=""
									background={NOOP_BG}
									dropBackground={false}
									callbacks={rowCallbacks}
								/>
							</div>
						)}
					</div>

					{/* Real Finder PathBar */}
					<PathBar
						path={currentDir}
						crumbs={currentDir === RECENTS_PATH ? [{ label: t("places.recents"), path: currentDir, separator: false, isLast: true }] : breadcrumbTrail(currentDir, Number.MAX_SAFE_INTEGER)}
						selectedName={focusedEntry !== null && focusedEntry.kind === "file" ? focusedEntry.name : null}
						selectedPath={focusedEntry !== null && focusedEntry.kind === "file" ? focusedEntry.path : null}
						onNavigate={navigate}
						onCopyPath={() => undefined}
						onGoToPath={async (target) => {
							navigate(target);
							return true;
						}}
						completePath={async () => []}
						openEditor={0}
						onEditorClosed={() => undefined}
					/>

					{/* Modal Action Footer */}
					<footer className="flex h-48 flex-none items-center justify-between gap-10 border-t border-divider bg-chrome px-16">
						<span className="min-w-0 flex-1 truncate text-meta tabular-nums text-ink-muted">
							{selectableSelected.length > 0
								? basename(selectableSelected[0]!) + (selectableSelected.length > 1 ? ` (+${selectableSelected.length - 1})` : "")
								: ""}
						</span>
						<div className="flex flex-none items-center gap-8">
							<button
								type="button"
								className="h-28 rounded-6 border border-border bg-window px-12 text-meta font-medium text-ink hover:bg-hover-row"
								onClick={onClose}
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								disabled={selectableSelected.length === 0}
								data-dazzi-picker-confirm="true"
								className="inline-flex h-28 items-center gap-4 rounded-6 border-0 bg-accent px-14 text-meta font-medium text-on-accent hover:opacity-90 disabled:opacity-35"
								onClick={() => {
									if (selectableSelected.length > 0) onPick(selectableSelected);
								}}
							>
								<Check size={13} />
								{confirmLabel}
							</button>
						</div>
					</footer>
				</div>
			</div>
		</div>
	);
}

export function DazziFilePickerModal(props: DazziFilePickerModalProps): ReactElement {
	const existing = useContextOrNull();
	const fallback = useFallbackDirectoryData();
	if (existing !== null) {
		return <DazziFilePickerInner {...props} />;
	}
	return (
		<DirectoryDataContext value={fallback}>
			<DazziFilePickerInner {...props} />
		</DirectoryDataContext>
	);
}

function useContextOrNull(): ReturnType<typeof useDirectoryData> | null {
	try {
		return useDirectoryData();
	} catch {
		return null;
	}
}
