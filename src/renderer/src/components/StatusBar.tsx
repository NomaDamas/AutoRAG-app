import type { ReactElement } from "react";
import { Keycap } from "./primitives/Keycap";

/**
 * Status bar (handoff README §2): item and selection counts on the left, the
 * Quick Look / drag hint on the right.
 */
export function StatusBar({
	text,
	showHotkeys,
	devLabel,
}: {
	readonly text: string;
	readonly showHotkeys: boolean;
	readonly devLabel: string | null;
}): ReactElement {
	return (
		<div className="status-bar flex flex-none items-center justify-between gap-12 h-status-bar px-16 border-t border-border text-ink-muted text-meta">
			<span>{text}</span>
			{devLabel === null ? null : (
				<span
					className="status-bar__dev overflow-hidden max-w-[46ch] text-ink-faint font-mono text-badge whitespace-nowrap text-ellipsis"
					title={devLabel}
				>
					{devLabel}
				</span>
			)}
			<span className="status-bar__hint flex items-center gap-6 whitespace-nowrap">
				{showHotkeys ? <Keycap label="space" variant="surface" /> : null}
				Quick Look · Drag into chat to ask
			</span>
		</div>
	);
}
