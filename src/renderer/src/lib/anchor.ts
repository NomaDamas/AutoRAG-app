import type { ActionAnchor } from "../../../shared/actions-contract";

/** The clicked element's rect in window CSS pixels, for menus and the share sheet. */
export function anchorOf(element: Element): ActionAnchor {
	const rect = element.getBoundingClientRect();
	return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}
