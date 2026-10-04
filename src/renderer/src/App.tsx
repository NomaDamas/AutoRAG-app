import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { PreviewBridge, QuickLookTarget } from "../../preview/shared/contract";
import type { Bounds } from "../../preview/shared/fit";
import type { ActionAnchor } from "../../shared/actions-contract";
import type { DataSourcesSnapshot, SettingsBridge } from "../../shared/settings-contract";
import type { CitationEvidence } from "../../shared/search-contract";

const autorag = (window as unknown as { readonly autorag: { readonly settings: SettingsBridge; readonly preview: PreviewBridge } }).autorag;
import { AiSearchPanel, type AiDockHandle } from "./components/AiSearchPanel";
import type { SearchMode } from "./components/SidebarSearch";
import { ColumnBrowser } from "./components/ColumnBrowser";
import { ColumnHeader } from "./components/ColumnHeader";
import { FileList } from "./components/FileList";
import type { BackgroundDropHandlers, RowCallbacks } from "./components/FileRow";
import { IconGrid } from "./components/IconGrid";
import { Inspector, type InspectorFamily } from "./components/Inspector";
import { PathBar } from "./components/PathBar";
import { ScopeBar } from "./components/ScopeBar";
import { ContextMenu } from "./components/primitives/ContextMenu";
import { Toast } from "./components/primitives/Toast";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import { RECENTS_PATH, type FsLocationIcon } from "../../shared/fs-contract";
import { SETTINGS_PATH } from "./state/tabs";
import { isFinderDrag, readFinderDragPaths, writeFinderDrag } from "./state/attachments";
import { backgroundDropDir } from "./state/file-transfer";
import type { FileActionTarget } from "./state/file-actions";
import { basename, breadcrumbTrail, dirname } from "./state/paths";
import {
	loadListColumns,
	listFixedWidth,
	resetListColumns,
	saveListColumns,
	setListColumnWidth,
	toggleListColumn,
	type ListColumnKey,
	type ListColumnsState,
} from "./state/list-columns";
import { TabStrip } from "./components/TabStrip";
import { Toolbar } from "./components/Toolbar";
import { useFinderController } from "./hooks/useFinderController";
import { useFinderSource } from "./hooks/useFinderSource";

/** The reference's `showHotkeys` prop (default true): keycaps on or off. */
const SHOW_HOTKEYS = true;

const SIDEBAR_KEY = "autorag.shell.sidebar";
const INSPECTOR_KEY = "autorag.shell.inspector";
const AI_OPEN_KEY = "autorag.shell.aiOpen";
const AI_HEIGHT_KEY = "autorag.shell.aiHeight";
const SIDEBAR_WIDTH_KEY = "autorag.shell.sidebarWidth";
const INSPECTOR_WIDTH_KEY = "autorag.shell.inspectorWidth";

/** Pane resize limits (px): the sidebar and inspector stay usable at both ends. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 320;
const INSPECTOR_MIN = 300;
const INSPECTOR_MAX = 560;

/**
 * How long an in-app drag must dwell on a tab before the tab adopts itself
 * (Finder's spring-loaded folders, applied to the tab strip).
 */
const TAB_SPRING_LOAD_MS = 1500;

function clampWidth(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

function loadFlag(key: string, fallback: boolean): boolean {
	try {
		const value = window.localStorage.getItem(key);
		return value === null ? fallback : value === "1";
	} catch {
		return fallback;
	}
}

function saveFlag(key: string, value: boolean): void {
	try {
		window.localStorage.setItem(key, value ? "1" : "0");
	} catch {
		/* private mode: session-only */
	}
}

function loadNumber(key: string, fallback: number): number {
	try {
		const value = Number(window.localStorage.getItem(key));
		return Number.isFinite(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

function saveNumber(key: string, value: number): void {
	try {
		window.localStorage.setItem(key, String(value));
	} catch {
		/* private mode: session-only */
	}
}

/** Sidebar cloud glyphs → live datasource rows (status dots on every account of that provider). */
const SOURCE_ICON_MATCH: readonly (readonly [FsLocationIcon, RegExp])[] = [
	["google-drive", /gdrive|google[- ]?drive/i],
	["dropbox", /dropbox/i],
	["icloud", /icloud/i],
	["onedrive", /onedrive/i],
];

function mapSourceStatus(snapshot: DataSourcesSnapshot): Partial<Record<FsLocationIcon, "syncing" | "error">> {
	const out: Partial<Record<FsLocationIcon, "syncing" | "error">> = {};
	for (const [icon, needle] of SOURCE_ICON_MATCH) {
		const row = snapshot.sources.find((source) => needle.test(source.id) || needle.test(source.type));
		if (row === undefined) continue;
		if (row.status === "syncing") out[icon] = "syncing";
		else if (row.status === "attention") out[icon] = "error";
	}
	return out;
}

/**
 * The visible Finder icon for `path`, in viewport CSS pixels: Quick Look zooms
 * out of it and back into it. Null when the row is scrolled away or absent.
 */
function iconRect(path: string): Bounds | null {
	const row = Array.from(document.querySelectorAll<HTMLElement>("[data-path]")).find((node) => node.dataset.path === path);
	const icon = row?.querySelector(".tile, .row__name svg") ?? row?.querySelector(".row__name");
	if (icon === null || icon === undefined) return null;
	const box = icon.getBoundingClientRect();
	const list = row?.closest(".list")?.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0) return null;
	if (list !== undefined && (box.bottom <= list.top || box.top >= list.bottom)) return null;
	return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Vertical pane resize grip: an invisible 6px hit strip with a hover wash. */
function PaneGrip({
	position,
	label,
	onDelta,
}: {
	readonly position: { readonly left: number } | { readonly right: number };
	readonly label: string;
	/** Incremental horizontal delta (px) since the last move event. */
	readonly onDelta: (dx: number) => void;
}): ReactElement {
	const drag = useRef<number | null>(null);
	return (
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			className="absolute top-0 bottom-0 z-20 w-6 cursor-col-resize [-webkit-app-region:no-drag] hover:bg-accent-soft"
			style={position}
			onPointerDown={(event) => {
				event.preventDefault();
				drag.current = event.clientX;
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (drag.current === null) return;
				onDelta(event.clientX - drag.current);
				drag.current = event.clientX;
			}}
			onPointerUp={(event) => {
				drag.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => {
				drag.current = null;
			}}
		/>
	);
}

export function App(): ReactElement {
	const source = useFinderSource();
	const [showHiddenFiles, setShowHiddenFiles] = useState(false);
	const [preview, setPreview] = useState<QuickLookTarget | null>(null);
	const previewRef = useRef<QuickLookTarget | null>(null);
	previewRef.current = preview;
	/** Icon of the file the preview closes on: captured before React drops `preview`. */
	const closingRef = useRef<Bounds | null>(null);
	const openQuickLook = useCallback((target: QuickLookTarget) => {
		const open = previewRef.current;
		if (open?.path === target.path) closingRef.current = iconRect(open.path);
		setPreview((current) => (current?.path === target.path ? null : { path: target.path, name: target.name }));
	}, []);
	const closeQuickLook = useCallback(() => {
		const open = previewRef.current;
		if (open !== null) closingRef.current = iconRect(open.path);
		setPreview(null);
	}, []);
	const isQuickLookOpen = useCallback(() => previewRef.current !== null, []);

	/* ------------------------------------------------ v7 shell chrome state */
	const [sidebarVisible, setSidebarVisible] = useState(() => loadFlag(SIDEBAR_KEY, true));
	const [inspectorVisible, setInspectorVisible] = useState(() => loadFlag(INSPECTOR_KEY, true));
	const [aiOpen, setAiOpen] = useState(() => loadFlag(AI_OPEN_KEY, true));
	const [aiHeight, setAiHeight] = useState(() => loadNumber(AI_HEIGHT_KEY, 280));
	const [sidebarWidth, setSidebarWidth] = useState(() => loadNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN));
	const [inspectorWidth, setInspectorWidth] = useState(() => loadNumber(INSPECTOR_WIDTH_KEY, INSPECTOR_MIN));
	const [listColumns, setListColumns] = useState<ListColumnsState>(loadListColumns);
	const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
	const [dropTabId, setDropTabId] = useState<number | null>(null);
	const [dropBackgroundDir, setDropBackgroundDir] = useState<string | null>(null);
	const [sourceStatus, setSourceStatus] = useState<Readonly<Partial<Record<FsLocationIcon, "syncing" | "error">>>>({});
	const aiDockRef = useRef<AiDockHandle | null>(null);

	useEffect(() => saveFlag(SIDEBAR_KEY, sidebarVisible), [sidebarVisible]);
	useEffect(() => saveFlag(INSPECTOR_KEY, inspectorVisible), [inspectorVisible]);
	useEffect(() => saveFlag(AI_OPEN_KEY, aiOpen), [aiOpen]);
	useEffect(() => saveNumber(AI_HEIGHT_KEY, aiHeight), [aiHeight]);
	useEffect(() => saveNumber(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth]);
	useEffect(() => saveNumber(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth]);
	useEffect(() => saveListColumns(listColumns), [listColumns]);

	useEffect(() => {
		let live = true;
		autorag.settings
			.sourcesList()
			.then((snapshot) => {
				if (live) setSourceStatus(mapSourceStatus(snapshot));
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);

	/* --------------------------------------------------------- evidence state */
	const [evidence, setEvidence] = useState<readonly CitationEvidence[]>([]);
	const [evidenceSession, setEvidenceSession] = useState<string | null>(null);
	const [selectedEvidence, setSelectedEvidence] = useState<number | null>(null);
	const [evidenceOpen, setEvidenceOpen] = useState(false);
	const evidenceSessionRef = useRef<string | null>(null);

	const publishEvidence = useCallback((items: readonly CitationEvidence[], sessionId: string | null) => {
		const sessionChanged = evidenceSessionRef.current !== sessionId;
		evidenceSessionRef.current = sessionId;
		setEvidence(items);
		setEvidenceSession(sessionId);
		if (items.length === 0 || sessionChanged) setEvidenceOpen(false);
		setSelectedEvidence((current) => (current !== null && items.some((item) => item.number === current) ? current : null));
	}, []);

	const dismissEvidence = useCallback((): boolean => {
		if (evidence.length > 0 && evidenceOpen) {
			setEvidenceOpen(false);
			return true;
		}
		return false;
	}, [evidence.length, evidenceOpen]);

	const finder = useFinderController(source, {
		showHiddenFiles,
		quickLook: { onQuickLook: openQuickLook, closeQuickLook, isQuickLookOpen },
		onFocusSearch: () => setSidebarVisible(true),
		onFocusComposer: () => {
			if (aiOpen) {
				setAiOpen(false);
				return;
			}
			setAiOpen(true);
			aiDockRef.current?.focusComposer();
		},
		onDismissEvidence: dismissEvidence,
	});

	/** ⌥Enter "content search": hand the query to the AI dock (real librarian search). */
	const contentSearch = useCallback((text: string) => {
		if (text.trim() === "") return;
		setAiOpen(true);
		aiDockRef.current?.sendQuery(text);
	}, []);

	/**
	 * Sidebar search commit. Enter runs a filename search in the chip's scope
	 * (전체 = This Mac, 파일 이름 = current folder); the 내용 chip — or ⌥Enter
	 * from any chip — hands the query to the AI dock's real content search.
	 */
	const submitSidebarSearch = useCallback(
		(mode: SearchMode, text: string) => {
			const value = text.trim();
			if (value === "") {
				finder.setQuery("");
				return;
			}
			if (mode === "content") {
				contentSearch(value);
				return;
			}
			finder.setSearchScope(mode === "name" ? "current" : "all");
			finder.setQuery(value);
		},
		[contentSearch, finder],
	);

	/** Inspector "AI 요약": attach the entry to the composer and focus it. */
	const askAi = useCallback((entry: { readonly path: string; readonly name: string; readonly kind: "file" | "folder" }) => {
		setAiOpen(true);
		aiDockRef.current?.attachFile({ kind: entry.kind, id: entry.path, name: entry.name });
	}, []);

	/** Inspector action bar: open, share, archive, and edits all run through the controller. */
	const runInspectorAction = useCallback(
		(target: FileActionTarget, anchor: ActionAnchor | null) => {
			const entry = finder.focusedEntry;
			if (entry !== null) finder.runEntryAction(entry, target, anchor);
		},
		[finder],
	);

	const selectEvidence = useCallback((number: number) => {
		setSelectedEvidence(number);
		setEvidenceOpen(true);
		setInspectorVisible(true);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const target = event.target;
			if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
			if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
				event.preventDefault();
				setEvidenceOpen((open) => !open);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const evidenceSelectedNumber = evidence.find((item) => item.number === selectedEvidence)?.number ?? evidence[0]?.number ?? 1;
	const focusPath = finder.selection.focus;
	useEffect(() => {
		if (focusPath === null) return;
		setPreview((current) => {
			if (current === null || current.path === focusPath) return current;
			const match = finder.stackRows.find((row) => row.entry.path === focusPath);
			if (match === undefined) return current;
			return { path: match.entry.path, name: match.entry.name };
		});
	}, [focusPath, finder.stackRows]);

	useEffect(() => {
		const request = preview === null ? autorag.preview.hide(closingRef.current) : autorag.preview.show(preview, iconRect(preview.path));
		closingRef.current = null;
		request.catch((error: unknown) => finder.showToast(error instanceof Error ? error.message : String(error)));
	}, [preview]);

	const moveSelectionBy = finder.moveSelectionBy;
	useEffect(() => {
		const offClosed = autorag.preview.onClosed(() => setPreview(null));
		const offNavigate = autorag.preview.onNavigate((delta) => moveSelectionBy(delta));
		return () => {
			offClosed();
			offNavigate();
		};
	}, [moveSelectionBy]);

	useEffect(() => {
		void autorag.settings.get().then((settings) => setShowHiddenFiles(settings.showHiddenFiles));
	}, []);

	/**
	 * Spring-loaded tabs: dwelling with an in-app drag over a tab for
	 * TAB_SPRING_LOAD_MS adopts that tab, so the rows can then be dropped into a
	 * folder inside it. Leaving the tab, dropping, or the drag ending cancels
	 * the pending switch.
	 */
	const springTabRef = useRef<{ readonly id: number; readonly timer: number } | null>(null);
	const cancelSpringTab = useCallback((): void => {
		const armed = springTabRef.current;
		if (armed === null) return;
		window.clearTimeout(armed.timer);
		springTabRef.current = null;
	}, []);
	const armSpringTab = useCallback(
		(id: number): void => {
			if (springTabRef.current?.id === id) return;
			cancelSpringTab();
			springTabRef.current = {
				id,
				timer: window.setTimeout(() => {
					springTabRef.current = null;
					setDropTabId(null);
					finder.selectTabId(id);
				}, TAB_SPRING_LOAD_MS),
			};
		},
		[cancelSpringTab, finder],
	);
	useEffect(() => cancelSpringTab, [cancelSpringTab]);

	/* A drag that leaves the app (or ends anywhere) clears the drop highlights. */
	const reset = useCallback((): void => {
		setDropTargetPath(null);
		setDropTabId(null);
		setDropBackgroundDir(null);
		cancelSpringTab();
	}, [cancelSpringTab]);
	useEffect(() => {
		window.addEventListener("dragend", reset);
		window.addEventListener("drop", reset);
		return () => {
			window.removeEventListener("dragend", reset);
			window.removeEventListener("drop", reset);
		};
	}, [reset]);

	const backgroundDrop = useCallback(
		(dir: string): BackgroundDropHandlers => ({
			onDragOver: (event) => {
				const overRow = event.target instanceof Element && event.target.closest('[role="row"], [role="option"]') !== null;
				const destination = backgroundDropDir(dir, { searching: finder.searching, overRow });
				if (destination === null || !isFinderDrag(event.dataTransfer.types)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
				setDropTargetPath(null);
				setDropTabId(null);
				setDropBackgroundDir((current) => (current === destination ? current : destination));
			},
			onDrop: (event) => {
				const overRow = event.target instanceof Element && event.target.closest('[role="row"], [role="option"]') !== null;
				const destination = backgroundDropDir(dir, { searching: finder.searching, overRow });
				setDropBackgroundDir(null);
				if (destination === null) return;
				const paths = readFinderDragPaths(event.dataTransfer);
				if (paths.length === 0) return;
				event.preventDefault();
				finder.transferDropped(paths, destination, event.altKey);
			},
			onDragLeave: (event) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setDropBackgroundDir((current) => (current === dir ? null : current));
			},
		}),
		[finder.searching, finder.transferDropped],
	);

	const rowCallbacks: RowCallbacks = {
		onClick: finder.clickRow,
		onOpen: finder.openEntry,
		onContextMenu: finder.openContextMenu,
		onDragStart: (entry, event) => writeFinderDrag(event.dataTransfer, finder.dragEntries(entry)),
		// An in-app row drag lands on folders: the rows move there (⌥ copies).
		onDragOver: (entry, event) => {
			if (isFinderDrag(event.dataTransfer.types)) setDropBackgroundDir(null);
			if (entry.kind !== "folder" || !isFinderDrag(event.dataTransfer.types)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
			setDropTargetPath((current) => (current === entry.path ? current : entry.path));
		},
		onDrop: (entry, event) => {
			setDropTargetPath(null);
			setDropBackgroundDir(null);
			if (entry.kind !== "folder") return;
			const paths = readFinderDragPaths(event.dataTransfer);
			if (paths.length === 0) return;
			// No stopPropagation: the window "drop" listener clears the AI dock's
			// drag overlay (and the highlights) once the transfer has started.
			event.preventDefault();
			finder.transferDropped(paths, entry.path, event.altKey);
		},
		dropTargetPath,
		onToggleIndex: finder.toggleIndex,
		onToggleStack: finder.toggleStack,
		onToggleFolder: finder.toggleFolder,
		onRenameChange: finder.setRenameDraft,
		onRenameCommit: finder.commitRename,
		onRenameCancel: finder.cancelRename,
		onVisible: finder.noteVisible,
	};

	const focused = finder.focusedEntry;
	const familyEntries = focused !== null ? finder.familyEntriesFor(focused.path) : null;
	const inspectorFamily: InspectorFamily | null =
		familyEntries === null
			? null
			: {
					headPath: familyEntries.head.path,
					headName: familyEntries.head.name,
					members: familyEntries.members.map((member) => ({
						path: member.entry.path,
						name: member.entry.name,
						relation: member.relation,
						where: dirname(member.entry.path),
					})),
				};
	const variantColumn =
		familyEntries !== null && finder.layout === "columns" && familyEntries.members.length > 0
			? { count: familyEntries.members.length, rows: familyEntries.members }
			: null;
	const openMemberEntry = useCallback(
		(path: string) => {
			const entry =
				familyEntries?.members.find((member) => member.entry.path === path)?.entry ??
				(familyEntries?.head.path === path ? familyEntries.head : undefined);
			if (entry !== undefined) finder.revealEntry(entry);
		},
		[familyEntries, finder],
	);

	const toolbarTitle =
		finder.path === SETTINGS_PATH
			? "Settings"
			: finder.searching
				? `Search "${finder.query}"`
				: basename(finder.path);
	/** Outer grid: sidebar + the region that holds the full-width toolbar. */
	const windowColumns = `${sidebarVisible ? `${sidebarWidth}px ` : ""}minmax(0,1fr)`;
	/** Inner grid under the toolbar: Finder + inspector. */
	const finderColumns = `minmax(0,1fr)${inspectorVisible ? ` ${inspectorWidth}px` : ""}`;

	return (
		<div className="desk flex h-full bg-window">
			<div
				className="window relative grid flex-1 min-w-0 bg-window overflow-hidden"
				style={{ gridTemplateColumns: windowColumns, gridTemplateRows: "minmax(0, 1fr)" }}
			>
				{sidebarVisible ? (
					<Sidebar
						groups={finder.navGroups}
						activePath={finder.activeNavPath}
						settingsActive={finder.path === SETTINGS_PATH}
						showHotkeys={SHOW_HOTKEYS}
						onNavigate={finder.navigateNav}
						onEject={finder.ejectNav}
						onOpenSettings={finder.openSettings}
						onHideSidebar={() => setSidebarVisible(false)}
						onNewFolder={finder.newFolder}
						sourceStatus={sourceStatus}
						searchQuery={finder.query}
						searchRef={finder.searchRef}
						searchFocused={finder.searchFocused}
						onSearchFocus={() => finder.setSearchFocused(true)}
						onSearchBlur={() => finder.setSearchFocused(false)}
						onSubmitSearch={submitSidebarSearch}
					/>
				) : null}
				<div className="flex min-w-0 min-h-0 flex-col">
					<Toolbar
						title={toolbarTitle}
						canGoBack={finder.canGoBack}
						canGoForward={finder.canGoForward}
						onBack={finder.back}
						onForward={finder.forward}
						viewMode={finder.viewMode}
						onViewModeChange={finder.setViewMode}
						sort={finder.sort}
						grouping={finder.grouping}
						onApplySort={finder.applySort}
						onSetGrouping={finder.setGrouping}
						inspectorVisible={inspectorVisible}
						onToggleInspector={() => setInspectorVisible((visible) => !visible)}
						aiOpen={aiOpen}
						onToggleAi={() => setAiOpen((open) => !open)}
						canShare={focused !== null}
						onShare={() => {
							if (focused !== null) finder.copyEntryPath(focused);
						}}
						sidebarHidden={!sidebarVisible}
						onShowSidebar={() => setSidebarVisible(true)}
						onNewFolder={finder.newFolder}
					/>
					<div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: finderColumns, gridTemplateRows: "minmax(0, 1fr)" }}>
						<section className="finder flex flex-col min-w-0 min-h-0" aria-label="Finder" onMouseDown={finder.focusFinder}>
					<TabStrip
						tabs={finder.tabs}
						canClose={finder.canCloseTabs}
						onSelect={finder.selectTabId}
						onClose={finder.closeTabId}
						onNewTab={finder.newTab}
						dropTabId={dropTabId}
						onTabDragOver={(id, event) => {
							if (!isFinderDrag(event.dataTransfer.types)) return;
							setDropBackgroundDir(null);
							event.preventDefault();
							event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
							setDropTabId((current) => (current === id ? current : id));
							if (finder.tabs.some((tab) => tab.id === id && !tab.active)) armSpringTab(id);
						}}
						onTabDragLeave={(id) => {
							cancelSpringTab();
							setDropTabId((current) => (current === id ? null : current));
						}}
						onTabDrop={(id, event) => {
							cancelSpringTab();
							setDropTabId(null);
							setDropBackgroundDir(null);
							const paths = readFinderDragPaths(event.dataTransfer);
							if (paths.length === 0) return;
							event.preventDefault();
							finder.dropOnTab(id, paths, event.altKey);
						}}
					/>
					{finder.path === SETTINGS_PATH ? (
						<SettingsView onSettingsChanged={(settings) => setShowHiddenFiles(settings.showHiddenFiles)} />
					) : (
						<>
							{finder.searching ? (
								<ScopeBar
									scope={finder.searchScope}
									folderName={basename(finder.path)}
									resultCount={finder.rows.length}
									onScopeChange={finder.setSearchScope}
								/>
							) : null}
							{finder.layout === "icons" ? (
								<IconGrid
									sections={finder.stackSections}
									listRef={finder.listRef}
									searching={finder.searching}
									emptyText={finder.emptyText}
									selectedKeys={finder.selection.keys}
									focusedZone={finder.zone === "finder"}
									flashPath={finder.flashPath}
									renamePath={finder.renamePath}
									renameDraft={finder.renameDraft}
									versionFamilyError={finder.versionFamilyError}
									onRetryVersionFamilies={finder.retryVersionFamilies}
									background={backgroundDrop(finder.path === RECENTS_PATH || finder.path === SETTINGS_PATH ? "" : finder.path)}
									dropBackground={dropBackgroundDir === finder.path}
									callbacks={rowCallbacks}
								/>
							) : finder.layout === "columns" ? (
								<ColumnBrowser
									panes={finder.columnPanes}
									listRef={finder.listRef}
									emptyText={finder.emptyText}
									selectedKeys={finder.selection.keys}
									focusedZone={finder.zone === "finder"}
									flashPath={finder.flashPath}
									renamePath={finder.renamePath}
									renameDraft={finder.renameDraft}
									versionFamilyError={finder.versionFamilyError}
									onRetryVersionFamilies={finder.retryVersionFamilies}
									variantColumn={variantColumn}
									onSelectVariant={finder.revealEntry}
									columnCallbacks={{ onClick: finder.clickColumnRow }}
									paneBackground={backgroundDrop}
									dropBackgroundDir={dropBackgroundDir}
									callbacks={rowCallbacks}
								/>
							) : (
								<div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
									<ColumnHeader
										sort={finder.sort}
										searching={finder.searching}
										onSort={finder.sortBy}
										columns={listColumns}
										minWidth={listFixedWidth(listColumns)}
										onToggleColumn={(key: ListColumnKey) => setListColumns((current) => toggleListColumn(current, key))}
										onResetColumns={() => setListColumns(resetListColumns())}
										onResizeColumn={(key: string, px: number) => setListColumns((current) => setListColumnWidth(current, key, px))}
									/>
									<FileList
										sections={finder.stackSections}
										listPath={finder.path}
										columns={listColumns}
										minWidth={listFixedWidth(listColumns)}
										versionFamilyError={finder.versionFamilyError}
										onRetryVersionFamilies={finder.retryVersionFamilies}
										listRef={finder.listRef}
										searching={finder.searching}
										emptyText={finder.emptyText}
										selectedKeys={finder.selection.keys}
										focusedZone={finder.zone === "finder"}
										flashPath={finder.flashPath}
										renamePath={finder.renamePath}
										renameDraft={finder.renameDraft}
										indexStatus={finder.indexStatus}
										background={backgroundDrop(finder.path === RECENTS_PATH || finder.path === SETTINGS_PATH ? "" : finder.path)}
										dropBackground={dropBackgroundDir === finder.path}
										callbacks={rowCallbacks}
									/>
								</div>
							)}
							<PathBar
								crumbs={breadcrumbTrail(finder.path, Number.MAX_SAFE_INTEGER)}
								selectedName={focused !== null && focused.kind === "file" ? focused.name : null}
								onNavigate={finder.navigate}
							/>
						</>
					)}
					<AiSearchPanel
						ref={aiDockRef}
						open={aiOpen}
						height={aiHeight}
						onToggleOpen={() => setAiOpen((open) => !open)}
						onHeightChange={setAiHeight}
						selectedEvidence={evidence.length === 0 ? null : evidenceSelectedNumber}
						onSelectEvidence={selectEvidence}
						onPublish={publishEvidence}
					/>
				</section>
				{inspectorVisible ? (
					<Inspector
						entry={focused}
						entries={finder.selectedEntries}
						indexStatus={focused !== null ? (finder.indexStatus[focused.path] ?? null) : null}
						onToggleIndex={finder.toggleIndex}
						onTrash={finder.trashEntry}
						onCopyPath={finder.copyEntryPath}
						onAskAi={askAi}
						actionCapabilities={finder.actionCapabilities}
						onAction={runInspectorAction}
						family={inspectorFamily}
						onOpenMember={openMemberEntry}
						evidence={evidence}
						evidenceVisible={evidence.length > 0 && evidenceOpen && selectedEvidence !== null}
						evidenceSelected={evidenceSelectedNumber}
						sessionId={evidenceSession}
						onSelectEvidence={selectEvidence}
						onRevealPath={finder.revealEvidence}
						onToast={finder.showToast}
					/>
				) : null}
					</div>
				</div>
				{finder.toast === null ? null : <Toast message={finder.toast} />}
				{sidebarVisible ? (
					<PaneGrip
						position={{ left: sidebarWidth - 3 }}
						label="Resize sidebar"
						onDelta={(dx) => setSidebarWidth((width) => clampWidth(width + dx, SIDEBAR_MIN, SIDEBAR_MAX))}
					/>
				) : null}
				{inspectorVisible ? (
					<PaneGrip
						position={{ right: inspectorWidth - 3 }}
						label="Resize inspector"
						onDelta={(dx) => setInspectorWidth((width) => clampWidth(width - dx, INSPECTOR_MIN, INSPECTOR_MAX))}
					/>
				) : null}
			</div>
			{finder.contextMenu === null ? null : (
				<ContextMenu
					cursor={finder.contextMenu.cursor}
					entries={finder.contextMenuEntries}
					onSelect={finder.runMenuAction}
					onClose={finder.closeContextMenu}
				/>
			)}
		</div>
	);
}
