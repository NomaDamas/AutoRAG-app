import type { ReactElement } from "react";
import { hostPlatform } from "../lib/shortcuts";

export type SearchScope = "all" | "current";

/** The whole-machine scope pill: "This Mac" on macOS, "This Computer" on Windows. */
export function allScopeLabel(platform: string = hostPlatform()): string {
	return platform === "win32" ? "This Computer" : "This Mac";
}

const ACTIVE_BUTTON_CLASS =
	"flex-none h-[20px] px-8 border-0 rounded-5 text-badge whitespace-nowrap cursor-default transition-[background,color] duration-(--dur-color) ease-[ease] bg-accent text-on-accent font-semibold";
const INACTIVE_BUTTON_CLASS =
	"flex-none h-[20px] px-8 border-0 rounded-5 text-badge whitespace-nowrap cursor-default transition-[background,color] duration-(--dur-color) ease-[ease] bg-transparent text-ink-body hover:bg-hover";

/**
 * Search scope bar (v7 handoff, screenshot 13): shown above the flat result
 * list while a query is committed. "Search:" then the whole-machine / folder
 * pills and the result count on the right.
 */
export function ScopeBar({
	scope,
	folderName,
	resultCount,
	onScopeChange,
}: {
	readonly scope: SearchScope;
	readonly folderName: string;
	readonly resultCount: number;
	readonly onScopeChange: (scope: SearchScope) => void;
}): ReactElement {
	const allButtonClass = scope === "all" ? ACTIVE_BUTTON_CLASS : INACTIVE_BUTTON_CLASS;
	const currentButtonClass = scope === "current" ? ACTIVE_BUTTON_CLASS : INACTIVE_BUTTON_CLASS;
	return (
		<div className="scope flex flex-none items-center gap-8 h-[27px] px-15 border-b border-divider text-ink-muted text-badge">
			<span className="scope__label">Search:</span>
			<button
				type="button"
				className={allButtonClass}
				aria-pressed={scope === "all"}
				onClick={() => onScopeChange("all")}
			>
				{allScopeLabel()}
			</button>
			<button
				type="button"
				className={currentButtonClass}
				aria-pressed={scope === "current"}
				title={folderName}
				onClick={() => onScopeChange("current")}
			>
				{folderName}
			</button>
			<span className="scope__spacer flex-1" />
			<span className="scope__count">
				<b className="font-semibold text-ink">{resultCount}</b> items found
			</span>
		</div>
	);
}
