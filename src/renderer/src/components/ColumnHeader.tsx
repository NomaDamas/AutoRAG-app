import type { ReactElement } from "react";
import type { SortKey, SortState } from "../state/sort";
import { ChevronUpIcon } from "./icons";

interface ColumnSpec {
	readonly key: SortKey;
	readonly label: string;
	readonly right: boolean;
}

const FIXED_COLUMNS: readonly ColumnSpec[] = [
	{ key: "name", label: "Name", right: false },
	{ key: "date", label: "Date Modified", right: false },
	{ key: "size", label: "Size", right: true },
];

/**
 * Column header (handoff README §2): four sort buttons on the row grid; the
 * active column is ink-colored and shows the 10px chevron, rotated when
 * descending. "Kind" becomes "Where" while searching.
 */
export function ColumnHeader({
	sort,
	searching,
	onSort,
}: {
	readonly sort: SortState | null;
	readonly searching: boolean;
	readonly onSort: (key: SortKey) => void;
}): ReactElement {
	const columns: readonly ColumnSpec[] = [
		...FIXED_COLUMNS,
		searching ? { key: "where", label: "Where", right: false } : { key: "kind", label: "Kind", right: false },
	];

	return (
		<div className="col-header grid flex-none grid-cols-(--grid-file-row) gap-12 items-center h-col-header pl-20 pr-16 border-b border-border text-ink-muted text-meta font-medium">
			{columns.map((column) => {
				const active = sort !== null && sort.key === column.key;
				return (
					<button
						key={column.key}
						type="button"
						className={[
							`col-header__sort${active ? " col-header__sort--active" : ""}${
								column.right ? " col-header__sort--right" : ""
							}`,
							"flex items-center gap-4 min-w-0 h-pill p-0 border-0 bg-transparent text-meta font-medium whitespace-nowrap hover:text-ink",
							active ? "text-ink" : "text-inherit",
							column.right ? "justify-end" : "",
						].join(" ")}
						title={`Sort by ${column.label}`}
						onClick={() => onSort(column.key)}
					>
						<span className="col-header__label overflow-hidden text-ellipsis">{column.label}</span>
						{active ? (
							<ChevronUpIcon
								className={[
									`col-header__chevron${sort.dir < 0 ? " col-header__chevron--desc" : ""}`,
									"flex-none",
									sort.dir < 0 ? "rotate-180" : "",
								].join(" ")}
							/>
						) : null}
					</button>
				);
			})}
			<span>Index</span>
		</div>
	);
}
