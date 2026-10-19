import { open, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema, type SchemaTree } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { DataCell, DataColumn, DataPreview, DataRows, DataTable } from "../shared/contract";

/** Rows the grid shows. */
export const DATA_ROW_LIMIT = 100;
/** Columns the grid shows; wider tables are cut and say so. */
export const DATA_COLUMN_LIMIT = 50;
/** Longest text a cell carries; the rest is cut with an ellipsis. */
export const DATA_CELL_LIMIT = 200;
/** A table's row count stops here and is shown as "100,000+". */
export const DATA_COUNT_LIMIT = 100_000;
/** A Parquet row group larger than this is not decoded: it could not be read within the preview's time and memory. */
const ROW_GROUP_BYTE_LIMIT = 64 * 1024 * 1024;

const SQLITE_MAGIC = "SQLite format 3\0";

function cellText(text: string): string {
	return text.length > DATA_CELL_LIMIT ? `${text.slice(0, DATA_CELL_LIMIT)}…` : text;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readPrefix(path: string, length: number): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function sqliteCell(value: SQLOutputValue): DataCell {
	if (value === null) return null;
	if (value instanceof Uint8Array) return { blob: value.byteLength };
	return cellText(String(value));
}

interface TableEntry {
	readonly name: string;
	readonly view: boolean;
}

function listTables(db: DatabaseSync): TableEntry[] {
	const rows = db.prepare("select name, type from sqlite_schema where type in ('table', 'view') and name not like 'sqlite\\_%' escape '\\' order by type, name").all();
	return rows.map((row) => ({ name: String(row.name), view: row.type === "view" }));
}

function countRows(db: DatabaseSync, name: string): DataTable {
	const row = db.prepare(`select count(*) as n from (select 1 from ${quoteIdentifier(name)} limit ${DATA_COUNT_LIMIT})`).get();
	const rowCount = Number(row?.n ?? 0);
	return { name, view: false, rowCount, exact: rowCount < DATA_COUNT_LIMIT };
}

function readRows(db: DatabaseSync, entry: TableEntry): DataRows {
	const base = { name: entry.name, rows: [], more: false, columnsCut: false } as const;
	try {
		const info = db.prepare(`pragma table_xinfo(${quoteIdentifier(entry.name)})`).all();
		const all: DataColumn[] = info.filter((column) => column.hidden === 0 || column.hidden === 2 || column.hidden === 3).map((column) => ({ name: String(column.name), type: String(column.type ?? "").toUpperCase() }));
		const columns = all.slice(0, DATA_COLUMN_LIMIT);
		if (entry.view) return { ...base, columns, columnsCut: all.length > columns.length, failure: "view" };
		if (columns.length === 0) return { ...base, columns, failure: null };
		const select = columns.map((column) => quoteIdentifier(column.name)).join(", ");
		const statement = db.prepare(`select ${select} from ${quoteIdentifier(entry.name)} limit ${DATA_ROW_LIMIT + 1}`);
		statement.setReadBigInts(true);
		statement.setReturnArrays(true);
		const fetched = statement.all();
		const rows = fetched.slice(0, DATA_ROW_LIMIT).map((row) => (row as unknown as SQLOutputValue[]).map(sqliteCell));
		return { name: entry.name, columns, rows, more: fetched.length > DATA_ROW_LIMIT, columnsCut: all.length > columns.length, failure: null };
	} catch (error) {
		if (error instanceof Error) return { ...base, columns: [], failure: "table" };
		throw error;
	}
}

async function previewSqlite(path: string, table: string | null): Promise<DataPreview> {
	const head = await readPrefix(path, SQLITE_MAGIC.length);
	if (new TextDecoder("latin1").decode(head) !== SQLITE_MAGIC) return { kind: "unreadable", reason: "not-sqlite" };
	let walPending = false;
	try {
		walPending = (await stat(`${path}-wal`)).size > 0;
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	// `immutable=1` makes SQLite skip locking and the `-wal`/`-shm` files entirely, so the
	// preview can neither block a writer nor create or modify a sidecar file.
	const uri = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(uri, { readOnly: true, readBigInts: false, allowExtension: false });
		// A stored view or trigger must not reach for functions an attacker-written schema could abuse.
		db.exec("pragma trusted_schema = off");
		const entries = listTables(db);
		const tables: DataTable[] = entries.map((entry) => (entry.view ? { name: entry.name, view: true, rowCount: null, exact: true } : countRows(db as DatabaseSync, entry.name)));
		const wanted = table === null ? (entries.find((entry) => !entry.view) ?? entries[0]) : entries.find((entry) => entry.name === table);
		const selected: DataRows | null = wanted === undefined ? (table === null ? null : { name: table, columns: [], rows: [], more: false, columnsCut: false, failure: "table" }) : readRows(db, wanted);
		return { kind: "database", tables, selected, walPending };
	} catch (error) {
		if (error instanceof Error) return { kind: "unreadable", reason: "corrupt" };
		throw error;
	} finally {
		db?.close();
	}
}

function parquetCell(value: unknown): DataCell {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return cellText(value);
	if (typeof value === "bigint") return String(value);
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (value instanceof Uint8Array) return { blob: value.byteLength };
	if (typeof value === "object") return cellText(JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? String(inner) : inner instanceof Uint8Array ? `<${inner.byteLength} bytes>` : inner)));
	return cellText(String(value));
}

function parquetType(node: SchemaTree): string {
	const { element } = node;
	if (node.children.length > 0) return element.logical_type?.type ?? element.converted_type ?? "STRUCT";
	return element.logical_type?.type ?? element.converted_type ?? element.type ?? "";
}

async function previewParquet(path: string): Promise<DataPreview> {
	const head = new TextDecoder("latin1").decode(await readPrefix(path, 4));
	if (head === "PARE") return { kind: "unreadable", reason: "encrypted" };
	if (head !== "PAR1") return { kind: "unreadable", reason: "not-parquet" };
	try {
		const file = await asyncBufferFromFile(path);
		const metadata = await parquetMetadataAsync(file);
		const top = parquetSchema(metadata).children;
		const all = top.map((node) => ({ name: node.element.name, type: parquetType(node) }));
		const columns = all.slice(0, DATA_COLUMN_LIMIT);
		const rowCount = Number(metadata.num_rows);
		const first = metadata.row_groups[0];
		const base = { kind: "parquet", rowCount, rowGroups: metadata.row_groups.length, createdBy: metadata.created_by ?? null } as const;
		const empty = { name: "", columns, rows: [], more: false, columnsCut: all.length > columns.length } as const;
		if (first === undefined || rowCount === 0) return { ...base, selected: { ...empty, failure: null } };
		if (Number(first.total_byte_size) > ROW_GROUP_BYTE_LIMIT) return { ...base, selected: { ...empty, failure: "too-large" } };
		const objects = await parquetReadObjects({ file, compressors, columns: columns.map((column) => column.name), rowStart: 0, rowEnd: DATA_ROW_LIMIT + 1 });
		const rows = objects.slice(0, DATA_ROW_LIMIT).map((row) => columns.map((column) => parquetCell(row[column.name])));
		return { ...base, selected: { ...empty, rows, more: rowCount > DATA_ROW_LIMIT, failure: null } };
	} catch (error) {
		if (error instanceof Error) return { kind: "unreadable", reason: "corrupt" };
		throw error;
	}
}

/**
 * Structure and first rows of a database or Parquet file for Quick Look. Reads
 * are bounded (row, column, cell, and count caps), run no stored SQL, and never
 * write: SQLite opens `mode=ro&immutable=1`, Parquet reads the footer and the
 * first row group's byte ranges.
 */
export async function previewData(path: string, table: string | null): Promise<DataPreview> {
	return path.toLowerCase().endsWith(".parquet") ? previewParquet(path) : previewSqlite(path, table);
}

