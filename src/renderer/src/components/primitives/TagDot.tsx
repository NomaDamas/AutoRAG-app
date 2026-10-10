import type { ReactElement } from "react";
import type { FsTagColor } from "../../../../shared/fs-contract";
import { cn } from "../../lib/cn";
import { TAG_COLOR_TOKEN, type TagDot } from "../../state/tags";

/**
 * One Finder tag colour: a filled disc, or a hollow ring for a tag with no
 * colour (Finder draws those as an empty circle). The colour is a `--tag-*`
 * token, never a literal.
 */
export function TagDotMark({ color, size = 9 }: { readonly color: FsTagColor; readonly size?: number }): ReactElement {
	const token = TAG_COLOR_TOKEN[color];
	return (
		<span
			className={cn("tag-dot flex-none rounded-full", token === null && "border border-ink-faint")}
			style={{ width: size, height: size, ...(token === null ? {} : { background: `var(${token})` }) }}
			aria-hidden="true"
		/>
	);
}

/**
 * A row's tag dots, Finder-style: the dots overlap like a stack and a file
 * with many tags shows the first few. The names ride on the tooltip and the
 * accessible name so colour is never the only carrier.
 */
export function TagDots({
	dots,
	size = 9,
	limit = 4,
	className,
}: {
	readonly dots: readonly TagDot[];
	readonly size?: number;
	readonly limit?: number;
	readonly className?: string;
}): ReactElement | null {
	if (dots.length === 0) return null;
	const shown = dots.slice(0, limit);
	const names = dots.map((dot) => dot.name).join(", ");
	return (
		<span className={cn("tag-dots inline-flex flex-none items-center", className)} title={names} role="img" aria-label={names}>
			{shown.map((dot, index) => (
				<span
					key={dot.name}
					className="tag-dots__dot flex rounded-full shadow-[0_0_0_1.5px_var(--bg-window)]"
					style={{ marginLeft: index === 0 ? 0 : -Math.round(size / 3) }}
				>
					<TagDotMark color={dot.color} size={size} />
				</span>
			))}
		</span>
	);
}
