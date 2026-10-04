import { useState, type MouseEvent, type ReactElement } from "react";
import type { GroupKey } from "../state/grouping";
import type { ViewMode } from "../state/view-mode";
import type { SortDirection, SortKey, SortState } from "../state/sort";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ColumnsViewIcon,
	FolderPlusIcon,
	GroupIcon,
	IconsViewIcon,
	InfoIcon,
	ListRowsIcon,
	PanelLeftIcon,
	ShareIcon,
	SparklesIcon,
	SortIcon,
} from "./icons";
import { ToolbarMenu } from "./ToolbarMenu";

const VIEW_OPTIONS: readonly { readonly mode: ViewMode; readonly label: string; readonly keycap: string; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", label: "Icons", keycap: "⌘1", Icon: IconsViewIcon },
	{ mode: "list", label: "List", keycap: "⌘2", Icon: ListRowsIcon },
	{ mode: "columns", label: "Columns", keycap: "⌘3", Icon: ColumnsViewIcon },
];

const NAV_BUTTON =
	"flex flex-none items-center justify-center size-toolbar-icon p-0 border-0 rounded-6 bg-transparent text-ink-body transition-[background,color] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-ink-faint disabled:cursor-default";

/**
 * Toolbar (v7 handoff): back/forward, the folder title, the view segmented
 * control, the Sort and Group pop-ups (issue #47), and the top-right cluster —
 * the inspector toggle, the AI Search toggle and Share. Instant search lives in
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
	aiActive,
	onShowAi,
	canShare,
	onShare,
	sidebarHidden,
	onShowSidebar,
	onNewFolder,
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
	/** The focused tab is AI Search. */
	readonly aiActive: boolean;
	/** Show the nearest AI Search tab (⌘K), or open one. */
	readonly onShowAi: () => void;
	readonly canShare: boolean;
	readonly onShare: () => void;
	readonly sidebarHidden: boolean;
	readonly onShowSidebar: () => void;
	readonly onNewFolder: () => void;
}): ReactElement {
	const [menu, setMenu] = useState<{
		readonly kind: "sort" | "group";
		readonly x: number;
		readonly y: number;
		readonly trigger: HTMLButtonElement;
	} | null>(null);

	const openMenu = (kind: "sort" | "group", event: MouseEvent<HTMLButtonElement>): void => {
		const rect = event.currentTarget.getBoundingClientRect();
		setMenu((current) => (current?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom, trigger: event.currentTarget }));
	};
	return (
		<div className="toolbar flex flex-none items-center gap-6 h-toolbar px-12 bg-linear-to-b from-window to-subtle-alt border-b border-border [-webkit-app-region:drag]">
			{sidebarHidden ? (
				<>
					<span className="w-[70px] flex-none" aria-hidden="true" />
					<button
						type="button"
						className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
						title="Show sidebar"
						aria-label="Show sidebar"
						onClick={onShowSidebar}
					>
						<PanelLeftIcon size={18} />
					</button>
					<button
						type="button"
						className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
						title="New folder"
						aria-label="New folder"
						onClick={onNewFolder}
					>
						<FolderPlusIcon size={18} />
					</button>
				</>
			) : null}
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title="Back"
				aria-label="Back"
				disabled={!canGoBack}
				onClick={onBack}
			>
				<ChevronLeftIcon size={18} />
			</button>
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title="Forward"
				aria-label="Forward"
				disabled={!canGoForward}
				onClick={onForward}
			>
				<ChevronRightIcon size={18} />
			</button>
			<strong className="toolbar-title min-w-150 overflow-hidden whitespace-nowrap text-ellipsis text-[15px] font-[650] text-ink">
				{title}
			</strong>
			<span className="toolbar-spacer flex-1" />
			<div className="seg flex flex-none items-center p-2 rounded-10 bg-subtle-alt [-webkit-app-region:no-drag]" role="group" aria-label="View">
				{VIEW_OPTIONS.map(({ mode, label, keycap, Icon }) => (
					<button
						key={mode}
						type="button"
						className={[
							`seg__button${mode === viewMode ? " seg__button--active" : ""}`,
							"flex items-center justify-center size-toolbar-icon p-0 border-0 rounded-7 transition-[background,color] duration-(--dur-color) ease-[ease]",
							mode === viewMode ? "bg-sel-mute text-ink" : "bg-transparent text-ink-muted hover:text-ink",
						].join(" ")}
						title={`as ${label} (${keycap})`}
						aria-label={label}
						aria-pressed={mode === viewMode}
						onClick={() => onViewModeChange(mode)}
					>
						<Icon size={18} />
					</button>
				))}
			</div>
			<ToolbarControl
				label="Sort"
				active={sort !== null}
				open={menu?.kind === "sort"}
				icon={<SortIcon size={14} />}
				onClick={(event) => openMenu("sort", event)}
			/>
			<ToolbarControl
				label="Group"
				active={grouping !== "none"}
				open={menu?.kind === "group"}
				icon={<GroupIcon size={14} />}
				onClick={(event) => openMenu("group", event)}
			/>
			<div className="tgroup flex flex-none items-center gap-2 [-webkit-app-region:no-drag]">
				<button
					type="button"
					className={[
						"flex flex-none items-center justify-center size-toolbar-icon p-0 border-0 rounded-6 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease]",
						inspectorVisible
							? "bg-transparent text-accent"
							: "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
					].join(" ")}
					title={inspectorVisible ? "Hide inspector" : "Show inspector"}
					aria-label="Toggle inspector"
					aria-pressed={inspectorVisible}
					onClick={onToggleInspector}
				>
					<InfoIcon size={18} />
				</button>
				<button
					type="button"
					className={[
						"flex flex-none items-center justify-center size-toolbar-icon p-0 border-0 rounded-6 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease]",
						aiActive ? "bg-transparent text-accent" : "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
					].join(" ")}
					title="AI Search (⌘K)"
					aria-label="Show AI Search"
					aria-pressed={aiActive}
					onClick={onShowAi}
				>
					<SparklesIcon size={18} />
				</button>
				<button
					type="button"
					className={NAV_BUTTON}
					title="Share"
					aria-label="Copy path"
					disabled={!canShare}
					onClick={onShare}
				>
					<ShareIcon size={18} />
				</button>
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
