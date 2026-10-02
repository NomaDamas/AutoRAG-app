import type { ReactElement } from "react";

/**
 * The single carrier of state color (DESIGN.md §5 StatusDot). `token` is a
 * custom-property name from tokens.css — never a literal color.
 */
export function StatusDot({ token }: { readonly token: string }): ReactElement {
	return (
		<span
			className="dot flex-none size-dot rounded-full"
			style={{ background: `var(${token})` }}
			aria-hidden="true"
		/>
	);
}

/** Excluded-index dot: a hollow ring instead of a fill (DESIGN.md §2.7). */
export function HollowDot(): ReactElement {
	return (
		<span
			className="dot dot--hollow flex-none size-dot rounded-full bg-transparent shadow-(--index-dot-excluded-ring)"
			aria-hidden="true"
		/>
	);
}
