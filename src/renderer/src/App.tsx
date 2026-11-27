import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { QuickLookTarget } from "../../preview/shared/contract";
import type { Bounds } from "../../preview/shared/fit";
import { NO_CAPABILITIES, type ActionAnchor } from "../../shared/actions-contract";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/settings-contract";
import { setAppLanguage } from "../../shared/i18n";
import { t as translate } from "../../shared/i18n/core";
import { REMOTE_PREVIEW_FOLDER_CODE, REMOTE_PREVIEW_UNSUPPORTED_CODE } from "../../shared/remote-contract";
import type { ChatAttachment, CitationEvidence } from "../../shared/search-contract";
import type { OsRendererRequest } from "../../shared/os-request-contract";
import { mapSourceStatus, type SourceStatusMap } from "./state/source-status";
import { AiSearchPanel, type AiDockHandle } from "./components/AiSearchPanel";
import { AutomationInspector } from "./components/AutomationInspector";
import { AutomationQuickLook } from "./components/AutomationQuickLook";
import { AutomationsContext } from "./components/AutomationsTab";
import { DocumentEditorAiSidebar } from "./components/DocumentEditorAiSidebar";
import { DocumentEditorSidebarProvider } from "./components/DocumentEditorSidebarContext";
import { FinderPane, type PaneShell } from "./components/FinderPane";
import { FadedDazziMark, Inspector, type InspectorFamily } from "./components/Inspector";
import { InspectorColumn } from "./components/InspectorColumn";
import { InspectorChatDock, InspectorChatHead, InspectorChatView } from "./components/InspectorChat";
import { ContextMenu } from "./components/primitives/ContextMenu";
import { Toast, type ToastTone } from "./components/primitives/Toast";
import { pushNotice, setNotificationCenterOpen } from "./state/notifications";
import { ConfirmDialog } from "./components/primitives/ConfirmDialog";
import { FullDiskAccessDialog } from "./components/primitives/FullDiskAccessDialog";
import { ConvertRenameDialog } from "./components/primitives/ConvertRenameDialog";
import { ErrorFixDialog } from "./components/ErrorFixDialog";
import { MagicActionDialog } from "./components/MagicActionDialog";
import { ReduceSizeDialog } from "./components/primitives/ReduceSizeDialog";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { SettingsAssistantContext, SettingsAssistantSlot, useSettingsAssistantHost } from "./components/settings/SettingsAssistantDock";
import { SettingsView } from "./components/SettingsView";
import { percentPlacement, TAB_DRAG_TYPE, WorkspaceView } from "./components/Workspace";
import { createDirectoryStore } from "./data/directory-store";
import { createEntrySidecar } from "./data/entry-sidecar";
import type { DirectoryData } from "./hooks/useDirectoryData";
import { isTagPath, isVirtualListing, tagNameOf } from "../../shared/fs-contract";
import { useFinderSource } from "./hooks/useFinderSource";
import { TagCatalogContext, useTagCatalogLoader } from "./hooks/useTagCatalog";
import { SidebarSettingsContext } from "./hooks/useSidebarSettings";
import { useSidebarRowMenu } from "./hooks/useSidebarRowMenu";
import type { SidebarSettings } from "../../shared/sidebar-contract";
import { ContextMenuSettingsContext } from "./hooks/useContextMenuSettings";
import type { ContextMenuSettings } from "../../shared/context-menu-contract";
import { ShortcutSettingsContext } from "./hooks/useShortcutSettings";
import type { ShortcutSettings } from "../../shared/shortcuts-contract";
import { createControllerStore, usePaneController } from "./hooks/usePaneControllers";
import { useAutomations } from "./hooks/useAutomations";
import { dismissMagicActionDialog } from "./hooks/useMagicAction";
import { useAutomationsShell } from "./hooks/useAutomationsShell";
import { useInspectorChats } from "./hooks/useInspectorChats";
import { useInteractionQueue } from "./hooks/useInteractionQueue";
import { frontRequest } from "./state/interaction";
import { useNow } from "./hooks/useNow";
import { deliverToDock, mergeDelivery, type AiDelivery, type AiDeliveryRequest } from "./state/ai-delivery";
import { attachmentsFromDrop, isAttachmentDrag } from "./state/attachments";
import { toolbarShareControl, type FileActionTarget } from "./state/file-actions";
import { sessionEvidencePaths } from "./state/evidence";
import { inspectorEntryFor } from "./state/inspector-target";
import { EMPTY_INSPECTOR_CHAT_TAB, pendingAttachments } from "./state/inspector-chat";
import { ruleNamesNow, ruleTitle, setRuleNames } from "./state/automations";
import { isFilesystemPath, watchSetFor } from "./state/live";
import { loadListColumns, saveListColumns, type ListColumnsState } from "./state/list-columns";
import { basename, dirname } from "./state/paths";
import { requestSettingsCategory } from "./state/settings-navigation";
import { aiPanelTabs, AI_SEARCH_PATH, AUTOMATIONS_PATH, editorFilePathOf, SETTINGS_PATH } from "./state/tabs";
import { allTabs, canCloseWorkspaceTab, closeSettingsInWorkspace, createWorkspace, focusAiSearchInWorkspace, focusPane, moveTab, resizeSplit, type Workspace } from "./state/workspace";
import { windowColumns } from "./state/window-layout";
import { FirstRun, type FirstRunHost } from "./first-run/FirstRun";
import { folderPaneId, splitWithAiSearch } from "./first-run/tour";
import { Tutorials } from "./first-run/Tutorials";
import type { TutorialEffect, TutorialFacts } from "./first-run/tutorial-steps";
import { cn } from "./lib/cn";

const autorag = window.autorag;

/**
 * The Finder chrome (left sidebar, toolbar and panes) stays mounted while Settings takes over, so tabs, AI chats and
 * scroll positions survive. A utility class such as `flex` beats the `hidden` attribute, so it hides with a style.
 */
const HIDDEN_STYLE = { display: "none" } as const;

/** How long a toast stays (--time-toast). */
const TOAST_MS = 2400;

/** The pane tab strip's height (`h-24` in TabStrip.tsx, borders included): an AI Search chat sits right below it, level with the Finder content and the 자동화 side. */
const TAB_STRIP_PX = 24;

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
	const [automationNames, setAutomationNames] = useState<AppSettings["automationNames"]>({});
	// Every rule title in the window reads the names from here; set before anything below renders.
	setRuleNames(automationNames);
	const [sidebarSettings, setSidebarSettings] = useState<SidebarSettings>(DEFAULT_SETTINGS.sidebar);
	const [contextMenuSettings, setContextMenuSettings] = useState<ContextMenuSettings>(DEFAULT_SETTINGS.contextMenu);
	const [shortcutSettings, setShortcutSettings] = useState<ShortcutSettings>(DEFAULT_SETTINGS.shortcuts);
	const [preview, setPreview] = useState<QuickLookTarget | null>(null);
	const previewRef = useRef<QuickLookTarget | null>(null);
	previewRef.current = preview;
	/** Icon of the file the preview closes on: captured before React drops `preview`. */
	const closingRef = useRef<Bounds | null>(null);
	const openQuickLook = useCallback((target: QuickLookTarget) => {
		const open = previewRef.current;
		if (open?.path === target.path && target.anchor === undefined) closingRef.current = iconRect(open.path);
		setPreview((current) =>
			current?.path === target.path && target.anchor === undefined
				? null
				: {
						path: target.path,
						name: target.name,
						...(target.kind === undefined ? {} : { kind: target.kind }),
						...(target.anchor === undefined ? {} : { anchor: target.anchor }),
					},
		);
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
	/** When 새 자동화 (or 채팅으로 만들기) was last pressed: the 자동화 column then starts a rule with an empty card. */
	const [automationStarter, setAutomationStarter] = useState<number | null>(null);
	const [sidebarWidth, setSidebarWidth] = useState(() => loadNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN));
	const [inspectorWidth, setInspectorWidth] = useState(() => loadNumber(INSPECTOR_WIDTH_KEY, INSPECTOR_MIN));
	const [listColumns, setListColumns] = useState<ListColumnsState>(loadListColumns);
	const [sourceStatus, setSourceStatus] = useState<SourceStatusMap>({});
	/** The sidebar AI Search item is under an attachment drag. */
	const [aiNavDropHover, setAiNavDropHover] = useState(false);
	const [toastState, setToastState] = useState<{ readonly message: string; readonly tone: ToastTone } | null>(null);
	const toast = toastState?.message ?? null;
	/** A plain notice (Figma 554:7353 with the green badge). */
	const setToast = useCallback((message: string | null) => setToastState(message === null ? null : { message, tone: "ok" }), []);
	/** Something failed: the same toast with the red badge. */
	const showErrorToast = useCallback((message: string) => {
		// Every error toast is also kept in the notification center, so it can be read after the toast has gone.
		pushNotice({ title: message });
		setToastState({ message, tone: "error" });
	}, []);
	/** The first-run layer is up (the main process passed the pending flag; the layer's `load` is authoritative). */
	const [firstRun, setFirstRun] = useState(() => autorag.onboarding.pending);
	/** The layer covers the whole window, so the Finder behind it takes no input. */
	const [firstRunCovered, setFirstRunCovered] = useState(firstRun);
	/** The contextual tutorials run unless the main process opted this profile out (QA lanes skip onboarding). */
	const [tutorialsAllowed, setTutorialsAllowed] = useState(false);
	useEffect(() => {
		void autorag.onboarding
			.load()
			.then((snapshot) => setTutorialsAllowed(snapshot.tutorials))
			.catch(() => setTutorialsAllowed(false));
	}, []);
	const [tagColorsFdaOpen, setTagColorsFdaOpen] = useState(false);
	const reportTagError = useCallback((error: unknown) => showErrorToast(error instanceof Error ? error.message : String(error)), [showErrorToast]);
	const grantTagColors = useCallback(() => setTagColorsFdaOpen(true), []);
	const tagCatalog = useTagCatalogLoader(source, reportTagError);

	useEffect(() => saveFlag(SIDEBAR_KEY, sidebarVisible), [sidebarVisible]);
	useEffect(() => saveFlag(INSPECTOR_KEY, inspectorVisible), [inspectorVisible]);
	useEffect(() => saveNumber(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth]);
	useEffect(() => saveNumber(INSPECTOR_WIDTH_KEY, inspectorWidth), [inspectorWidth]);
	useEffect(() => saveListColumns(listColumns), [listColumns]);
	useEffect(() => {
		if (toast === null) return;
		const timer = window.setTimeout(() => setToast(null), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [toastState]);

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

	// Temporary Evidence Folders owned by open tabs: when a tab closes or
	// navigates away from its Evidence Folder, delete the temporary folder from disk.
	const activeEvidenceFoldersRef = useRef<Set<string>>(new Set());
	const evidenceFoldersKey = tabs
		.map((tab) => tab.evidenceFolder ?? "")
		.filter((folder) => folder !== "")
		.join("\u0000");
	useEffect(() => {
		const current = new Set(evidenceFoldersKey === "" ? [] : evidenceFoldersKey.split("\u0000"));
		for (const previous of activeEvidenceFoldersRef.current) {
			if (!current.has(previous)) {
				directoryData.store.drop([previous]);
				void source.removeEvidenceFolder(previous).catch((error: unknown) => console.error(error));
			}
		}
		activeEvidenceFoldersRef.current = current;
	}, [source, directoryData, evidenceFoldersKey]);
	/* --------------------------------------------------------- evidence state */
	// The focused AI Search tab publishes its answer's citations; the inspector
	// shows them as a full-height Evidence view while that tab is focused.
	const [evidence, setEvidence] = useState<readonly CitationEvidence[]>([]);
	const evidenceRef = useRef<readonly CitationEvidence[]>(evidence);
	evidenceRef.current = evidence;
	const [sessionEvidence, setSessionEvidence] = useState<readonly CitationEvidence[]>([]);
	const [selectedEvidence, setSelectedEvidence] = useState<number | null>(null);

	const [freshEvidence, setFreshEvidence] = useState<readonly number[]>([]);
	const publishEvidence = useCallback(
		(items: readonly CitationEvidence[], sessionItems?: readonly CitationEvidence[], freshItems?: readonly number[]) => {
			evidenceRef.current = items;
			setEvidence(items);
			setSessionEvidence(sessionItems ?? items);
			setFreshEvidence((current) => {
				const next = freshItems ?? [];
				return current.length === next.length && current.every((number, index) => number === next[index]) ? current : next;
			});
			setSelectedEvidence((current) => (current !== null && items.some((item) => item.number === current) ? current : null));
		},
		[],
	);
	const localEvidencePaths = useMemo(() => sessionEvidencePaths(sessionEvidence), [sessionEvidence]);

	/**
	 * Work for the AI Search tab that is (about to be) focused: the tab switch
	 * and the panel mount land in the same render, so the request waits here
	 * until the effect below finds the focused tab's panel handle.
	 */
	const aiHandlesRef = useRef(new Map<number, AiDockHandle>());
	const aiPendingRef = useRef<AiDelivery | null>(null);
	/** The AI Search tab the waiting delivery is for; null means whichever one is focused when it lands. */
	const aiTargetRef = useRef<number | null>(null);
	const [aiDelivery, setAiDelivery] = useState(0);
	const deliverToAi = useCallback((request: AiDeliveryRequest, tabId?: number) => {
		aiPendingRef.current = mergeDelivery(aiPendingRef.current, request);
		if (tabId !== undefined) aiTargetRef.current = tabId;
		setAiDelivery((tick) => tick + 1);
	}, []);

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
		const target = aiTargetRef.current ?? activeAiTabId;
		const handle = target === null ? undefined : aiHandlesRef.current.get(target);
		// The tab was just opened and its chat is not mounted yet: keep the request for the render that mounts it.
		if (handle === undefined) return;
		aiPendingRef.current = null;
		aiTargetRef.current = null;
		deliverToDock(handle, pending);
	}, [aiDelivery, activeAiTabId, aiPanelIds]);

	const firstRunHost = useMemo<FirstRunHost>(
		() => ({
			arrange: () => {
				setSidebarVisible(true);
				setInspectorVisible(true);
				setWorkspace((current) => splitWithAiSearch(current));
			},
			focusAi: () => {
				setWorkspace((current) => focusAiSearchInWorkspace(current));
			},
			typeDraft: (text, focus = true) => {
				const ws = workspaceRef.current;
				const aiTab = allTabs(ws).find((tab) => tab.path === AI_SEARCH_PATH);
				if (aiTab === undefined) return;
				aiHandlesRef.current.get(aiTab.id)?.prefill(text, { focus });
				if (focus) setWorkspace((current) => focusAiSearchInWorkspace(current));
			},
			showFamily: (family) => {
				const paneId = folderPaneId(workspaceRef.current);
				const head = family.entriesByPath[family.head];
				if (paneId === null || head === undefined) return;
				// Open the folder and scroll the stacked head row into view without selecting it yet:
				// the user's own click on the spotlighted row unfolds the stack and opens Versions.
				store.get(paneId)?.showEntryFolder(head);
				setWorkspace((current) => focusPane(current, paneId));
			},
			versionFamilies: async () => (await source.versionFamilies()).families,
			folderPath: () => {
				const paneId = folderPaneId(workspaceRef.current);
				const pane = workspaceRef.current.panes.find((candidate) => candidate.id === paneId);
				return pane?.tabs.find((tab) => tab.id === pane.activeId)?.path ?? null;
			},
			setCovered: setFirstRunCovered,
		}),
		[source, store],
	);
	const endFirstRun = useCallback(() => {
		setFirstRun(false);
		setFirstRunCovered(false);
	}, []);

	/** Settings' saves reach the window: the rows it shows, the interface language, the sidebar and the shortcuts follow. */
	const onSettingsChanged = useCallback((settings: AppSettings): void => {
		setShowHiddenFiles(settings.showHiddenFiles);
		setLanguage(settings.language);
		setSidebarSettings(settings.sidebar);
		setShortcutSettings(settings.shortcuts);
		void setAppLanguage(settings.language);
	}, []);

	/** While Settings is open the Finder's search box is hidden, so the focus-search shortcut goes to Settings' own. */
	const settingsSearchRef = useRef<HTMLInputElement | null>(null);
	const settingsOpenRef = useRef(false);

	/** The window-level callbacks every pane shares: one stable object, so panes re-render only for their own state. */
	const shell = useMemo<PaneShell>(
		() => ({
			source,
			store,
			directoryData,
			quickLook: { onQuickLook: openQuickLook, closeQuickLook, isQuickLookOpen },
			update: (change) => setWorkspace((current) => change(current)),
			onFocusSearch: () => {
				if (settingsOpenRef.current) settingsSearchRef.current?.focus();
				else setSidebarVisible(true);
			},
			// ⌘K: the controller adopts the nearest AI Search tab (or opens one); focus its composer.
			onFocusComposer: () => deliverToAi({}),
			onToast: setToast,
			onErrorToast: showErrorToast,
			deliverToAi,
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

	/**
	 * Sidebar search commit: one whole search in the focused pane — file names over the whole machine (This Mac / This
	 * Computer) shown at once, the document index and every connected datasource under their own group tabs.
	 */
	const submitSidebarSearch = useCallback(
		(text: string) => {
			if (finder === undefined) return;
			const value = text.trim();
			if (value === "") {
				finder.setQuery("");
				return;
			}
			// A Settings / AI Search tab lists nothing: the results show in its last folder.
			finder.leaveVirtualTab();
			finder.setSearchScope("all");
			finder.setQuery(value);
		},
		[finder],
	);

	/** Inspector "AI 요약": a new AI Search tab that attaches the entry and sends the summary run. */
	const askAi = useCallback(
		(entry: { readonly path: string; readonly name: string; readonly kind: "file" | "folder" }) => {
			finder?.openAiSearch();
			deliverToAi({ summarize: [{ kind: entry.kind, id: entry.path, name: entry.name }] });
		},
		[deliverToAi, finder],
	);

	/**
	 * Requests from the OS file menu ("Ask AutoRAG", "Show in AutoRAG") and the `dazzi` command. They are
	 * drained into a ref first: a cold start delivers one before the first pane
	 * has published its controller, and the effect below runs them once it has.
	 */
	const osQueueRef = useRef<OsRendererRequest[]>([]);
	const [osQueueTick, setOsQueueTick] = useState(0);
	useEffect(() => {
		const drain = (): void => {
			autorag.osRequests
				.take()
				.then((requests) => {
					if (requests.length === 0) return;
					osQueueRef.current.push(...requests);
					setOsQueueTick((tick) => tick + 1);
				})
				.catch((error: unknown) => console.error("os request take failed", error));
		};
		drain();
		return autorag.osRequests.onAvailable(drain);
	}, []);
	useEffect(() => {
		if (finder === undefined) return;
		for (const request of osQueueRef.current.splice(0)) {
			if (request.action === "reveal") {
				finder.revealEvidence(request.path);
			} else if (request.action === "open") {
				// `dazzi <path>...`: a folder gets a tab, a file is shown selected in its folder; the last one ends up in front.
				for (const target of request.targets) {
					if (target.kind === "folder") finder.openFolder(target.path);
					else finder.revealEvidence(target.path);
				}
			} else if (request.query !== null) {
				// `dazzi --ask`, Raycast, and the quick-search launcher's "Ask Dazzi": a new AI Search tab asks at once, like
				// the sidebar's content search, so a tab that is still answering never swallows the question.
				finder.openAiSearch();
				deliverToAi({ attach: request.attachments, query: request.query });
			} else {
				// Attached as drafts on the nearest AI Search tab: the user types the question.
				finder.focusAiSearch();
				deliverToAi({ attach: request.attachments });
			}
		}
	}, [osQueueTick, finder, deliverToAi]);

	/** Answer and evidence images and links: a local picture opens in Quick Look; a web image's page (never fetched) or a web link opens in the OS browser. */
	const revealEvidence = finder?.revealEvidence;
	const imageActions = useMemo(
		() => ({ onOpenImage: openQuickLook, onOpenUrl: (target: string) => revealEvidence?.(target) }),
		[openQuickLook, revealEvidence],
	);

	/** The AI 에이전트 side last shown (채팅 or 자동화): the sidebar's AI 에이전트 comes back to it. */
	const agentSide = useRef<"chat" | "automations">("chat");

	/** Sidebar "AI Search": the focused tab becomes AI Search. */
	const showAiSearch = useCallback(() => {
		finder?.showAiSearch();
		deliverToAi({});
	}, [deliverToAi, finder]);

	const selectEvidence = useCallback(
		(number: number) => {
			// A citation chip with no evidence entry must never open a different
			// result: the panel would silently show unrelated evidence.
			if (!evidenceRef.current.some((item) => item.number === number)) {
				showErrorToast(t("finderComponents.evidenceNotFound", { number }));
				return;
			}
			setSelectedEvidence(number);
			setInspectorVisible(true);
		},
		[t],
	);

	/** A source picked in the Inspector's evidence tabs: the AI Chat tab scrolls its text to where that source is cited. */
	const [evidenceJump, setEvidenceJump] = useState<{ readonly number: number; readonly nonce: number } | null>(null);
	const pickEvidenceTab = useCallback(
		(number: number) => {
			selectEvidence(number);
			setEvidenceJump((current) => ({ number, nonce: (current?.nonce ?? 0) + 1 }));
		},
		[selectEvidence],
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
			return { path: match.entry.path, name: match.entry.name, kind: match.entry.kind };
		});
	}, [focusPath, stackRows]);

	useEffect(() => {
		const request = preview === null ? autorag.preview.hide(closingRef.current) : autorag.preview.show(preview, iconRect(preview.path));
		closingRef.current = null;
		request.catch((error: unknown) => {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code === REMOTE_PREVIEW_FOLDER_CODE) showErrorToast(translate("finderComponents.remotePreviewFolderUnsupported"));
			else if (code === REMOTE_PREVIEW_UNSUPPORTED_CODE) showErrorToast(translate("finderComponents.remotePreviewUnsupported"));
			else showErrorToast(error instanceof Error ? error.message : String(error));
		});
	}, [preview]);

	// The OS takes 0.1-0.7s to draw a legacy Office page and up to 0.4s more to
	// prepare its pictures; starting when the file is selected means Space finds
	// the page ready instead of waiting for it.
	const prefetchEntry = finder?.focusedEntry ?? null;
	const prefetchPath = prefetchEntry?.kind === "file" ? prefetchEntry.path : undefined;
	const prefetchMtime = prefetchEntry?.mtimeMs;
	const prefetchSize = prefetchEntry?.size;
	useEffect(() => {
		if (prefetchPath === undefined || prefetchMtime === undefined || prefetchSize === undefined || prefetchSize === null) return;
		if (!/\.(doc|dot|ppt|pps|pot)$/i.test(prefetchPath)) return;
		autorag.preview.prefetch({ path: prefetchPath, mtimeMs: prefetchMtime, size: prefetchSize });
	}, [prefetchPath, prefetchMtime, prefetchSize]);

	const moveSelectionBy = finder?.moveSelectionBy;
	const openDocumentEditor = finder?.openDocumentEditor;
	useEffect(() => {
		const offClosed = autorag.preview.onClosed(() => setPreview(null));
		const offNavigate = autorag.preview.onNavigate((delta) => moveSelectionBy?.(delta));
		const offOpenEdit = autorag.preview.onOpenEdit?.((filePath) => {
			setPreview(null);
			openDocumentEditor?.(filePath);
		});
		return () => {
			offClosed();
			offNavigate();
			offOpenEdit?.();
		};
	}, [moveSelectionBy, openDocumentEditor]);

	useEffect(() => {
		const applySettings = (settings: AppSettings): void => {
			setShowHiddenFiles(settings.showHiddenFiles);
			setLanguage(settings.language);
			setSidebarSettings(settings.sidebar);
			setContextMenuSettings(settings.contextMenu);
			setShortcutSettings(settings.shortcuts);
			setAutomationNames(settings.automationNames ?? {});
			void setAppLanguage(settings.language);
		};
		void autorag.settings.get().then(applySettings);
		return autorag.settings.onChanged?.(applySettings);
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
	const automationsTabActive = path === AUTOMATIONS_PATH;
	/** While the focused tab is Settings it takes over the window: its own sidebar, no tab strip or toolbar. */
	const settingsOpen = path === SETTINGS_PATH;
	settingsOpenRef.current = settingsOpen;
	/** On a customizable Settings section the right sidebar is that section's AI assistant instead of the Inspector. */
	const { host: settingsAssistant, dock: settingsAssistantDock } = useSettingsAssistantHost({
		rightSidebarVisible: inspectorVisible,
		setRightSidebarVisible: setInspectorVisible,
		settingsFocused: path === SETTINGS_PATH,
	});
	const fileMenuOpen = finder?.contextMenu?.onEntry === true;
	const settingsTabActive = path === SETTINGS_PATH;
	const tutorialTriggers = useMemo(
		() => ({ automations: automationsTabActive, fileMenu: fileMenuOpen, settings: settingsTabActive }),
		[automationsTabActive, fileMenuOpen, settingsTabActive],
	);
	const { view: automationsView, store: automationsStore } = useAutomations();
	/** The row selected, else (in a folder some rule watches) the folder itself, so its rules show with nothing selected. */
	const inspectorEntry = inspectorEntryFor({
		focused,
		selectedCount: finder?.selection.keys.length ?? 0,
		searching: finder?.searching ?? false,
		path,
		rules: automationsView.state.rules,
	});
	/**
	 * The inspector's AI chat, one per folder tab (state/inspector-chat.ts). It is an ordinary AI Search chat: the same
	 * history keeps it, and ⤢ opens it in an AI Search tab.
	 */
	const inspectorChats = useInspectorChats(language);
	const { refresh: refreshInspectorChat, prune: pruneInspectorChats } = inspectorChats;
	// The 자동화 tab has a chat of its own, apart from the one the same tab had while it showed a folder: its key is the
	// tab's id mirrored below zero (-id - 1), so a folder's conversation never shows beside the automations, or back.
	const chatTabId = focusedTab === null || focusedTab.path === AI_SEARCH_PATH ? null : focusedTab.path === AUTOMATIONS_PATH ? -focusedTab.id - 1 : focusedTab.id;
	const chatNow = useNow(chatTabId !== null && inspectorVisible, 30_000);
	const chatTab = chatTabId === null ? EMPTY_INSPECTOR_CHAT_TAB : inspectorChats.tab(chatTabId);
	/** One inspector run at a time across the window; this tab's chat is the one streaming. */
	const chatRunning = inspectorChats.runningTab !== null;
	const chatLive = chatTabId !== null && inspectorChats.runningTab === chatTabId;
	/** What the agent of this tab's running chat waits on (an `ask_user` question or a file-change approval), if anything. */
	const interactionQueue = useInteractionQueue();
	const chatRequest = chatLive && inspectorChats.runSearchId !== null ? frontRequest(interactionQueue, inspectorChats.runSearchId) : null;
	/** What a question is about: every selected item of a multi-selection, else the inspector's one entry. */
	const selectedForChat = (finder?.selectedEntries.length ?? 0) > 1 ? (finder?.selectedEntries ?? []) : inspectorEntry === null ? [] : [inspectorEntry];
	const chatTargets: readonly ChatAttachment[] = selectedForChat.map((entry) => ({
		kind: entry.kind === "folder" ? "folder" : "file",
		id: entry.path,
		name: entry.name,
	}));
	const chatPending = pendingAttachments(chatTab, chatTargets);
	/**
	 * The folder the tab shows, told to the agent as a hint when a question is asked with nothing selected. Not for a
	 * search result list or another virtual listing (no folder is being looked at), and never an app tab.
	 */
	const viewingFolder = chatTargets.length === 0 && finder !== undefined && !finder.searching && isFilesystemPath(path) && !isVirtualListing(path) ? path : undefined;
	/**
	 * A multi-selection's index button: shown when every selected item can be toggled. Like the single file's button, an
	 * item whose status has not arrived counts as a toggleable file in the index.
	 */
	const selectionIndexStates = (finder?.selectedEntries.length ?? 0) > 1
		? (finder?.selectedEntries ?? []).map((entry) => {
				const status = finder?.indexStatusFor(entry.path) ?? null;
				return status === null ? { toggleable: entry.kind === "file", included: true } : { toggleable: status.toggleable, included: !status.excluded };
			})
		: [];
	const selectionIndex =
		selectionIndexStates.length > 0 && selectionIndexStates.every((state) => state.toggleable)
			? { included: selectionIndexStates.every((state) => state.included) }
			: null;
	const chatMode = chatTab.chat === null ? "info" : chatTab.mode;
	// A question asked in the AI Search tab showing the same chat shows here once the inspector is back on screen.
	useEffect(() => {
		if (chatTabId !== null && inspectorVisible) refreshInspectorChat(chatTabId);
	}, [chatTabId, inspectorVisible, chatMode, refreshInspectorChat]);
	useEffect(() => {
		pruneInspectorChats(tabs.flatMap((tab) => [tab.id, -tab.id - 1]));
	}, [tabs, pruneInspectorChats]);

	// The 자동화 tab's chat is the AI 에이전트's conversation, not one of its own: on the 자동화 tab the column shows the
	// chat the last AI 에이전트 tab shows, a question asked there continues it, and that AI tab shows the same chat
	// (re-read from history) the next time it comes to the front. A new chat started on either side becomes the shared one.
	const lastAiTabRef = useRef<number | null>(null);
	const sharedChatRef = useRef<string | null>(null);
	useEffect(() => {
		if (activeAiTabId === null) return;
		lastAiTabRef.current = activeAiTabId;
		const handle = aiHandlesRef.current.get(activeAiTabId);
		const shared = sharedChatRef.current;
		if (handle !== undefined && shared !== null && handle.currentChatId() !== shared) deliverToAi({ chat: shared }, activeAiTabId);
		else if (handle !== undefined && shared !== null) handle.openChat(shared);
		sharedChatRef.current = null;
	}, [activeAiTabId, deliverToAi]);
	const automationsChatKey = automationsTabActive && chatTabId !== null && chatTabId < 0 ? chatTabId : null;
	useEffect(() => {
		if (automationsChatKey === null || !inspectorVisible) return;
		// A chat this column moved on to that the AI tab has not taken yet stays; otherwise follow the AI tab's.
		if (sharedChatRef.current !== null) return;
		const lastAi = lastAiTabRef.current;
		const aiChat = lastAi === null ? null : (aiHandlesRef.current.get(lastAi)?.currentChatId() ?? null);
		if (aiChat !== null && inspectorChats.tab(automationsChatKey).chat?.chatId !== aiChat) inspectorChats.open(automationsChatKey, aiChat);
	}, [automationsChatKey, inspectorVisible]);
	const automationsChatId = automationsChatKey === null ? null : (chatTab.chat?.chatId ?? null);
	useEffect(() => {
		if (automationsChatId !== null) sharedChatRef.current = automationsChatId;
	}, [automationsChatId, chatTab.chat?.updatedAt]);
	const openChatInAiTab = useCallback(
		(chatId: string) => {
			finder?.openAiSearch();
			deliverToAi({ chat: chatId });
		},
		[deliverToAi, finder],
	);
	const openAiHistory = useCallback(() => {
		finder?.openAiSearch();
		deliverToAi({ history: true });
	}, [deliverToAi, finder]);
	/** Inspector action bar: open, share, and edits run on the focused row; a multi-selection's Compress packs every selected row. */
	const runInspectorAction = useCallback(
		(target: FileActionTarget, anchor: ActionAnchor | null) => {
			if ((finder?.selectedEntries.length ?? 0) > 1) finder?.runSelectionAction(target, anchor);
			else if (inspectorEntry !== null) finder?.runEntryAction(inspectorEntry, target, anchor);
		},
		[finder, inspectorEntry],
	);
	/** Edit and add leave the list for a new AI Search tab whose composer holds a draft: nothing is sent for the person. */
	const openAiDraft = useCallback(
		(draft: string): number => {
			// A new tab takes the next id of the window's counter: the draft goes there, not to another AI Search that is open.
			const opened = workspaceRef.current.nextTabId;
			finder?.openAiSearch();
			deliverToAi({ draft }, opened);
			return opened;
		},
		[deliverToAi, finder],
	);
	const runTutorialEffect = useCallback(
		async (effect: TutorialEffect, facts: TutorialFacts): Promise<TutorialFacts | null> => {
			try {
				switch (effect) {
					case "showNewRightClick": {
						finder?.showAutomations();
						// 추가하기 saves the action a moment after the click: find the one the recommendation made, by its task.
						const task = translate("automations.templates.summary.task").trim();
						for (let attempt = 0; attempt < 20; attempt += 1) {
							const added = (await autorag.settings.get()).contextMenu.magicActions.find((action) => action.execution.kind === "agent" && action.execution.prompt.trim() === task);
							if (added !== undefined) return { action: added.id };
							await new Promise((resolve) => setTimeout(resolve, 250));
						}
						return null;
					}
					case "openSample": {
						const { sample } = await autorag.demo.prepareSample();
						finder?.closeContextMenu();
						finder?.openFolder(dirname(sample));
						return { sample };
					}
					case "backToAutomations":
						dismissMagicActionDialog();
						finder?.closeContextMenu();
						finder?.showAutomations();
						return {};
					case "showAutomations":
						finder?.showAutomations();
						return {};
					case "createMagicAction": {
						const { sample } = await autorag.demo.prepareMagicAction();
						finder?.closeContextMenu();
						finder?.openFolder(dirname(sample));
						return { sample };
					}
					case "openContextMenuSettings":
						dismissMagicActionDialog();
						finder?.closeContextMenu();
						requestSettingsCategory("contextMenu");
						finder?.openSettings();
						return {};
					case "showRemoteSettings":
						requestSettingsCategory("remote");
						return {};
				}
			} catch (error) {
				setToast(error instanceof Error ? error.message : String(error));
				return null;
			}
		},
		[finder, openAiDraft],
	);
	const automations = useAutomationsShell({
		store: automationsStore,
		view: automationsView,
		active: automationsTabActive,
		openAiDraft,
		openFolder: (folder) => finder?.openFolder(folder),
		showInList: () => finder?.showAutomations(),
		onError: showErrorToast,
		names: automationNames,
		autoStartService: true,
		showChat: () => {
			agentSide.current = "chat";
			finder?.showAiSearch();
		},
		// The column opens (or stays open) and starts a rule: 새 자동화 만들기, the reply, and an empty card, each press anew.
		talk: () => {
			setInspectorVisible(true);
			setAutomationStarter(Date.now());
		},
		renameRule: async (id, name) => {
			const next: Record<string, string> = { ...ruleNamesNow() };
			if (name.trim().length === 0) delete next[id];
			else next[id] = name.trim();
			setAutomationNames(next);
			await autorag.settings.set({ automationNames: next });
		},
	});
	const editedDocPath = editorFilePathOf(path);
	const toolbarTitle =
		path === SETTINGS_PATH
			? t("settings.title")
			: automationsTabActive || aiTabActive
				? t("places.aiSearch")
				: editedDocPath !== null
					? basename(editedDocPath)
					: finder?.searching === true
						? t("finderComponents.searchToolbarTitle")
						: finder?.inTrashLocation === true
							? t("places.trash")
							: isTagPath(path) ? tagNameOf(path) : basename(path);
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
	/** A pinned Favorites row's right-click menu (사이드바에서 제거). */
	const sidebarRowMenu = useSidebarRowMenu((id) => finder?.sidebarPins.unpin(id));
	/** Window grid: left sidebar, the content column (toolbar over the workspace), right sidebar (the inspector). */
	const columns = windowColumns({ sidebarVisible, sidebarWidth, inspectorVisible, inspectorWidth, settingsOpen });
	const canCloseTabs = canCloseWorkspaceTab(workspace);
	const split = workspace.panes.length > 1;

	return (
		<TagCatalogContext value={tagCatalog}>
		<SidebarSettingsContext value={sidebarSettings}>
		<ContextMenuSettingsContext value={contextMenuSettings}>
		<ShortcutSettingsContext value={shortcutSettings}>
		<AutomationsContext value={automations}>
		<SettingsAssistantContext value={settingsAssistant}>
		<DocumentEditorSidebarProvider onOpenRightSidebar={() => setInspectorVisible(true)}>
		<div className="desk flex h-full bg-window">
			<div
				className="window relative grid flex-1 min-w-0 bg-window overflow-hidden"
				style={{ gridTemplateColumns: columns, gridTemplateRows: "minmax(0, 1fr)" }}
				inert={firstRunCovered}
			>
				<div className="min-w-0 min-h-0 overflow-hidden" style={settingsOpen ? HIDDEN_STYLE : undefined} inert={!sidebarVisible} aria-hidden={!sidebarVisible}><div className="h-full" style={{ width: sidebarWidth }}><Sidebar
						groups={finder?.navGroups ?? []}
						activePath={aiTabActive || automationsTabActive ? AI_SEARCH_PATH : (finder?.activeNavPath ?? null)}
						settingsActive={path === SETTINGS_PATH}
						showHotkeys={SHOW_HOTKEYS}
						onNavigate={(item) => (item.view === "aiSearch" ? (agentSide.current === "automations" ? finder?.showAutomations() : showAiSearch()) : item.view === "automations" ? finder?.showAutomations() : finder?.navigateNav(item))}
						onEject={(item) => finder?.ejectNav(item)}
						onOpenSettings={() => finder?.openSettings()}
						onOpenUsage={() => {
							requestSettingsCategory("plan");
							finder?.openSettings();
						}}
						onHideSidebar={() => setSidebarVisible(false)}
						onOpenIndexing={() => {
							requestSettingsCategory("indexing");
							finder?.openSettings();
						}}
						onOpenAiSettings={() => {
							requestSettingsCategory("ai");
							finder?.openSettings();
						}}
						onOpenSettingsPage={(category) => {
							requestSettingsCategory(category);
							finder?.openSettings();
						}}
						sourceStatus={sourceStatus}
						searchQuery={finder?.query ?? ""}
						searchRef={finder?.searchRef ?? NO_INPUT}
						searchFocused={finder?.searchFocused ?? false}
						onSearchFocus={() => finder?.setSearchFocused(true)}
						onSearchBlur={() => finder?.setSearchFocused(false)}
						onSubmitSearch={submitSidebarSearch}
						aiSearchDrop={aiSearchDrop}
						tagColorsDenied={tagCatalog.catalog.colorsDenied}
						onGrantTagColors={grantTagColors}
						favorites={
							finder === undefined
								? undefined
								: {
										shownIds: finder.sidebarPins.shownIds,
										onPin: finder.sidebarPins.pin,
										onMove: finder.sidebarPins.move,
										onRowMenu: sidebarRowMenu.open,
										pathForFile: autorag.pathForFile,
									}
						}
					/></div></div>
				{settingsOpen ? (
					<div className="flex min-w-0 min-h-0" style={{ gridColumn: "1 / span 2", gridRow: 1 }}>
						<SettingsView
							onSettingsChanged={onSettingsChanged}
							navWidth={sidebarWidth}
							onBack={() => setWorkspace((current) => closeSettingsInWorkspace(current))}
							inspectorHidden={!inspectorVisible}
							onShowInspector={() => setInspectorVisible(true)}
							sidebarHidden={!sidebarVisible}
							onHideSidebar={() => setSidebarVisible(false)}
							onShowSidebar={() => setSidebarVisible(true)}
							searchRef={settingsSearchRef}
						/>
					</div>
				) : null}
				<div className="flex min-w-0 min-h-0 flex-col" style={settingsOpen ? HIDDEN_STYLE : undefined}>
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
						inspectorHidden={!inspectorVisible}
						onShowInspector={() => setInspectorVisible(true)}
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
						fileControls={!aiTabActive && !automationsTabActive}
					/>
					<div className="flex min-h-0 flex-1" style={{ "--pane-min-width": `calc((100vw - ${sidebarWidth + inspectorWidth}px) / 2)` } as CSSProperties}>
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
											className={cn("ai-host absolute flex flex-col overflow-x-hidden", motion, box === undefined && "hidden")}
											data-ai-tab={id}
											style={box === undefined ? undefined : percentPlacement(box, TAB_STRIP_PX)}
											onMouseDownCapture={() => {
												if (paneId !== undefined) setWorkspace((current) => focusPane(current, paneId));
											}}
										>
											{/* Narrower than half the workspace with both sidebars open (--pane-min-width), the chat is cut on the right instead of squeezed. */}
											<div className="flex min-h-0 flex-1 flex-col min-w-(--pane-min-width)">
											<AiSearchPanel
												ref={(handle) => {
													if (handle === null) aiHandlesRef.current.delete(id);
													else aiHandlesRef.current.set(id, handle);
												}}
												active={id === activeAiTabId}
												visible={box !== undefined}
												selectedEvidence={evidence.length === 0 ? null : evidenceSelectedNumber}
												evidenceJump={evidenceJump}
												onSelectEvidence={selectEvidence}
												onPublish={publishEvidence}
												imageActions={imageActions}
												language={language}
												onOpenSettings={(page) => {
													requestSettingsCategory(page);
													finder?.openSettings();
												}}
												onOpenSource={(alias) => {
													requestSettingsCategory(`source:${alias}`);
													finder?.openSettings();
												}}
												onShowAutomations={() => {
													agentSide.current = "automations";
													finder?.showAutomations();
												}}
											/>
											</div>
										</div>
									);
								})
							}
						/>
					</div>
				</div>
				<InspectorColumn visible={inspectorVisible} width={inspectorWidth} onHide={() => setInspectorVisible(false)} surface={settingsAssistantDock !== null || editedDocPath !== null ? "window" : "subtle"}>
						{settingsAssistantDock !== null ? (
							<SettingsAssistantSlot dock={settingsAssistantDock} />
						) : settingsOpen ? (
							// Settings pages other than 사이드바, 우클릭 메뉴 and 단축키 have no AI: the sidebar shows only the faded mark (Figma 367:8769).
							<FadedDazziMark reserveDock />
						) : automationsTabActive ? (
							<AutomationInspector
								// The 자동화 tab's sidebar is the AI chat: it asks about no file, and the agent manages automations with its own tools.
								// Empty, it still carries the chat head: the history list is there to pick a past chat from.
								chatHead={
									chatTabId === null ? undefined : (
										<InspectorChatHead standalone title={t("places.automations")} currentChatId={null} newChatDisabled onNewChat={() => undefined} onOpenChat={(chatId) => inspectorChats.open(chatTabId, chatId)} />
									)
								}
								chatDock={
									chatTabId === null ? undefined : (
										<InspectorChatDock
											tab={chatTab}
											now={chatNow}
											targets={[]}
											running={chatRunning}
											request={chatRequest}
											onAsk={(text) => inspectorChats.ask(chatTabId, text, [], true)}
											onSummarize={() => undefined}
											onStop={inspectorChats.stop}
											onResume={() => inspectorChats.setMode(chatTabId, "chat")}
											standalone
										/>
									)
								}
								chatView={
									// The 자동화 tab's chat is the whole column: once it has a conversation it shows it, whatever the file inspector's mode.
									// A rule being started shows the column's chat too, before it has a conversation.
									chatTabId === null || (chatTab.chat === null && automationStarter === null) ? null : (
										<InspectorChatView
											tab={chatTab}
											targetName={t("places.automations")}
											pending={[]}
											running={chatLive}
											request={chatRequest}
											imageActions={imageActions}
											onAsk={(text) => inspectorChats.ask(chatTabId, text, [], false)}
											onSteer={(text) => inspectorChats.steer(chatTabId, text)}
											onQueue={(text) => inspectorChats.queue(chatTabId, text)}
											onUnqueue={(index) => inspectorChats.unqueue(chatTabId, index)}
											onPostpone={(id) => inspectorChats.postpone(chatTabId, id)}
											onCancelSteer={(id) => inspectorChats.cancelSteer(chatTabId, id)}
											onSendNow={(index) => inspectorChats.sendNow(chatTabId, index)}
											onStop={inspectorChats.stop}
											onBack={() => inspectorChats.setMode(chatTabId, "info")}
											onNewChat={() => inspectorChats.reset(chatTabId)}
											onExpand={() => {
												if (chatTab.chat !== null) openChatInAiTab(chatTab.chat.chatId);
											}}
											onOpenChat={(chatId) => inspectorChats.open(chatTabId, chatId)}
											onDismiss={(id) => inspectorChats.dismiss(chatTabId, id)}
											onReveal={(target) => finder?.revealEvidence(target)}
											onPreview={(target, excerpts) => openQuickLook({ path: target, name: basename(target), anchor: excerpts })}
											newAutomation={automationStarter}
											onNewAutomationDone={() => setAutomationStarter(null)}
											standalone
										/>
									)
								}
							/>
						) : editedDocPath !== null ? (
							<DocumentEditorAiSidebar filePath={editedDocPath} />
						) : (
							<Inspector
								entry={inspectorEntry}
								entries={finder?.selectedEntries ?? []}
								indexStatus={focused !== null ? (finder?.indexStatusFor(focused.path) ?? null) : null}
								folderInView={focused === null && inspectorEntry !== null}
								onToggleIndex={(entry) => finder?.toggleIndex(entry)}
								onTrash={(entry) => finder?.trashEntry(entry)}
								onCopyPath={(entry) => finder?.copyEntryPath(entry)}
								onAskAi={(entry) => {
									if (chatTabId === null) askAi(entry);
									else {
										const target: ChatAttachment = { kind: entry.kind === "folder" ? "folder" : "file", id: entry.path, name: entry.name };
										void inspectorChats.summarize(chatTabId, [target], pendingAttachments(chatTab, [target]));
									}
								}}
								actionCapabilities={finder?.actionCapabilities ?? NO_CAPABILITIES}
								onAction={runInspectorAction}
								loadOpenWithApplications={(entry) => finder?.loadOpenWithApplications(entry) ?? Promise.resolve([])}
								family={inspectorFamily}
								onOpenMember={openMemberEntry}
								view={aiTabActive ? "evidence" : "info"}
								evidence={evidence}
								freshEvidence={freshEvidence}
								evidenceSelected={evidenceSelectedNumber}
								onSelectEvidence={pickEvidenceTab}
								onRevealPath={(target, excerpts) => {
									if (excerpts !== undefined) openQuickLook({ path: target, name: basename(target), anchor: excerpts });
									else finder?.revealEvidence(target);
								}}
								onToast={setToast}
								imageActions={imageActions}
								evidenceFolderCount={localEvidencePaths.length}
								onOpenEvidenceFolder={() => finder?.openEvidenceFolder(localEvidencePaths)}
								automations={{ rules: automationsView.state.rules, onEdit: automations.edit, onDelete: automations.askDelete, onMenu: automations.openRuleMenu }}
								selectionIndex={selectionIndex}
								onSetSelectionIndexed={(include) => finder?.setSelectionIndexed(include)}
								onTrashSelection={() => finder?.trashSelection()}
								chatDock={
									chatTabId === null ? undefined : (
										<InspectorChatDock
											tab={chatTab}
											now={chatNow}
											targets={chatTargets}
											running={chatRunning}
											request={chatRequest}
											onAsk={(text, pasted) => inspectorChats.ask(chatTabId, text, [...chatTargets, ...pasted], true, viewingFolder)}
											onSummarize={() => {
												if (chatTargets.length > 0) void inspectorChats.summarize(chatTabId, chatTargets, chatTargets, true);
											}}
											onStop={inspectorChats.stop}
											onResume={() => inspectorChats.setMode(chatTabId, "chat")}
										/>
									)
								}
								chatView={
									chatTabId === null || chatTab.chat === null || chatTab.mode !== "chat" ? null : (
										<InspectorChatView
											tab={chatTab}
											targetName={
												selectedForChat.length > 1 ? t("finder.itemsCount", { count: selectedForChat.length }) : (inspectorEntry?.name ?? basename(path))
											}
											pending={chatPending}
											running={chatLive}
											request={chatRequest}
											imageActions={imageActions}
											onAsk={(text, pasted) => inspectorChats.ask(chatTabId, text, [...chatPending, ...pasted], false, chatTargets.length === 0 ? viewingFolder : undefined)}
											onSteer={(text) => inspectorChats.steer(chatTabId, text)}
											onQueue={(text) => inspectorChats.queue(chatTabId, text)}
											onUnqueue={(index) => inspectorChats.unqueue(chatTabId, index)}
											onPostpone={(id) => inspectorChats.postpone(chatTabId, id)}
											onCancelSteer={(id) => inspectorChats.cancelSteer(chatTabId, id)}
											onSendNow={(index) => inspectorChats.sendNow(chatTabId, index)}
											onStop={inspectorChats.stop}
											onBack={() => inspectorChats.setMode(chatTabId, "info")}
											onNewChat={() => inspectorChats.reset(chatTabId)}
											onExpand={() => {
												if (chatTab.chat !== null) openChatInAiTab(chatTab.chat.chatId);
											}}
											onOpenChat={(chatId) => inspectorChats.open(chatTabId, chatId)}
											onDismiss={(id) => inspectorChats.dismiss(chatTabId, id)}
											onReveal={(target) => finder?.revealEvidence(target)}
											onPreview={(target, excerpts) => openQuickLook({ path: target, name: basename(target), anchor: excerpts })}
										/>
									)
								}
							/>
						)}
				</InspectorColumn>
				{toast === null && automations.undoToast === null ? null : (
					<Toast
						message={automations.undoToast?.message ?? toast ?? ""}
						tone={automations.undoToast === null ? (toastState?.tone ?? "ok") : automations.undoToast.busy === true ? "busy" : "ok"}
						action={
							automations.undoToast !== null
								? automations.undoToast.onUndo === null
									? undefined
									: { label: t("automations.toast.undo"), onAction: () => void automations.undoToast?.onUndo?.() }
								: toastState?.tone === "error"
									? {
											label: t("notifications.viewInCenter"),
											onAction: () => {
												setToastState(null);
												setNotificationCenterOpen(true);
											},
										}
									: undefined
						}
						onClose={() => {
							setToastState(null);
							if (automations.undoToast !== null) automations.dismissUndoToast();
						}}
					/>
				)}
				{sidebarVisible || settingsOpen ? (
					<PaneGrip
						position={{ left: sidebarWidth - 3 }}
						label={t("finderComponents.resizeSidebar")}
						onDelta={(dx) => setSidebarWidth((width) => clampWidth(width + dx, SIDEBAR_MIN, SIDEBAR_MAX))}
					/>
				) : null}
				{inspectorVisible ? (
					<PaneGrip
						position={{ right: inspectorWidth - 3 }}
						label={t("finderComponents.resizeInspector")}
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
			{finder?.convertRename == null ? null : (
				<ConvertRenameDialog
					state={finder.convertRename}
					onConvert={(keepOriginal) => finder?.confirmConvertRename(keepOriginal)}
					onCancel={() => finder?.cancelConvertRename()}
					onMinimize={() => finder?.minimizeConvertRename()}
				/>
			)}
			{finder?.reduceDialog == null ? null : (
				<ReduceSizeDialog
					state={finder.reduceDialog}
					onChangeLevel={(level) => finder.setReduceDialogLevel(level)}
					onChangeReplaceOriginal={(replaceOriginal) => finder.setReduceDialogReplaceOriginal(replaceOriginal)}
					onStart={() => finder.confirmReduceSize()}
					onCancel={() => finder.cancelReduceSize()}
					onMinimize={() => finder.minimizeReduceSize()}
				/>
			)}
			{finder?.emptyTrashConfirm === true ? (
				<ConfirmDialog
					title={t("confirm.emptyTrashTitle")}
					message={t("confirm.emptyTrashMessage")}
					confirmLabel={t("confirm.emptyTrashAction")}
					cancelLabel={t("common.cancel")}
					danger
					onConfirm={() => finder?.confirmEmptyTrash()}
					onCancel={() => finder?.cancelEmptyTrash()}
				/>
			) : null}
			{finder?.compressStop == null ? null : (
				<ConfirmDialog
					title={t("confirm.compressStopTitle")}
					message={t("confirm.compressStopMessage", { name: finder.compressStop.name })}
					confirmLabel={t("confirm.compressStopAction")}
					cancelLabel={t("confirm.compressKeep")}
					danger
					onConfirm={() => finder.confirmCompressStop()}
					onCancel={() => finder.keepCompressing()}
				/>
			)}
			{finder?.closeEvidenceFolderConfirm === true ? (
				<ConfirmDialog
					title={t("confirm.closeEvidenceFolderTitle")}
					message={t("confirm.closeEvidenceFolderMessage")}
					confirmLabel={t("confirm.closeEvidenceFolderAction")}
					cancelLabel={t("common.cancel")}
					danger
					onConfirm={() => finder?.confirmCloseEvidenceFolder()}
					onCancel={() => finder?.cancelCloseEvidenceFolder()}
				/>
			) : null}
			{automations.confirm === null ? null : (
				<ConfirmDialog
					title={t("automations.confirm.title", { title: ruleTitle(automations.confirm) })}
					message={t("automations.confirm.message")}
					confirmLabel={t("automations.confirm.action")}
					cancelLabel={t("common.cancel")}
					danger
					onConfirm={() => void automations.confirmDelete()}
					onCancel={automations.cancelDelete}
				/>
			)}
			{automations.menu === null ? null : (
				<ContextMenu cursor={automations.menu.cursor} entries={automations.menu.entries} onSelect={automations.menuSelect} onClose={automations.closeMenu} />
			)}
			{sidebarRowMenu.menu === null ? null : (
				<ContextMenu cursor={sidebarRowMenu.menu.cursor} entries={sidebarRowMenu.menu.entries} onSelect={sidebarRowMenu.select} onClose={sidebarRowMenu.close} />
			)}
			{automations.preview === null ? null : (
				<AutomationQuickLook rule={automations.preview} onClose={automations.closePreview} onEdit={automations.edit} />
			)}
			<div id="dazzi-error-fix-host">
				<ErrorFixDialog
					onOpenSettings={(page) => {
						requestSettingsCategory(page);
						finder?.openSettings();
					}}
					onOpenSource={(alias) => {
						requestSettingsCategory(`source:${alias}`);
						finder?.openSettings();
					}}
				/>
				<MagicActionDialog />
			</div>
		</div>
		{tagColorsFdaOpen ? (
			<FullDiskAccessDialog
				reason="tagColors"
				onClose={() => setTagColorsFdaOpen(false)}
				onConfirmed={() => {
					setTagColorsFdaOpen(false);
					tagCatalog.reload();
				}}
			/>
		) : null}
		{firstRun ? (
			<FirstRun
				host={firstRunHost}
				onDone={endFirstRun}
			/>
		) : null}
		<Tutorials enabled={tutorialsAllowed && !firstRun} triggers={tutorialTriggers} onEffect={runTutorialEffect} />
		</DocumentEditorSidebarProvider>
		</SettingsAssistantContext>
		</AutomationsContext>
		</ShortcutSettingsContext>
		</ContextMenuSettingsContext>
		</SidebarSettingsContext>
		</TagCatalogContext>
	);
}
