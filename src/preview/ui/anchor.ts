import type { AnchorRect } from "../shared/session";

export function anchorForPath(path: string): AnchorRect | null {
	const node = document.querySelector(`[data-quicklook-anchor="${CSS.escape(path)}"]`);
	if (!(node instanceof Element)) return null;
	const rect = node.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
