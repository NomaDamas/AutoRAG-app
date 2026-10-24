import { describe, expect, it } from "vitest";
import { summarizeArchive } from "../src/preview/shared/archive-items";
import { listTarEntries } from "../src/preview/shared/tar-list";
import { listZipEntries } from "../src/preview/shared/zip-list";

/** A stored (uncompressed) ZIP whose entry names are the given raw bytes, with or without the UTF-8 flag (bit 11). */
function zipWithRawNames(entries: readonly { readonly name: Uint8Array; readonly utf8Flag: boolean }[]): Uint8Array {
	const parts: number[] = [];
	const directory: number[] = [];
	const u16 = (value: number) => [value & 255, (value >> 8) & 255];
	const u32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
	for (const entry of entries) {
		const offset = parts.length;
		const flags = entry.utf8Flag ? 0x0800 : 0;
		const date = ((2026 - 1980) << 9) | (10 << 5) | 24;
		parts.push(...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(date), ...u32(0), ...u32(0), ...u32(0), ...u16(entry.name.length), ...u16(0), ...entry.name);
		directory.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(0), ...u16(0), ...u16(date), ...u32(0), ...u32(0), ...u32(0), ...u16(entry.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...entry.name);
	}
	const directoryOffset = parts.length;
	return Uint8Array.from([...parts, ...directory, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(directory.length), ...u32(directoryOffset), ...u16(0)]);
}

const utf8 = (text: string) => new TextEncoder().encode(text);
/** Hangul in CP949 (EUC-KR range): 한글.txt */
const CP949_HANGUL_TXT = Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb, 0x2e, 0x74, 0x78, 0x74]);
const nameOf = (bytes: Uint8Array, utf8Flag: boolean) => listZipEntries(zipWithRawNames([{ name: bytes, utf8Flag }]))?.[0]?.name;

describe("zip entry names", () => {
	it("reads a UTF-8 name with the flag", () => {
		expect(nameOf(utf8("한글.txt"), true)).toBe("한글.txt");
	});

	it("reads a CP949 name written without the flag (Korean Windows Explorer)", () => {
		expect(nameOf(CP949_HANGUL_TXT, false)).toBe("한글.txt");
	});

	it("reads a UTF-8 name even when the writer forgot the flag (Info-ZIP, Python)", () => {
		expect(nameOf(utf8("보고서/요약.md"), false)).toBe("보고서/요약.md");
	});

	it("returns names in NFC whichever form the archive stored (macOS writes NFD)", () => {
		const nfd = "한글.txt".normalize("NFD");
		expect(nfd).not.toBe("한글.txt");
		expect(nameOf(utf8(nfd), true)).toBe("한글.txt");
		expect(nameOf(utf8(nfd), false)).toBe("한글.txt");
	});

	it("keeps plain ASCII names and a name that is neither UTF-8 nor CP949 readable", () => {
		expect(nameOf(utf8("readme.txt"), false)).toBe("readme.txt");
		expect(nameOf(Uint8Array.from([0x61, 0xff, 0xff, 0x62]), false)).toContain("a");
	});

	it("groups NFC and NFD spellings of one folder as a single top-level child", () => {
		const bytes = zipWithRawNames([
			{ name: utf8("한글/가.txt".normalize("NFD")), utf8Flag: true },
			{ name: utf8("한글/나.txt"), utf8Flag: true },
		]);
		const entries = listZipEntries(bytes) ?? [];
		const summary = summarizeArchive(entries.map((entry) => ({ name: entry.name, size: entry.uncompressedSize, modified: entry.modified })), 6);
		expect(summary.itemCount).toBe(1);
		expect(summary.items[0]?.name).toBe("한글");
	});
});

describe("tar entry names", () => {
	it("returns NFC names", () => {
		const header = new Uint8Array(512);
		header.set(utf8("한글.txt".normalize("NFD")), 0);
		header.set(utf8("0000644\0"), 100);
		header.set(utf8("00000000000\0"), 124);
		header.set(utf8("00000000000\0"), 136);
		header[156] = 0x30;
		header.set(utf8("ustar\0"), 257);
		const entries = listTarEntries(Uint8Array.from([...header, ...new Uint8Array(1024)]));
		expect(entries?.[0]?.name).toBe("한글.txt");
	});
});
