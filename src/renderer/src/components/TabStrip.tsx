import type { DragEvent, MouseEvent, ReactElement } from "react";
import { cn } from "../lib/cn";
import { formatShortcut } from "../lib/shortcuts";
import { SparklesIcon, TabCloseIcon, TabPlusIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

export interface TabView {
	readonly id: number;
	readonly title: string;
	readonly active: boolean;
	readonly flash: boolean;
	/** The tab shows the AI Search chat: a drop on it attaches instead of moving files. */
	readonly aiSearch: boolean;
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
	dropTabId,
	onTabDragOver,
	onTabDragLeave,
	onTabDrop,
}: {
	readonly tabs: readonly TabView[];
	readonly canClose: boolean;
	readonly onSelect: (id: number) => void;
	readonly onClose: (id: number) => void;
	readonly onNewTab: () => void;
	/** The tab under an in-app row drag, highlighted as the drop target. */
	readonly dropTabId: number | null;
	readonly onTabDragOver: (id: number, event: DragEvent<HTMLDivElement>) => void;
	readonly onTabDragLeave: (id: number) => void;
	readonly onTabDrop: (id: number, event: DragEvent<HTMLDivElement>) => void;
}): ReactElement {
	return (
		<div className="tabs flex h-25 flex-none items-stretch overflow-hidden border-b border-tabstrip-line bg-tabstrip [-webkit-app-region:drag]">
			{tabs.map((tab, index) => (
				<div
					key={tab.id}
					data-tab-id={tab.id}
					data-ai-search={tab.aiSearch ? "true" : undefined}
					className={[
						`tab group/tab${tab.active ? " tab--active" : ""}`,
						"relative flex flex-1 min-w-0 items-center justify-center px-24 text-badge font-normal select-none cursor-pointer [-webkit-app-region:no-drag]",
						index > 0 ? "border-l border-tabstrip-line" : "",
						tab.active ? "bg-tab-active text-ink" : cn(TAB_GRADIENT, TAB_GRADIENT_HOVER, "text-tab-text"),
						dropTabId === tab.id ? "shadow-[inset_0_0_0_1.5px_var(--accent)]" : "",
					].join(" ")}
					onClick={() => onSelect(tab.id)}
					onDragOver={(event) => onTabDragOver(tab.id, event)}
					onDragLeave={(event) => {
						if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
						onTabDragLeave(tab.id);
					}}
					onDrop={(event) => onTabDrop(tab.id, event)}
				>
					{tab.flash ? (
						<span className="absolute left-6 top-1/2 -mt-3 flex" aria-hidden="true">
							<StatusDot token="--accent" />
						</span>
					) : null}
					<button
						type="button"
						className="tab__title flex min-w-0 flex-[0_1_auto] items-center gap-4 overflow-hidden whitespace-nowrap p-0 border-0 rounded-none bg-transparent text-inherit appearance-none text-center cursor-pointer"
						onClick={(event: MouseEvent<HTMLButtonElement>) => {
							event.stopPropagation();
							onSelect(tab.id);
						}}
					>
						{tab.aiSearch ? <SparklesIcon size={11} className="flex-none text-accent" /> : null}
						<span className="min-w-0 truncate">{tab.title}</span>
					</button>
					{canClose ? (
						<button
							type="button"
							className="tab__close absolute left-5 top-1/2 mt-[-7.5px] flex flex-none items-center justify-center size-15 p-0 border-0 rounded-3 bg-transparent text-ink-muted opacity-0 transition-[background,opacity] duration-(--dur-color) ease-[ease] group-hover/tab:opacity-100 hover:bg-hover-strong hover:text-ink"
							title={`Close tab ${formatShortcut({ key: "W" })}`}
							aria-label={`Close tab ${formatShortcut({ key: "W" })}`}
							onClick={(event: MouseEvent<HTMLButtonElement>) => {
								event.stopPropagation();
								onClose(tab.id);
							}}
						>
							<TabCloseIcon />
						</button>
					) : null}
				</div>
			))}
			<button
				type="button"
				className={cn(
					"tabs__new flex flex-none w-28 items-center justify-center border-0 border-l border-tabstrip-line text-tab-text hover:text-ink [-webkit-app-region:no-drag]",
					TAB_GRADIENT,
					TAB_GRADIENT_HOVER,
				)}
				title={`New tab ${formatShortcut({ key: "T" })}`}
				aria-label={`New tab ${formatShortcut({ key: "T" })}`}
				onClick={onNewTab}
			>
				<TabPlusIcon />
			</button>
		</div>
	);
}
