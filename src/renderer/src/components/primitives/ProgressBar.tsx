import type { ReactElement } from "react";
import { cn } from "../../lib/cn";

const FILL_BY_TONE = {
	run: "bg-accent",
	ok: "bg-(--ok-dot)",
	error: "bg-(--error-orange-dot)",
} as const;

/**
 * A 4px determinate bar, or a shimmering full-width one when `percent` is
 * `null` (running, but nothing reports how far). The caller supplies the label
 * that names what is being measured.
 */
export function ProgressBar({
	percent,
	tone,
	label,
}: {
	readonly percent: number | null;
	readonly tone: keyof typeof FILL_BY_TONE;
	readonly label: string;
}): ReactElement {
	return (
		<div
			className="progress h-4 w-full overflow-hidden rounded-full bg-hover-strong"
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent ?? undefined}
		>
			{percent === null ? (
				<div className="progress__fill h-full w-full bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] bg-[length:200%_100%] animate-shimmer" />
			) : (
				<div
					className={cn("progress__fill h-full rounded-full transition-[width] duration-(--dur-step) ease-[ease]", FILL_BY_TONE[tone])}
					style={{ width: `${percent}%` }}
				/>
			)}
		</div>
	);
}
