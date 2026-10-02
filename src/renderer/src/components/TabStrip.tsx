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
 * Tab strip (v7 handoff): a 38px chrome bar with bottom-aligned 30px tabs; the
 * active tab is white and merges into the browser via a -1px margin, and the
 * close button fades in on hover. A flash dot marks the tab a reveal landed in.
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
		<div className="tabs group/tabs flex flex-none items-end gap-2 h-[38px] pr-8 pl-8 bg-chrome border-b border-border [-webkit-app-region:drag]">
			{tabs.map((tab) => (
				<div
					key={tab.id}
					className={[
						`tab group/tab${tab.active ? " tab--active" : ""}`,
						"relative flex flex-[1_1_0] items-center justify-center min-w-tab-min max-w-tab-max h-[30px] -mb-px px-12 border border-b-0 rounded-t-8 text-meta font-medium transition-[background] duration-(--dur-modal) ease-[ease] [-webkit-app-region:no-drag]",
						tab.active
							? "bg-window border-border text-ink"
							: "border-transparent bg-transparent text-ink-muted hover:bg-hover",
					].join(" ")}
				>
					{tab.flash ? (
						<span className="absolute left-7 top-1/2 -mt-3 flex" aria-hidden="true">
							<StatusDot token="--accent" />
						</span>
					) : null}
					<button
						type="button"
						className="tab__title min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis p-0 border-0 rounded-none bg-transparent text-inherit appearance-none font-medium text-center"
						onClick={() => onSelect(tab.id)}
					>
						{tab.title}
					</button>
					{canClose ? (
						<button
							type="button"
							className="tab__close absolute left-5 top-1/2 -mt-[11px] flex flex-none items-center justify-center size-pill border-0 rounded-6 bg-transparent text-ink-muted opacity-0 transition-[background,opacity] duration-(--dur-color) ease-[ease] group-hover/tab:opacity-100 hover:bg-hover-strong hover:text-ink"
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
				className="tabs__new flex flex-none items-center justify-center size-icon-sm mb-1 border-0 rounded-8 bg-transparent text-ink-muted transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover-icon hover:text-ink [-webkit-app-region:no-drag]"
				title="New tab ⌘T"
				aria-label="New tab ⌘T"
				onClick={onNewTab}
			>
				<PlusIcon />
			</button>
		</div>
	);
}
