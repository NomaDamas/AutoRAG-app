import type { ReactElement } from "react";
import { StatusDot } from "./StatusDot";

/**
 * Bottom-center toast (DESIGN.md §5 Toast). A new message replaces the current
 * one and it auto-hides after --time-toast; the live region is the only way the
 * message reaches a screen reader (DESIGN.md §8 constraint 6). An `action` adds
 * one text button beside the message (the 자동화 tab's 실행 취소); its owner
 * decides how long the toast stays.
 */
export function Toast({
	message,
	action,
}: {
	readonly message: string;
	readonly action?: { readonly label: string; readonly onAction: () => void } | undefined;
}): ReactElement {
	return (
		// The centring offset is an arbitrary `transform`, not `-translate-x-1/2`:
		// Tailwind's translate utilities emit the `translate` property, which would
		// *compose* with the `rise` keyframe's `transform`. The reference uses
		// `transform: translateX(-50%)`, where the running animation overrides it,
		// so the two must stay in the same property to behave identically.
		<output
			className="toast absolute left-1/2 bottom-24 z-30 flex items-center gap-10 h-tab px-14 border border-border rounded-10 bg-input shadow-raised text-ink text-meta [transform:translateX(-50%)] animate-rise"
			aria-live="polite"
		>
			<StatusDot token="--ok-dot" />
			{message}
			{action === undefined ? null : (
				<button type="button" className="p-0 border-0 bg-transparent text-accent-text text-meta cursor-pointer" onClick={action.onAction}>
					{action.label}
				</button>
			)}
		</output>
	);
}
