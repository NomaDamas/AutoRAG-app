export interface Size {
	readonly width: number;
	readonly height: number;
}

export interface Bounds extends Size {
	readonly x: number;
	readonly y: number;
}

export const QUICK_LOOK_TOOLBAR = 46;
export const QUICK_LOOK_MIN: Size = { width: 360, height: 240 };

const MEDIA_WIDTH_SHARE = 0.86;
const MEDIA_HEIGHT_SHARE = 0.86;
const DOCUMENT: Size = { width: 880, height: 1040 };
const DOCUMENT_SHARE = 0.86;

/**
 * How a viewer's preferred size meets the screen. `aspect` scales media and
 * page-shaped content uniformly; `clamp` keeps a document's preferred width and
 * caps each side on its own, so a long file opens tall instead of narrow.
 */
export type QuickLookFit = "aspect" | "clamp";

/**
 * Window size for one previewed item, like macOS Quick Look: the window hugs
 * the size the viewer asked for (media, a PDF page, a laid-out panel), never
 * upscaling past it and staying inside a share of the screen. Content that
 * cannot measure itself gets a page-shaped window.
 */
export function fitQuickLook(content: Size, workArea: Size, fit: QuickLookFit): Size {
	if (content.width <= 0 || content.height <= 0) {
		return {
			width: Math.round(Math.min(DOCUMENT.width, workArea.width * DOCUMENT_SHARE)),
			height: Math.round(Math.min(DOCUMENT.height, workArea.height * DOCUMENT_SHARE)),
		};
	}
	const maxWidth = workArea.width * MEDIA_WIDTH_SHARE;
	const maxHeight = workArea.height * MEDIA_HEIGHT_SHARE - QUICK_LOOK_TOOLBAR;
	const widthScale = Math.min(1, maxWidth / content.width);
	const heightScale = Math.min(1, maxHeight / content.height);
	const uniform = Math.min(widthScale, heightScale);
	const [x, y] = fit === "aspect" ? [uniform, uniform] : [widthScale, heightScale];
	return {
		width: Math.max(QUICK_LOOK_MIN.width, Math.round(content.width * x)),
		height: Math.max(QUICK_LOOK_MIN.height, Math.round(content.height * y) + QUICK_LOOK_TOOLBAR),
	};
}

/** Keeps the window's center where it was (or the screen center) and clamps it on screen. */
export function placeQuickLook(size: Size, previous: Bounds | null, workArea: Bounds): Bounds {
	const width = Math.min(size.width, workArea.width);
	const height = Math.min(size.height, workArea.height);
	const centerX = previous === null ? workArea.x + workArea.width / 2 : previous.x + previous.width / 2;
	const centerY = previous === null ? workArea.y + workArea.height / 2 : previous.y + previous.height / 2;
	const x = Math.min(Math.max(Math.round(centerX - width / 2), workArea.x), workArea.x + workArea.width - width);
	const y = Math.min(Math.max(Math.round(centerY - height / 2), workArea.y), workArea.y + workArea.height - height);
	return { x, y, width, height };
}
