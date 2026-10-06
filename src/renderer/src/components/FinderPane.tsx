import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import type { AppSettings } from "../../../shared/settings-contract";
import type { ChatAttachment } from "../../../shared/search-contract";
import { RECENTS_PATH } from "../../../shared/fs-contract";
import type { FinderSource } from "../data/source";
import { useFinderController, type ListingSnapshot, type QuickLookBridge } from "../hooks/useFinderController";
import type { ControllerStore } from "../hooks/usePaneControllers";
import { attachmentsFromDrop, isAttachmentDrag, isFinderDrag, readFinderDragPaths, writeFinderDrag } from "../state/attachments";
import { backgroundDropDir } from "../state/file-transfer";
import { listFixedWidth, resetListColumns, setListColumnWidth, toggleListColumn, type ListColumnKey, type ListColumnsState } from "../state/list-columns";
import { basename, breadcrumbTrail } from "../state/paths";
import { AI_SEARCH_PATH, SETTINGS_PATH } from "../state/tabs";
import { focusPane, type Pane, type Workspace } from "../state/workspace";
import { ColumnBrowser } from "./ColumnBrowser";
import { ColumnHeader } from "./ColumnHeader";
import { FileList } from "./FileList";
import type { BackgroundDropHandlers, RowCallbacks } from "./FileRow";
import { IconGrid } from "./IconGrid";
import { PathBar } from "./PathBar";
import { ScopeBar } from "./ScopeBar";
import { SettingsView } from "./SettingsView";
import { TabStrip } from "./TabStrip";

const autorag = window.autorag;

/**
 * How long an in-app drag must dwell on a tab before the tab adopts itself
 * (Finder's spring-loaded folders, applied to the tab strip).
 */
const TAB_SPRING_LOAD_MS = 1500;

/**
 * Everything a pane needs from the window, as one stable object: the App
 * builds it once and its methods read the latest state, so a pane re-renders
 * only when its own props change.
 */
export interface PaneShell {
	readonly source: FinderSource;
	readonly store: ControllerStore;
	readonly listingCache: Map<number, ListingSnapshot>;
	readonly quickLook: QuickLookBridge;
	update(change: (workspace: Workspace) => Workspace): void;
	onFocusSearch(): void;
	onFocusComposer(): void;
	onToast(message: string): void;
	/** Attach to / send a query in the focused AI Search tab once it is visible. */
	deliverToAi(request: { readonly attach?: readonly ChatAttachment[]; readonly query?: string }): void;
	onSettingsChanged(settings: AppSettings): void;
	setListColumns(change: (current: ListColumnsState) => ListColumnsState): void;
	/** A strip tab started a drag: the workspace shows where it can land. */
	beginTabDrag(tabId: number, event: DragEvent<HTMLDivElement>): void;
	endTabDrag(): void;
}

export interface FinderPaneProps {
	readonly pane: Pane;
	readonly focused: boolean;
	readonly canCloseTabs: boolean;
	/** The window is split: the focused pane marks its active tab. */
	readonly split: boolean;
	readonly showHiddenFiles: boolean;
	readonly listColumns: ListColumnsState;
	readonly draggingTabId: number | null;
	readonly shell: PaneShell;
}

/**
 * One workspace pane: its tab strip, the active tab's view, and the path bar.
 * Each pane runs its own Finder controller and publishes it to the window
 * chrome, which follows the focused pane.
 */
export const FinderPane = memo(function FinderPane({
	pane,
	focused,
	canCloseTabs,
	split,
	showHiddenFiles,
	listColumns,
	draggingTabId,
	shell,
}: FinderPaneProps): ReactElement {
	const binding = useMemo(() => ({ pane, focused, canCloseTabs, update: shell.update }), [pane, focused, canCloseTabs, shell]);
	const finder = useFinderController(shell.source, binding, {
		showHiddenFiles,
		quickLook: shell.quickLook,
		onFocusSearch: shell.onFocusSearch,
		onFocusComposer: shell.onFocusComposer,
		onToast: shell.onToast,
		listingCache: shell.listingCache,
	});
	const finderRef = useRef(finder);
	finderRef.current = finder;
	useLayoutEffect(() => {
		shell.store.publish(pane.id, finder);
	});
	useLayoutEffect(() => () => shell.store.remove(pane.id, finderRef.current), [shell, pane.id]);

	const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
	const [dropTabId, setDropTabId] = useState<number | null>(null);
	const [dropBackgroundDir, setDropBackgroundDir] = useState<string | null>(null);

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
					finderRef.current.selectTabId(id);
				}, TAB_SPRING_LOAD_MS),
			};
		},
		[cancelSpringTab],
	);
	useEffect(() => cancelSpringTab, [cancelSpringTab]);

	/* A drag that leaves the app (or ends anywhere) clears the drop highlights. */
	useEffect(() => {
		const reset = (): void => {
			setDropTargetPath(null);
			setDropTabId(null);
			setDropBackgroundDir(null);
			cancelSpringTab();
		};
		window.addEventListener("dragend", reset);
		window.addEventListener("drop", reset);
		return () => {
			window.removeEventListener("dragend", reset);
			window.removeEventListener("drop", reset);
		};
	}, [cancelSpringTab]);

	const backgroundDrop = useCallback(
		(dir: string): BackgroundDropHandlers => ({
			onContextMenu: (event) => {
				event.preventDefault();
				// Recents (and the virtual tabs) have no folder to create into.
				if (dir === "" || finder.searching) return;
				finder.openBackgroundContextMenu(event, dir);
			},
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
		[finder.searching, finder.transferDropped, finder.openBackgroundContextMenu],
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
			// No stopPropagation: the window "drop" listener clears the AI panel's
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

	const focusedEntry = finder.focusedEntry;
	const familyEntries = focusedEntry !== null ? finder.familyEntriesFor(focusedEntry.path) : null;
	const variantColumn =
		familyEntries !== null && finder.layout === "columns" && familyEntries.members.length > 0
			? { count: familyEntries.members.length, rows: familyEntries.members }
			: null;
	const listingDir = finder.path === RECENTS_PATH || finder.path === SETTINGS_PATH ? "" : finder.path;

	return (
		<section
			className="finder flex h-full flex-col min-w-0 min-h-0"
			aria-label="Finder"
			data-pane-id={pane.id}
			data-focused={focused ? "true" : undefined}
			onMouseDownCapture={() => {
				shell.update((workspace) => focusPane(workspace, pane.id));
				finder.focusFinder();
			}}
		>
			<TabStrip
				tabs={finder.tabs}
				canClose={finder.canCloseTabs}
				onSelect={finder.selectTabId}
				onClose={finder.closeTabId}
				onNewTab={finder.newTab}
				dropTabId={dropTabId}
				focusMark={split && focused}
				draggingTabId={draggingTabId}
				onTabDragStart={shell.beginTabDrag}
				onTabDragEnd={shell.endTabDrag}
				onTabDragOver={(id, event) => {
					const aiTab = finder.tabs.some((tab) => tab.id === id && tab.aiSearch);
					if (aiTab ? !isAttachmentDrag(event.dataTransfer.types) : !isFinderDrag(event.dataTransfer.types)) return;
					setDropBackgroundDir(null);
					event.preventDefault();
					event.dataTransfer.dropEffect = aiTab ? "copy" : event.altKey ? "copy" : "move";
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
					if (finder.tabs.some((tab) => tab.id === id && tab.aiSearch)) {
						// An AI Search tab takes the drop as chat attachments, not a file move.
						if (!isAttachmentDrag(event.dataTransfer.types)) return;
						event.preventDefault();
						const dropped = attachmentsFromDrop(event.dataTransfer, autorag.pathForFile);
						if (dropped.length === 0) return;
						finder.selectTabId(id);
						shell.deliverToAi({ attach: dropped });
						return;
					}
					const paths = readFinderDragPaths(event.dataTransfer);
					if (paths.length === 0) return;
					event.preventDefault();
					finder.dropOnTab(id, paths, event.altKey);
				}}
			/>
			{finder.path === SETTINGS_PATH ? (
				<SettingsView onSettingsChanged={shell.onSettingsChanged} />
			) : finder.path === AI_SEARCH_PATH ? (
				// The tab's chat is mounted by the workspace over this body, so it survives moving panes.
				<div className="min-h-0 flex-1 bg-subtle-alt" />
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
							focusedZone={focused && finder.zone === "finder"}
							flashPath={finder.flashPath}
							renamePath={finder.renamePath}
							renameDraft={finder.renameDraft}
							versionFamilyError={finder.versionFamilyError}
							onRetryVersionFamilies={finder.retryVersionFamilies}
							background={backgroundDrop(listingDir)}
							dropBackground={dropBackgroundDir === finder.path}
							callbacks={rowCallbacks}
						/>
					) : finder.layout === "columns" ? (
						<ColumnBrowser
							panes={finder.columnPanes}
							listRef={finder.listRef}
							emptyText={finder.emptyText}
							selectedKeys={finder.selection.keys}
							focusedZone={focused && finder.zone === "finder"}
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
								onToggleColumn={(key: ListColumnKey) => shell.setListColumns((current) => toggleListColumn(current, key))}
								onResetColumns={() => shell.setListColumns(() => resetListColumns())}
								onResizeColumn={(key: string, px: number) => shell.setListColumns((current) => setListColumnWidth(current, key, px))}
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
								focusedZone={focused && finder.zone === "finder"}
								flashPath={finder.flashPath}
								renamePath={finder.renamePath}
								renameDraft={finder.renameDraft}
								indexStatus={finder.indexStatus}
								background={backgroundDrop(listingDir)}
								dropBackground={dropBackgroundDir === finder.path}
								callbacks={rowCallbacks}
							/>
						</div>
					)}
					<PathBar
						crumbs={breadcrumbTrail(finder.path, Number.MAX_SAFE_INTEGER)}
						selectedName={focusedEntry !== null && focusedEntry.kind === "file" ? focusedEntry.name : null}
						onNavigate={finder.navigate}
					/>
				</>
			)}
		</section>
	);
});
