import type { MouseEvent, ReactElement } from "react";
import { CloseIcon, PlusIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

export interface TabView {
	readonly id: number;
	readonly title: string;
	readonly active: boolean;
	readonly flash: boolean;
}

/**
 * Tab strip (handoff README §2): 48px chrome bar with bottom-aligned 36px
 * tabs; the active tab is white and merges into the toolbar via -1px margin.
 */
export function TabStrip({
	tabs,
	canClose,
	onSelect,
	onClose,
	onNewTab,
}: {
	readonly tabs: readonly TabView[];
	readonly canClose: boolean;
	readonly onSelect: (id: number) => void;
	readonly onClose: (id: number) => void;
	readonly onNewTab: () => void;
}): ReactElement {
	return (
		<div className="tabs flex flex-none items-end gap-2 h-bar pr-8 pl-6 bg-chrome border-b border-border">
			{tabs.map((tab) => (
				<div
					key={tab.id}
					className={[
						`tab${tab.active ? " tab--active" : ""}`,
						"flex flex-[1_1_0] items-center gap-8 min-w-tab-min max-w-tab-max h-tab -mb-px pl-12 pr-6 border border-b-0 rounded-t-10 text-meta transition-[background] duration-(--dur-modal) ease-[ease]",
						tab.active
							? "bg-window border-border text-ink shadow-[0_-1px_0_var(--bg-window)]"
							: "border-transparent bg-transparent text-ink-muted",
					].join(" ")}
				>
					{tab.flash ? <StatusDot token="--accent" /> : null}
					<button
						type="button"
						className="tab__title flex-1 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis p-0 border-0 rounded-none bg-transparent text-inherit appearance-none font-medium text-left"
						onClick={() => onSelect(tab.id)}
					>
						{tab.title}
					</button>
					{canClose ? (
						<button
							type="button"
							className="tab__close flex flex-none items-center justify-center size-pill border-0 rounded-6 bg-transparent text-ink-muted transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover-strong hover:text-ink"
							title="Close tab ⌘W"
							aria-label="Close tab ⌘W"
							onClick={(event: MouseEvent<HTMLButtonElement>) => {
								event.stopPropagation();
								onClose(tab.id);
							}}
						>
							<CloseIcon />
						</button>
					) : null}
				</div>
			))}
			<button
				type="button"
				className="tabs__new flex flex-none items-center justify-center size-row mb-2 border-0 rounded-8 bg-transparent text-ink-muted transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover-icon hover:text-ink"
				title="New tab ⌘T"
				aria-label="New tab ⌘T"
				onClick={onNewTab}
			>
				<PlusIcon />
			</button>
		</div>
	);
}
