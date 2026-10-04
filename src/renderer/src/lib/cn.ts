import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's stock scale, so it classifies our custom
 * font sizes (`text-meta`, `text-title`, …) as text *colours* — and then drops
 * them when they meet a real colour such as `text-ink-muted`. Registering them
 * as font sizes restores the correct conflict groups.
 *
 * `text-sm` is already a stock font size and is listed only for completeness.
 */
const FONT_SIZES = ["title", "body", "sm", "meta", "caption", "badge", "file-row", "file-meta", "tile", "tile-xs"];
const RADII = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "14", "full"];
const SHADOWS = ["raised", "drag", "window"];

const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [{ text: FONT_SIZES }],
			rounded: [{ rounded: RADII }],
			shadow: [{ shadow: SHADOWS }],
		},
	},
});

/**
 * Conditional class names with later Tailwind utilities winning over earlier
 * ones, so a component can append a state class (or an override) without
 * depending on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
