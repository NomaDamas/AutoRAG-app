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
import { TagDotMark } from "./TagDot";

/** What a menu choice carries beyond its action: a new-file format, a service, or a Finder tag name. */
export type MenuSelect = (action: FinderMenuAction, format: NewFileFormatId | null, serviceId: string | null, tagName: string | null) => void;

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
	readonly onSelect: MenuSelect;
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
				if (entry.kind === "tags") {
					return (
						<div key="tags" className="menu__tags flex flex-col gap-4 px-10 py-4" role="group" aria-label={entry.label}>
							<span className="text-badge text-ink-muted">{entry.label}</span>
							<div className="flex items-center gap-8">
								{entry.swatches.map((swatch) => (
									<button
										key={swatch.color}
										type="button"
										role="menuitemcheckbox"
										aria-checked={swatch.checked}
										aria-label={swatch.name}
										title={swatch.name}
										className={cn(
											"menu__swatch flex items-center justify-center size-16 p-0 border-0 rounded-full bg-transparent cursor-default",
											swatch.checked && "shadow-[0_0_0_2px_var(--bg-window),0_0_0_3.5px_var(--accent)]",
										)}
										onClick={() => onSelect("toggleTag", null, null, swatch.name)}
									>
										<TagDotMark color={swatch.color} size={14} />
									</button>
								))}
							</div>
						</div>
					);
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
							{open ? <SubmenuPanel submenu={entry} anchorTop={openSubmenu.anchorTop} rootLeft={placement.left} depth={0} onSelect={onSelect} /> : null}
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
						onClick={() => onSelect(entry.action, null, null, null)}
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

/** A row's box in viewport pixels: where a nested panel anchors. */
interface AnchorRect {
	readonly top: number;
	readonly left: number;
	readonly right: number;
}

function anchorRectOf(element: HTMLElement): AnchorRect {
	const { top, left, right } = element.getBoundingClientRect();
	return { top, left, right };
}

/**
 * One popout panel. A leaf runs its action; a nested parent (an application's
 * group under 서비스) opens one more panel beside this one.
 *
 * A first-level panel hangs off the root menu (`absolute`, flipping left when
 * the window's right edge would clip it). A nested panel is `fixed` at its
 * row's viewport rect instead: its parent may scroll (`overflow-y: auto` for a
 * long service list), and a scroll container clips absolutely positioned
 * descendants. `depth` counts panels already open to the right of the root.
 */
function SubmenuPanel({
	submenu,
	anchorTop,
	rootLeft,
	depth,
	fixedAt,
	onSelect,
}: {
	readonly submenu: FinderMenuSubmenu;
	readonly anchorTop: number;
	readonly rootLeft: number;
	readonly depth: number;
	/** The parent row's rect when this panel is nested; absent for a first-level panel. */
	readonly fixedAt?: AnchorRect;
	readonly onSelect: MenuSelect;
}): ReactElement {
	const [openChild, setOpenChild] = useState<{ readonly label: string; readonly rect: AnchorRect } | null>(null);
	const wanted = menuHeightForItems(submenu.items.length);
	const available = window.innerHeight - 16;
	// A list taller than the window scrolls; one that fits never grows a scrollbar.
	const height = Math.min(wanted, available);
	const scrolls = wanted > available;
	// Keep the popout inside the window: shift it up when its bottom would clip.
	const top = Math.max(8, Math.min(anchorTop, window.innerHeight - 8 - height));
	const nested =
		fixedAt === undefined
			? {
					className: popoutFlipsLeft(rootLeft, depth) ? "absolute right-full" : "absolute left-full",
					style: { top: top - anchorTop, maxHeight: height, ...(scrolls ? { overflowY: "auto" as const } : {}) },
				}
			: {
					className: "fixed",
					style: {
						top,
						left: fixedAt.right + CONTEXT_MENU_WIDTH > window.innerWidth - 8 ? fixedAt.left - CONTEXT_MENU_WIDTH : fixedAt.right,
						maxHeight: height,
						...(scrolls ? { overflowY: "auto" as const } : {}),
					},
				};
	return (
		<div
			className={cn(
				"menu z-70 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]",
				nested.className,
			)}
			role="menu"
			aria-label={submenu.label}
			style={nested.style}
		>
			{submenu.items.map((entry) =>
				entry.kind === "submenu" ? (
					<div
						key={`group-${entry.label}`}
						className="relative"
						onMouseEnter={(event) => setOpenChild({ label: entry.label, rect: anchorRectOf(event.currentTarget) })}
						onMouseLeave={() => setOpenChild(null)}
					>
						<button
							type="button"
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={openChild?.label === entry.label}
							className={cn(ITEM_CLASS, openChild?.label === entry.label && "bg-hover")}
							onClick={(event) =>
								setOpenChild((current) =>
									current?.label === entry.label ? null : { label: entry.label, rect: anchorRectOf(event.currentTarget) },
								)
							}
							onKeyDown={(event) => {
								if (event.key === "ArrowRight") {
									event.preventDefault();
									setOpenChild({ label: entry.label, rect: anchorRectOf(event.currentTarget) });
								}
							}}
						>
							<span className="menu__label flex-1">{entry.label}</span>
							<span className="menu__chevron flex-none ml-auto text-ink-faint">
								<ChevronRightSmallIcon />
							</span>
						</button>
						{openChild?.label === entry.label ? (
							<SubmenuPanel
								submenu={entry}
								anchorTop={openChild.rect.top}
								rootLeft={rootLeft}
								depth={depth + 1}
								fixedAt={openChild.rect}
								onSelect={onSelect}
							/>
						) : null}
					</div>
				) : (
					<button
						key={`${entry.action}-${entry.serviceId ?? entry.format ?? entry.tagName ?? "folder"}`}
						type="button"
						role={entry.action === "toggleTag" ? "menuitemcheckbox" : "menuitem"}
						aria-checked={entry.action === "toggleTag" ? entry.checked === true : undefined}
						className={ITEM_CLASS}
						onClick={() => onSelect(entry.action, entry.format, entry.serviceId ?? null, entry.tagName ?? null)}
					>
						<span className="menu__label flex-1 truncate">{entry.label}</span>
						{entry.checked === true ? <span className="menu__check flex-none ml-auto text-ink-muted">✓</span> : null}
					</button>
				),
			)}
		</div>
	);
}

/** A first-level popout flips left when the window's right edge would clip it. */
function popoutFlipsLeft(rootLeft: number, depth: number): boolean {
	return rootLeft + CONTEXT_MENU_WIDTH * (depth + 2) > window.innerWidth;
}
