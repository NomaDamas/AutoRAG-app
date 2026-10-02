import type { Bounds } from "./fit";

/**
 * Finder-style zoom: the panel grows out of the file's icon and shrinks back
 * into it, on an Apple spring (src/preview/ui/zoom-motion.ts). The process only
 * needs a backstop here: the page reports when the motion has finished.
 */
export const ZOOM_DONE_TIMEOUT_MS = 600;

export type ZoomDirection = "in" | "out";
export type ZoomAnchorX = "left" | "right";
export type ZoomAnchorY = "top" | "bottom";

/**
 * Where a zoom runs. The window temporarily covers `union` (icon and panel
 * together) so the scaled panel can travel over the icon; `from`/`to` are
 * relative to it. The panel always touches one horizontal and one vertical
 * edge of the union, and the anchors name those edges: laying the panel out
 * against them keeps it pixel-still when the window snaps between the union
 * and the panel bounds.
 */
export interface ZoomGeometry {
	readonly union: Bounds;
	readonly from: Bounds;
	readonly to: Bounds;
	readonly anchorX: ZoomAnchorX;
	readonly anchorY: ZoomAnchorY;
}

function atLeastOne(rect: Bounds): Bounds {
	return { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

export function zoomGeometry(origin: Bounds, panel: Bounds): ZoomGeometry {
	const icon = atLeastOne(origin);
	const left = Math.min(icon.x, panel.x);
	const top = Math.min(icon.y, panel.y);
	const right = Math.max(icon.x + icon.width, panel.x + panel.width);
	const bottom = Math.max(icon.y + icon.height, panel.y + panel.height);
	const union = { x: left, y: top, width: right - left, height: bottom - top };
	const relative = (rect: Bounds): Bounds => ({ x: rect.x - left, y: rect.y - top, width: rect.width, height: rect.height });
	return {
		union,
		from: relative(icon),
		to: relative(panel),
		anchorX: panel.x === left ? "left" : "right",
		anchorY: panel.y === top ? "top" : "bottom",
	};
}

/** The CSS transform (origin top-left) that draws a box laid out at `to` exactly over `from`. */
export function zoomTransform(from: Bounds, to: Bounds): string {
	return `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`;
}

/** The identity in the same function list as `zoomTransform`, so the two interpolate. */
export const ZOOM_IDENTITY = "translate(0px, 0px) scale(1, 1)";

/** A file without a visible icon (scrolled away, evidence source) zooms from the panel's center. */
export function fallbackOrigin(panel: Bounds): Bounds {
	const width = Math.max(1, Math.round(panel.width / 4));
	const height = Math.max(1, Math.round(panel.height / 4));
	return {
		x: panel.x + Math.round((panel.width - width) / 2),
		y: panel.y + Math.round((panel.height - height) / 2),
		width,
		height,
	};
}

/** Maps a rect from the Finder page's CSS pixels to screen coordinates. */
export function screenOrigin(content: Bounds, rect: Bounds, zoomFactor: number): Bounds {
	return {
		x: Math.round(content.x + rect.x * zoomFactor),
		y: Math.round(content.y + rect.y * zoomFactor),
		width: Math.round(rect.width * zoomFactor),
		height: Math.round(rect.height * zoomFactor),
	};
}

