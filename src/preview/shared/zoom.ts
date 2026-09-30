export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ZoomTransform {
	readonly x: number;
	readonly y: number;
	readonly scale: number;
}

/**
 * Quick Look grows from the file row. The scale stays uniform (a squashed
 * row-shaped panel looks nothing like macOS) and is clamped so a 32px row
 * still reads as a window, not a speck.
 */
export function zoomFromAnchor(anchor: Rect, dest: Rect): ZoomTransform {
	const raw = dest.height <= 0 ? 0.16 : anchor.height / dest.height;
	const scale = Math.min(0.22, Math.max(0.12, raw));
	const destCx = dest.x + dest.width / 2;
	const destCy = dest.y + dest.height / 2;
	const anchorCx = anchor.x + anchor.width / 2;
	const anchorCy = anchor.y + anchor.height / 2;
	return { x: anchorCx - destCx, y: anchorCy - destCy, scale };
}
