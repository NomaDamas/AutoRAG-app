import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { PreviewBridge, QuickLookTarget } from "../../preview/shared/contract";
import type { Bounds } from "../../preview/shared/fit";
import type { SettingsBridge } from "../../shared/settings-contract";
import type { CitationEvidence } from "../../shared/search-contract";

const autorag = (window as unknown as { readonly autorag: { readonly settings: SettingsBridge; readonly preview: PreviewBridge } }).autorag;
import { AiSearchPanel } from "./components/AiSearchPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { ColumnBrowser } from "./components/ColumnBrowser";
import { ColumnHeader } from "./components/ColumnHeader";
import { FileList } from "./components/FileList";
import type { RowCallbacks } from "./components/FileRow";
import { IconGrid } from "./components/IconGrid";
import { ContextMenu } from "./components/primitives/ContextMenu";
import { Toast } from "./components/primitives/Toast";
import { Sidebar } from "./components/Sidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusBar } from "./components/StatusBar";
import { formatDevLabel, type DevLabel } from "../../shared/app-info";
import { TabStrip } from "./components/TabStrip";
import { Toolbar } from "./components/Toolbar";
import { useFinderController } from "./hooks/useFinderController";
import { useFinderSource } from "./hooks/useFinderSource";

/** The reference's `showHotkeys` prop (default true): keycaps on or off. */
const SHOW_HOTKEYS = true;

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
	const finder = useFinderController(source, {
		showHiddenFiles,
		quickLook: { onQuickLook: openQuickLook, closeQuickLook, isQuickLookOpen },
	});
	const [settingsTab, setSettingsTab] = useState<"general" | "contacts" | null>(null);
	const [evidence, setEvidence] = useState<readonly CitationEvidence[]>([]);
	const [evidenceSession, setEvidenceSession] = useState<string | null>(null);
	const [selectedEvidence, setSelectedEvidence] = useState<number | null>(null);
	const [evidenceOpen, setEvidenceOpen] = useState(true);

	const publishEvidence = useCallback((items: readonly CitationEvidence[], sessionId: string | null) => {
		setEvidence(items);
		setEvidenceSession(sessionId);
		setSelectedEvidence((current) => (current !== null && items.some((item) => item.number === current) ? current : null));
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

	return (
		<div className="desk">
			<div className="window">
				<Sidebar
					activeLabel={finder.activeNavLabel}
					showHotkeys={SHOW_HOTKEYS}
					onNavigate={finder.navigateNav}
					onOpenSettings={() => setSettingsTab("general")}
				/>
				<section className="finder" aria-label="Finder" onMouseDown={finder.focusFinder}>
					<TabStrip
						tabs={finder.tabs}
						canClose={finder.canCloseTabs}
						onSelect={finder.selectTabId}
						onClose={finder.closeTabId}
						onNewTab={finder.newTab}
					/>
					<Toolbar
						crumbs={finder.crumbs}
						canGoBack={finder.canGoBack}
						canGoForward={finder.canGoForward}
						query={finder.query}
						placeholder={finder.searchPlaceholder}
						searchFocused={finder.searchFocused}
						showHotkeys={SHOW_HOTKEYS}
						searchRef={finder.searchRef}
						viewMode={finder.viewMode}
						onViewModeChange={finder.setViewMode}
						onNavigate={finder.navigate}
						onBack={finder.back}
						onForward={finder.forward}
						onQueryChange={finder.setQuery}
						onSearchKeyDown={finder.onSearchKeyDown}
						onSearchFocus={() => finder.setSearchFocused(true)}
						onSearchBlur={() => finder.setSearchFocused(false)}
					/>
					{finder.layout === "icons" ? (
						<IconGrid
							rows={finder.stackRows}
							listRef={finder.listRef}
							searching={finder.searching}
							summary={finder.searchSummary}
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
							columnCallbacks={{ onClick: finder.clickColumnRow }}
							callbacks={rowCallbacks}
						/>
					) : (
						<>
							<ColumnHeader sort={finder.sort} searching={finder.searching} onSort={finder.sortBy} />
							<FileList
								rows={finder.stackRows}
								listPath={finder.path}
								versionFamilyError={finder.versionFamilyError}
								onRetryVersionFamilies={finder.retryVersionFamilies}
								listRef={finder.listRef}
								searching={finder.searching}
								summary={finder.searchSummary}
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
					<StatusBar text={finder.statusText} showHotkeys={SHOW_HOTKEYS} devLabel={DEV_LABEL} />
					{evidence.length === 0 ? null : (
						<EvidencePanel
							evidence={evidence}
							sessionId={evidenceSession}
							selected={evidenceSelectedNumber}
							open={evidenceOpen}
							onToggleOpen={() => setEvidenceOpen((open) => !open)}
							onSelect={(number) => {
								setSelectedEvidence(number);
								setEvidenceOpen(true);
							}}
							onQuickLook={finder.quickLookPath}
							onReveal={finder.revealEvidence}
							onToast={finder.showToast}
						/>
					)}
				</section>
				<AiSearchPanel selectedEvidence={evidence.length === 0 ? null : evidenceSelectedNumber} onSelectEvidence={(number) => { setSelectedEvidence(number); setEvidenceOpen(true); }} onPublish={publishEvidence} />
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
			{settingsTab === null ? null : (
				<SettingsPanel
					initialTab={settingsTab}
					onClose={() => setSettingsTab(null)}
					onSettingsChanged={(settings) => setShowHiddenFiles(settings.showHiddenFiles)}
				/>
			)}
		</div>
	);
}
