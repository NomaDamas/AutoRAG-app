import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { CONTEXT_MENU_WIDTH, menuHeightForItems, menuPlacement } from "../../state/context-menu";
import type { FileActionItem, FileActionTarget } from "../../state/file-actions";

/** Tall menus (an application list) scroll instead of running off the window. */
const MAX_MENU_HEIGHT = 360;
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
		{ width: CONTEXT_MENU_WIDTH, height: Math.min(menuHeightForItems(items.length), MAX_MENU_HEIGHT) },
		{ width: window.innerWidth, height: window.innerHeight },
	);

	// Items from the first `separated` one on form a footer pinned below the
	// scrolling list, so "기타…" stays reachable however many applications precede it.
	const footerStart = items.findIndex((item) => item.separated === true);
	const listItems = footerStart < 0 ? items : items.slice(0, footerStart);
	const footerItems = footerStart < 0 ? [] : items.slice(footerStart);
	const renderItem = (item: FileActionItem): ReactElement => (
		<button
			key={item.id}
			type="button"
			role="menuitem"
			className="menu__item flex flex-none items-center gap-8 h-icon-sm px-10 border-0 rounded-6 bg-transparent text-ink text-sm text-left whitespace-nowrap transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
			onClick={() => {
				onSelect(item.target);
			}}
		>
			{item.icon === undefined ? null : item.icon === null ? (
				<span aria-hidden="true" className="size-16 flex-none" />
			) : (
				<img src={item.icon} alt="" aria-hidden="true" className="size-16 flex-none" draggable={false} />
			)}
			<span className="menu__label flex-1 min-w-0 truncate">{item.label}</span>
		</button>
	);

	return (
		<div
			ref={ref}
			className="menu fixed z-60 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
			role="menu"
			aria-label="세부 작업"
			style={{ left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${MAX_MENU_HEIGHT}px` }}
		>
			<div className="flex min-h-0 flex-col overflow-y-auto">{listItems.map(renderItem)}</div>
			{footerItems.length === 0 ? null : (
				<>
					<div className="menu__separator h-px my-4 mx-6 flex-none bg-divider" role="separator" />
					{footerItems.map(renderItem)}
				</>
			)}
		</div>
	);
}
