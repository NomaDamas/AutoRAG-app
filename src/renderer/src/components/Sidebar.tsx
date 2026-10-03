import type { ReactElement } from "react";
import { INDEXING_STATUS, NAV_GROUPS, type NavItem } from "../data/places";
import { cn } from "../lib/cn";
import { GearIcon } from "./icons";
import { Keycap } from "./primitives/Keycap";
import { StatusDot } from "./primitives/StatusDot";

/** Shared shape of a sidebar row (nav item and the footer settings button). */
const ITEM_CLASS =
	"sidebar__item flex items-center gap-10 h-row px-8 border-0 rounded-6 bg-transparent text-ink-body text-body text-left transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover";

/**
 * Sidebar (handoff README §1): native window chrome is supplied by Electron,
 * so the renderer starts directly with the navigation groups.
 */
export function Sidebar({
	activeLabel,
	showHotkeys,
	onNavigate,
	onOpenSettings,
}: {
	readonly activeLabel: string | null;
	readonly showHotkeys: boolean;
	readonly onNavigate: (item: NavItem) => void;
	readonly onOpenSettings?: (() => void) | undefined;
}): ReactElement {
	return (
		<aside className="sidebar flex flex-col min-h-0 bg-chrome border-r border-border" aria-label="Places">
			<div className="sidebar__scroll flex flex-1 flex-col gap-14 px-10 pt-4 pb-12 overflow-auto">
				{NAV_GROUPS.map((group) => (
					<div key={group.label} className="sidebar__group flex flex-col gap-1">
						<div className="sidebar__label px-8 pt-4 pb-6 text-ink-muted text-badge font-semibold tracking-label">
							{group.label}
						</div>
						{group.items.map((item) => {
							const active = item.label === activeLabel;
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
										className={cn("sidebar__item-icon flex-none text-ink-muted", active && "text-accent")}
										size={16}
										strokeWidth={1.8}
									/>
									<span className="sidebar__item-label flex-1 min-w-0 truncate">{item.label}</span>
									{item.syncing ? <StatusDot token="--warn-dot" /> : null}
									{item.error ? <StatusDot token="--error-orange-dot" /> : null}
								</button>
							);
						})}
					</div>
				))}
			</div>
			<div className="sidebar__footer flex flex-none flex-col gap-8 p-10 border-t border-border">
				<div className="sidebar__indexing flex flex-col gap-6 py-4 px-6">
					<div className="sidebar__indexing-row flex justify-between text-ink-muted text-meta">
						<span>{INDEXING_STATUS.label}</span>
						<span className="sidebar__indexing-value text-ink-body">{INDEXING_STATUS.percent}%</span>
					</div>
					<div className="sidebar__progress h-4 rounded-4 bg-input overflow-hidden">
						<div className="sidebar__progress-fill h-full rounded-4 bg-warn-dot" style={{ width: `${INDEXING_STATUS.percent}%` }} />
					</div>
				</div>
				<button
					type="button"
					className={`${ITEM_CLASS}${activeLabel === "Settings" ? " bg-selected-nav text-ink-primary font-medium shadow-xs" : ""}`}
					aria-current={activeLabel === "Settings" ? "true" : undefined}
					onClick={onOpenSettings}
				>
					<GearIcon className={`sidebar__item-icon flex-none ${activeLabel === "Settings" ? "text-accent-text" : "text-ink-muted"}`} />
					<span className="sidebar__item-label flex-1 min-w-0 truncate">Settings</span>
					{showHotkeys ? <Keycap label="⌘," /> : null}
				</button>
			</div>
		</aside>
	);
}
