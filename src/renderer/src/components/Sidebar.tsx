import { FolderPlus, PanelLeft } from "lucide-react";
import type { ReactElement } from "react";
import { NAV_GROUPS, type NavItem } from "../data/places";
import { cn } from "../lib/cn";
import { GearIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { Keycap } from "./primitives/Keycap";
import { StatusDot } from "./primitives/StatusDot";

/** Shared shape of a sidebar row (nav item and the footer settings button). */
const ITEM_CLASS =
	"sidebar__item flex items-center gap-10 w-full h-row px-8 border-0 rounded-6 bg-transparent text-ink-body text-sm text-left transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover";

/** The window head's chrome buttons (28px) opt out of the drag region. */
const HEAD_BUTTON_CLASS = cn(
	iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }),
	"[-webkit-app-region:no-drag]",
);

/**
 * Sidebar (v7 `.sidebar` / `.side-head` / `.side-scroll` / `.side-footer`): the
 * navigation groups plus the two window-head buttons and the Settings row.
 *
 * The native traffic lights overlay the head's left edge (`hiddenInset`), so the
 * head is a drag region and the buttons sit flush right. Status dots come from
 * the live datasource status — the sidebar holds no mock state.
 */
export function Sidebar({
	activeLabel,
	showHotkeys,
	onNavigate,
	onOpenSettings,
	onHideSidebar,
	onNewFolder,
	sourceStatus,
}: {
	readonly activeLabel: string | null;
	readonly showHotkeys: boolean;
	readonly onNavigate: (item: NavItem) => void;
	readonly onOpenSettings?: (() => void) | undefined;
	readonly onHideSidebar: () => void;
	readonly onNewFolder: () => void;
	readonly sourceStatus?: Readonly<Record<string, "syncing" | "error">>;
}): ReactElement {
	return (
		<aside
			className="sidebar flex w-sidebar flex-none flex-col min-h-0 bg-sidebar border-r border-border backdrop-blur-[18px]"
			aria-label="Places"
		>
			<div className="side-head flex flex-none items-center gap-8 h-toolbar px-12 [-webkit-app-region:drag]">
				<div className="flex-1" aria-hidden="true" />
				<button
					type="button"
					className={HEAD_BUTTON_CLASS}
					title="Hide sidebar"
					aria-label="Hide sidebar"
					onClick={onHideSidebar}
				>
					<PanelLeft size={16} strokeWidth={1.8} />
				</button>
				<button
					type="button"
					className={HEAD_BUTTON_CLASS}
					title="New folder"
					aria-label="New folder"
					onClick={onNewFolder}
				>
					<FolderPlus size={16} strokeWidth={1.8} />
				</button>
			</div>
			<div className="side-scroll flex flex-1 flex-col gap-14 min-h-0 px-10 pt-6 pb-12 overflow-auto">
				{NAV_GROUPS.map((group) => (
					<div key={group.label} className="side-group flex flex-col gap-1">
						<div className="side-label px-8 pt-4 pb-6 text-ink-muted text-badge font-semibold tracking-label">
							{group.label}
						</div>
						{group.items.map((item) => {
							const active = item.label === activeLabel;
							const status = sourceStatus?.[item.label];
							const Icon = item.icon;
							return (
								<button
									key={item.label}
									type="button"
									className={cn(ITEM_CLASS, active && "sidebar__item--active bg-selected-nav text-ink")}
									aria-current={active ? "true" : undefined}
									onClick={() => onNavigate(item)}
								>
									<Icon
										className={cn("sidebar__item-icon flex-none", active ? "text-accent" : "text-ink-muted")}
										size={16}
										strokeWidth={1.8}
									/>
									<span className="sidebar__item-label flex-1 min-w-0 truncate">{item.label}</span>
									{status ? (
										<StatusDot token={status === "syncing" ? "--warn-dot" : "--error-orange-dot"} />
									) : null}
								</button>
							);
						})}
					</div>
				))}
			</div>
			<div className="side-footer flex flex-none flex-col p-10 border-t border-border">
				<button
					type="button"
					className={cn(
						ITEM_CLASS,
						"sidebar__item--settings",
						activeLabel === "Settings" && "bg-selected-nav text-ink",
					)}
					aria-current={activeLabel === "Settings" ? "true" : undefined}
					onClick={onOpenSettings}
				>
					<GearIcon
						className={cn(
							"sidebar__item-icon flex-none",
							activeLabel === "Settings" ? "text-accent-text" : "text-ink-muted",
						)}
					/>
					<span className="sidebar__item-label flex-1 min-w-0 truncate">Settings</span>
					{showHotkeys ? <Keycap label="⌘," /> : null}
				</button>
			</div>
		</aside>
	);
}
