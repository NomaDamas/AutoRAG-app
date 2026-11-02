/**
 * The phone shell: what a remote browser session on a phone-sized screen
 * renders instead of the desktop Finder (src/renderer/src/main.tsx picks it).
 *
 * The desktop window (sidebar · tabbed panes · inspector · right-click menu)
 * becomes four tabs and a search button, the way Files and Music arrange an
 * iPhone app:
 *
 * - 둘러보기: the sidebar as a grouped list; folders push full-screen lists.
 * - 최근 항목: Recents grouped by day.
 * - AI 검색: the desktop's AI Search panel, full screen; evidence is a sheet.
 * - 자동화: the desktop's rules list.
 * - 설정 (gear in 둘러보기): the desktop settings pages as a stack.
 *
 * Every action calls the same `FinderSource` the desktop calls, so the host
 * does the work and the desktop sees the change live. The phone only lays
 * things out and maps touch to those calls (docs/remote-access.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	ArrowDownUp,
	Bot,
	ChevronLeft,
	Clock,
	Copy,
	Download,
	Ellipsis,
	Eye,
	FileArchive,
	FilePlus,
	Files,
	FolderInput,
	FolderOpen,
	FolderPlus,
	History,
	Info,
	LayoutGrid,
	Link2,
	List,
	PackageOpen,
	Pencil,
	Plus,
	RotateCcw,
	Search,
	Settings as SettingsIcon,
	Sparkles,
	SquareCheckBig,
	SquarePen,
	Tag,
	Trash2,
	Upload,
	WandSparkles,
	Zap,
} from "lucide-react";
import type { ActionCapabilities } from "../../../shared/actions-contract";
import { NO_CAPABILITIES } from "../../../shared/actions-contract";
import type { AccountStatus } from "../../../shared/account-contract";
import type { AutomationRule } from "../../../shared/automation-contract";
import { DEFAULT_CONTEXT_MENU_SETTINGS, type ContextMenuSettings, type MagicAction } from "../../../shared/context-menu-contract";
import { RECENTS_PATH, isTagPath, tagNameOf, type FsBatchResult, type FsFileDetails } from "../../../shared/fs-contract";
import { setAppLanguage } from "../../../shared/i18n";
import { REMOTE_ROUTES } from "../../../shared/remote-contract";
import type { CitationEvidence, ChatAttachment } from "../../../shared/search-contract";
import { DEFAULT_SETTINGS, type AppSettings } from "../../../shared/settings-contract";
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettings } from "../../../shared/sidebar-contract";
import { AiSearchPanel, type AiDockHandle } from "../components/AiSearchPanel";
import { AutomationsView } from "../components/AutomationsView";
import { ErrorFixDialog } from "../components/ErrorFixDialog";
import { MagicActionDialog } from "../components/MagicActionDialog";
import { placeGroupLabel, placeItemLabel } from "../components/Sidebar";
import { PAGES, SettingsPageContent, normalizeCategory, useSettingsData, type SettingsCategory } from "../components/SettingsView";
import dazziMark from "../assets/dazzi-mark.png";
import type { FinderEntry } from "../data/entries";
import { navGroups, type NavItem } from "../data/places";
import { useFinderSource } from "../hooks/useFinderSource";
import { useAutomations } from "../hooks/useAutomations";
import { useAutomationsShell } from "../hooks/useAutomationsShell";
import { useBackgroundTasks } from "../hooks/useBackgroundTasks";
import { openErrorFixDialog, useErrorFixStore } from "../hooks/useErrorFix";
import { useIndexActivity } from "../hooks/useIndexActivity";
import { useIndexProblem } from "../hooks/useIndexProblem";
import { openMagicActionDialog, startMagicActionRun, useMagicActionStore } from "../hooks/useMagicAction";
import { cn } from "../lib/cn";
import { deliverToDock, mergeDelivery, type AiDelivery, type AiDeliveryRequest } from "../state/ai-delivery";
import { rulesWatching } from "../state/automations";
import { batchToast, formatSize, historyToast, indexToast } from "../state/format";
import { useModelDownload } from "../state/model-download";
import { basename, dirname } from "../state/paths";
import { requestSettingsCategory } from "../state/settings-navigation";
import { collectSidebarActivities } from "../state/sidebar-activity-queue";
import { sharedTags, sidebarTags, tagColorsOf, tagKey } from "../state/tags";
import { familyViewFor } from "../state/version-family";
import {
	DEFAULT_MOBILE_SORT,
	INITIAL_STACKS,
	MOBILE_SORT_KEYS,
	MOBILE_TABS,
	ancestorPaths,
	groupRecents,
	itemMenu,
	mobileListing,
	nextSort,
	popRoute,
	popToRoot,
	previewKind,
	pushRoute,
	revealStack,
	toolItems,
	type MobileRoute,
	type MobileSort,
	type MobileStacks,
	type MobileTab,
} from "./model";
import { Alert, MenuItem, MenuLabel, MenuLayer, MenuSeparator, QuickLook, type MenuAnchor } from "./overlays";
import { Cell, GlassButton, GlassText, LargeTitle, NavTitle, ProgressRing, Section } from "./parts";
import { EntryList, PlacesBody, RecentsBody, RowMeta, SearchField, tagCss, type RowActions, type RowContext } from "./screens";
import { ActivitySheet, EvidenceSheet, FolderPicker, InfoSheet, type PickerRoot } from "./sheets";
import { useMobileFiles } from "./useMobileFiles";

/* ----------------------------------------------------------- Remote URLs -- */

interface RemoteUrls {
	readonly url: (route: string, params: Record<string, string>) => string;
}

function remoteUrls(): RemoteUrls | null {
	const value: unknown = Reflect.get(window, "__autoragRemote");
	if (typeof value !== "object" || value === null) return null;
	const url: unknown = Reflect.get(value, "url");
	return typeof url === "function" ? { url: url as RemoteUrls["url"] } : null;
}

/** The browser-viewable bytes for a file: the remote preview endpoint (null outside a remote session). */
function previewUrlFor(entry: FinderEntry): string | null {
	if (previewKind(entry) === null) return null;
	return remoteUrls()?.url(REMOTE_ROUTES.preview, { path: entry.path }) ?? null;
}

/** Download every path through the remote download endpoint (the bootstrap's `fs.startDrag`). */
function download(paths: readonly string[]): void {
	window.autorag.fs.startDrag(paths);
}

type UploadFs = { readonly uploadFiles?: (folder: string, files: File[]) => Promise<{ name: string; ok: boolean }[]> };

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/* ------------------------------------------------------------- Overlays -- */

type MenuKind = "item" | "view" | "add" | "path" | "selMore";

type Overlay =
	| { readonly type: "menu"; readonly kind: MenuKind; readonly anchor: MenuAnchor; readonly entries: readonly FinderEntry[]; readonly open?: "magic" | "tools" | "tags" | undefined }
	| { readonly type: "info"; readonly entry: FinderEntry }
	| { readonly type: "picker"; readonly verb: "move" | "copy"; readonly entries: readonly FinderEntry[] }
	| { readonly type: "ql"; readonly list: readonly FinderEntry[]; readonly index: number }
	| { readonly type: "alert"; readonly kind: "rename" | "newFolder" | "emptyTrash" | "deleteRule"; readonly entry?: FinderEntry; readonly rule?: AutomationRule }
	| { readonly type: "evidence" }
	| { readonly type: "activity" };

interface ToastState {
	readonly message: string;
	readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

const MENU_WIDTH = 268;

/** A menu anchored to a button: under it when it fits, else over it; right-aligned to the screen edge. */
function anchorUnder(el: HTMLElement, frame: HTMLElement): MenuAnchor {
	const r = el.getBoundingClientRect();
	const f = frame.getBoundingClientRect();
	const right = Math.max(12, f.right - r.right);
	const below = f.bottom - r.bottom - 20;
	const above = r.top - f.top - 20;
	if (below >= 320 || below >= above) return { style: { top: r.bottom - f.top + 8, right, maxHeight: below, ["--phone-origin" as string]: "top right" } };
	return { style: { bottom: f.bottom - r.top + 8, right, maxHeight: above, ["--phone-origin" as string]: "bottom right" } };
}

/**
 * Long-press: the row lifts in place and the menu opens under it. When the
 * menu would not fit, the lifted row slides up instead (iOS never squeezes a
 * context menu).
 */
function anchorLift(row: HTMLElement, frame: HTMLElement, entry: FinderEntry, count: number, meta: ReactNode): MenuAnchor {
	const r = row.getBoundingClientRect();
	const f = frame.getBoundingClientRect();
	const liftH = 64;
	const gap = 10;
	const top = parseFloat(getComputedStyle(frame).getPropertyValue("--phone-sa-top")) || 0;
	const menuH = Math.min(560, f.height - top - 16 - liftH - gap - 24);
	let liftTop = r.top - f.top;
	if (liftTop + liftH + gap + menuH > f.height - 24) liftTop = f.height - 24 - menuH - gap - liftH;
	liftTop = Math.max(top + 16, liftTop);
	return {
		style: { top: liftTop + liftH + gap, right: 16, maxHeight: menuH, width: Math.min(MENU_WIDTH, f.width - 32), ["--phone-origin" as string]: "top right" },
		lift: { entry, top: liftTop, count, previewUrl: previewUrlFor(entry), meta },
	};
}

/* ------------------------------------------------------------- The app -- */

export function MobileApp(): ReactElement {
	const { t } = useTranslation();
	const source = useFinderSource();
	const frameRef = useRef<HTMLDivElement>(null);
	const pageRef = useRef<HTMLDivElement>(null);

	const [tab, setTab] = useState<MobileTab>("browse");
	const [stacks, setStacks] = useState<MobileStacks>(INITIAL_STACKS);
	const [motion, setMotion] = useState<"push" | "pop" | null>(null);
	const [scrolled, setScrolled] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const [toast, setToast] = useState<ToastState | null>(null);
	const [sort, setSort] = useState<MobileSort>(DEFAULT_MOBILE_SORT);
	const [grid, setGrid] = useState(false);
	const [selecting, setSelecting] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<readonly FinderEntry[] | null>(null);
	const [recents, setRecents] = useState<readonly FinderEntry[] | null>(null);
	const [flashPath, setFlashPath] = useState<string | null>(null);
	const [details, setDetails] = useState<FsFileDetails | null>(null);
	const [capabilities, setCapabilities] = useState<ActionCapabilities>(NO_CAPABILITIES);
	const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
	const [account, setAccount] = useState<AccountStatus | null>(null);
	const searchInput = useRef<HTMLInputElement>(null);

	const showToast = useCallback((message: string, action?: ToastState["action"]) => setToast({ message, action }), []);
	const showError = useCallback((message: string) => setToast({ message: t("mobile.toast.failed", { message }) }), [t]);
	useEffect(() => {
		if (toast === null) return;
		const timer = window.setTimeout(() => setToast(null), toast.action === undefined ? 2600 : 5000);
		return () => window.clearTimeout(timer);
	}, [toast]);

	const files = useMobileFiles(source, showError);

	// The interface language, hidden files, sidebar and context-menu settings follow the desktop's settings, live.
	useEffect(() => {
		const apply = (settings: AppSettings): void => {
			setAppSettings(settings);
			void setAppLanguage(settings.language);
		};
		void window.autorag.settings.get().then(apply);
		return window.autorag.settings.onChanged?.(apply);
	}, []);
	useEffect(() => {
		void source.actions.capabilities().then(setCapabilities, () => undefined);
	}, [source]);
	useEffect(() => {
		void window.autorag.account?.status().then(setAccount, () => undefined);
	}, []);

	const sidebar: SidebarSettings = appSettings.sidebar ?? DEFAULT_SIDEBAR_SETTINGS;
	const contextMenu: ContextMenuSettings = appSettings.contextMenu ?? DEFAULT_CONTEXT_MENU_SETTINGS;
	const magicActions: readonly MagicAction[] = useMemo(() => contextMenu.magicActions.filter((action) => action.enabled), [contextMenu.magicActions]);
	const groups = useMemo(() => navGroups(files.locations, sidebarTags(files.tagCatalog), sidebar), [files.locations, files.tagCatalog, sidebar]);
	const tagColors = useMemo(() => tagColorsOf(files.tagCatalog), [files.tagCatalog]);
	const machine = window.autorag.platform === "darwin" ? "Mac" : "PC";

	/* --------------------------------------------------------- Navigation -- */

	const stack = stacks[tab];
	const route = stack[stack.length - 1] ?? INITIAL_STACKS[tab][0]!;
	const folderPath = route.kind === "folder" ? route.path : route.kind === "recents" ? RECENTS_PATH : null;

	useEffect(() => {
		files.open(folderPath === RECENTS_PATH ? null : folderPath);
	}, [files.open, folderPath]);

	// Recents is its own listing so switching tabs never loses the folder on screen.
	const loadRecents = useCallback(() => {
		source.list(RECENTS_PATH).then(setRecents, (cause: unknown) => showError(messageOf(cause)));
	}, [showError, source]);
	useEffect(() => {
		if (tab === "recents") loadRecents();
	}, [loadRecents, tab]);

	const leaveSelection = useCallback(() => {
		setSelecting(false);
		setSelected(new Set());
	}, []);

	const go = useCallback((next: MobileRoute) => {
		setStacks((current) => pushRoute(current, tab, next));
		setMotion("push");
		setScrolled(false);
		leaveSelection();
	}, [leaveSelection, tab]);
	const back = useCallback(() => {
		setStacks((current) => popRoute(current, tab));
		setMotion("pop");
		setScrolled(false);
		leaveSelection();
	}, [leaveSelection, tab]);
	const switchTab = useCallback((next: MobileTab) => {
		if (next === tab) setStacks((current) => popToRoot(current, next));
		setTab(next);
		setMotion(null);
		setScrolled(false);
		setMinimized(false);
		setSearchOpen(false);
		leaveSelection();
	}, [leaveSelection, tab]);
	const revealIn = useCallback((path: string, flash?: string) => {
		setStacks((current) => ({ ...current, browse: revealStack(path, ancestorPaths(path)) }));
		setTab("browse");
		setMotion("push");
		setSearchOpen(false);
		setOverlay(null);
		leaveSelection();
		if (flash !== undefined) {
			setFlashPath(flash);
			window.setTimeout(() => setFlashPath(null), 1800);
		}
	}, [leaveSelection]);

	useEffect(() => {
		pageRef.current?.scrollTo({ top: 0 });
	}, [route, tab]);
	useEffect(() => {
		if (flashPath === null) return;
		const row = frameRef.current?.querySelector(`[data-path="${CSS.escape(flashPath)}"]`);
		row?.scrollIntoView({ block: "center" });
	}, [flashPath, files.folder]);

	/* --------------------------------------------------------------- AI -- */

	const aiRef = useRef<AiDockHandle | null>(null);
	const aiPending = useRef<AiDelivery | null>(null);
	const [aiTick, setAiTick] = useState(0);
	const [evidence, setEvidence] = useState<readonly CitationEvidence[]>([]);
	const [selectedEvidence, setSelectedEvidence] = useState<number | null>(null);
	const deliverToAi = useCallback((request: AiDeliveryRequest) => {
		aiPending.current = mergeDelivery(aiPending.current, request);
		setTab("ai");
		setOverlay(null);
		setSearchOpen(false);
		leaveSelection();
		setAiTick((value) => value + 1);
	}, [leaveSelection]);
	useEffect(() => {
		const dock = aiRef.current;
		const pending = aiPending.current;
		if (dock === null || pending === null || tab !== "ai") return;
		aiPending.current = null;
		deliverToDock(dock, pending);
	}, [aiTick, tab]);
	const attachmentsOf = (entries: readonly FinderEntry[]): ChatAttachment[] => entries.map((entry) => ({ kind: entry.kind, id: entry.path, name: entry.name }));
	const askAi = useCallback((entries: readonly FinderEntry[]) => {
		if (entries.length === 1) deliverToAi({ summarize: attachmentsOf(entries) });
		else deliverToAi({ attach: attachmentsOf(entries) });
	}, [deliverToAi]);
	const imageActions = useMemo(() => ({
		onOpenImage: (target: { readonly path: string; readonly name: string }) => {
			const entry = { name: target.name, path: target.path, kind: "file" as const, ext: target.name.split(".").pop()?.toLowerCase() ?? "", size: null, mtimeMs: 0, birthtimeMs: 0 };
			setOverlay({ type: "ql", list: [entry], index: 0 });
		},
		onOpenUrl: (target: string) => void window.open(target, "_blank", "noopener"),
	}), []);
	const evidenceNumber = evidence.find((item) => item.number === selectedEvidence)?.number ?? evidence[0]?.number ?? 1;

	// Questions and file-change approvals the agent is waiting on: the AI 검색 tab carries a red badge while another tab is shown.
	const [openRequests, setOpenRequests] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		const bridge = window.autorag.interaction;
		if (bridge === undefined) return;
		let live = true;
		void bridge.pending().then((list) => live && setOpenRequests(new Set(list.map((request) => request.id))), () => undefined);
		const offRequest = bridge.onRequest((request) => setOpenRequests((current) => new Set(current).add(request.id)));
		const offClosed = bridge.onClosed((event) => setOpenRequests((current) => {
			const next = new Set(current);
			next.delete(event.id);
			return next;
		}));
		return () => {
			live = false;
			offRequest();
			offClosed();
		};
	}, []);

	/* ------------------------------------------------------- Automations -- */

	const { view: automationsView, store: automationsStore } = useAutomations();
	const automations = useAutomationsShell({
		store: automationsStore,
		view: automationsView,
		active: tab === "automations",
		openAiDraft: (draft) => deliverToAi({ draft }),
		openFolder: (folder) => revealIn(folder),
		showInList: () => switchTab("automations"),
		onError: showError,
	});

	/* ---------------------------------------------------------- Activity -- */

	const indexActivity = useIndexActivity();
	const indexProblem = useIndexProblem();
	const errorFix = useErrorFixStore();
	const magicAction = useMagicActionStore();
	const backgroundTasks = useBackgroundTasks();
	const modelDownload = useModelDownload();
	const openSettingsPage = useCallback((category: SettingsCategory) => {
		requestSettingsCategory(category);
		setStacks((current) => ({ ...current, browse: [{ kind: "places" }, { kind: "settings" }, { kind: "settingsPage", category }] }));
		setTab("browse");
		setOverlay(null);
	}, []);
	const activities = collectSidebarActivities({
		indexActivity,
		indexProblem,
		errorFix,
		magicAction,
		backgroundTasks,
		modelDownload: modelDownload.status,
		t,
		onOpenIndexing: () => openSettingsPage("indexing"),
		onOpenErrorFix: (id) => openErrorFixDialog(id),
		onOpenMagicAction: (id) => openMagicActionDialog(id),
		onOpenAiSettings: () => openSettingsPage("ai"),
	});

	/* ------------------------------------------------------- File actions -- */

	const listing = useMemo(() => {
		if (files.folder === null || route.kind !== "folder" || files.folder.path !== route.path) return null;
		return mobileListing(files.folder.entries, sort, appSettings.showHiddenFiles);
	}, [appSettings.showHiddenFiles, files.folder, route, sort]);
	const inTrash = route.kind === "folder" && groups.some((group) => group.items.some((item) => item.kind === "trash" && item.path === route.path));

	const afterBatch = useCallback((verb: Parameters<typeof batchToast>[0], result: FsBatchResult, undoable: boolean) => {
		files.refresh();
		if (tab === "recents") loadRecents();
		const message = batchToast(verb, result);
		if (!undoable || result.ok.length === 0) {
			showToast(message);
			return;
		}
		showToast(message, {
			label: t("mobile.toast.undo"),
			run: () => {
				void source.undo().then((outcome) => {
					files.refresh();
					const text = historyToast("undo", outcome);
					if (text !== null) showToast(text);
				});
			},
		});
	}, [files, loadRecents, showToast, source, t, tab]);

	const run = useCallback(<T,>(work: Promise<T>, done: (value: T) => void) => {
		work.then(done, (cause: unknown) => showError(messageOf(cause)));
	}, [showError]);

	const trash = useCallback((entries: readonly FinderEntry[]) => {
		setOverlay(null);
		leaveSelection();
		const paths = entries.map((entry) => entry.path);
		if (inTrash) run(source.restoreFromTrash(paths), (result) => afterBatch("putBack", result, true));
		else run(source.trash(paths), (result) => afterBatch("trash", result, true));
	}, [afterBatch, inTrash, leaveSelection, run, source]);

	const moveOrCopy = useCallback((verb: "move" | "copy", entries: readonly FinderEntry[], folder: string) => {
		setOverlay(null);
		leaveSelection();
		const paths = entries.map((entry) => entry.path);
		run(verb === "move" ? source.moveInto(paths, folder) : source.copyInto(paths, folder), (result) => {
			files.refresh();
			const message = batchToast(verb, result);
			showToast(message, { label: t("mobile.toast.show"), run: () => revealIn(folder, result.ok[0]) });
		});
	}, [files, leaveSelection, revealIn, run, showToast, source, t]);

	const setIndexed = useCallback((entries: readonly FinderEntry[], included: boolean) => {
		setOverlay(null);
		run(files.setIndexed(entries, included), () => {
			const first = entries[0];
			if (first !== undefined) showToast(entries.length === 1 ? indexToast(first.name, included) : t(included ? "contextMenu.includeInIndex" : "contextMenu.excludeFromIndex"));
		});
	}, [files, run, showToast, t]);

	const toggleTag = useCallback((entries: readonly FinderEntry[], name: string) => {
		const on = sharedTags(entries.map((entry) => entry.finder)).has(tagKey(name));
		run(source.setTags(entries.map((entry) => entry.path), on ? { add: [], remove: [name] } : { add: [name], remove: [] }), () => {
			files.refresh();
			setOverlay(null);
		});
	}, [files, run, source]);

	const archive = useCallback((kind: "compress" | "extract", entries: readonly FinderEntry[]) => {
		setOverlay(null);
		leaveSelection();
		run(source.actions.run(entries.map((entry) => entry.path), { kind }), (outcome) => {
			if (outcome.output !== null) void source.recordCreated(outcome.output, kind);
			files.refresh();
			showToast(outcome.note);
		});
	}, [files, leaveSelection, run, showToast, source]);

	const open = useCallback((entry: FinderEntry, list: readonly FinderEntry[]) => {
		if (entry.kind === "folder") {
			go({ kind: "folder", path: entry.path });
			return;
		}
		const previewable = list.filter((item) => item.kind === "file");
		const index = Math.max(0, previewable.findIndex((item) => item.path === entry.path));
		void source.quickLook(entry.path);
		setOverlay({ type: "ql", list: previewable, index });
	}, [go, source]);

	const openInfo = useCallback((entry: FinderEntry) => {
		setDetails(null);
		setOverlay({ type: "info", entry });
		window.autorag.fs.details(entry.path).then(setDetails, () => undefined);
	}, []);

	const upload = useCallback((folder: string) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.addEventListener("change", () => {
			const chosen = [...(input.files ?? [])];
			const fs = window.autorag.fs as typeof window.autorag.fs & UploadFs;
			if (chosen.length === 0 || fs.uploadFiles === undefined) return;
			fs.uploadFiles(folder, chosen).then((results) => {
				files.refresh();
				const failed = results.filter((result) => !result.ok);
				const firstFailed = failed[0];
				if (firstFailed !== undefined) showToast(t("mobile.toast.uploadFailed", { name: firstFailed.name }));
				else showToast(results.length === 1 ? t("mobile.toast.uploaded", { name: results[0]?.name ?? "" }) : t("mobile.toast.uploadedMany", { count: results.length }));
			}, (cause: unknown) => showError(messageOf(cause)));
		});
		input.click();
	}, [files, showError, showToast, t]);

	/* ------------------------------------------------------------ Search -- */

	useEffect(() => {
		if (!searchOpen) return;
		const needle = query.trim();
		if (needle.length === 0) {
			setHits(null);
			return;
		}
		let live = true;
		const timer = window.setTimeout(() => {
			source.search(needle).then((result) => live && setHits(result), () => live && setHits([]));
		}, 160);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [query, searchOpen, source]);
	useEffect(() => {
		if (searchOpen) searchInput.current?.focus();
	}, [searchOpen]);

	/* ----------------------------------------------------------- Rows -- */

	const ctx: RowContext = {
		selecting,
		selected,
		tagColors,
		indexStatus: files.indexStatus,
		previewUrl: previewUrlFor,
		inTrash,
		flashPath,
		where: tab === "recents" || searchOpen ? (entry) => basename(dirname(entry.path)) || dirname(entry.path) : undefined,
	};
	const listFor = (): readonly FinderEntry[] => (searchOpen ? (hits ?? []) : tab === "recents" ? (recents ?? []) : (listing ?? []));
	const rowActions: RowActions = {
		onOpen: (entry) => open(entry, listFor()),
		onToggleSelect: (entry) => setSelected((current) => {
			const next = new Set(current);
			if (next.has(entry.path)) next.delete(entry.path);
			else next.add(entry.path);
			return next;
		}),
		onLongPress: (entry, row) => {
			if (frameRef.current === null) return;
			navigator.vibrate?.(8);
			setOverlay({ type: "menu", kind: "item", entries: [entry], anchor: anchorLift(row, frameRef.current, entry, 1, <RowMeta entry={entry} ctx={ctx} />) });
		},
		onMore: (entry, anchor) => {
			if (frameRef.current !== null) setOverlay({ type: "menu", kind: "item", entries: [entry], anchor: anchorUnder(anchor, frameRef.current) });
		},
		onTrash: (entry) => trash([entry]),
	};
	const selectedEntries = (): readonly FinderEntry[] => listFor().filter((entry) => selected.has(entry.path));
	const openMenu = (kind: MenuKind, el: HTMLElement, entries: readonly FinderEntry[] = []): void => {
		if (frameRef.current !== null) setOverlay({ type: "menu", kind, entries, anchor: anchorUnder(el, frameRef.current) });
	};

	/* ---------------------------------------------------------- Screens -- */

	const groupLabel = useCallback((label: string) => placeGroupLabel(t, label), [t]);
	const itemLabel = useCallback((item: NavItem) => placeItemLabel(t, item), [t]);
	const folderTitle = (path: string): string => {
		const place = groups.flatMap((group) => group.items).find((item) => item.path === path);
		if (place !== undefined) return itemLabel(place);
		if (isTagPath(path)) return tagNameOf(path);
		return basename(path) || path;
	};
	const pickerRoots: readonly PickerRoot[] = groups.flatMap((group) => group.items).filter((item) => item.view === undefined && item.tag === undefined && item.kind !== "trash" && item.kind !== "recents" && item.available).map((item) => ({ path: item.path, label: itemLabel(item) }));

	let nav: ReactNode = null;
	let body: ReactNode = null;
	let plain = false;
	let hosted: "ai" | "rules" | "settings" | null = null;

	const backButton = stack.length > 1 ? (
		<GlassButton label={t("mobile.back")} onClick={back}><ChevronLeft size={24} strokeWidth={2.4} /></GlassButton>
	) : null;
	const selectNav = (title: string): ReactNode => (
		<>
			<GlassText onClick={() => setSelected(new Set(selected.size === listFor().length ? [] : listFor().map((entry) => entry.path)))}>{selected.size === listFor().length && selected.size > 0 ? t("mobile.select.none") : t("mobile.select.all")}</GlassText>
			<NavTitle always title={selected.size === 0 ? title : t("mobile.select.count", { count: selected.size })} />
			<span className="phone-spacer" />
			<GlassText prominent onClick={leaveSelection}>{t("mobile.select.done")}</GlassText>
		</>
	);
	const viewButton = (
		<GlassButton label={t("mobile.view.options")} onClick={(event) => openMenu("view", event.currentTarget)}><Ellipsis size={22} strokeWidth={2.2} /></GlassButton>
	);

	if (searchOpen) {
		plain = true;
		nav = <NavTitle always title={t("mobile.tabs.search")} />;
		const needle = query.trim();
		body = (
			<>
				<LargeTitle title={t("mobile.tabs.search")} />
				{needle.length === 0 ? (
					<div className="phone-empty">{t("mobile.search.typeHint")}</div>
				) : (
					<>
						<Section>
							<Cell icon={<Sparkles size={22} strokeWidth={2} />} title={t("mobile.search.askAi", { query: needle })} subtitle={t("mobile.search.askAiHint")} tone="accent" onClick={() => deliverToAi({ query: needle })} testId="phone-ask-ai" />
						</Section>
						{hits === null ? (
							<div className="phone-empty">{t("mobile.loading")}</div>
						) : hits.length === 0 ? (
							<div className="phone-empty"><b>{t("mobile.search.none", { query: needle })}</b><span>{t("mobile.search.noneHint")}</span></div>
						) : (
							<>
								<div className="phone-group-head">{t("mobile.search.results", { machine, count: hits.length })}</div>
								<EntryList entries={hits} ctx={ctx} actions={rowActions} grid={false} />
							</>
						)}
					</>
				)}
			</>
		);
	} else if (tab === "browse" && route.kind === "places") {
		nav = (
			<>
				<span className="phone-spacer" />
				<NavTitle title={t("mobile.tabs.browse")} />
				<GlassButton label={t("mobile.settings")} onClick={() => go({ kind: "settings" })}><SettingsIcon size={21} strokeWidth={2.1} /></GlassButton>
			</>
		);
		body = (
			<>
				<LargeTitle title={t("mobile.tabs.browse")} subtitle={<><span className="phone-live-dot" />{t("mobile.connectedTo", { name: machine })}</>} />
				<PlacesBody
					groups={groups}
					groupLabel={groupLabel}
					itemLabel={itemLabel}
					collapsed={collapsed}
					onToggle={(label) => setCollapsed((current) => {
						const next = new Set(current);
						if (next.has(label)) next.delete(label);
						else next.add(label);
						return next;
					})}
					onOpen={(item) => (item.kind === "recents" ? switchTab("recents") : go({ kind: "folder", path: item.path }))}
				/>
			</>
		);
	} else if (route.kind === "folder") {
		plain = true;
		const title = folderTitle(route.path);
		const folder = files.folder?.path === route.path ? files.folder : null;
		const entries = listing ?? [];
		const totalSize = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
		nav = selecting ? selectNav(title) : (
			<>
				{backButton}
				<NavTitle title={title} />
				<span className="phone-spacer" />
				<div className="phone-ggroup phone-glass">
					{inTrash ? null : <button type="button" className="phone-gbtn" aria-label={t("mobile.add")} onClick={(event) => openMenu("add", event.currentTarget)}><Plus size={22} strokeWidth={2.2} /></button>}
					<button type="button" className="phone-gbtn" aria-label={t("mobile.view.options")} onClick={(event) => openMenu("view", event.currentTarget)}><Ellipsis size={22} strokeWidth={2.2} /></button>
				</div>
			</>
		);
		body = (
			<>
				<LargeTitle title={title} titleLabel={t("mobile.pathMenu")} onTitle={ancestorPaths(route.path).length > 0 ? (event) => openMenu("path", event.currentTarget) : undefined} subtitle={folder?.loading === false ? (totalSize > 0 ? t("mobile.itemCountSize", { count: entries.length, size: formatSize(totalSize) }) : t("mobile.itemCount", { count: entries.length })) : undefined} />
				{inTrash && entries.length > 0 ? (
					<div className="phone-chips"><button type="button" className="phone-chip" onClick={() => setOverlay({ type: "alert", kind: "emptyTrash" })}><Trash2 size={15} strokeWidth={2.2} />{t("contextMenu.emptyTrash")}</button></div>
				) : null}
				{folder === null || folder.loading ? (
					<div className="phone-empty">{t("mobile.loading")}</div>
				) : folder.error !== null ? (
					<div className="phone-empty">{t("mobile.loadFailed", { message: folder.error })}</div>
				) : entries.length === 0 ? (
					<div className="phone-empty"><b>{inTrash ? t("mobile.emptyTrash") : t("mobile.emptyFolder")}</b>{inTrash ? null : <span>{t("mobile.emptyFolderHint")}</span>}</div>
				) : (
					<>
						<EntryList entries={entries} ctx={ctx} actions={rowActions} grid={grid} />
						<div className="phone-list-foot">{t("mobile.itemCount", { count: entries.length })}</div>
					</>
				)}
			</>
		);
	} else if (route.kind === "recents") {
		plain = true;
		const groupsByDay = groupRecents(recents ?? [], Date.now());
		nav = selecting ? selectNav(t("mobile.tabs.recents")) : (
			<>
				<span className="phone-spacer" />
				<NavTitle title={t("mobile.tabs.recents")} />
				{viewButton}
			</>
		);
		body = (
			<>
				<LargeTitle title={t("mobile.tabs.recents")} />
				{recents === null ? <div className="phone-empty">{t("mobile.loading")}</div> : <RecentsBody groups={groupsByDay} ctx={ctx} actions={rowActions} grid={grid} bucketLabel={(group) => t(`mobile.recents.buckets.${group.bucket}`)} />}
			</>
		);
	} else if (route.kind === "chat") {
		hosted = "ai";
		nav = (
			<>
				<GlassButton label={t("mobile.ai.history")} onClick={() => aiRef.current?.toggleHistory()}><History size={21} strokeWidth={2.1} /></GlassButton>
				<NavTitle always title={t("mobile.tabs.ai")} />
				<span className="phone-spacer" />
				{evidence.length === 0 ? null : <GlassText onClick={() => setOverlay({ type: "evidence" })}>{t("inspector.evidence")}</GlassText>}
				<GlassButton label={t("mobile.ai.newChat")} onClick={() => aiRef.current?.newChat()}><SquarePen size={20} strokeWidth={2.1} /></GlassButton>
			</>
		);
	} else if (route.kind === "rules") {
		hosted = "rules";
		nav = (
			<>
				<span className="phone-spacer" />
				<NavTitle always title={t("mobile.tabs.automations")} />
				<GlassButton label={t("mobile.rules.add")} onClick={() => automations.props.onAdd()}><Plus size={22} strokeWidth={2.2} /></GlassButton>
			</>
		);
	} else if (route.kind === "settings") {
		nav = (
			<>
				{backButton}
				<NavTitle title={t("mobile.settingsHub.title")} />
			</>
		);
		const snapshot = account?.account ?? null;
		const pagesByGroup = PAGES.reduce<Map<string, (typeof PAGES)[number][]>>((map, page) => {
			map.set(page.groupKey, [...(map.get(page.groupKey) ?? []), page]);
			return map;
		}, new Map());
		body = (
			<>
				<LargeTitle title={t("mobile.settingsHub.title")} />
				<div className="phone-hub-conn">
					<img className="phone-acct-mark" src={dazziMark} alt="" />
					<div style={{ flex: 1, minWidth: 0 }}>
						<b>{snapshot?.email ?? t("mobile.settingsHub.signedOut")}</b>
						<small>{t("mobile.settingsHub.connection", { address: location.host, version: window.autorag.version })}</small>
					</div>
					{snapshot === null ? null : <span className="phone-plan-badge">{snapshot.plan}</span>}
				</div>
				{[...pagesByGroup.entries()].map(([groupKey, pages]) => (
					<Section key={groupKey} title={t(groupKey as (typeof PAGES)[number]["groupKey"])}>
						{pages.map((page) => {
							const Icon = page.icon;
							return <Cell key={page.id} icon={<Icon size={20} strokeWidth={2} />} title={t(page.labelKey)} onClick={() => go({ kind: "settingsPage", category: page.id })} testId="phone-settings-page" />;
						})}
					</Section>
				))}
			</>
		);
	} else if (route.kind === "settingsPage") {
		hosted = "settings";
		const page = PAGES.find((meta) => meta.id === normalizeCategory(route.category as SettingsCategory));
		nav = (
			<>
				{backButton}
				<NavTitle always title={page === undefined ? route.category.replace(/^source:/u, "") : t(page.labelKey)} />
			</>
		);
	}

	/* -------------------------------------------------------------- Menus -- */

	const menuBody = (menu: Extract<Overlay, { type: "menu" }>): ReactNode => {
		const close = (): void => setOverlay(null);
		const entries = menu.entries;
		const first = entries[0];
		const toggleOpen = (part: "magic" | "tools" | "tags"): void => setOverlay({ ...menu, open: menu.open === part ? undefined : part });
		switch (menu.kind) {
			case "item": {
				if (first === undefined) return null;
				const model = itemMenu({
					entries,
					inTrash,
					outsideFolder: tab === "recents" || searchOpen,
					allIndexed: entries.every((entry) => files.indexStatus.get(entry.path)?.kind === "included"),
					magicActions,
					archive: capabilities.archive,
					tags: files.tagCatalog.supported,
				});
				const many = entries.length > 1;
				const shared = sharedTags(entries.map((entry) => entry.finder));
				const items = model.items.map((id): ReactNode => {
					switch (id) {
						case "restore":
							return <MenuItem key={id} icon={<RotateCcw size={20} strokeWidth={2} />} label={many ? t("contextMenu.putBackCount", { count: entries.length }) : t("contextMenu.putBack")} onClick={() => trash(entries)} />;
						case "quickLook":
							return <MenuItem key={id} icon={<Eye size={20} strokeWidth={2} />} label={t("mobile.menu.quickLook")} onClick={() => open(first, listFor())} />;
						case "info":
							return <MenuItem key={id} icon={<Info size={20} strokeWidth={2} />} label={t("mobile.menu.info")} onClick={() => openInfo(first)} />;
						case "reveal":
							return <MenuItem key={id} icon={<FolderOpen size={20} strokeWidth={2} />} label={t("mobile.menu.reveal")} onClick={() => revealIn(dirname(first.path), first.path)} />;
						case "ask":
							return <MenuItem key={id} icon={<Sparkles size={20} strokeWidth={2} />} tone="accent" label={many ? t("mobile.menu.askMany", { count: entries.length }) : first.kind === "folder" ? t("mobile.menu.askFolder") : t("mobile.menu.askOne")} onClick={() => askAi(entries)} />;
						case "magic":
							return (
								<div key={id} style={{ display: "contents" }}>
									<MenuItem icon={<WandSparkles size={20} strokeWidth={2} />} label={t("mobile.menu.magic")} submenu open={menu.open === "magic"} onClick={() => toggleOpen("magic")} />
									{menu.open === "magic" ? model.magic.map((action) => (
										<MenuItem key={action.id} sub icon={action.execution.kind === "agent" ? <Bot size={18} strokeWidth={2} /> : <Zap size={18} strokeWidth={2} />} label={action.label} hint={action.execution.kind === "agent" ? t("mobile.menu.agent") : t("mobile.menu.script")} onClick={() => {
											close();
											startMagicActionRun(action, entries.map((entry) => entry.path));
											showToast(t("mobile.toast.magicStarted", { name: action.label }));
										}} />
									)) : null}
								</div>
							);
						case "tools": {
							const tools = toolItems(entries, capabilities.archive);
							return (
								<div key={id} style={{ display: "contents" }}>
									<MenuItem icon={<Zap size={20} strokeWidth={2} />} label={t("mobile.menu.tools")} hint={t("mobile.menu.toolsHint")} submenu open={menu.open === "tools"} onClick={() => toggleOpen("tools")} />
									{menu.open === "tools" ? tools.map((tool) => {
										if (tool === "compress") return <MenuItem key={tool} sub icon={<FileArchive size={18} strokeWidth={2} />} label={many ? t("contextMenu.compressCount", { count: entries.length }) : t("contextMenu.compress")} onClick={() => archive("compress", entries)} />;
										if (tool === "extract") return <MenuItem key={tool} sub icon={<PackageOpen size={18} strokeWidth={2} />} label={t("contextMenu.extract")} onClick={() => archive("extract", entries)} />;
										if (tool === "index") return <MenuItem key={tool} sub icon={<Sparkles size={18} strokeWidth={2} />} label={model.indexIncludes ? t("contextMenu.includeInIndex") : t("contextMenu.excludeFromIndex")} onClick={() => setIndexed(entries, model.indexIncludes)} />;
										return <MenuItem key={tool} sub icon={<Files size={18} strokeWidth={2} />} label={t("contextMenu.duplicate")} onClick={() => { close(); run(source.duplicate(entries.map((entry) => entry.path)), (result) => afterBatch("duplicate", result, true)); }} />;
									}) : null}
								</div>
							);
						}
						case "rename":
							return <MenuItem key={id} icon={<Pencil size={20} strokeWidth={2} />} label={t("contextMenu.rename")} onClick={() => setOverlay({ type: "alert", kind: "rename", entry: first })} />;
						case "copyPath":
							return <MenuItem key={id} icon={<Link2 size={20} strokeWidth={2} />} label={t("contextMenu.copyPath")} onClick={() => { close(); run(source.copyPaths(entries.map((entry) => entry.path)), () => showToast(t("toasts.copiedPath"))); }} />;
						case "tags":
							return (
								<div key={id} className="phone-menu-tags" role="group" aria-label={t("contextMenu.tags")}>
									{sidebarTags(files.tagCatalog).slice(0, 7).map((tag) => {
										const on = shared.has(tagKey(tag.name));
										return (
											<button key={tag.name} type="button" aria-pressed={on} aria-label={tag.name} style={{ background: tagCss(tag.color), ["--phone-tag" as string]: tagCss(tag.color) }} onClick={() => toggleTag(entries, tag.name)}>
												{on ? <Tag size={12} strokeWidth={3} /> : null}
											</button>
										);
									})}
								</div>
							);
						case "trash":
							return <MenuItem key={id} icon={<Trash2 size={20} strokeWidth={2} />} tone="danger" label={many ? t("contextMenu.moveToTrashCount", { count: entries.length }) : t("contextMenu.moveToTrash")} onClick={() => trash(entries)} />;
						default:
							return null;
					}
				});
				return (
					<>
						{model.quick ? (
							<>
								<div className="phone-menu-quick">
									<button type="button" onClick={() => setOverlay({ type: "picker", verb: "copy", entries })}><Copy size={22} strokeWidth={1.9} />{t("mobile.menu.copy")}</button>
									<button type="button" onClick={() => setOverlay({ type: "picker", verb: "move", entries })}><FolderInput size={22} strokeWidth={1.9} />{t("mobile.menu.move")}</button>
									<button type="button" onClick={() => { close(); download(entries.map((entry) => entry.path)); showToast(many ? t("mobile.toast.downloadingMany", { count: entries.length }) : t("mobile.toast.downloading", { name: first.name })); }}><Download size={22} strokeWidth={1.9} />{t("mobile.menu.download")}</button>
								</div>
								<MenuSeparator />
							</>
						) : null}
						{items}
					</>
				);
			}
			case "view": {
				return (
					<>
						<MenuItem icon={<SquareCheckBig size={20} strokeWidth={2} />} label={t("mobile.view.select")} onClick={() => { close(); setSelecting(true); }} />
						<MenuSeparator />
						<MenuItem icon={<LayoutGrid size={20} strokeWidth={2} />} label={t("mobile.view.grid")} checked={grid} onClick={() => { close(); setGrid(true); }} />
						<MenuItem icon={<List size={20} strokeWidth={2} />} label={t("mobile.view.list")} checked={!grid} onClick={() => { close(); setGrid(false); }} />
						{route.kind === "folder" ? (
							<>
								<MenuSeparator />
								<MenuLabel>{t("mobile.sort.title")}</MenuLabel>
								{MOBILE_SORT_KEYS.map((key) => (
									<MenuItem key={key} icon={<ArrowDownUp size={18} strokeWidth={2} />} checked={sort.key === key} label={t(`mobile.sort.${key}`)} hint={sort.key === key ? (sort.ascending ? "↑" : "↓") : undefined} onClick={() => setSort((current) => nextSort(current, key))} />
								))}
								<MenuSeparator />
								<MenuItem icon={<Info size={20} strokeWidth={2} />} label={t("mobile.folderInfo")} onClick={() => run(source.stat(route.path), openInfo)} />
								<MenuItem icon={<Sparkles size={20} strokeWidth={2} />} tone="accent" label={t("mobile.askFolder")} onClick={() => deliverToAi({ attach: [{ kind: "folder", id: route.path, name: folderTitle(route.path) }] })} />
							</>
						) : null}
					</>
				);
			}
			case "add": {
				if (route.kind !== "folder") return null;
				const dir = route.path;
				const create = (kind: "text" | "markdown"): void => {
					close();
					run(source.createFile(dir, kind), (made) => {
						files.refresh();
						setFlashPath(made.path);
						showToast(t("mobile.toast.created", { name: made.name }));
					});
				};
				return (
					<>
						<MenuItem icon={<FolderPlus size={20} strokeWidth={2} />} label={t("mobile.create.newFolder")} onClick={() => setOverlay({ type: "alert", kind: "newFolder" })} />
						<MenuItem icon={<FilePlus size={20} strokeWidth={2} />} label={t("mobile.create.newText")} onClick={() => create("text")} />
						<MenuItem icon={<FilePlus size={20} strokeWidth={2} />} label={t("mobile.create.newMarkdown")} onClick={() => create("markdown")} />
						<MenuSeparator />
						<MenuItem icon={<Upload size={20} strokeWidth={2} />} label={t("mobile.create.upload")} hint={t("mobile.create.uploadHint")} onClick={() => { close(); upload(dir); }} />
					</>
				);
			}
			case "path": {
				if (route.kind !== "folder") return null;
				return (
					<>
						{[...ancestorPaths(route.path)].reverse().map((path) => (
							<MenuItem key={path} icon={<FolderOpen size={20} strokeWidth={2} />} label={folderTitle(path)} onClick={() => revealIn(path)} />
						))}
					</>
				);
			}
			case "selMore":
				return (
					<>
						<MenuItem icon={<Download size={20} strokeWidth={2} />} label={t("mobile.menu.download")} onClick={() => { close(); download(entries.map((entry) => entry.path)); leaveSelection(); }} />
						<MenuItem icon={<Files size={20} strokeWidth={2} />} label={t("contextMenu.duplicate")} onClick={() => { close(); leaveSelection(); run(source.duplicate(entries.map((entry) => entry.path)), (result) => afterBatch("duplicate", result, true)); }} />
						{capabilities.archive ? <MenuItem icon={<FileArchive size={20} strokeWidth={2} />} label={t("contextMenu.compressCount", { count: entries.length })} onClick={() => archive("compress", entries)} /> : null}
						<MenuItem icon={<Sparkles size={20} strokeWidth={2} />} label={t("contextMenu.includeInIndex")} onClick={() => { leaveSelection(); setIndexed(entries, true); }} />
						<MenuItem icon={<Link2 size={20} strokeWidth={2} />} label={t("contextMenu.copyPath")} onClick={() => { close(); run(source.copyPaths(entries.map((entry) => entry.path)), () => showToast(t("toasts.copiedPath"))); }} />
					</>
				);
		}
	};

	/* ----------------------------------------------------------- Overlay -- */

	const overlayNode = ((): ReactNode => {
		if (overlay === null) return null;
		const close = (): void => setOverlay(null);
		switch (overlay.type) {
			case "menu":
				return <MenuLayer anchor={overlay.anchor} label={t("mobile.more")} onDismiss={close}>{menuBody(overlay)}</MenuLayer>;
			case "info": {
				const entry = overlay.entry;
				return (
					<InfoSheet
						entry={entry}
						details={details}
						status={files.indexStatus.get(entry.path)}
						family={familyViewFor(entry.path, files.families)}
						rules={entry.kind === "folder" ? rulesWatching(automationsView.state.rules, entry.path) : []}
						tagColors={tagColors}
						previewUrl={previewUrlFor(entry)}
						onClose={close}
						onQuickLook={() => open(entry, listFor())}
						onDownload={() => { download([entry.path]); showToast(t("mobile.toast.downloading", { name: entry.name })); }}
						onAsk={() => askAi([entry])}
						onMove={() => setOverlay({ type: "picker", verb: "move", entries: [entry] })}
						onToggleIndex={(included) => run(files.setIndexed([entry], included), () => showToast(indexToast(entry.name, included)))}
						onOpenMember={(path) => revealIn(dirname(path), path)}
						onOpenRule={() => switchTab("automations")}
					/>
				);
			}
			case "picker": {
				const start = route.kind === "folder" ? route.path : (overlay.entries[0] === undefined ? null : dirname(overlay.entries[0].path));
				return <FolderPicker source={source} roots={pickerRoots} start={start} verb={overlay.verb} count={overlay.entries.length} onClose={close} onPick={(folder) => moveOrCopy(overlay.verb, overlay.entries, folder)} onError={showError} />;
			}
			case "ql":
				return (
					<QuickLook
						entries={overlay.list}
						index={overlay.index}
						previewUrl={previewUrlFor}
						onIndex={(index) => setOverlay({ ...overlay, index })}
						onClose={close}
						onInfo={openInfo}
						onDownload={(entry) => { download([entry.path]); showToast(t("mobile.toast.downloading", { name: entry.name })); }}
						onAsk={(entry) => askAi([entry])}
						onMore={(entry, anchor) => frameRef.current !== null && setOverlay({ type: "menu", kind: "item", entries: [entry], anchor: anchorUnder(anchor, frameRef.current) })}
						onTrash={(entry) => trash([entry])}
					/>
				);
			case "alert":
				if (overlay.kind === "rename" && overlay.entry !== undefined) {
					const entry = overlay.entry;
					return (
						<Alert title={t("mobile.rename.title")} input={entry.name} selectStem={entry.kind === "file"} okLabel={t("mobile.rename.ok")} cancelLabel={t("common.cancel")} onCancel={close} onOk={(name) => {
							const next = name.trim();
							close();
							if (next.length === 0 || next === entry.name) return;
							run(source.rename(entry.path, next), () => {
								files.refresh();
								showToast(t("mobile.toast.renamed", { name: next }), { label: t("mobile.toast.undo"), run: () => void source.undo().then(() => files.refresh()) });
							});
						}} />
					);
				}
				if (overlay.kind === "newFolder" && route.kind === "folder") {
					const dir = route.path;
					return (
						<Alert title={t("mobile.newFolder.title")} input={t("mobile.newFolder.placeholder")} okLabel={t("mobile.newFolder.ok")} cancelLabel={t("common.cancel")} onCancel={close} onOk={(name) => {
							close();
							run(source.createFolder(dir), async (made) => {
								const wanted = name.trim();
								if (wanted.length > 0 && wanted !== made.name) await source.rename(made.path, wanted).catch((cause: unknown) => showError(messageOf(cause)));
								files.refresh();
								showToast(t("mobile.toast.created", { name: wanted.length > 0 ? wanted : made.name }));
							});
						}} />
					);
				}
				if (overlay.kind === "emptyTrash") {
					return (
						<Alert title={t("mobile.confirm.emptyTrash")} text={t("mobile.confirm.emptyTrashBody")} okLabel={t("mobile.confirm.emptyTrashOk")} cancelLabel={t("common.cancel")} danger onCancel={close} onOk={() => {
							close();
							run(source.emptyTrash(), () => files.refresh());
						}} />
					);
				}
				return null;
			case "evidence":
				return (
					<EvidenceSheet
						evidence={evidence}
						selected={evidenceNumber}
						onSelect={setSelectedEvidence}
						onReveal={(path, excerpts) => {
							if (excerpts !== undefined && previewKind({ kind: "file", path }) !== null) {
								const name = basename(path);
								setOverlay({ type: "ql", list: [{ name, path, kind: "file", ext: name.split(".").pop()?.toLowerCase() ?? "", size: null, mtimeMs: 0, birthtimeMs: 0 }], index: 0 });
							} else if (/^https?:/u.test(path)) window.open(path, "_blank", "noopener");
							else revealIn(dirname(path), path);
						}}
						onToast={(message) => showToast(message)}
						imageActions={imageActions}
						onClose={close}
					/>
				);
			case "activity":
				return <ActivitySheet entries={activities} onClose={close} />;
		}
	})();

	// The 자동화 rule confirm and the per-rule menu come from the shared shell.
	const ruleConfirm = automations.confirm === null ? null : (
		<Alert
			title={t("automations.confirm.title", { title: automations.confirm.id })}
			text={t("automations.confirm.message")}
			okLabel={t("automations.confirm.action")}
			cancelLabel={t("common.cancel")}
			danger
			onCancel={automations.cancelDelete}
			onOk={() => void automations.confirmDelete()}
		/>
	);

	/* ------------------------------------------------------------ Bottom -- */

	const pendingApprovals = openRequests.size;
	const primaryActivity = activities[0];
	const accessory = primaryActivity === undefined || searchOpen || selecting ? null : (
		<button type="button" className="phone-accessory phone-glass" onClick={() => setOverlay({ type: "activity" })} aria-label={t("mobile.activity.open")} data-testid="phone-accessory">
			<ProgressRing percent={primaryActivity.tone === "queued" ? 0 : primaryActivity.percent} tone={primaryActivity.tone === "error" ? "error" : undefined}>
				<Sparkles size={13} strokeWidth={2.4} />
			</ProgressRing>
			<span className="phone-acc-main">
				<b>{primaryActivity.headline}</b>
				<small>{primaryActivity.title}</small>
			</span>
			{activities.length > 1 ? <span className="phone-acc-count">+{activities.length - 1}</span> : null}
		</button>
	);
	const tabIcon = (id: MobileTab): ReactElement => {
		if (id === "browse") return <FolderOpen size={24} strokeWidth={2} />;
		if (id === "recents") return <Clock size={24} strokeWidth={2} />;
		if (id === "ai") return <Sparkles size={24} strokeWidth={2} />;
		return <Zap size={24} strokeWidth={2} />;
	};
	const selection = selectedEntries();
	const bottom = (
		<div className={cn("phone-bottom", minimized && !selecting && !searchOpen && "is-min")}>
			{toast === null ? null : (
				<div className={cn("phone-toast phone-glass", toast.action === undefined && "is-plain")} role="status">
					<span>{toast.message}</span>
					{toast.action === undefined ? null : <button type="button" onClick={() => { toast.action?.run(); setToast(null); }}>{toast.action.label}</button>}
				</div>
			)}
			{searchOpen ? (
				<SearchField value={query} onChange={setQuery} onClose={() => { setSearchOpen(false); setQuery(""); setHits(null); }} inputRef={searchInput} />
			) : selecting ? (
				<div className="phone-selbar phone-glass" role="toolbar" aria-label={t("mobile.select.title")}>
					{inTrash ? (
						<button type="button" disabled={selection.length === 0} onClick={() => trash(selection)}><RotateCcw size={22} strokeWidth={2} />{t("mobile.select.restore")}</button>
					) : (
						<>
							<button type="button" disabled={selection.length === 0} onClick={() => setOverlay({ type: "picker", verb: "move", entries: selection })}><FolderInput size={22} strokeWidth={2} />{t("mobile.select.move")}</button>
							<button type="button" disabled={selection.length === 0} onClick={() => setOverlay({ type: "picker", verb: "copy", entries: selection })}><Copy size={22} strokeWidth={2} />{t("mobile.select.copy")}</button>
							<button type="button" disabled={selection.length === 0} onClick={() => askAi(selection)}><Sparkles size={22} strokeWidth={2} />{t("mobile.select.ask")}</button>
							<button type="button" disabled={selection.length === 0} onClick={(event) => openMenu("selMore", event.currentTarget, selection)}><Ellipsis size={22} strokeWidth={2} />{t("mobile.more")}</button>
							<button type="button" className="is-danger" disabled={selection.length === 0} onClick={() => trash(selection)}><Trash2 size={22} strokeWidth={2} />{t("mobile.select.trash")}</button>
						</>
					)}
				</div>
			) : (
				<>
					{accessory}
					<div className="phone-bar-row">
						<div className="phone-tabbar phone-glass" role="tablist" aria-label={t("mobile.tabs.aria")} style={{ ["--phone-i" as string]: MOBILE_TABS.indexOf(tab) }}>
							<span className="phone-tab-lens" aria-hidden="true" />
							{MOBILE_TABS.map((id) => (
								<button key={id} type="button" role="tab" className="phone-tab" aria-selected={tab === id} onClick={() => switchTab(id)} data-testid={`phone-tab-${id}`}>
									{tabIcon(id)}
									<span>{t(`mobile.tabs.${id}`)}</span>
									{id === "ai" && tab !== "ai" && pendingApprovals > 0 ? <i className="phone-tab-badge">{pendingApprovals}</i> : null}
								</button>
							))}
						</div>
						<button type="button" className="phone-gbtn phone-glass phone-search-tab" aria-label={t("mobile.tabs.search")} onClick={() => { setSearchOpen(true); setMinimized(false); }} data-testid="phone-tab-search">
							<Search size={24} strokeWidth={2.1} />
						</button>
					</div>
				</>
			)}
		</div>
	);

	const lastScroll = useRef(0);
	return (
		<div ref={frameRef} className={cn("phone-app", plain && "is-plain", scrolled && "is-scrolled")} data-testid="mobile-app">
			{hosted === null ? (
				<div
					ref={pageRef}
					key={`${tab}:${stack.length}:${searchOpen ? "s" : ""}`}
					className={cn("phone-page", motion === "push" && "is-push", motion === "pop" && "is-pop")}
					onScroll={(event) => {
						const top = event.currentTarget.scrollTop;
						setScrolled(top > 24);
						// The tab bar shrinks while scrolling down through a long list and comes back on the way up.
						if (top > lastScroll.current + 6 && top > 120) setMinimized(true);
						else if (top < lastScroll.current - 6) setMinimized(false);
						lastScroll.current = top;
					}}
				>
					{body}
				</div>
			) : null}
			<div className={cn("phone-hosted is-ai", hosted !== "ai" && "hidden")} aria-hidden={hosted !== "ai" ? true : undefined}>
				<AiSearchPanel
					ref={aiRef}
					active={tab === "ai"}
					visible={tab === "ai"}
					selectedEvidence={evidence.length === 0 ? null : evidenceNumber}
					onSelectEvidence={setSelectedEvidence}
					onPublish={(next) => setEvidence(next)}
					imageActions={imageActions}
					language={appSettings.language}
					onOpenSettings={(page) => openSettingsPage(page)}
					onOpenSource={(alias) => openSettingsPage(`source:${alias}`)}
				/>
			</div>
			{hosted === "rules" ? (
				<div className="phone-hosted is-rules">
					<AutomationsView {...automations.props} />
				</div>
			) : null}
			{hosted === "settings" && route.kind === "settingsPage" ? (
				<HostedSettings category={route.category as SettingsCategory} onNavigate={(category) => go({ kind: "settingsPage", category })} />
			) : null}
			<div className="phone-edge-top" aria-hidden="true" />
			<nav className="phone-navbar" aria-label={t("mobile.tabs.aria")}>{nav}</nav>
			{hosted === "settings" ? null : <div className="phone-edge-bottom" aria-hidden="true" />}
			{bottom}
			{overlayNode}
			{ruleConfirm}
			<ErrorFixDialog onOpenSettings={(page) => openSettingsPage(page)} onOpenSource={(alias) => openSettingsPage(`source:${alias}`)} />
			<MagicActionDialog />
		</div>
	);
}

/** One desktop settings page in the phone frame, with its own data owner (desktop pages reconcile through it). */
function HostedSettings({ category, onNavigate }: { readonly category: SettingsCategory; readonly onNavigate: (category: SettingsCategory) => void }): ReactElement {
	const data = useSettingsData();
	return (
		<div className="phone-hosted is-settings">
			<div className="settings-view settings-panel">
				<main className="settings-content">
					<div className="settings-content-wrap">
						{data.error !== null ? <div className="settings-error" role="alert">{data.error}</div> : null}
						<SettingsPageContent data={data} category={category} onNavigate={onNavigate} />
					</div>
				</main>
			</div>
		</div>
	);
}
