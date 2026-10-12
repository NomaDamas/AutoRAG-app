import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import type { AppSettings } from "../../../shared/settings-contract";
import type { ChatAttachment } from "../../../shared/search-contract";
import { isTagPath, RECENTS_PATH, tagNameOf } from "../../../shared/fs-contract";
import type { FinderSource } from "../data/source";
import { DirectoryDataContext, type DirectoryData } from "../hooks/useDirectoryData";
import { useFinderController, type QuickLookBridge } from "../hooks/useFinderController";
import type { ControllerStore } from "../hooks/usePaneControllers";
import { pressRow } from "../lib/row-drag";
import { attachmentsFromDrop, isAttachmentDrag, isFileTransferDrag, isFinderDrag, readDropPaths } from "../state/attachments";
import { backgroundDropDir, dropTransferOp } from "../state/file-transfer";
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
	/** The window's directory store and entry sidecar, shared by every pane. */
	readonly directoryData: DirectoryData;
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
	const finder = useFinderController(shell.source, shell.directoryData, binding, {
		showHiddenFiles,
		quickLook: shell.quickLook,
		onFocusSearch: shell.onFocusSearch,
		onFocusComposer: shell.onFocusComposer,
		onToast: shell.onToast,
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
				// A row/tile's own context menu owns the event; only the empty
				// background opens the New / Paste menu.
				if (event.target instanceof Element && event.target.closest('[role="row"], [role="option"]') !== null) return;
				event.preventDefault();
				// Recents (and the virtual tabs) have no folder to create into.
				if (dir === "" || finder.searching) return;
				finder.openBackgroundContextMenu(event, dir);
			},
			// A folder row claims its drop (`preventDefault`); anywhere else in the
			// listing — empty space or a file row — the drop lands in this folder.
			onDragOver: (event) => {
				const destination = backgroundDropDir(dir, { searching: finder.searching, claimed: event.defaultPrevented });
				if (destination === null || !isFileTransferDrag(event.dataTransfer.types)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey);
				setDropTargetPath(null);
				setDropTabId(null);
				setDropBackgroundDir((current) => (current === destination ? current : destination));
			},
			onDrop: (event) => {
				const destination = backgroundDropDir(dir, { searching: finder.searching, claimed: event.defaultPrevented });
				setDropBackgroundDir(null);
				if (destination === null) return;
				const paths = readDropPaths(event.dataTransfer, autorag.pathForFile);
				if (paths.length === 0) return;
				event.preventDefault();
				const copy = dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey) === "copy";
				finder.transferDropped(paths, destination, copy);
			},
			onDragLeave: (event) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setDropBackgroundDir((current) => (current === dir ? null : current));
			},
		}),
		[finder.searching, finder.transferDropped, finder.openBackgroundContextMenu],
	);

	// One object per drop highlight, not per render: every row and tile gets
	// it, and the controller's handlers are stable (useLatestCallback).
	const dragEntries = finder.dragEntries;
	const transferDropped = finder.transferDropped;
	const rowCallbacks = useMemo<RowCallbacks>(
		() => ({
			onClick: finder.clickRow,
			onOpen: finder.openEntry,
			onContextMenu: finder.openContextMenu,
			// Inside the window the rows are an in-app drag; past its edge, the OS's file drag.
			onPointerDown: (entry, event) => pressRow(event, { entries: () => dragEntries(entry), startNative: autorag.fs.startDrag }),
			// A folder row claims an in-app drag (the rows move into it, ⌥ copies); the
			// listing's own handler sees `defaultPrevented` and stays out.
			onDragOver: (entry, event) => {
				if (entry.kind !== "folder" || !isFileTransferDrag(event.dataTransfer.types)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey);
				setDropBackgroundDir(null);
				setDropTargetPath((current) => (current === entry.path ? current : entry.path));
			},
			onDrop: (entry, event) => {
				setDropTargetPath(null);
				setDropBackgroundDir(null);
				if (entry.kind !== "folder") return;
				const paths = readDropPaths(event.dataTransfer, autorag.pathForFile);
				if (paths.length === 0) return;
				// No stopPropagation: the window "drop" listener clears the AI panel's
				// drag overlay (and the highlights) once the transfer has started.
				event.preventDefault();
				const copy = dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey) === "copy";
				transferDropped(paths, entry.path, copy);
			},
			dropTargetPath,
			onToggleIndex: finder.toggleIndex,
			onToggleStack: finder.toggleStack,
			onToggleFolder: finder.toggleFolder,
			onRenameChange: finder.setRenameDraft,
			onRenameCommit: finder.commitRename,
			onRenameCancel: finder.cancelRename,
			onVisible: finder.noteVisible,
		}),
		[
			finder.clickRow,
			finder.openEntry,
			finder.openContextMenu,
			dragEntries,
			transferDropped,
			dropTargetPath,
			finder.toggleIndex,
			finder.toggleStack,
			finder.toggleFolder,
			finder.setRenameDraft,
			finder.commitRename,
			finder.cancelRename,
			finder.noteVisible,
		],
	);

	const focusedEntry = finder.focusedEntry;
	const familyEntries = focusedEntry !== null ? finder.familyEntriesFor(focusedEntry.path) : null;
	const variantColumn =
		familyEntries !== null && finder.layout === "columns" && familyEntries.members.length > 0
			? { count: familyEntries.members.length, rows: familyEntries.members }
			: null;
	const listingDir = finder.path === RECENTS_PATH || finder.path === SETTINGS_PATH ? "" : finder.path;

	return (
		<DirectoryDataContext value={shell.directoryData}>
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
						if (aiTab ? !isAttachmentDrag(event.dataTransfer.types) : !isFileTransferDrag(event.dataTransfer.types)) return;
						setDropBackgroundDir(null);
						event.preventDefault();
						event.dataTransfer.dropEffect = aiTab ? "copy" : dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey);
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
						const paths = readDropPaths(event.dataTransfer, autorag.pathForFile);
						if (paths.length === 0) return;
						event.preventDefault();
						const copy = dropTransferOp(isFinderDrag(event.dataTransfer.types), event.altKey) === "copy";
						finder.dropOnTab(id, paths, copy);
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
								folderName={isTagPath(finder.path) ? tagNameOf(finder.path) : basename(finder.path)}
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
								onMarqueeSelect={finder.marqueeSelect}
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
									background={backgroundDrop(listingDir)}
									dropBackground={dropBackgroundDir === finder.path}
									callbacks={rowCallbacks}
								/>
							</div>
						)}
						<PathBar
							path={finder.path}
							crumbs={breadcrumbTrail(finder.path, Number.MAX_SAFE_INTEGER)}
							selectedName={focusedEntry !== null && focusedEntry.kind === "file" ? focusedEntry.name : null}
							onNavigate={finder.navigate}
							onGoToPath={finder.goToPath}
						/>
					</>
				)}
			</section>
		</DirectoryDataContext>
	);
});
