import { cn } from "../../lib/cn";

/** Figma 435:8582 "Button": Small (28), Medium (32), Large (36). */
export type ButtonSize = "sm" | "md" | "lg";

/**
 * Height, side padding, icon–label gap, label size and the icon box with its stroke, all from the
 * `--button-*` tokens (`styles/tokens.css`). The icon stroke is the design's pixel width (0.9 / 1.05 / 1.2),
 * kept at that width whatever the icon's size by `vector-effect: non-scaling-stroke`.
 */
const SIZE: Readonly<Record<ButtonSize, string>> = {
	sm: "h-(--button-height-sm) px-(--button-pad-x-sm) gap-(--button-gap-sm) text-(length:--button-font-sm) leading-(--button-line-sm) [&_svg]:size-(--button-icon-sm) [&_svg]:[stroke-width:var(--button-icon-stroke-sm)]",
	md: "h-(--button-height-md) px-(--button-pad-x-md) gap-(--button-gap-md) text-(length:--button-font-md) leading-(--button-line-md) [&_svg]:size-(--button-icon-md) [&_svg]:[stroke-width:var(--button-icon-stroke-md)]",
	lg: "h-(--button-height-lg) px-(--button-pad-x-lg) gap-(--button-gap-lg) text-(length:--button-font-lg) leading-(--button-line-lg) [&_svg]:size-(--button-icon-lg) [&_svg]:[stroke-width:var(--button-icon-stroke-lg)]",
};

/**
 * The size half of every text button (Figma 435:8582). It sets no colour: each call site keeps its own
 * background, border, label and icon colours, and appends them after this. Icons sit before and/or after
 * the label as plain children and take the label's colour unless the call site says otherwise.
 * Hover is 80% opacity and disabled 50%, as the component's states say.
 */
export function buttonClass({ size }: { readonly size: ButtonSize }): string {
	return cn(
		"inline-flex flex-none items-center justify-center py-0 font-medium whitespace-nowrap",
		"[&_svg]:flex-none [&_svg_*]:[vector-effect:non-scaling-stroke]",
		"enabled:hover:opacity-80 disabled:opacity-50",
		SIZE[size],
	);
}
