import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { PreviewBridge, QuickLookTarget } from "../../preview/shared/contract";
import type { Bounds } from "../../preview/shared/fit";
import type { DataSourcesSnapshot, SettingsBridge } from "../../shared/settings-contract";
import type { CitationEvidence } from "../../shared/search-contract";

const autorag = (window as unknown as { readonly autorag: { readonly settings: SettingsBridge; readonly preview: PreviewBridge } }).autorag;
import { AiSearchPanel, type AiDockHandle } from "./components/AiSearchPanel";
import { ColumnBrowser } from "./components/ColumnBrowser";
import { ColumnHeader } from "./components/ColumnHeader";
import { FileList } from "./components/FileList";
import type { RowCallbacks } from "./components/FileRow";
import { IconGrid } from "./components/IconGrid";
import { Inspector, type InspectorFamily } from "./components/Inspector";
import { PathBar } from "./components/PathBar";
import { ScopeBar } from "./components/ScopeBar";
import { ContextMenu } from "./components/primitives/ContextMenu";
import { Toast } from "./components/primitives/Toast";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import { SETTINGS_PATH } from "./state/tabs";
import { basename, breadcrumbTrail, dirname } from "./state/paths";
import {
	loadListColumns,
	resetListColumns,
	saveListColumns,
	setListColumnWidth,
	toggleListColumn,
	type ListColumnKey,
	type ListColumnsState,
} from "./state/list-columns";
import { formatDevLabel, type DevLabel } from "../../shared/app-info";
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

/** Sidebar cloud labels → live datasource rows (status dots). */
const SOURCE_LABEL_MATCH: readonly (readonly [string, RegExp])[] = [
	["Google Drive", /gdrive|google[- ]?drive/i],
	["Dropbox", /dropbox/i],
	["iCloud Drive", /icloud/i],
];

function mapSourceStatus(snapshot: DataSourcesSnapshot): Record<string, "syncing" | "error"> {
	const out: Record<string, "syncing" | "error"> = {};
	for (const [label, needle] of SOURCE_LABEL_MATCH) {
		const row = snapshot.sources.find((source) => needle.test(source.id) || needle.test(source.type));
		if (row === undefined) continue;
		if (row.status === "syncing") out[label] = "syncing";
		else if (row.status === "attention") out[label] = "error";
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

/** Unpackaged runs label the window with their clone, branch, and commit. */
const DEV_LABEL = (() => {
	const dev = (window as unknown as { readonly autorag?: { readonly dev?: DevLabel | null } }).autorag?.dev;
	return dev === undefined || dev === null ? null : formatDevLabel(dev);
})();

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
	const [listColumns, setListColumns] = useState<ListColumnsState>(loadListColumns);
	const [sourceStatus, setSourceStatus] = useState<Readonly<Record<string, "syncing" | "error">>>({});
	const aiDockRef = useRef<AiDockHandle | null>(null);

	useEffect(() => saveFlag(SIDEBAR_KEY, sidebarVisible), [sidebarVisible]);
	useEffect(() => saveFlag(INSPECTOR_KEY, inspectorVisible), [inspectorVisible]);
	useEffect(() => saveFlag(AI_OPEN_KEY, aiOpen), [aiOpen]);
	useEffect(() => saveNumber(AI_HEIGHT_KEY, aiHeight), [aiHeight]);
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
	const [evidenceOpen, setEvidenceOpen] = useState(true);

	const publishEvidence = useCallback((items: readonly CitationEvidence[], sessionId: string | null) => {
		setEvidence(items);
		setEvidenceSession(sessionId);
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
		onFocusComposer: () => {
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

	/** Inspector "AI 요약": attach the file to the composer and focus it. */
	const askAi = useCallback((entry: { readonly path: string; readonly name: string }) => {
		setAiOpen(true);
		aiDockRef.current?.attachFile({ kind: "file", id: entry.path, name: entry.name });
	}, []);

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

	const rowCallbacks: RowCallbacks = {
		onClick: finder.clickRow,
		onOpen: finder.openEntry,
		onContextMenu: finder.openContextMenu,
		onToggleIndex: finder.toggleIndex,
		onToggleStack: finder.toggleStack,
		onToggleFolder: finder.toggleFolder,
		onRenameChange: finder.setRenameDraft,
		onRenameCommit: finder.commitRename,
		onRenameCancel: finder.cancelRename,
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
	const gridColumns = `${sidebarVisible ? "var(--w-sidebar) " : ""}minmax(0,1fr)${inspectorVisible ? " var(--w-inspector)" : ""}`;

	return (
		<div className="desk flex h-full bg-window">
			<div
				className="window relative grid flex-1 min-w-0 bg-window overflow-hidden"
				style={{ gridTemplateColumns: gridColumns }}
			>
				{sidebarVisible ? (
					<Sidebar
						activeLabel={finder.activeNavLabel}
						showHotkeys={SHOW_HOTKEYS}
						onNavigate={finder.navigateNav}
						onOpenSettings={finder.openSettings}
						onHideSidebar={() => setSidebarVisible(false)}
						onNewFolder={finder.newFolder}
						sourceStatus={sourceStatus}
					/>
				) : null}
				<section className="finder flex flex-col min-w-0 min-h-0" aria-label="Finder" onMouseDown={finder.focusFinder}>
					<Toolbar
						title={toolbarTitle}
						canGoBack={finder.canGoBack}
						canGoForward={finder.canGoForward}
						onBack={finder.back}
						onForward={finder.forward}
						viewMode={finder.viewMode}
						onViewModeChange={finder.setViewMode}
						inspectorVisible={inspectorVisible}
						onToggleInspector={() => setInspectorVisible((visible) => !visible)}
						committedQuery={finder.query}
						onCommitQuery={finder.setQuery}
						onContentSearch={contentSearch}
						searchRef={finder.searchRef}
						searchFocused={finder.searchFocused}
						onSearchFocus={() => finder.setSearchFocused(true)}
						onSearchBlur={() => finder.setSearchFocused(false)}
						showHotkeys={SHOW_HOTKEYS}
						placeholder={finder.searchPlaceholder}
						sidebarHidden={!sidebarVisible}
						onShowSidebar={() => setSidebarVisible(true)}
						onNewFolder={finder.newFolder}
					/>
					<TabStrip
						tabs={finder.tabs}
						canClose={finder.canCloseTabs}
						onSelect={finder.selectTabId}
						onClose={finder.closeTabId}
						onNewTab={finder.newTab}
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
									rows={finder.stackRows}
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
									callbacks={rowCallbacks}
								/>
							) : (
								<>
									<ColumnHeader
										sort={finder.sort}
										searching={finder.searching}
										onSort={finder.sortBy}
										columns={listColumns}
										onToggleColumn={(key: ListColumnKey) => setListColumns((current) => toggleListColumn(current, key))}
										onResetColumns={() => setListColumns(resetListColumns())}
										onResizeColumn={(key: string, px: number) => setListColumns((current) => setListColumnWidth(current, key, px))}
									/>
									<FileList
										rows={finder.stackRows}
										listPath={finder.path}
										columns={listColumns}
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
										callbacks={rowCallbacks}
									/>
								</>
							)}
							<PathBar
								crumbs={breadcrumbTrail(finder.path, Number.MAX_SAFE_INTEGER)}
								selectedName={focused !== null && focused.kind === "file" ? focused.name : null}
								onNavigate={finder.navigate}
								statusText={finder.statusText}
								devLabel={DEV_LABEL}
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
						indexStatus={focused !== null ? (finder.indexStatus[focused.path] ?? null) : null}
						onToggleIndex={finder.toggleIndex}
						onTrash={finder.trashEntry}
						onCopyPath={finder.copyEntryPath}
						onQuickLook={(entry) => finder.quickLookPath(entry.path)}
						onAskAi={askAi}
						family={inspectorFamily}
						onOpenMember={openMemberEntry}
						evidence={evidence}
						evidenceVisible={evidence.length > 0 && evidenceOpen}
						evidenceSelected={evidenceSelectedNumber}
						sessionId={evidenceSession}
						onSelectEvidence={selectEvidence}
						onCloseEvidence={() => setEvidenceOpen(false)}
						onRevealPath={finder.revealEvidence}
						onQuickLookPath={finder.quickLookPath}
						onToast={finder.showToast}
					/>
				) : null}
				{finder.toast === null ? null : <Toast message={finder.toast} />}
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
