import type { MouseEvent, ReactElement } from "react";
import { cn } from "../../lib/cn";
import type { BadgeVisual, PillTone } from "../../state/badges";
import { RotateIcon } from "../icons";
import { HollowDot, StatusDot } from "./StatusDot";

const PILL_BASE =
	"flex items-center gap-5 h-pill px-8 border border-transparent rounded-11 bg-transparent text-badge font-semibold whitespace-nowrap transition-[border-color] duration-(--dur-color) ease-[ease] hover:border-border-strong";

const TONE_CLASS: Record<PillTone, string> = {
	included: "border-border text-ink-body",
	excluded: "bg-input text-ink-muted",
	failed: "bg-error-orange-bg text-error-orange-text",
};

/**
 * 22px pill badge (DESIGN.md §5 PillBadge) — the Index variant.
 * `visual` comes from state/badges so the mapping stays pure and the tooltip
 * doubles as the accessible name.
 */
export function PillBadge({
	visual,
	onClick,
}: {
	readonly visual: BadgeVisual;
	readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
	return (
		<button
			type="button"
			className={cn(`pill pill--${visual.tone}`, PILL_BASE, TONE_CLASS[visual.tone])}
			title={visual.title}
			aria-label={visual.title}
			onClick={onClick}
		>
			{visual.spinning ? <RotateIcon className="pill__spinner flex-none animate-spin" /> : null}
			{!visual.spinning && visual.hollowDot ? <HollowDot /> : null}
			{!visual.spinning && !visual.hollowDot && visual.dotToken !== null ? (
				<StatusDot token={visual.dotToken} />
			) : null}
			{visual.label}
		</button>
	);
}
