import { loadDazziNativeCore } from "../../main/dazzi-native-core";
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, readSheetPreview, type SheetPreview } from "../shared/sheet";
import { withReadableFile } from "./provider-access";
import { PREVIEW_BYTE_CAP, readHead } from "./read-file";

/** Rows scanned per sheet before stopping (matches `SHEET_READ_ROWS` in `shared/sheet.ts`). */
const SHEET_SCAN_ROWS = 1000;

/**
 * Main-process spreadsheet preview reader.
 *
 * Primary path: streams XLSX/XLSM and CSV/TSV directly inside the bundled Rust
 * N-API core on the libuv thread pool (`previewSheetNative`), reading only up
 * to `SHEET_SCAN_ROWS` rows and only the referenced shared strings. This avoids
 * sending multi-megabyte workbooks over IPC or freezing the Quick Look renderer
 * with synchronous SheetJS parsing — and unlocks >32 MiB CSV/XLSX previews.
 *
 * Formats outside the streaming reader (legacy `.xls` BIFF, `.xlsb`, `.ods`,
 * encrypted workbooks, or unexpected native errors) transparently fall back to
 * SheetJS (`readSheetPreview`) in the main process with zero compatibility loss.
 */
export async function previewSheetFile(path: string, sheetIndex: number): Promise<SheetPreview> {
	const index = Number.isInteger(sheetIndex) && sheetIndex >= 0 ? sheetIndex : 0;
	return withReadableFile(path, async (localPath) => {
		const native = loadDazziNativeCore();
		if (native !== null) {
			try {
				const result = await native.previewSheetNative(localPath, index, SHEET_SCAN_ROWS, SHEET_MAX_ROWS, SHEET_MAX_COLS);
				if (result.handled) {
					return {
						names: result.names,
						rows: result.rows,
						sheetsRead: result.sheetsRead,
						scannedRows: result.scannedRows,
						namesPass: result.namesPass,
					};
				}
			} catch (error) {
				console.warn(`[dazzi-core] previewSheetNative failed for ${path}, falling back to SheetJS:`, error instanceof Error ? error.message : error);
			}
		}
		const bytes = await readHead(localPath, PREVIEW_BYTE_CAP);
		return readSheetPreview(bytes, index);
	});
}
