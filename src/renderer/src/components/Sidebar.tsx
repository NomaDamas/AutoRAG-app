import { Eject, PanelLeft } from "lucide-react";
import type { DragEvent, ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { FsLocationIcon } from "../../../shared/fs-contract";
import type { NavGroup, NavItem } from "../data/places";
import { cn } from "../lib/cn";
import { formatShortcut } from "../lib/shortcuts";
import { GearIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { Keycap } from "./primitives/Keycap";
import { StatusDot } from "./primitives/StatusDot";
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
	onHideSidebar,
	sourceStatus,
	searchQuery,
	searchRef,
	searchFocused,
	onSearchFocus,
	onSearchBlur,
	onSubmitSearch,
	aiSearchDrop,
}: {
	readonly groups: readonly NavGroup[];
	/** Path of the row that owns the current folder. */
	readonly activePath: string | null;
	readonly settingsActive: boolean;
	readonly showHotkeys: boolean;
	readonly onNavigate: (item: NavItem) => void;
	readonly onEject: (item: NavItem) => void;
	readonly onOpenSettings?: (() => void) | undefined;
	readonly onHideSidebar: () => void;
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
}): ReactElement {
	const { t } = useTranslation();
	const localizedGroupLabel = (label: string): string => {
		switch (label) {
			case "Favorites": return t("places.favorites", label);
			case "Cloud": return t("places.cloud", label);
			case "Locations": return t("places.locations", label);
			default: return label;
		}
	};
	const localizedItemLabel = (item: NavItem): string => {
		if (item.view === "aiSearch") return t("places.aiSearch", item.label);
		if (item.kind !== undefined) return t(`places.${item.kind}`, item.label);
		return item.label;
	};
	return (
		<aside
			className="sidebar flex w-full flex-none flex-col min-h-0 bg-sidebar border-r border-border backdrop-blur-[18px]"
			aria-label="Places"
		>
			<div className="side-head flex flex-none items-center gap-8 h-toolbar px-12 [-webkit-app-region:drag]">
				<div className="flex-1" aria-hidden="true" />
				<button
					type="button"
					className={HEAD_BUTTON_CLASS}
					title={t("toolbar.hideSidebar", "Hide sidebar")}
					aria-label="Hide sidebar"
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
										<Icon
											className={cn("sidebar__item-icon flex-none", active ? "text-accent" : "text-ink-muted")}
											size={14}
											strokeWidth={1.8}
										/>
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
											title={t("places.eject", `"${item.label}" 추출`, { name: item.label })}
											aria-label={t("places.eject", `"${item.label}" 추출`, { name: item.label })}
											onClick={() => onEject(item)}
										>
											<Eject size={12} strokeWidth={1.8} />
										</button>
									) : null}
								</div>
							);
						})}
					</div>
				))}
			</div>
			<div className="side-footer flex flex-none flex-col p-10 border-t border-border">
				<button
					type="button"
					className={cn(ITEM_CLASS, "sidebar__item--settings", settingsActive && "bg-selected-nav text-ink")}
					aria-current={settingsActive ? "true" : undefined}
					aria-label="Settings"
					onClick={onOpenSettings}
				>
					<GearIcon
						className={cn("sidebar__item-icon flex-none", settingsActive ? "text-accent-text" : "text-ink-muted")}
					/>
					<span className="sidebar__item-label flex-1 min-w-0 truncate">{t("places.settings", "설정")}</span>
					<span className="sr-only" aria-hidden="true" style={{ display: "none" }}>Settings</span>
					{showHotkeys ? <Keycap label={formatShortcut({ key: "," })} /> : null}
				</button>
			</div>
		</aside>
	);
}
