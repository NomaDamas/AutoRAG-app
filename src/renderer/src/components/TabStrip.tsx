import type { MouseEvent, ReactElement } from "react";
import { cn } from "../lib/cn";
import { CloseIcon, PlusIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

export interface TabView {
	readonly id: number;
	readonly title: string;
	readonly active: boolean;
	readonly flash: boolean;
}

const TAB_GRADIENT = "bg-[linear-gradient(var(--tab-grad-from),var(--tab-grad-to))]";
const TAB_GRADIENT_HOVER = "hover:bg-[linear-gradient(var(--tab-grad-hover-from),var(--tab-grad-hover-to))]";

/**
 * Tab strip (v7 handoff, proto:.tabs/.tab): a 25px #D4D4D8 bar of equal-width
 * Safari-style segments with hairline dividers; the active tab is #ECECEE and
 * the close button fades in on hover. A flash dot marks the reveal target.
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
		<div className="tabs flex h-25 flex-none items-stretch overflow-hidden border-b border-tabstrip-line bg-tabstrip [-webkit-app-region:drag]">
			{tabs.map((tab, index) => (
				<div
					key={tab.id}
					className={[
						`tab group/tab${tab.active ? " tab--active" : ""}`,
						"relative flex flex-1 min-w-0 items-center justify-center px-24 text-badge font-normal select-none cursor-default [-webkit-app-region:no-drag]",
						index > 0 ? "border-l border-tabstrip-line" : "",
						tab.active ? "bg-tab-active text-ink" : cn(TAB_GRADIENT, TAB_GRADIENT_HOVER, "text-tab-text"),
					].join(" ")}
				>
					{tab.flash ? (
						<span className="absolute left-6 top-1/2 -mt-3 flex" aria-hidden="true">
							<StatusDot token="--accent" />
						</span>
					) : null}
					<button
						type="button"
						className="tab__title min-w-0 flex-[0_1_auto] overflow-hidden whitespace-nowrap text-ellipsis p-0 border-0 rounded-none bg-transparent text-inherit appearance-none text-center cursor-default"
						onClick={() => onSelect(tab.id)}
					>
						{tab.title}
					</button>
					{canClose ? (
						<button
							type="button"
							className="tab__close absolute left-5 top-1/2 mt-[-7.5px] flex flex-none size-15 items-center justify-center border-0 rounded-4 bg-transparent text-ink-muted opacity-0 transition-[background,opacity] duration-(--dur-color) ease-[ease] group-hover/tab:opacity-100 hover:bg-[rgba(0,0,0,0.12)] hover:text-ink"
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
				className={cn(
					"tabs__new flex flex-none w-28 items-center justify-center border-l border-tabstrip-line text-tab-text hover:text-ink [-webkit-app-region:no-drag]",
					TAB_GRADIENT,
					TAB_GRADIENT_HOVER,
				)}
				title="New tab ⌘T"
				aria-label="New tab ⌘T"
				onClick={onNewTab}
			>
				<PlusIcon />
			</button>
		</div>
	);
}
