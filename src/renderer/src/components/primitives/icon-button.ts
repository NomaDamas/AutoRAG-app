import { cn } from "../../lib/cn";

/** `--size-row` (32px) is the default; the history header is 28px (`--size-icon-sm`). */
export type IconButtonSize = "size-row" | "size-icon-sm";

/** `--text-body` by default; the history header uses `--text-muted`. */
export type IconButtonTone = "text-ink-body" | "text-ink-muted";

/**
 * The square icon button shared by the toolbar, the AI header and history
 * header, the requests popover, and the settings header (DESIGN.md §5).
 *
 * Replaces the `.icon-button` blocks that lived in both `finder.css` and
 * `shell.css` plus the two per-context overrides in `shell.css`. The cascade
 * made `finder.css` win wherever the two disagreed, and that is the behaviour
 * encoded here:
 *
 * - enabled hover: `--bg-hover-icon` and `--text-primary` (finder beat shell)
 * - disabled: `--border-strong` and `cursor: default`; still takes the shell
 *   hover wash, because `:disabled` only overrode the colour
 * - `--active`: `--bg-hover` and `--text-primary`
 *
 * Size and tone are parameters rather than appended classes: these are custom
 * utilities that `tailwind-merge` cannot classify, so an appended override would
 * not reliably win.
 */
export function iconButtonClass({
	active = false,
	size = "size-row",
	tone = "text-ink-body",
}: {
	readonly active?: boolean;
	readonly size?: IconButtonSize;
	readonly tone?: IconButtonTone;
} = {}): string {
	return cn(
		"flex flex-none items-center justify-center p-0 border-0 rounded-6 bg-transparent cursor-pointer",
		size,
		tone,
		"transition-[background] duration-(--dur-color) ease-[ease]",
		"enabled:hover:bg-hover-icon enabled:hover:text-ink",
		"disabled:text-border-strong disabled:cursor-default disabled:hover:bg-hover",
		active && "bg-hover text-ink",
	);
}
