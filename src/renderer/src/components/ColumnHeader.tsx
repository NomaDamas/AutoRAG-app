import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import {
	LIST_COLUMN_OPTIONS,
	listGridTemplate,
	type ListColumnKey,
	type ListColumnsState,
} from "../state/list-columns";
import type { SortKey, SortState } from "../state/sort";
import { ChevronUpIcon } from "./icons";

/** Columns the header can sort by; everything else renders a static label. */
const SORT_KEYS: Readonly<Record<string, SortKey>> = {
	name: "name",
	date: "date",
	size: "size",
	kind: "kind",
};

/** Columns whose right edge carries a drag grip. */
const RESIZABLE: Readonly<Record<string, true>> = { name: true, size: true, kind: true };

/**
 * List column header (v7 handoff): 24px sticky grid matching the row template,
 * sort buttons on Name / Date Modified / Size / Kind, a right-click column menu
 * and drag grips on the resizable tracks.
 */
export function ColumnHeader({
	sort,
	searching,
	onSort,
	columns,
	onToggleColumn,
	onResetColumns,
	onResizeColumn,
}: {
	readonly sort: SortState | null;
	readonly searching: boolean;
	readonly onSort: (key: SortKey) => void;
	readonly columns: ListColumnsState;
	readonly onToggleColumn: (key: ListColumnKey) => void;
	readonly onResetColumns: () => void;
	readonly onResizeColumn: (key: string, px: number) => void;
}): ReactElement {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const drag = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
	const descending = sort !== null && sort.dir < 0;

	useEffect(() => {
		if (menu === null) return;
		const close = (event: MouseEvent): void => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			setMenu(null);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const openMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
		event.preventDefault();
		setMenu({
			x: Math.max(10, Math.min(event.clientX, window.innerWidth - 240)),
			y: Math.max(10, Math.min(event.clientY, window.innerHeight - 520)),
		});
	};

	const startResize = (key: string) => (event: ReactPointerEvent<HTMLSpanElement>): void => {
		const cell = event.currentTarget.parentElement;
		if (cell === null) return;
		event.preventDefault();
		event.stopPropagation();
		drag.current = { key, startX: event.clientX, startWidth: cell.getBoundingClientRect().width };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const moveResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
		const state = drag.current;
		if (state === null) return;
		onResizeColumn(state.key, state.startWidth + (event.clientX - state.startX));
	};

	const endResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
		if (drag.current === null) return;
		drag.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
	};

	const visible = LIST_COLUMN_OPTIONS.filter((option) => option.key === "name" || columns.visible[option.key]);

	return (
		<>
			<div
				className="col-header grid flex-none items-center gap-8 h-[24px] px-13 border-b border-border text-ink-muted text-badge font-medium cursor-default"
				style={{ gridTemplateColumns: listGridTemplate(columns) }}
				data-searching={searching ? "" : undefined}
				onContextMenu={openMenu}
			>
				{visible.map((option, index) => {
					const sortKey = option.key === "name" ? undefined : SORT_KEYS[option.key];
					const active = sortKey !== undefined && sort !== null && sort.key === sortKey;
					return (
						<div
							key={option.key}
							className={[
								"relative flex items-center min-w-0 h-full",
								option.key === "index" ? "justify-center" : "",
							].join(" ")}
						>
							{index > 0 ? (
								<span
									className="absolute left-[-4.5px] top-5 bottom-5 w-1 bg-border"
									aria-hidden="true"
								/>
							) : null}
							{sortKey !== undefined ? (
								<button
									type="button"
									className={[
										"col-header__sort flex items-center gap-4 w-full min-w-0 h-full p-0 pr-10 border-0 bg-transparent text-badge font-medium text-left whitespace-nowrap",
										active ? "text-ink font-semibold" : "text-inherit hover:text-ink",
									].join(" ")}
									title={`Sort by ${option.label}`}
									onClick={() => onSort(sortKey)}
								>
									<span className="col-header__label overflow-hidden text-ellipsis">{option.label}</span>
									{active ? (
										<ChevronUpIcon
											className={[
												"col-header__chevron flex-none",
												descending ? "rotate-180" : "",
											].join(" ")}
										/>
									) : null}
								</button>
							) : (
								<span className="col-header__label min-w-0 overflow-hidden text-ellipsis">{option.label}</span>
							)}
							{RESIZABLE[option.key] ? (
								<span
									className="col-grip absolute -right-4 top-0 w-8 h-full cursor-col-resize"
									role="separator"
									aria-label={`Resize ${option.label}`}
									onPointerDown={startResize(option.key)}
									onPointerMove={moveResize}
									onPointerUp={endResize}
									onPointerCancel={endResize}
								/>
							) : null}
						</div>
					);
				})}
			</div>
			{menu !== null ? (
				<div
					ref={menuRef}
					className="col-menu fixed z-[80] w-[230px] p-4 bg-window border border-border rounded-10 shadow-menu"
					role="menu"
					aria-label="Columns"
					style={{ left: menu.x, top: menu.y }}
					onContextMenu={(event) => event.preventDefault()}
				>
					{LIST_COLUMN_OPTIONS.map((option) => {
						const fixed = option.key === "name";
						const shown = option.key === "name" ? true : columns.visible[option.key];
						return (
							<button
								key={option.key}
								type="button"
								className={[
									"col-menu__option flex items-center gap-7 w-full h-[24px] px-8 border-0 rounded-5 bg-transparent text-badge text-left",
									fixed
										? "text-ink-muted cursor-default"
										: "text-ink-body cursor-default hover:bg-hover hover:text-ink",
								].join(" ")}
								role="menuitemcheckbox"
								aria-checked={shown}
								disabled={fixed}
								onClick={() => {
									if (option.key !== "name") onToggleColumn(option.key);
								}}
							>
								<span
									className={`col-menu__check flex-none w-14 text-center ${shown ? "text-accent" : "text-transparent"}`}
									aria-hidden="true"
								>
									✓
								</span>
								<span className="col-menu__label ml-auto">{option.label}</span>
							</button>
						);
					})}
					<hr className="col-menu__sep my-4 border-0 border-t border-divider" />
					<button
						type="button"
						className="col-menu__reset flex items-center w-full h-[24px] px-8 border-0 rounded-5 bg-transparent text-badge text-ink-body text-left cursor-default hover:bg-hover hover:text-ink"
						role="menuitem"
						onClick={() => {
							onResetColumns();
							setMenu(null);
						}}
					>
						Use Default Columns
					</button>
				</div>
			) : null}
		</>
	);
}
