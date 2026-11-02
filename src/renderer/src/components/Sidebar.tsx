import { Eject, PanelLeft } from "lucide-react";
import type { DragEvent, ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { FsLocationIcon } from "../../../shared/fs-contract";
import { TAGS_GROUP_LABEL, type NavGroup, type NavItem } from "../data/places";
import { TagDotMark } from "./primitives/TagDot";
import { cn } from "../lib/cn";
import { formatShortcut, hostPlatform } from "../lib/shortcuts";
import { GearIcon, EyeIcon, UsageIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { SidebarUpdateButton } from "./SidebarUpdateButton";
import { StatusDot } from "./primitives/StatusDot";
import { SidebarIndexActivity } from "./SidebarIndexActivity";
import { SidebarErrorFixActivity } from "./SidebarErrorFixActivity";
import { SidebarSearch, type SearchMode } from "./SidebarSearch";

/** Shared shape of a sidebar row (nav item and the footer settings button): 28px rows, 12px labels. */
const ITEM_CLASS =
	"sidebar__item flex items-center gap-8 w-full h-icon-sm px-8 border-0 rounded-6 bg-transparent text-ink-body text-meta text-left transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover";

/** The window head's chrome buttons (28px) opt out of the drag region. */
const HEAD_BUTTON_CLASS = cn(
	iconButtonClass({ size: "size-toolbar-icon", tone: "text-ink-muted" }),
	"[-webkit-app-region:no-drag]",
);

/** The 20px eject affordance on a mounted volume's row, flush right inside it. */
const EJECT_BUTTON_CLASS =
	"sidebar__eject absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center size-20 p-0 border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover-icon hover:text-ink";

/**
 * Sidebar (v7 `.sidebar` / `.side-head` / `.side-scroll` / `.side-footer`): the
 * live navigation groups (Favorites / Cloud / Locations, see data/places.ts)
 * plus the two window-head buttons and the Settings row.
 *
 * The native traffic lights overlay the head's left edge (`hiddenInset`), so the
 * head is a drag region and the buttons sit flush right. Status dots come from
 * the live datasource status, keyed by the row's provider glyph — the sidebar
 * holds no mock state. A mounted volume's row carries an eject button.
 */
export function Sidebar({
	groups,
	activePath,
	settingsActive,
	showHotkeys,
	onNavigate,
	onEject,
	onOpenSettings,
	onOpenUsage,
	onHideSidebar,
	onOpenIndexing,
	sourceStatus,
	searchQuery,
	searchRef,
	searchFocused,
	onSearchFocus,
	onSearchBlur,
	onSubmitSearch,
	aiSearchDrop,
	tagColorsDenied = false,
	onGrantTagColors,
}: {
	readonly groups: readonly NavGroup[];
	/** Path of the row that owns the current folder. */
	readonly activePath: string | null;
	readonly settingsActive: boolean;
	readonly showHotkeys: boolean;
	readonly onNavigate: (item: NavItem) => void;
	readonly onEject: (item: NavItem) => void;
	readonly onOpenSettings?: (() => void) | undefined;
	/** The footer's chart icon opens Settings on the AI usage page. */
	readonly onOpenUsage?: (() => void) | undefined;
	readonly onHideSidebar: () => void;
	/** The indexing block opens Settings on its Indexing page. */
	readonly onOpenIndexing: () => void;
	readonly sourceStatus?: Readonly<Partial<Record<FsLocationIcon, "syncing" | "error">>>;
	readonly searchQuery: string;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	readonly searchFocused: boolean;
	readonly onSearchFocus: () => void;
	readonly onSearchBlur: () => void;
	readonly onSubmitSearch: (mode: SearchMode, text: string) => void;
	/** The AI Search item takes Finder rows and OS files as chat attachments. */
	readonly aiSearchDrop: {
		readonly hovered: boolean;
		readonly onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
		readonly onDragLeave: () => void;
		readonly onDrop: (event: DragEvent<HTMLButtonElement>) => void;
	};
	/** macOS refused the app Finder's tag registry: the Tags group offers the Full Disk Access grant. */
	readonly tagColorsDenied?: boolean;
	readonly onGrantTagColors?: (() => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const localizedGroupLabel = (label: string): string => {
		switch (label) {
			case "Favorites": return t("places.favorites", label);
			case "Cloud": return t("places.cloud", label);
			case "Connections": return t("places.connections", label);
			case "Locations": return t("places.locations", label);
			case TAGS_GROUP_LABEL: return t("places.tags", label);
			default: return label;
		}
	};
	const localizedItemLabel = (item: NavItem): string => {
		if (item.view === "aiSearch") return t("places.aiSearch", item.label);
		if (item.view === "automations") return t("places.automations", item.label);
		// Windows calls these folders Videos and Recycle Bin; the other keys read the same everywhere.
		if (item.kind === "movies" && hostPlatform() === "win32") return t("places.moviesWindows", item.label);
		if (item.kind === "trash" && hostPlatform() === "win32") return t("places.trashWindows", item.label);
		if (item.kind !== undefined) return t(`places.${item.kind}`, item.label);
		return item.label;
	};
	return (
		<aside
			className="sidebar flex w-full h-full flex-none flex-col min-h-0 bg-sidebar border-r border-border backdrop-blur-[18px]"
			aria-label={t("finderComponents.sidebar")}
		>
			<div className="side-head flex flex-none items-center gap-8 h-toolbar px-12 [-webkit-app-region:drag]">
				<div className="flex-1" aria-hidden="true" />
				<button
					type="button"
					className={HEAD_BUTTON_CLASS}
					title={t("toolbar.hideSidebar")}
					aria-label={t("toolbar.hideSidebar")}
					onClick={onHideSidebar}
				>
					<PanelLeft size={18} strokeWidth={1.8} />
				</button>
			</div>
			<SidebarSearch
				query={searchQuery}
				inputRef={searchRef}
				focused={searchFocused}
				showHotkeys={showHotkeys}
				onFocus={onSearchFocus}
				onBlur={onSearchBlur}
				onSubmit={onSubmitSearch}
			/>
			<div className="side-scroll flex flex-1 flex-col gap-10 min-h-0 px-10 pt-6 pb-12 overflow-auto">
				{groups.map((group) => (
					<div key={group.label} className="side-group flex flex-col gap-1">
						<div className="side-label px-8 pt-4 pb-4 text-ink-muted text-badge font-semibold tracking-label">
							{localizedGroupLabel(group.label)}
						</div>
						{group.items.map((item) => {
							const active = item.path === activePath && !settingsActive;
							const status = item.kind === undefined ? undefined : sourceStatus?.[item.kind];
							const Icon = item.icon;
							const drop = item.view === "aiSearch" ? aiSearchDrop : null;
							// The path tooltip disambiguates same-named locations; an app row has no path to show.
							const pathTitle = item.kind === undefined ? undefined : item.path;
							return (
								<div key={item.path} className="relative">
									<button
										type="button"
										className={cn(
											ITEM_CLASS,
											item.ejectable && "pr-28",
											!item.available && "text-ink-faint",
											active && "sidebar__item--active bg-selected-nav text-ink",
											drop?.hovered === true && "shadow-[inset_0_0_0_1.5px_var(--accent)]",
										)}
										title={pathTitle}
										aria-label={item.label}
										aria-current={active ? "true" : undefined}
										onClick={() => onNavigate(item)}
										onDragOver={drop?.onDragOver}
										onDragLeave={
											drop === null
												? undefined
												: (event) => {
														if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
														drop.onDragLeave();
													}
										}
										onDrop={drop?.onDrop}
									>
										{item.tag === undefined ? (
											<Icon
												className={cn("sidebar__item-icon flex-none", active ? "text-accent" : "text-ink-muted")}
												size={14}
												strokeWidth={1.8}
											/>
										) : (
											<span className="sidebar__item-icon flex flex-none items-center justify-center size-14">
												<TagDotMark color={item.tag.color} size={10} />
											</span>
										)}
										<span className="sidebar__item-label flex-1 min-w-0 truncate">{localizedItemLabel(item)}</span>
										{localizedItemLabel(item) !== item.label ? <span className="sr-only" aria-hidden="true" style={{ display: "none" }}>{item.label}</span> : null}
										{status ? (
											<StatusDot token={status === "syncing" ? "--warn-dot" : "--error-orange-dot"} />
										) : null}
									</button>
									{item.ejectable ? (
										<button
											type="button"
											className={EJECT_BUTTON_CLASS}
											title={t("places.eject", { name: item.label })}
											aria-label={t("places.eject", { name: item.label })}
											onClick={() => onEject(item)}
										>
											<Eject size={12} strokeWidth={1.8} />
										</button>
									) : null}
								</div>
							);
						})}
						{group.label === TAGS_GROUP_LABEL && tagColorsDenied ? (
							<button
								type="button"
								data-action="grant-tag-colors"
								className="flex w-full items-start gap-8 px-8 py-4 border-0 rounded-6 bg-transparent text-ink-muted text-badge text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
								title={t("places.tagColorsDeniedHint")}
								onClick={onGrantTagColors}
							>
								<EyeIcon className="flex-none text-ink-muted" />
								<span className="min-w-0">{t("places.tagColorsDenied")}</span>
							</button>
						) : null}
					</div>
				))}
			</div>
			<div className="side-footer flex flex-none flex-col px-12 py-10 border-t border-border">
				<SidebarErrorFixActivity />
				<SidebarIndexActivity onOpen={onOpenIndexing} />
				<div className="flex items-center gap-4">
					<button
						type="button"
						className={cn(
							iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }),
							"sidebar__item--settings",
							settingsActive && "bg-selected-nav text-accent-text",
						)}
						aria-current={settingsActive ? "true" : undefined}
						aria-label={t("places.settings")}
						title={t("places.settingsHint", { shortcut: formatShortcut({ key: "," }) })}
						onClick={onOpenSettings}
					>
						<GearIcon />
					</button>
					<button
						type="button"
						className={iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" })}
						data-action="open-usage"
						aria-label={t("places.usage")}
						title={t("places.usage")}
						onClick={onOpenUsage}
					>
						<UsageIcon />
					</button>
					<div className="flex-1" aria-hidden="true" />
					<SidebarUpdateButton />
				</div>
			</div>
		</aside>
	);
}
