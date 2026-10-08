import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { QuickLookTarget } from "../../preview/shared/contract";
import type { Bounds } from "../../preview/shared/fit";
import { NO_CAPABILITIES, type ActionAnchor } from "../../shared/actions-contract";
import { DEFAULT_SETTINGS, type AppSettings, type DataSourcesSnapshot } from "../../shared/settings-contract";
import { setAppLanguage } from "../../shared/i18n";
import type { ChatAttachment, CitationEvidence } from "../../shared/search-contract";
import type { FsLocationIcon } from "../../shared/fs-contract";
import { AiSearchPanel, type AiDockHandle } from "./components/AiSearchPanel";
import { FinderPane, type PaneShell } from "./components/FinderPane";
import { Inspector, type InspectorFamily } from "./components/Inspector";
import { ContextMenu } from "./components/primitives/ContextMenu";
import { Toast } from "./components/primitives/Toast";
import { ConfirmDialog } from "./components/primitives/ConfirmDialog";
import { Sidebar } from "./components/Sidebar";
import type { SearchMode } from "./components/SidebarSearch";
import { Toolbar } from "./components/Toolbar";
import { percentPlacement, TAB_DRAG_TYPE, WorkspaceView } from "./components/Workspace";
import { createDirectoryStore } from "./data/directory-store";
import { createEntrySidecar } from "./data/entry-sidecar";
import type { DirectoryData } from "./hooks/useDirectoryData";
import { useFinderSource } from "./hooks/useFinderSource";
import { createControllerStore, usePaneController } from "./hooks/usePaneControllers";
import { attachmentsFromDrop, isAttachmentDrag } from "./state/attachments";
import { toolbarShareControl, type FileActionTarget } from "./state/file-actions";
import { watchSetFor } from "./state/live";
import { loadListColumns, saveListColumns, type ListColumnsState } from "./state/list-columns";
import { basename, dirname } from "./state/paths";
import { aiPanelTabs, AI_SEARCH_PATH, SETTINGS_PATH } from "./state/tabs";
import { allTabs, canCloseWorkspaceTab, createWorkspace, focusPane, moveTab, resizeSplit, type Workspace } from "./state/workspace";
import { cn } from "./lib/cn";

const autorag = window.autorag;

/** How long a toast stays (--time-toast). */
const TOAST_MS = 2400;

/** The pane tab strip's height (`h-25`): an AI Search chat sits right below it. */
const TAB_STRIP_PX = 25;

/** The sidebar search ref before the first pane publishes its controller. */
const NO_INPUT = { current: null };

/** The reference's `showHotkeys` prop (default true): keycaps on or off. */
const SHOW_HOTKEYS = true;

const SIDEBAR_KEY = "autorag.shell.sidebar";
const INSPECTOR_KEY = "autorag.shell.inspector";
const SIDEBAR_WIDTH_KEY = "autorag.shell.sidebarWidth";
const INSPECTOR_WIDTH_KEY = "autorag.shell.inspectorWidth";

/** Pane resize limits (px): the sidebar and inspector stay usable at both ends. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 320;
const INSPECTOR_MIN = 300;
const INSPECTOR_MAX = 560;

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
	const { t } = useTranslation();
	const source = useFinderSource();
	const [showHiddenFiles, setShowHiddenFiles] = useState(false);
	/** The Interface language setting; "AI 요약" prompts in this language. */
	const [language, setLanguage] = useState<AppSettings["language"]>(DEFAULT_SETTINGS.language);
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
	const [sidebarWidth, setSidebarWidth] = useState(() => loadNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN));
	const [inspectorWidth, setInspectorWidth] = useState(() => loadNumber(INSPECTOR_WIDTH_KEY, INSPECTOR_MIN));
	const [listColumns, setListColumns] = useState<ListColumnsState>(loadListColumns);
	const [sourceStatus, setSourceStatus] = useState<Readonly<Partial<Record<FsLocationIcon, "syncing" | "error">>>>({});
	/** The sidebar AI Search item is under an attachment drag. */
	const [aiNavDropHover, setAiNavDropHover] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	useEffect(() => saveFlag(SIDEBAR_KEY, sidebarVisible), [sidebarVisible]);
	useEffect(() => saveFlag(INSPECTOR_KEY, inspectorVisible), [inspectorVisible]);
	useEffect(() => saveNumber(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth]);
	useEffect(() => saveNumber(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth]);
	useEffect(() => saveListColumns(listColumns), [listColumns]);
	useEffect(() => {
		if (toast === null) return;
		const timer = window.setTimeout(() => setToast(null), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [toast]);

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

	/* ------------------------------------------------------ split workspace */
	const [workspace, setWorkspace] = useState<Workspace>(() => createWorkspace(source.initialPath));
	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;
	const [store] = useState(createControllerStore);
	/** Every pane's folders and their enrichment, owned outside React (FS roadmap #99). */
	const [directoryData] = useState<DirectoryData>(() => {
		const sidecar = createEntrySidecar();
		return { sidecar, store: createDirectoryStore({ source, sidecar }) };
	});
	useEffect(() => directoryData.store.connect(), [directoryData]);
	const [draggingTabId, setDraggingTabId] = useState<number | null>(null);

	const focusedPaneId = workspace.focusedPaneId;
	const finder = usePaneController(store, focusedPaneId);
	const tabs = useMemo(() => allTabs(workspace), [workspace]);

	// Every pane's folders are watched.
	const tabPathsKey = tabs.map((tab) => tab.path).join("\u0000");
	useEffect(() => {
		void source.setWatchSet(watchSetFor(allTabs(workspaceRef.current))).catch((error: unknown) => console.error(error));
	}, [source, tabPathsKey]);
	useEffect(() => () => void source.setWatchSet([]).catch((error: unknown) => console.error(error)), [source]);
	useEffect(() => {
		const resync = (): void => {
			void source.setWatchSet(watchSetFor(allTabs(workspaceRef.current))).catch((error: unknown) => console.error("live watch resync failed", error));
		};
		window.addEventListener("focus", resync);
		// A restarted fs worker holds no watches: hand it the open tabs again.
		const offReconnect = source.onReconnect(resync);
		return () => {
			window.removeEventListener("focus", resync);
			offReconnect();
		};
	}, [source]);

	/* --------------------------------------------------------- evidence state */
	// The focused AI Search tab publishes its answer's citations; the inspector
	// shows them as a full-height Evidence view while that tab is focused.
	const [evidence, setEvidence] = useState<readonly CitationEvidence[]>([]);
	const [evidenceSession, setEvidenceSession] = useState<string | null>(null);
	const [selectedEvidence, setSelectedEvidence] = useState<number | null>(null);

	const publishEvidence = useCallback((items: readonly CitationEvidence[], sessionId: string | null) => {
		setEvidence(items);
		setEvidenceSession(sessionId);
		setSelectedEvidence((current) => (current !== null && items.some((item) => item.number === current) ? current : null));
	}, []);

	/**
	 * Work for the AI Search tab that is (about to be) focused: the tab switch
	 * and the panel mount land in the same render, so the request waits here
	 * until the effect below finds the focused tab's panel handle.
	 */
	const aiHandlesRef = useRef(new Map<number, AiDockHandle>());
	const aiPendingRef = useRef<{
		readonly attach: readonly ChatAttachment[];
		readonly query: string | null;
		/** "AI 요약" targets sent with their own summary run, never as drafts. */
		readonly summarize: readonly ChatAttachment[];
	} | null>(null);
	const [aiDelivery, setAiDelivery] = useState(0);
	const deliverToAi = useCallback(
		(request: { readonly attach?: readonly ChatAttachment[]; readonly query?: string; readonly summarize?: readonly ChatAttachment[] }) => {
			const pending = aiPendingRef.current;
			aiPendingRef.current = {
				attach: [...(pending?.attach ?? []), ...(request.attach ?? [])],
				query: request.query ?? pending?.query ?? null,
				summarize: [...(pending?.summarize ?? []), ...(request.summarize ?? [])],
			};
			setAiDelivery((tick) => tick + 1);
		},
		[],
	);

	const focusedPane = workspace.panes.find((pane) => pane.id === focusedPaneId);
	const focusedTab = focusedPane?.tabs.find((tab) => tab.id === focusedPane.activeId) ?? null;
	const activeAiTabId = focusedTab?.path === AI_SEARCH_PATH ? focusedTab.id : null;
	/** Every AI Search tab some pane shows: several chats can be on screen side by side. */
	const visibleAiTabs = new Map<number, number>();
	for (const pane of workspace.panes) {
		const shown = pane.tabs.find((tab) => tab.id === pane.activeId);
		if (shown?.path === AI_SEARCH_PATH) visibleAiTabs.set(shown.id, pane.id);
	}
	// Each AI Search tab keeps its own mounted chat, also while the tab shows a folder or moves pane.
	const [aiPanelIds, setAiPanelIds] = useState<readonly number[]>([]);
	const nextAiPanelIds = aiPanelTabs(
		aiPanelIds,
		tabs.map((tab) => ({ id: tab.id, aiSearch: tab.path === AI_SEARCH_PATH })),
	);
	if (nextAiPanelIds !== aiPanelIds) setAiPanelIds(nextAiPanelIds);

	useEffect(() => {
		const pending = aiPendingRef.current;
		if (pending === null) return;
		aiPendingRef.current = null;
		const handle = activeAiTabId === null ? undefined : aiHandlesRef.current.get(activeAiTabId);
		if (handle === undefined) return;
		if (pending.summarize.length > 0) {
			handle.summarize(pending.summarize);
			return;
		}
		if (pending.attach.length > 0) handle.attach(pending.attach);
		if (pending.query !== null) handle.sendQuery(pending.query);
		else handle.focusComposer();
	}, [aiDelivery, activeAiTabId]);

	/** The window-level callbacks every pane shares: one stable object, so panes re-render only for their own state. */
	const shell = useMemo<PaneShell>(
		() => ({
			source,
			store,
			directoryData,
			quickLook: { onQuickLook: openQuickLook, closeQuickLook, isQuickLookOpen },
			update: (change) => setWorkspace((current) => change(current)),
			onFocusSearch: () => setSidebarVisible(true),
			// ⌘K: the controller adopts the nearest AI Search tab (or opens one); focus its composer.
			onFocusComposer: () => deliverToAi({}),
			onToast: setToast,
			deliverToAi,
			onSettingsChanged: (settings: AppSettings) => {
				setShowHiddenFiles(settings.showHiddenFiles);
				setLanguage(settings.language);
				void setAppLanguage(settings.language);
			},
			setListColumns,
			beginTabDrag: (tabId, event) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(TAB_DRAG_TYPE, String(tabId));
				// The overlay must not appear under the pointer in the same task as dragstart.
				window.setTimeout(() => setDraggingTabId(tabId), 0);
			},
			endTabDrag: () => setDraggingTabId(null),
		}),
		[source, store, directoryData, openQuickLook, closeQuickLook, isQuickLookOpen, deliverToAi],
	);
	useEffect(() => {
		if (draggingTabId === null) return;
		const end = (): void => setDraggingTabId(null);
		window.addEventListener("dragend", end);
		window.addEventListener("drop", end);
		return () => {
			window.removeEventListener("dragend", end);
			window.removeEventListener("drop", end);
		};
	}, [draggingTabId]);

	/** Sidebar 내용 / ⌥Enter "content search": a new AI Search tab runs the query. */
	const contentSearch = useCallback(
		(text: string) => {
			if (finder === undefined || text.trim() === "") return;
			finder.openAiSearch();
			deliverToAi({ query: text });
		},
		[deliverToAi, finder],
	);

	/**
	 * Sidebar search commit. Enter runs a filename search over the whole machine
	 * (This Mac / This Computer) in the focused pane; the 내용 chip — or ⌥Enter
	 * from either chip — hands the query to a new AI Search tab.
	 */
	const submitSidebarSearch = useCallback(
		(mode: SearchMode, text: string) => {
			if (finder === undefined) return;
			const value = text.trim();
			if (value === "") {
				finder.setQuery("");
				return;
			}
			if (mode === "content") {
				contentSearch(value);
				return;
			}
			// A Settings / AI Search tab lists nothing: the results show in its last folder.
			finder.leaveVirtualTab();
			finder.setSearchScope("all");
			finder.setQuery(value);
		},
		[contentSearch, finder],
	);

	/** Inspector "AI 요약": a new AI Search tab that attaches the entry and sends the summary run. */
	const askAi = useCallback(
		(entry: { readonly path: string; readonly name: string; readonly kind: "file" | "folder" }) => {
			finder?.openAiSearch();
			deliverToAi({ summarize: [{ kind: entry.kind, id: entry.path, name: entry.name }] });
		},
		[deliverToAi, finder],
	);

	/** Answer and evidence images: a local picture opens in Quick Look; a web image's page (never fetched) in the OS browser. */
	const revealEvidence = finder?.revealEvidence;
	const imageActions = useMemo(
		() => ({ onOpenImage: openQuickLook, onOpenUrl: (target: string) => revealEvidence?.(target) }),
		[openQuickLook, revealEvidence],
	);

	/** Sidebar "AI Search": the focused tab becomes AI Search. */
	const showAiSearch = useCallback(() => {
		finder?.showAiSearch();
		deliverToAi({});
	}, [deliverToAi, finder]);

	/** Inspector action bar: open, share, archive, and edits all run through the focused pane's controller. */
	const runInspectorAction = useCallback(
		(target: FileActionTarget, anchor: ActionAnchor | null) => {
			const entry = finder?.focusedEntry ?? null;
			if (entry !== null) finder?.runEntryAction(entry, target, anchor);
		},
		[finder],
	);

	const selectEvidence = useCallback(
		(number: number) => {
			// A citation chip with no evidence entry must never open a different
			// result: the panel would silently show unrelated evidence.
			if (!evidence.some((item) => item.number === number)) {
				setToast(`근거 ${number}에 대한 정보를 찾을 수 없습니다`);
				return;
			}
			setSelectedEvidence(number);
			setInspectorVisible(true);
		},
		[evidence],
	);

	const evidenceSelectedNumber = evidence.find((item) => item.number === selectedEvidence)?.number ?? evidence[0]?.number ?? 1;
	const focusPath = finder?.selection.focus ?? null;
	const stackRows = finder?.stackRows;
	useEffect(() => {
		if (focusPath === null || stackRows === undefined) return;
		setPreview((current) => {
			if (current === null || current.path === focusPath) return current;
			const match = stackRows.find((row) => row.entry.path === focusPath);
			if (match === undefined) return current;
			return { path: match.entry.path, name: match.entry.name };
		});
	}, [focusPath, stackRows]);

	useEffect(() => {
		const request = preview === null ? autorag.preview.hide(closingRef.current) : autorag.preview.show(preview, iconRect(preview.path));
		closingRef.current = null;
		request.catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)));
	}, [preview]);

	const moveSelectionBy = finder?.moveSelectionBy;
	useEffect(() => {
		const offClosed = autorag.preview.onClosed(() => setPreview(null));
		const offNavigate = autorag.preview.onNavigate((delta) => moveSelectionBy?.(delta));
		return () => {
			offClosed();
			offNavigate();
		};
	}, [moveSelectionBy]);

	useEffect(() => {
		void autorag.settings.get().then((settings) => {
			setShowHiddenFiles(settings.showHiddenFiles);
			setLanguage(settings.language);
			void setAppLanguage(settings.language);
		});
	}, []);

	const focused = finder?.focusedEntry ?? null;
	/** The toolbar Share item: shown where the OS has a share sheet, enabled with a focused row. */
	const shareControl = toolbarShareControl(focused !== null, finder?.actionCapabilities ?? NO_CAPABILITIES);
	const familyEntries = focused !== null && finder !== undefined ? finder.familyEntriesFor(focused.path) : null;
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
	const openMemberEntry = useCallback(
		(path: string) => {
			const entry =
				familyEntries?.members.find((member) => member.entry.path === path)?.entry ??
				(familyEntries?.head.path === path ? familyEntries.head : undefined);
			if (entry !== undefined) finder?.revealEntry(entry);
		},
		[familyEntries, finder],
	);

	const path = finder?.path ?? focusedTab?.path ?? "";
	const aiTabActive = path === AI_SEARCH_PATH;
	const toolbarTitle =
		path === SETTINGS_PATH
			? "Settings"
			: aiTabActive
				? "AI Search"
				: finder?.searching === true
					? `Search "${finder.query}"`
					: basename(path);

	/** The sidebar AI Search item: a drop turns the focused tab into AI Search with the files attached. */
	const aiSearchDrop = {
		hovered: aiNavDropHover,
		onDragOver: (event: DragEvent<HTMLButtonElement>) => {
			if (!isAttachmentDrag(event.dataTransfer.types)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			setAiNavDropHover(true);
		},
		onDragLeave: () => setAiNavDropHover(false),
		onDrop: (event: DragEvent<HTMLButtonElement>) => {
			setAiNavDropHover(false);
			if (!isAttachmentDrag(event.dataTransfer.types)) return;
			event.preventDefault();
			const dropped = attachmentsFromDrop(event.dataTransfer, autorag.pathForFile);
			if (dropped.length === 0) return;
			finder?.showAiSearch();
			deliverToAi({ attach: dropped });
		},
	};
	/** Outer grid: sidebar + the region that holds the full-width toolbar. */
	const windowColumns = `${sidebarVisible ? `${sidebarWidth}px ` : ""}minmax(0,1fr)`;
	/** Inner grid under the toolbar: workspace + inspector. */
	const finderColumns = `minmax(0,1fr)${inspectorVisible ? ` ${inspectorWidth}px` : ""}`;
	const canCloseTabs = canCloseWorkspaceTab(workspace);
	const split = workspace.panes.length > 1;

	return (
		<div className="desk flex h-full bg-window">
			<div
				className="window relative grid flex-1 min-w-0 bg-window overflow-hidden"
				style={{ gridTemplateColumns: windowColumns, gridTemplateRows: "minmax(0, 1fr)" }}
			>
				{sidebarVisible ? (
					<Sidebar
						groups={finder?.navGroups ?? []}
						activePath={aiTabActive ? AI_SEARCH_PATH : (finder?.activeNavPath ?? null)}
						settingsActive={path === SETTINGS_PATH}
						showHotkeys={SHOW_HOTKEYS}
						onNavigate={(item) => (item.view === "aiSearch" ? showAiSearch() : finder?.navigateNav(item))}
						onEject={(item) => finder?.ejectNav(item)}
						onOpenSettings={() => finder?.openSettings()}
						onHideSidebar={() => setSidebarVisible(false)}
						sourceStatus={sourceStatus}
						searchQuery={finder?.query ?? ""}
						searchRef={finder?.searchRef ?? NO_INPUT}
						searchFocused={finder?.searchFocused ?? false}
						onSearchFocus={() => finder?.setSearchFocused(true)}
						onSearchBlur={() => finder?.setSearchFocused(false)}
						onSubmitSearch={submitSidebarSearch}
						aiSearchDrop={aiSearchDrop}
					/>
				) : null}
				<div className="flex min-w-0 min-h-0 flex-col">
					<Toolbar
						title={toolbarTitle}
						canGoBack={finder?.canGoBack ?? false}
						canGoForward={finder?.canGoForward ?? false}
						onBack={() => finder?.back()}
						onForward={() => finder?.forward()}
						viewMode={finder?.viewMode ?? "list"}
						onViewModeChange={(mode) => finder?.setViewMode(mode)}
						sort={finder?.sort ?? null}
						grouping={finder?.grouping ?? "none"}
						onApplySort={(key, direction) => finder?.applySort(key, direction)}
						onSetGrouping={(key) => finder?.setGrouping(key)}
						inspectorVisible={inspectorVisible}
						onToggleInspector={() => setInspectorVisible((visible) => !visible)}
						aiActive={aiTabActive}
						onShowAi={() => {
							finder?.focusAiSearch();
							deliverToAi({});
						}}
						shareAvailable={shareControl.shown}
						canShare={shareControl.enabled}
						onShare={(anchor) => {
							if (focused !== null) finder?.runEntryAction(focused, { kind: "share" }, anchor);
						}}
						trashActive={finder?.inTrashLocation === true}
						canPutBack={(finder?.selection.keys.length ?? 0) > 0}
						onPutBack={() => finder?.putBackSelection()}
						onEmptyTrash={() => finder?.requestEmptyTrash()}
						sidebarHidden={!sidebarVisible}
						onShowSidebar={() => setSidebarVisible(true)}
					/>
					<div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: finderColumns, gridTemplateRows: "minmax(0, 1fr)" }}>
						<WorkspaceView
							workspace={workspace}
							draggingTabId={draggingTabId}
							onDrop={(tabId, target) => setWorkspace((current) => moveTab(current, tabId, target))}
							onResize={(handle, delta, minShare) =>
								setWorkspace((current) => resizeSplit(current, handle.splitId, handle.index, delta, minShare))
							}
							renderPane={(paneId) => {
								const pane = workspace.panes.find((candidate) => candidate.id === paneId);
								if (pane === undefined) return null;
								return (
									<FinderPane
										pane={pane}
										focused={paneId === focusedPaneId}
										canCloseTabs={canCloseTabs}
										split={split}
										showHiddenFiles={showHiddenFiles}
										listColumns={listColumns}
										draggingTabId={draggingTabId}
										shell={shell}
									/>
								);
							}}
							overlay={(rects, motion) =>
								aiPanelIds.map((id) => {
									const paneId = visibleAiTabs.get(id);
									const box = paneId === undefined ? undefined : rects.get(paneId);
									return (
										<div
											key={id}
											className={cn("ai-host absolute flex flex-col", motion, box === undefined && "hidden")}
											data-ai-tab={id}
											style={box === undefined ? undefined : percentPlacement(box, TAB_STRIP_PX)}
											onMouseDownCapture={() => {
												if (paneId !== undefined) setWorkspace((current) => focusPane(current, paneId));
											}}
										>
											<AiSearchPanel
												ref={(handle) => {
													if (handle === null) aiHandlesRef.current.delete(id);
													else aiHandlesRef.current.set(id, handle);
												}}
												active={id === activeAiTabId}
												visible={box !== undefined}
												selectedEvidence={evidence.length === 0 ? null : evidenceSelectedNumber}
												onSelectEvidence={selectEvidence}
												onPublish={publishEvidence}
												imageActions={imageActions}
												language={language}
											/>
										</div>
									);
								})
							}
						/>
						{inspectorVisible ? (
							<Inspector
								entry={focused}
								entries={finder?.selectedEntries ?? []}
								indexStatus={focused !== null ? (finder?.indexStatusFor(focused.path) ?? null) : null}
								onToggleIndex={(entry) => finder?.toggleIndex(entry)}
								onTrash={(entry) => finder?.trashEntry(entry)}
								onCopyPath={(entry) => finder?.copyEntryPath(entry)}
								onAskAi={askAi}
								actionCapabilities={finder?.actionCapabilities ?? NO_CAPABILITIES}
								onAction={runInspectorAction}
								family={inspectorFamily}
								onOpenMember={openMemberEntry}
								view={aiTabActive ? "evidence" : "info"}
								evidence={evidence}
								evidenceSelected={evidenceSelectedNumber}
								sessionId={evidenceSession}
								onSelectEvidence={selectEvidence}
								onRevealPath={(target) => finder?.revealEvidence(target)}
								onToast={setToast}
								imageActions={imageActions}
							/>
						) : null}
					</div>
				</div>
				{toast === null ? null : <Toast message={toast} />}
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
			{finder?.contextMenu == null ? null : (
				<ContextMenu
					cursor={finder.contextMenu.cursor}
					entries={finder.contextMenuEntries}
					onSelect={finder.runMenuAction}
					onClose={finder.closeContextMenu}
				/>
			)}
			{finder?.emptyTrashConfirm === true ? (
				<ConfirmDialog
					title={t("confirm.emptyTrashTitle", "휴지통 비우기")}
					message={t("confirm.emptyTrashMessage", "휴지통의 모든 항목이 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.")}
					confirmLabel={t("confirm.emptyTrashAction", "비우기")}
					cancelLabel={t("common.cancel", "취소")}
					danger
					onConfirm={() => finder?.confirmEmptyTrash()}
					onCancel={() => finder?.cancelEmptyTrash()}
				/>
			) : null}
		</div>
	);
}
