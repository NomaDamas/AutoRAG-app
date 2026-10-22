/**
 * A GFM pipe table as a scrolling table, shared by AI Search answers and
 * evidence excerpts. The caller decides how one cell line renders (evidence
 * excerpts print `[n]` as text, answers render citation chips), so the frame and
 * the table styling stay in one place.
 */

import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn";
import type { PipeTablePart } from "../state/excerpt-format";

/** Narrow-column table: scrolls sideways instead of crushing its columns. */
export const TABLE_WRAP = "evidence__table-wrap max-w-full overflow-x-auto rounded-6 border border-border bg-window";
export const TABLE =
	"min-w-full border-collapse text-badge leading-[1.45] text-ink-body break-keep [overflow-wrap:anywhere] [&_td]:min-w-[64px] [&_th]:min-w-[64px] [&_td]:align-top [&_th]:align-top [&_td]:py-4 [&_th]:py-4 [&_td]:px-8 [&_th]:px-8 [&_td]:border-b [&_th]:border-b [&_td]:border-r [&_th]:border-r [&_td]:border-border [&_th]:border-border [&_td:last-child]:border-r-0 [&_th:last-child]:border-r-0 [&_tr:last-child>td]:border-b-0 [&_th]:bg-code [&_th]:font-semibold [&_th]:text-ink [&_th]:text-left [&_strong]:text-ink [&_strong]:font-semibold";

/** One cell: a line per `<br>` a parser wrote for an in-cell line break, each rendered by `renderLine`. */
function Cell({ text, renderLine }: { readonly text: string; readonly renderLine: (line: string) => ReactNode }): ReactElement {
	return (
		<>
			{text.split(/<br\s*\/?>/iu).map((line, index) => (
				<span key={`${index}`}>
					{index === 0 ? null : <br />}
					{renderLine(line)}
				</span>
			))}
		</>
	);
}

export function PipeTable({
	table,
	renderLine,
	wrapClassName,
	tableClassName,
}: {
	readonly table: Pick<PipeTablePart, "header" | "align" | "rows">;
	/** Render one line of one cell's inline markdown. */
	readonly renderLine: (line: string) => ReactNode;
	/** Extra classes on the scrolling frame (the caller's block marker). */
	readonly wrapClassName?: string;
	/** Classes merged over the table's, e.g. a larger text size. */
	readonly tableClassName?: string;
}): ReactElement {
	const { header, align, rows } = table;
	return (
		<div className={wrapClassName === undefined ? TABLE_WRAP : `${wrapClassName} ${TABLE_WRAP}`}>
			<table className={tableClassName === undefined ? TABLE : cn(TABLE, tableClassName)}>
				{header === null ? null : (
					<thead>
						<tr>
							{header.map((cell, column) => (
								<th key={`${column}`} style={{ textAlign: align[column] ?? "left" }}>
									<Cell text={cell} renderLine={renderLine} />
								</th>
							))}
						</tr>
					</thead>
				)}
				<tbody>
					{rows.map((row, line) => (
						<tr key={`${line}`}>
							{row.map((cell, column) => (
								<td key={`${column}`} style={align[column] == null ? undefined : { textAlign: align[column] }}>
									<Cell text={cell} renderLine={renderLine} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
