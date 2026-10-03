import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import {
	CONTEXT_MENU_WIDTH,
	estimateMenuHeight,
	type FinderMenuAction,
	type FinderMenuEntry,
	menuPlacement,
} from "../../state/context-menu";

/**
 * Row context menu (v7 `.menu`): fixed at the cursor, 28px items with the
 * shortcut hint right-aligned, closes on outside mousedown. Esc is handled by
 * the window keymap so the whole dismissal order stays in one place.
 */
export function ContextMenu({
	cursor,
	entries,
	onSelect,
	onClose,
}: {
	readonly cursor: { readonly x: number; readonly y: number };
	readonly entries: readonly FinderMenuEntry[];
	readonly onSelect: (action: FinderMenuAction) => void;
	readonly onClose: () => void;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);

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
			{entries.map((entry, index) =>
				entry.kind === "separator" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: separators carry no identity
					<div key={`sep-${index}`} className="menu__separator h-px my-4 mx-6 bg-divider" role="separator" />
				) : (
					<button
						key={entry.action}
						type="button"
						role="menuitem"
						className={cn(
							`menu__item${entry.tone === "danger" ? " menu__item--danger" : ""}${
								entry.tone === "warning" ? " menu__item--warning" : ""
							}`,
							"flex items-center gap-8 h-icon-sm px-10 border-0 rounded-6 bg-transparent text-ink text-sm text-left whitespace-nowrap transition-[background] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover disabled:opacity-40 disabled:cursor-default",
							entry.tone === "danger" && "text-danger-text",
							entry.tone === "warning" && "text-error-orange-text",
						)}
						disabled={entry.disabled}
						onClick={() => onSelect(entry.action)}
					>
						<span className="menu__label flex-1">{entry.label}</span>
						{entry.keycap === null ? null : (
							<span className="menu__keycap flex-none ml-auto text-ink-faint text-badge">{entry.keycap}</span>
						)}
					</button>
				),
			)}
		</div>
	);
}
