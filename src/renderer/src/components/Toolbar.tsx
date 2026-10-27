import { useState, type MouseEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ActionAnchor } from "../../../shared/actions-contract";
import type { GroupKey } from "../state/grouping";
import type { ViewMode } from "../state/view-mode";
import type { SortDirection, SortKey, SortState } from "../state/sort";
import { anchorOf } from "../lib/anchor";
import { formatShortcut, hostPlatform } from "../lib/shortcuts";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ColumnsViewIcon,
	GroupIcon,
	IconsViewIcon,
	InfoIcon,
	ListRowsIcon,
	PanelLeftIcon,
	ShareIcon,
	SortIcon,
	PutBackIcon,
	EmptyTrashIcon,
} from "./icons";
import { ToolbarMenu } from "./ToolbarMenu";

const VIEW_OPTIONS: readonly { readonly mode: ViewMode; readonly key: string; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", key: "1", Icon: IconsViewIcon },
	{ mode: "list", key: "2", Icon: ListRowsIcon },
	{ mode: "columns", key: "3", Icon: ColumnsViewIcon },
];

const NAV_BUTTON =
	"flex flex-none items-center justify-center size-toolbar-icon p-0 border-0 rounded-6 bg-transparent text-ink-body transition-[background,color] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-ink-faint disabled:cursor-default";

/**
 * Toolbar (v7 handoff): back/forward, the folder title, the view segmented
 * control, the Sort and Group pop-ups (issue #47), and the top-right cluster —
 * Put Back and 휴지통 비우기 while the folder is the Trash (issue #86), the
 * inspector toggle, and Share (the OS share sheet for the
 * focused row; hidden where the platform has none). Instant search lives in
 * the sidebar now (`SidebarSearch`), so this bar holds no search field.
 */
export function Toolbar({
	title,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
	viewMode,
	onViewModeChange,
	sort,
	grouping,
	onApplySort,
	onSetGrouping,
	inspectorVisible,
	onToggleInspector,
	shareAvailable,
	canShare,
	onShare,
	trashActive,
	canPutBack,
	onPutBack,
	onEmptyTrash,
	sidebarHidden,
	onShowSidebar,
}: {
	readonly title: string;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly onBack: () => void;
	readonly onForward: () => void;
	readonly viewMode: ViewMode;
	readonly onViewModeChange: (mode: ViewMode) => void;
	/** The active sort the Sort menu stays in sync with (shared with the list column headers). */
	readonly sort: SortState | null;
	/** The active grouping criterion the Group menu shows. */
	readonly grouping: GroupKey;
	readonly onApplySort: (key: SortKey, direction: SortDirection) => void;
	readonly onSetGrouping: (key: GroupKey) => void;
	readonly inspectorVisible: boolean;
	readonly onToggleInspector: () => void;
	/** The OS has a share sheet, so the Share item is shown at all. */
	readonly shareAvailable: boolean;
	/** A row is focused, so the shown Share item is enabled. */
	readonly canShare: boolean;
	/** Open the OS share sheet for the focused row, anchored to the button. */
	readonly onShare: (anchor: ActionAnchor) => void;
	/** The folder in view is the Trash, so the Trash controls are shown. */
	readonly trashActive: boolean;
	/** A trashed row is selected, so the shown Put Back is enabled. */
	readonly canPutBack: boolean;
	/** Put the selected rows back where they came from. */
	readonly onPutBack: () => void;
	/** Open the destructive confirm for emptying the Trash. */
	readonly onEmptyTrash: () => void;
	readonly sidebarHidden: boolean;
	readonly onShowSidebar: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const viewLabel = (mode: ViewMode): string => {
		switch (mode) {
			case "icons": return t("toolbar.viewIcons");
			case "list": return t("toolbar.viewList");
			case "columns": return t("toolbar.viewColumns");
		}
	};
	const [menu, setMenu] = useState<{
		readonly kind: "sort" | "group";
		readonly x: number;
		readonly y: number;
		readonly trigger: HTMLButtonElement;
	} | null>(null);

	const openMenu = (kind: "sort" | "group", event: MouseEvent<HTMLButtonElement>): void => {
		// Read the button now: React runs this updater after the handler returns (for every
		// open but the first), when the event's `currentTarget` has already been cleared.
		const trigger = event.currentTarget;
		const rect = trigger.getBoundingClientRect();
		setMenu((current) => (current?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom, trigger }));
	};
	return (
		<div className="toolbar flex flex-none items-center gap-6 h-toolbar pl-12 pr-[calc(12px+var(--window-controls-gutter))] bg-linear-to-b from-window to-subtle-alt border-b border-border [-webkit-app-region:drag]">
			{sidebarHidden ? (
				<>
					{hostPlatform() === "win32" ? null : <span className="w-[70px] flex-none" aria-hidden="true" />}
					<button
						type="button"
						className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
						title={t("toolbar.showSidebar")}
						aria-label={t("toolbar.showSidebar")}
						onClick={onShowSidebar}
					>
						<PanelLeftIcon size={18} />
					</button>
				</>
			) : null}
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title={t("toolbar.back")}
				aria-label={t("toolbar.back")}
				disabled={!canGoBack}
				onClick={onBack}
			>
				<ChevronLeftIcon size={18} />
			</button>
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title={t("toolbar.forward")}
				aria-label={t("toolbar.forward")}
				disabled={!canGoForward}
				onClick={onForward}
			>
				<ChevronRightIcon size={18} />
			</button>
			<strong className="toolbar-title min-w-150 overflow-hidden whitespace-nowrap text-ellipsis text-[15px] font-[650] text-ink">
				{title}
			</strong>
			<span className="toolbar-spacer flex-1" />
			<div className="seg flex flex-none items-center p-2 rounded-10 bg-subtle-alt [-webkit-app-region:no-drag]" role="group" aria-label={t("toolbar.view")}>
				{VIEW_OPTIONS.map(({ mode, key, Icon }) => (
					<button
						key={mode}
						type="button"
						className={[
							`seg__button${mode === viewMode ? " seg__button--active" : ""}`,
							"flex items-center justify-center size-toolbar-icon p-0 border-0 rounded-7 transition-[background,color] duration-(--dur-color) ease-[ease]",
							mode === viewMode ? "bg-sel-mute text-ink" : "bg-transparent text-ink-muted hover:text-ink",
						].join(" ")}
						title={t("toolbar.viewAs", { label: viewLabel(mode), shortcut: formatShortcut({ key }) })}
						aria-label={viewLabel(mode)}
						aria-pressed={mode === viewMode}
						onClick={() => onViewModeChange(mode)}
					>
						<Icon size={18} />
					</button>
				))}
			</div>
			<ToolbarControl
				label={t("toolbar.sort")}
				active={sort !== null}
				open={menu?.kind === "sort"}
				icon={<SortIcon size={14} />}
				onClick={(event) => openMenu("sort", event)}
			/>
			<ToolbarControl
				label={t("toolbar.group")}
				active={grouping !== "none"}
				open={menu?.kind === "group"}
				icon={<GroupIcon size={14} />}
				onClick={(event) => openMenu("group", event)}
			/>
			<div className="tgroup flex flex-none items-center gap-2 [-webkit-app-region:no-drag]">
				{trashActive ? (
					<>
						<button
							type="button"
							className={NAV_BUTTON}
							title={t("toolbar.putBack")}
							aria-label={t("toolbar.putBack")}
							disabled={!canPutBack}
							onClick={onPutBack}
						>
							<PutBackIcon size={18} />
						</button>
						<button
							type="button"
							className={NAV_BUTTON}
							title={t("toolbar.emptyTrash")}
							aria-label={t("toolbar.emptyTrash")}
							onClick={onEmptyTrash}
						>
							<EmptyTrashIcon size={18} />
						</button>
					</>
				) : null}
				<button
					type="button"
					className={[
						"flex flex-none items-center justify-center size-toolbar-icon p-0 border-0 rounded-6 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease]",
						inspectorVisible
							? "bg-transparent text-accent"
							: "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
					].join(" ")}
					title={inspectorVisible ? t("toolbar.hideInspector") : t("toolbar.showInspector")}
					aria-label={t("toolbar.toggleInspector")}
					aria-pressed={inspectorVisible}
					onClick={onToggleInspector}
				>
					<InfoIcon size={18} />
				</button>
				{shareAvailable ? (
					<button
						type="button"
						className={NAV_BUTTON}
						title={t("toolbar.share")}
						aria-label={t("toolbar.share")}
						disabled={!canShare}
						onClick={(event) => onShare(anchorOf(event.currentTarget))}
					>
						<ShareIcon size={18} />
					</button>
				) : null}
			</div>
			{menu === null ? null : (
				<ToolbarMenu
					kind={menu.kind}
					trigger={menu.trigger}
					anchor={{ x: menu.x, y: menu.y }}
					sort={sort}
					grouping={grouping}
					onSort={onApplySort}
					onGroup={onSetGrouping}
					onClose={() => setMenu(null)}
				/>
			)}
		</div>
	);
}

/**
 * A toolbar pop-up button (issue #47): the control glyph plus a small chevron
 * that opens the Sort/Group menu. The active state mirrors macOS Finder — the
 * control stays highlighted while a sort or grouping is applied.
 */
function ToolbarControl({
	label,
	active,
	open,
	icon,
	onClick,
}: {
	readonly label: string;
	readonly active: boolean;
	readonly open: boolean;
	readonly icon: ReactElement;
	readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
	return (
		<button
			type="button"
			className={[
				"toolbar__control flex flex-none items-center gap-3 h-[25px] px-6 border-0 rounded-7 transition-[background,color] duration-(--dur-color) ease-[ease] [-webkit-app-region:no-drag]",
				active || open ? "bg-sel-mute text-ink" : "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
			].join(" ")}
			title={label}
			aria-label={label}
			aria-haspopup="menu"
			aria-expanded={open}
			onClick={onClick}
		>
			{icon}
			<ChevronRightIcon size={10} className="rotate-90" />
		</button>
	);
}
