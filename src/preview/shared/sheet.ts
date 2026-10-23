import { read, utils } from "xlsx";
import { decodeText } from "./code";

/** Rows and columns the sheet panel draws; nothing past them is ever shown. */
export const SHEET_MAX_ROWS = 100;
export const SHEET_MAX_COLS = 20;
/**
 * Rows SheetJS reads per sheet. Blank rows are not drawn, so reading exactly
 * {@link SHEET_MAX_ROWS} could leave the panel short; a margin keeps it full
 * for sheets with gaps while still being a few hundred rows, not a few hundred thousand.
 */
const SHEET_READ_ROWS = 1000;

export interface SheetPreview {
	readonly names: readonly string[];
	readonly rows: readonly (readonly string[])[];
	/** Sheets SheetJS actually parsed (xlsx reads one; the binary and ODF readers parse them all). */
	readonly sheetsRead: readonly string[];
	/** Rows SheetJS read from the shown sheet before it stopped. */
	readonly scannedRows: number;
	/** True when a names-only pass ran first (workbook containers); text tables are read in one pass. */
	readonly namesPass: boolean;
}

function cellText(cell: unknown): string {
	if (cell === null || cell === undefined) return "";
	if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return String(cell);
	return "";
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

/** Rows in a sheet's `!ref` range (`A1:F1000` is 1000), 0 for an empty sheet. */
function rowCount(ref: string | undefined): number {
	if (ref === undefined) return 0;
	const range = utils.decode_range(ref);
	return range.e.r - range.s.r + 1;
}

/**
 * The sheet names and the first {@link SHEET_MAX_ROWS} non-blank rows of sheet
 * `index`, reading as little as the format allows:
 *
 * - A workbook container (zip: xlsx, xlsb, ods; compound file: xls) gets a
 *   names-only pass first (SheetJS opens the container and the workbook list
 *   but no cells), then one pass for the chosen sheet that stops after
 *   {@link SHEET_READ_ROWS} rows. A file with several large sheets costs what
 *   a small one does.
 * - Anything else is a delimited text table: decoded to a string first (see
 *   `decodeText`), then one sheet read in one pass that
 *   stops after {@link SHEET_READ_ROWS} rows. A names pass would scan the whole
 *   file (1.4s for 28MB) to learn the one name it is about to be given anyway.
 */
export function readSheetPreview(bytes: Uint8Array, index: number): SheetPreview {
	const data = copyBytes(bytes);
	const container = (data[0] === 0x50 && data[1] === 0x4b) || (data[0] === 0xd0 && data[1] === 0xcf);
	const names = container ? read(data, { type: "array", bookSheets: true }).SheetNames : null;
	const chosen = names === null || names[index] === undefined ? 0 : index;
	// SheetJS reads text from bytes as Latin-1 unless a byte order mark says otherwise, which
	// garbles every Hangul csv/tsv saved without one. Decode the text here (BOM, UTF-8, then
	// CP949) and hand it over as a string, which it takes as is.
	const book = container
		? read(data, { type: "array", sheetRows: SHEET_READ_ROWS, sheets: chosen })
		: read(decodeText(data).text, { type: "string", sheetRows: SHEET_READ_ROWS });
	const known = names ?? book.SheetNames;
	const name = known[chosen];
	const grid = name === undefined ? undefined : book.Sheets[name];
	const base = { names: known, sheetsRead: Object.keys(book.Sheets), namesPass: container };
	if (grid === undefined) return { ...base, rows: [], scannedRows: 0 };
	const table: unknown = utils.sheet_to_json(grid, { header: 1, raw: false, blankrows: false });
	if (!Array.isArray(table)) return { ...base, rows: [], scannedRows: 0 };
	return {
		...base,
		rows: table.slice(0, SHEET_MAX_ROWS).map((row) => (Array.isArray(row) ? row.slice(0, SHEET_MAX_COLS).map(cellText) : [])),
		scannedRows: rowCount(grid["!ref"]),
	};
}
