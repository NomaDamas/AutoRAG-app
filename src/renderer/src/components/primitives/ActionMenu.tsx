import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { CONTEXT_MENU_WIDTH, menuHeightForItems, menuPlacement } from "../../state/context-menu";
import type { FileActionItem, FileActionTarget } from "../../state/file-actions";

/**
 * The variant menu an Inspector action opens ("이미지 편집", "동영상 변환").
 *
 * Same `.menu` surface and 28px rows as the row context menu, anchored to the
 * button instead of the cursor. `anchor` is the button's rect in window CSS
 * pixels; the shared placement helper flips it upward when it would overflow
 * the bottom, which is where the action bar always sits.
 */
export function ActionMenu({
	items,
	anchor,
	onSelect,
	onClose,
}: {
	readonly items: readonly FileActionItem[];
	readonly anchor: { readonly x: number; readonly y: number };
	readonly onSelect: (target: FileActionTarget) => void;
	readonly onClose: () => void;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onMouseDown = (event: globalThis.MouseEvent): void => {
			const node = ref.current;
			if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
			onClose();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose]);

	const placement = menuPlacement(
		anchor,
		{ width: CONTEXT_MENU_WIDTH, height: menuHeightForItems(items.length) },
		{ width: window.innerWidth, height: window.innerHeight },
	);

	return (
		<div
			ref={ref}
			className="menu fixed z-60 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
			role="menu"
			aria-label="세부 작업"
			style={{ left: `${placement.left}px`, top: `${placement.top}px` }}
		>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					role="menuitem"
					className="menu__item flex items-center gap-8 h-icon-sm px-10 border-0 rounded-6 bg-transparent text-ink text-sm text-left whitespace-nowrap transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
					onClick={() => {
						onSelect(item.target);
					}}
				>
					<span className="menu__label flex-1">{item.label}</span>
				</button>
			))}
		</div>
	);
}
