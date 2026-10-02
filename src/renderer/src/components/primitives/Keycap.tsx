import type { ReactElement } from "react";

/**
 * Shortcut hint (DESIGN.md §5 Keycap). Static, never interactive: it labels a
 * shortcut, it does not invoke one. Rendered only when `showHotkeys` is on.
 */
export function Keycap({
	label,
	variant = "chrome",
}: {
	readonly label: string;
	readonly variant?: "chrome" | "surface";
}): ReactElement {
	return (
		<span
			className={`${variant === "surface" ? "keycap keycap--surface" : "keycap"} flex-none px-5 border border-border rounded-5 text-ink-muted text-badge whitespace-nowrap ${
				variant === "surface" ? "py-0 bg-window" : "py-1 bg-hover-row"
			}`}
			aria-hidden="true"
		>
			{label}
		</span>
	);
}
