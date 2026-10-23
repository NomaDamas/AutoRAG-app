import { read, utils, write } from "xlsx";
import { describe, expect, it } from "vitest";
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, readSheetPreview } from "../src/preview/shared/sheet";

function workbook(sheets: Readonly<Record<string, readonly (readonly (string | number)[])[]>>, bookType: "xlsx" | "csv" = "xlsx"): Uint8Array {
	const book = utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) utils.book_append_sheet(book, utils.aoa_to_sheet(rows.map((row) => [...row])), name);
	return new Uint8Array(write(book, { type: "array", bookType }));
}

const grid = (rows: number, cols: number): (string | number)[][] => Array.from({ length: rows }, (_unused, r) => Array.from({ length: cols }, (_u, c) => `r${r}c${c}`));

describe("readSheetPreview", () => {
	it("shows only the first rows and columns the panel can draw", () => {
		const bytes = workbook({ Data: grid(SHEET_MAX_ROWS + 400, SHEET_MAX_COLS + 15) });
		const preview = readSheetPreview(bytes, 0);
		expect(preview.rows).toHaveLength(SHEET_MAX_ROWS);
		expect(preview.rows[0]).toHaveLength(SHEET_MAX_COLS);
		expect(preview.rows[0]?.[0]).toBe("r0c0");
		expect(preview.rows.at(-1)?.[0]).toBe(`r${SHEET_MAX_ROWS - 1}c0`);
	});

	it("lists every sheet name and reads the one asked for", () => {
		const bytes = workbook({ First: [["a1"]], Second: [["b1"], ["b2"]], Third: [["c1"]] });
		expect(readSheetPreview(bytes, 0).names).toEqual(["First", "Second", "Third"]);
		const second = readSheetPreview(bytes, 1);
		expect(second.rows).toEqual([["b1"], ["b2"]]);
		expect(readSheetPreview(bytes, 2).rows).toEqual([["c1"]]);
	});

	it("falls back to the first sheet when the index is past the end", () => {
		const bytes = workbook({ Only: [["x"]] });
		expect(readSheetPreview(bytes, 9).rows).toEqual([["x"]]);
	});

	it("reads csv through the same path", () => {
		const bytes = workbook({ Sheet1: [["h1", "h2"], ["v1", "v2"]] }, "csv");
		const preview = readSheetPreview(bytes, 0);
		expect(preview.names).toHaveLength(1);
		expect(preview.rows).toEqual([["h1", "h2"], ["v1", "v2"]]);
	});

	describe("Korean text tables", () => {
		const csv = "이름,부서,금액\n김민수,영업,1200\n이지은,마케팅,980\n";
		const expected = [["이름", "부서", "금액"], ["김민수", "영업", "1200"], ["이지은", "마케팅", "980"]];
		const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

		it("reads a UTF-8 csv without a byte order mark as UTF-8, not Latin-1", () => {
			expect(readSheetPreview(utf8(csv), 0).rows).toEqual(expected);
		});

		it("reads a UTF-8 csv with a byte order mark", () => {
			expect(readSheetPreview(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(csv)]), 0).rows).toEqual(expected);
		});

		it("reads a tab-separated table", () => {
			expect(readSheetPreview(utf8(csv.replaceAll(",", "\t")), 0).rows).toEqual(expected);
		});

		it("reads a CP949 csv saved by Excel on Korean Windows", () => {
			// "이름,부서\n김민수,영업\n" in CP949, the bytes Excel's "CSV" save writes.
			const bytes = Uint8Array.from([
				0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xba, 0xce, 0xbc, 0xad, 0x0a,
				0xb1, 0xe8, 0xb9, 0xce, 0xbc, 0xf6, 0x2c, 0xbf, 0xb5, 0xbe, 0xf7, 0x0a,
			]);
			expect(readSheetPreview(bytes, 0).rows).toEqual([["이름", "부서"], ["김민수", "영업"]]);
		});

		it("reads a UTF-16 LE csv with a byte order mark", () => {
			const units = Array.from("이름,부서\n김민수,영업\n", (ch) => ch.charCodeAt(0));
			const bytes = new Uint8Array(2 + units.length * 2);
			bytes.set([0xff, 0xfe]);
			units.forEach((unit, i) => {
				bytes[2 + i * 2] = unit & 0xff;
				bytes[3 + i * 2] = unit >> 8;
			});
			expect(readSheetPreview(bytes, 0).rows).toEqual([["이름", "부서"], ["김민수", "영업"]]);
		});

		it("keeps Korean text in an xlsx workbook", () => {
			expect(readSheetPreview(workbook({ 지출: [["이름", "금액"], ["김민수", 1200]] }), 0).rows).toEqual([["이름", "금액"], ["김민수", "1200"]]);
		});
	});

	it("reads a text table in one pass: it has a single sheet, so there are no names to look up first", () => {
		const text = new TextEncoder().encode(`id,name\n${Array.from({ length: 20_000 }, (_u, r) => `${r},row-${r}`).join("\n")}`);
		const preview = readSheetPreview(text, 0);
		expect(preview.names).toHaveLength(1);
		expect(preview.rows).toHaveLength(SHEET_MAX_ROWS);
		expect(preview.rows[0]).toEqual(["id", "name"]);
		expect(preview.namesPass).toBe(false);
	});

	it("looks sheet names up first for a workbook", () => {
		expect(readSheetPreview(workbook({ A: [["a"]], B: [["b"]] }), 1).namesPass).toBe(true);
	});

	it("stops reading a sheet long before its last row", () => {
		const preview = readSheetPreview(workbook({ Big: grid(20_000, 6) }), 0);
		expect(preview.rows).toHaveLength(SHEET_MAX_ROWS);
		// Reading stops at a small multiple of what is drawn, not at row 20,000.
		expect(preview.scannedRows).toBeGreaterThanOrEqual(SHEET_MAX_ROWS);
		expect(preview.scannedRows).toBeLessThanOrEqual(SHEET_MAX_ROWS * 20);
	});

	it("turns non-text cells into empty strings and keeps formatted text", () => {
		const bytes = workbook({ S: [["name", 1.5, true as unknown as string], ["", 2, "z"]] });
		const preview = readSheetPreview(bytes, 0);
		expect(preview.rows[0]?.slice(0, 2)).toEqual(["name", "1.5"]);
		expect(preview.rows[1]?.[2]).toBe("z");
	});

	it("still fills the panel when blank rows are scattered through the head", () => {
		const rows: (string | number)[][] = [];
		for (let r = 0; r < 300; r += 1) {
			rows.push([`r${r}`]);
			if (r % 3 === 0) rows.push([]);
		}
		const preview = readSheetPreview(workbook({ Gappy: rows }), 0);
		expect(preview.rows).toHaveLength(SHEET_MAX_ROWS);
		expect(preview.rows.every((row) => row[0]?.startsWith("r"))).toBe(true);
	});

	it("reads only the sheet asked for, never the others", () => {
		const bytes = workbook({ A: grid(5_000, 4), B: grid(5_000, 4), C: [["tail"]] });
		const preview = readSheetPreview(bytes, 2);
		expect(preview.rows).toEqual([["tail"]]);
		expect(preview.names).toEqual(["A", "B", "C"]);
		expect(preview.sheetsRead).toEqual(["C"]);
		expect(readSheetPreview(bytes, 0).sheetsRead).toEqual(["A"]);
	});
	it("keeps the old behavior for non-workbook bytes: SheetJS reads them as a one-sheet csv", () => {
		const preview = readSheetPreview(new TextEncoder().encode("not,a\nworkbook,really"), 0);
		expect(preview.names).toHaveLength(1);
		expect(preview.rows).toEqual([["not", "a"], ["workbook", "really"]]);
	});
});
