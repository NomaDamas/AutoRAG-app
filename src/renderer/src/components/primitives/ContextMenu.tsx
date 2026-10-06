import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import {
	CONTEXT_MENU_WIDTH,
	estimateMenuHeight,
	menuHeightForItems,
	menuPlacement,
	type FinderMenuAction,
	type FinderMenuEntry,
	type FinderMenuSubmenu,
} from "../../state/context-menu";
import type { NewFileFormatId } from "../../../../shared/new-file-contract";
import { ChevronRightSmallIcon } from "../icons";

/** Shared row styling for a menu item and a submenu parent. */
const ITEM_CLASS =
	"menu__item flex items-center gap-8 w-full h-icon-sm px-10 border-0 rounded-6 bg-transparent text-ink text-sm text-left whitespace-nowrap transition-[background] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover disabled:opacity-40 disabled:cursor-default";

/**
 * Row / empty-space context menu (v7 `.menu`): fixed at the cursor, 28px items
 * with the shortcut hint right-aligned, closes on outside mousedown. A submenu
 * parent (New) opens its popout panel on hover or click, flipping to the left
 * when the window's right edge would clip it. Esc is handled by the window
 * keymap so the whole dismissal order stays in one place.
 */
export function ContextMenu({
	cursor,
	entries,
	onSelect,
	onClose,
}: {
	readonly cursor: { readonly x: number; readonly y: number };
	readonly entries: readonly FinderMenuEntry[];
	readonly onSelect: (action: FinderMenuAction, format: NewFileFormatId | null) => void;
	readonly onClose: () => void;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const [openSubmenu, setOpenSubmenu] = useState<{ readonly label: string; readonly anchorTop: number } | null>(null);

	useEffect(() => {
		const onMouseDown = (event: globalThis.MouseEvent): void => {
			const node = ref.current;
			if (node !== null && event.target instanceof Node && node.contains(event.target)) {
				return;
			}
			onClose();
		};
		window.addEventListener("mousedown", onMouseDown);
		return () => window.removeEventListener("mousedown", onMouseDown);
	}, [onClose]);

	const placement = menuPlacement(
		cursor,
		{ width: CONTEXT_MENU_WIDTH, height: estimateMenuHeight(entries) },
		{ width: window.innerWidth, height: window.innerHeight },
	);
	// A popout at the right of the menu would leave the window: flip it left.
	const flipSubmenu = placement.left + CONTEXT_MENU_WIDTH * 2 > window.innerWidth;

	const submenuPanel = (submenu: FinderMenuSubmenu, anchorTop: number): ReactElement => {
		const height = menuHeightForItems(submenu.items.length);
		// Keep the popout inside the window: shift it up when its bottom would clip.
		const top = Math.max(8, Math.min(anchorTop, window.innerHeight - 8 - height)) - anchorTop;
		return (
			<div
				className={cn(
					"menu absolute z-70 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]",
					flipSubmenu ? "right-full" : "left-full",
				)}
				role="menu"
				aria-label={submenu.label}
				style={{ top, maxHeight: height }}
			>
				{submenu.items.map((entry) => (
					<button
						key={`${entry.action}-${entry.format ?? "folder"}`}
						type="button"
						role="menuitem"
						className={ITEM_CLASS}
						onClick={() => onSelect(entry.action, entry.format)}
					>
						<span className="menu__label flex-1">{entry.label}</span>
					</button>
				))}
			</div>
		);
	};

	return (
		<div
			ref={ref}
			className="menu fixed z-60 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
			role="menu"
			aria-label="파일 작업"
			style={{ left: `${placement.left}px`, top: `${placement.top}px` }}
		>
			{entries.map((entry, index) => {
				if (entry.kind === "separator") {
					// biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
					return <div key={`sep-${index}`} className="menu__separator h-px my-4 mx-6 bg-divider" role="separator" />;
				}
				if (entry.kind === "submenu") {
					const open = openSubmenu?.label === entry.label;
					return (
						<div
							key={entry.label}
							className="relative"
							onMouseEnter={(event) =>
								setOpenSubmenu({ label: entry.label, anchorTop: event.currentTarget.getBoundingClientRect().top })
							}
							onMouseLeave={() => setOpenSubmenu(null)}
						>
							<button
								type="button"
								role="menuitem"
								aria-haspopup="menu"
								aria-expanded={open}
								className={cn(ITEM_CLASS, open && "bg-hover")}
								onClick={(event) =>
									setOpenSubmenu((current) =>
										current?.label === entry.label
											? null
											: { label: entry.label, anchorTop: event.currentTarget.getBoundingClientRect().top },
									)
								}
								onKeyDown={(event) => {
									if (event.key === "ArrowRight") {
										event.preventDefault();
										setOpenSubmenu({
											label: entry.label,
											anchorTop: event.currentTarget.getBoundingClientRect().top,
										});
									}
								}}
							>
								<span className="menu__label flex-1">{entry.label}</span>
								<span className="menu__chevron flex-none ml-auto text-ink-faint">
									<ChevronRightSmallIcon />
								</span>
							</button>
							{open ? submenuPanel(entry, openSubmenu.anchorTop) : null}
						</div>
					);
				}
				return (
					<button
						key={entry.action}
						type="button"
						role="menuitem"
						className={cn(
							`menu__item${entry.tone === "danger" ? " menu__item--danger" : ""}${
								entry.tone === "warning" ? " menu__item--warning" : ""
							}`,
							ITEM_CLASS,
							entry.tone === "danger" && "text-danger-text",
							entry.tone === "warning" && "text-error-orange-text",
						)}
						disabled={entry.disabled}
						onClick={() => onSelect(entry.action, null)}
					>
						<span className="menu__label flex-1">{entry.label}</span>
						{entry.keycap === null ? null : (
							<span className="menu__keycap flex-none ml-auto text-ink-faint text-badge">{entry.keycap}</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
