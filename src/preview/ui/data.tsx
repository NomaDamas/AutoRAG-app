import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { DataCell, DataPreview, DataRows, DataTable, PreviewDocument } from "../shared/contract";
import { formatBytes } from "../shared/format";
import { useChrome } from "./chrome";
import { FallbackView, Status } from "./fallback";

const DATA_SIZE = { width: 980, height: 674 } as const;

const FOOTER = "flex flex-none items-center gap-14 h-30 px-16 border-t-[0.5px] border-ql-hairline text-ql-ink-secondary text-[11.5px] whitespace-nowrap";

type Loaded = { readonly path: string; readonly table: string | null; readonly preview: DataPreview } | { readonly path: string; readonly table: string | null; readonly error: string };

function CellView({ cell }: { readonly cell: DataCell }): ReactElement {
	const { t, i18n } = useTranslation();
	if (cell === null) return <span className="text-ql-ink-secondary italic">NULL</span>;
	if (typeof cell === "string") return <>{cell}</>;
	return <span className="text-ql-ink-secondary italic">{t("quickLook.data.blob", { size: formatBytes(cell.blob), count: cell.blob.toLocaleString(i18n.language) })}</span>;
}

function Grid({ data }: { readonly data: DataRows }): ReactElement {
	const { t, i18n } = useTranslation();
	if (data.failure === "view") return <Status>{t("quickLook.data.viewNotRun")}</Status>;
	if (data.failure === "table") return <Status>{t("quickLook.data.tableFailed")}</Status>;
	if (data.failure === "too-large") return <Status>{t("quickLook.data.tooLarge")}</Status>;
	if (data.columns.length === 0) return <Status>{t("quickLook.data.noColumns")}</Status>;
	return (
		<div className="flex flex-col flex-1 min-w-0 min-h-0">
			<div className="ql-data__grid flex-1 min-h-0 overflow-auto bg-ql-paper select-text">
				<table className="border-collapse font-ql-mono text-[12px] [&_th]:sticky [&_th]:top-0 [&_th]:bg-ql-sunk [&_th]:text-left [&_th]:font-semibold [&_th]:text-ql-ink [&_th]:max-w-[320px] [&_td]:max-w-[320px] [&_th]:px-10 [&_td]:px-10 [&_th]:py-5 [&_td]:py-4 [&_th]:overflow-hidden [&_td]:overflow-hidden [&_th]:text-ellipsis [&_td]:text-ellipsis [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap [&_th]:border-b [&_td]:border-b [&_th]:border-r [&_td]:border-r [&_th]:border-ql-hairline [&_td]:border-ql-hairline">
					<thead>
						<tr>
							{data.columns.map((column, index) => (
								<th key={index} title={column.type === "" ? column.name : `${column.name} · ${column.type}`}>
									{column.name}
									{column.type === "" ? null : <span className="ml-6 font-normal text-ql-ink-secondary">{column.type}</span>}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{data.rows.length === 0 ? (
							<tr>
								<td colSpan={data.columns.length} className="text-ql-ink-secondary">
									{t("quickLook.data.noRows")}
								</td>
							</tr>
						) : (
							data.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex} title={typeof cell === "string" ? cell : undefined}>
											<CellView cell={cell} />
										</td>
									))}
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
			{data.more || data.columnsCut ? (
				<div className="flex-none px-16 py-6 border-t-[0.5px] border-ql-hairline bg-ql-sunk text-[11.5px] text-ql-ink-secondary">
					{data.more ? t("quickLook.data.firstRows", { count: data.rows.length.toLocaleString(i18n.language) }) : null}
					{data.more && data.columnsCut ? " · " : null}
					{data.columnsCut ? t("quickLook.data.columnsCut", { count: data.columns.length.toLocaleString(i18n.language) }) : null}
				</div>
			) : null}
		</div>
	);
}

function TableCount({ table }: { readonly table: DataTable }): ReactElement {
	const { t, i18n } = useTranslation();
	if (table.rowCount === null) return <>{t("quickLook.data.view")}</>;
	const count = table.rowCount.toLocaleString(i18n.language);
	return <>{table.exact ? count : t("quickLook.data.rowsAtLeast", { count })}</>;
}

/**
 * SQLite databases and Parquet files. The main process opens the file read-only
 * and sends back capped rows; this page never receives the file or runs SQL.
 */
export function DataView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const { bridge, report } = useChrome();
	const [table, setTable] = useState<string | null>(null);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	useEffect(() => report(DATA_SIZE, "clamp"), [report]);
	useEffect(() => {
		let cancelled = false;
		bridge.dataPreview(file.path, table).then(
			(preview) => {
				if (!cancelled) setLoaded({ path: file.path, table, preview });
			},
			(caught: unknown) => {
				if (!cancelled) setLoaded({ path: file.path, table, error: caught instanceof Error ? caught.message : t("quickLook.data.readFailed") });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, file.path, table, t]);
	useEffect(() => setTable(null), [file.path]);

	if (loaded === null || loaded.path !== file.path) return <Status>{t("quickLook.status.loading")}</Status>;
	if ("error" in loaded) return <FallbackView file={file} note={loaded.error} />;
	const { preview } = loaded;
	if (preview.kind === "unreadable") return <FallbackView file={file} note={t(`quickLook.data.unreadable.${preview.reason}`)} />;
	if (preview.kind === "parquet") {
		return (
			<>
				<Grid data={preview.selected} />
				<footer className={FOOTER}>
					<span className="font-semibold text-ql-ink">Parquet</span>
					<span>{t("quickLook.data.rows", { count: preview.rowCount.toLocaleString(i18n.language) })}</span>
					<span>{t("quickLook.data.columns", { count: preview.selected.columns.length.toLocaleString(i18n.language) })}</span>
					<span>{t("quickLook.data.rowGroups", { count: preview.rowGroups.toLocaleString(i18n.language) })}</span>
					{preview.createdBy === null ? null : <span className="overflow-hidden text-ellipsis">{preview.createdBy}</span>}
				</footer>
			</>
		);
	}
	const active = preview.selected?.name ?? null;
	return (
		<>
			<div className="flex flex-1 min-h-0">
				<nav aria-label={t("quickLook.data.tables")} className="flex flex-none flex-col w-[220px] overflow-auto py-8 border-r-[0.5px] border-ql-hairline bg-ql-sunk text-[12.5px]">
					{preview.tables.length === 0 ? <span className="px-14 py-6 text-ql-ink-secondary">{t("quickLook.data.noTables")}</span> : null}
					{preview.tables.map((entry) => (
						<button
							key={entry.name}
							type="button"
							aria-pressed={entry.name === active}
							className="flex items-center gap-8 mx-6 px-8 py-4 border-0 rounded-5 bg-transparent text-left text-ql-ink font-ql cursor-default aria-pressed:bg-ql-highlight"
							onClick={() => setTable(entry.name)}
						>
							<span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
							<span className="flex-none text-[11px] text-ql-ink-secondary"><TableCount table={entry} /></span>
						</button>
					))}
				</nav>
				{preview.selected === null ? <Status>{t("quickLook.data.noTables")}</Status> : <Grid data={preview.selected} />}
			</div>
			<footer className={FOOTER}>
				<span className="font-semibold text-ql-ink">SQLite</span>
				<span>{t("quickLook.data.tableCount", { count: preview.tables.length.toLocaleString(i18n.language) })}</span>
				{preview.walPending ? <span>{t("quickLook.data.walPending")}</span> : null}
			</footer>
		</>
	);
}
