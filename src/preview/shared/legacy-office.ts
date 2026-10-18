/**
 * Text readers for the binary Office formats of 1997-2003: Word `.doc`/`.dot`
 * ([MS-DOC]) and PowerPoint `.ppt`/`.pps`/`.pot` ([MS-PPT]). Both live inside a
 * compound file ([MS-CFB]); this file reads that container itself, with typed
 * arrays and bounds checks, instead of going through a general library: the
 * container libraries in the tree materialise a 32MB file as a JavaScript array
 * of numbers (measured 1.2GB resident), and these viewers only need two or
 * three streams.
 *
 * Nothing here executes or follows anything in the file: macros (`Macros`,
 * `_VBA_PROJECT_CUR`), OLE objects, and external links are never opened, and
 * every read is range-checked, so a damaged or hostile file ends in a
 * {@link LegacyOfficeError} and never in an out-of-bounds read or a runaway loop.
 */

export type LegacyOfficeErrorCode = "encrypted" | "unsupported" | "corrupt" | "empty";

export class LegacyOfficeError extends Error {
	readonly code: LegacyOfficeErrorCode;

	constructor(code: LegacyOfficeErrorCode, message: string) {
		super(message);
		this.name = "LegacyOfficeError";
		this.code = code;
	}
}

function corrupt(message: string): LegacyOfficeError {
	return new LegacyOfficeError("corrupt", message);
}

/** The first bytes of a compound file. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const MAX_SECTOR = 0xfffffffa;

/** What a `.doc`/`.ppt` file really is, going by its first bytes: Word and Office both save other formats under these names. */
export type LegacyContainer = "ole" | "zip" | "rtf" | "other";

export function sniffLegacyContainer(bytes: Uint8Array): LegacyContainer {
	if (CFB_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "ole";
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
	if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) return "rtf";
	return "other";
}

function u16(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > bytes.length) throw corrupt("read past the end of a stream");
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.length) throw corrupt("read past the end of a stream");
	return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

interface DirectoryEntry {
	readonly name: string;
	readonly type: number;
	readonly start: number;
	readonly size: number;
}

/** A compound file opened for reading whole streams by name. */
class Container {
	private readonly sectorSize: number;
	private readonly miniCutoff: number;
	private readonly fat: Uint32Array;
	private readonly entries: readonly DirectoryEntry[];
	private miniFat: Uint32Array | null = null;
	private miniStream: Uint8Array | null = null;
	private readonly miniFatStart: number;

	constructor(private readonly file: Uint8Array) {
		if (sniffLegacyContainer(file) !== "ole" || file.length < 512) throw corrupt("not a compound file");
		const shift = u16(file, 30);
		if (shift !== 9 && shift !== 12) throw corrupt("unknown sector size");
		this.sectorSize = 1 << shift;
		this.miniCutoff = u32(file, 56);
		this.miniFatStart = u32(file, 60);
		const sectorCount = Math.floor(file.length / this.sectorSize);
		const perSector = this.sectorSize / 4;

		const fatSectors: number[] = [];
		for (let index = 0; index < 109; index += 1) {
			const id = u32(file, 76 + index * 4);
			if (id === FREE_SECTOR) break;
			fatSectors.push(id);
		}
		let difat = u32(file, 68);
		const difatCount = Math.min(u32(file, 72), sectorCount);
		for (let seen = 0; seen < difatCount && difat <= MAX_SECTOR; seen += 1) {
			const sector = this.sector(difat);
			for (let index = 0; index < perSector - 1; index += 1) {
				const id = u32(sector, index * 4);
				if (id === FREE_SECTOR) break;
				fatSectors.push(id);
			}
			difat = u32(sector, (perSector - 1) * 4);
		}
		if (fatSectors.length === 0 || fatSectors.length > sectorCount) throw corrupt("bad allocation table");
		this.fat = new Uint32Array(fatSectors.length * perSector);
		fatSectors.forEach((id, slot) => {
			const sector = this.sector(id);
			for (let index = 0; index < perSector; index += 1) this.fat[slot * perSector + index] = u32(sector, index * 4);
		});
		this.entries = this.readDirectory(u32(file, 48));
	}

	private sector(id: number): Uint8Array {
		const start = (id + 1) * this.sectorSize;
		if (id > MAX_SECTOR || start + this.sectorSize > this.file.length) throw corrupt("sector outside the file");
		return this.file.subarray(start, start + this.sectorSize);
	}

	/** The sectors of a chain, in order; a loop or a dangling id is a corrupt file. */
	private chain(start: number): number[] {
		const ids: number[] = [];
		let id = start;
		while (id !== END_OF_CHAIN) {
			if (id > MAX_SECTOR || id >= this.fat.length || ids.length > this.fat.length) throw corrupt("broken sector chain");
			ids.push(id);
			id = this.fat[id] ?? END_OF_CHAIN;
		}
		return ids;
	}

	private readChain(start: number, limit: number): Uint8Array {
		const ids = this.chain(start);
		if (ids.length * this.sectorSize > limit + this.sectorSize) throw corrupt("stream longer than declared");
		const out = new Uint8Array(ids.length * this.sectorSize);
		ids.forEach((id, slot) => out.set(this.sector(id), slot * this.sectorSize));
		return out;
	}

	private readDirectory(start: number): DirectoryEntry[] {
		const raw = this.readChain(start, this.file.length);
		const entries: DirectoryEntry[] = [];
		for (let offset = 0; offset + 128 <= raw.length; offset += 128) {
			const type = raw[offset + 66] ?? 0;
			const nameBytes = Math.min(u16(raw, offset + 64), 64);
			const name = type === 0 ? "" : new TextDecoder("utf-16le").decode(raw.subarray(offset, offset + Math.max(0, nameBytes - 2)));
			entries.push({ name, type, start: u32(raw, offset + 116), size: u32(raw, offset + 120) });
		}
		return entries;
	}

	has(name: string): boolean {
		return this.entries.some((entry) => entry.type === 2 && entry.name === name);
	}

	/** A copy of the named stream's bytes, or null when the file has no such stream. */
	stream(name: string): Uint8Array | null {
		const entry = this.entries.find((candidate) => candidate.type === 2 && candidate.name === name);
		if (entry === undefined) return null;
		if (entry.size > this.file.length) throw corrupt("stream larger than the file");
		if (entry.size < this.miniCutoff) return this.readMini(entry);
		return this.readChain(entry.start, entry.size).slice(0, entry.size);
	}

	private readMini(entry: DirectoryEntry): Uint8Array {
		const root = this.entries[0];
		if (root === undefined || root.type !== 5) throw corrupt("no root entry");
		this.miniStream ??= this.readChain(root.start, root.size).slice(0, root.size);
		if (this.miniFat === null) {
			const raw = this.miniFatStart === END_OF_CHAIN ? new Uint8Array(0) : this.readChain(this.miniFatStart, this.file.length);
			const table = new Uint32Array(raw.length / 4);
			for (let index = 0; index < table.length; index += 1) table[index] = u32(raw, index * 4);
			this.miniFat = table;
		}
		const out = new Uint8Array(entry.size);
		let id = entry.start;
		let written = 0;
		while (written < entry.size) {
			const from = id * 64;
			if (id > MAX_SECTOR || from + 64 > this.miniStream.length) throw corrupt("mini sector outside the mini stream");
			const take = Math.min(64, entry.size - written);
			out.set(this.miniStream.subarray(from, from + take), written);
			written += take;
			id = this.miniFat[id] ?? END_OF_CHAIN;
			if (written < entry.size && id === END_OF_CHAIN) throw corrupt("mini stream ended early");
		}
		return out;
	}
}

function openContainer(file: Uint8Array): Container {
	try {
		return new Container(file);
	} catch (error) {
		throw asLegacyError(error);
	}
}

function asLegacyError(error: unknown): LegacyOfficeError {
	if (error instanceof LegacyOfficeError) return error;
	return corrupt(error instanceof Error ? error.message : "unreadable file");
}

/** Most characters a viewer is handed; the rest of a very large document is cut and reported. */
export const LEGACY_TEXT_CHARS = 400_000;

export interface LegacyReadOptions {
	readonly maxChars?: number;
}

// ---------------------------------------------------------------------------
// Word 97-2003

export interface WordText {
	/** The document text, one entry per page break (form feed) with blank pages dropped. */
	readonly pages: readonly string[];
	readonly truncated: boolean;
}

const WORD_MAGIC = 0xa5ec;
/** nFib of Word 97 and everything after it; earlier values are Word 6/95, which stores text differently. */
const WORD_97_NFIB = 0x00c1;
const FIB_ENCRYPTED = 0x0100;
const FIB_TABLE_1 = 0x0200;
/** Index of fcClx in the FibRgFcLcb97 pair array. */
const FC_CLX_PAIR = 33;

interface Piece {
	readonly cpStart: number;
	readonly cpEnd: number;
	readonly offset: number;
	readonly compressed: boolean;
}

function readPieces(table: Uint8Array, fcClx: number, lcbClx: number): Piece[] {
	if (lcbClx === 0 || fcClx + lcbClx > table.length) throw corrupt("piece table outside its stream");
	let offset = fcClx;
	const end = fcClx + lcbClx;
	while (offset < end) {
		const kind = table[offset];
		if (kind === 1) {
			offset += 3 + u16(table, offset + 1);
		} else if (kind === 2) {
			const size = u32(table, offset + 1);
			const plc = offset + 5;
			if (size < 16 || plc + size > end) throw corrupt("piece table size");
			const count = (size - 4) / 12;
			if (!Number.isInteger(count)) throw corrupt("piece table size");
			const pieces: Piece[] = [];
			for (let index = 0; index < count; index += 1) {
				const fc = u32(table, plc + (count + 1) * 4 + index * 8 + 2);
				const compressed = (fc & 0x40000000) !== 0;
				const base = fc & 0x3fffffff;
				pieces.push({ cpStart: u32(table, plc + index * 4), cpEnd: u32(table, plc + (index + 1) * 4), offset: compressed ? base >>> 1 : base, compressed });
			}
			return pieces;
		} else {
			throw corrupt("unknown piece table clause");
		}
	}
	throw corrupt("no piece table");
}

/** Turns Word's control characters into text: fields keep their result, cells become tabs, form feeds become page breaks. */
function cleanWordText(raw: string, limit: number): { readonly pages: string[]; readonly truncated: boolean } {
	const pages: string[] = [];
	let page = "";
	let size = 0;
	let truncated = false;
	/** One entry per open field: true while its instruction (before the 0x14 separator) is being skipped. */
	const fields: boolean[] = [];
	let cellMark = false;
	const flush = (): void => {
		if (page.trim() !== "") pages.push(page.trim());
		page = "";
	};
	for (const char of raw) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0x13) {
			fields.push(true);
			continue;
		}
		if (code === 0x14) {
			if (fields.length > 0) fields[fields.length - 1] = false;
			continue;
		}
		if (code === 0x15) {
			fields.pop();
			continue;
		}
		if (fields.includes(true)) continue;
		if (code === 0x07) {
			// A cell ends in one mark; the mark right after a cell's is the row's end.
			page = cellMark && page.endsWith("\t") ? `${page.slice(0, -1)}\n` : `${page}\t`;
			cellMark = !cellMark;
			continue;
		}
		cellMark = false;
		if (code === 0x0c) {
			flush();
			continue;
		}
		let out: string;
		if (code === 0x0d || code === 0x0b) out = "\n";
		else if (code === 0x09 || code >= 0x20) out = code === 0xfffc ? "" : char;
		else if (code === 0x1e) out = "-";
		else out = "";
		if (size + out.length > limit) {
			truncated = true;
			break;
		}
		page += out;
		size += out.length;
	}
	flush();
	return { pages, truncated };
}

export function readWordDocument(file: Uint8Array, options: LegacyReadOptions = {}): WordText {
	try {
		return readWord(file, options.maxChars ?? LEGACY_TEXT_CHARS);
	} catch (error) {
		throw asLegacyError(error);
	}
}

function readWord(file: Uint8Array, limit: number): WordText {
	const container = openContainer(file);
	const main = container.stream("WordDocument");
	if (main === null) throw new LegacyOfficeError("unsupported", "no WordDocument stream");
	if (u16(main, 0) !== WORD_MAGIC) throw new LegacyOfficeError("unsupported", "not a Word binary document");
	if (u16(main, 2) < WORD_97_NFIB) throw new LegacyOfficeError("unsupported", "Word 6/95 document");
	const flags = u16(main, 10);
	if ((flags & FIB_ENCRYPTED) !== 0) throw new LegacyOfficeError("encrypted", "encrypted document");

	const shortCount = u16(main, 32);
	const longCountAt = 34 + shortCount * 2;
	const longCount = u16(main, longCountAt);
	const longs = longCountAt + 2;
	const mainChars = u32(main, longs + 12);
	const pairsAt = longs + longCount * 4;
	const pairCount = u16(main, pairsAt);
	if (pairCount <= FC_CLX_PAIR) throw corrupt("File Information Block too short");
	const pair = pairsAt + 2 + FC_CLX_PAIR * 8;
	const table = container.stream(flags & FIB_TABLE_1 ? "1Table" : "0Table");
	if (table === null) throw corrupt("missing table stream");
	const pieces = readPieces(table, u32(main, pair), u32(main, pair + 4));

	const ucs2 = new TextDecoder("utf-16le");
	const cp1252 = new TextDecoder("windows-1252");
	let raw = "";
	let previous = 0;
	for (const piece of pieces) {
		if (piece.cpStart < previous || piece.cpEnd < piece.cpStart) throw corrupt("piece characters out of order");
		previous = piece.cpEnd;
		if (piece.cpStart >= mainChars) break;
		const length = Math.min(piece.cpEnd, mainChars) - piece.cpStart;
		const bytes = piece.compressed ? length : length * 2;
		if (piece.offset + bytes > main.length) throw corrupt("piece outside the document stream");
		const slice = main.subarray(piece.offset, piece.offset + bytes);
		raw += piece.compressed ? cp1252.decode(slice) : ucs2.decode(slice);
		// Control marks and the cleaner can only shrink the text, so this bounds the work.
		if (raw.length > limit * 2) break;
	}
	const { pages, truncated } = cleanWordText(raw, limit);
	if (pages.length === 0) throw new LegacyOfficeError("empty", "no text");
	return { pages, truncated: truncated || raw.length > limit * 2 };
}

// ---------------------------------------------------------------------------
// PowerPoint 97-2003

export interface DeckSlide {
	readonly title: string;
	readonly lines: readonly string[];
}

export interface DeckText {
	readonly slides: readonly DeckSlide[];
	readonly truncated: boolean;
}

const RT_DOCUMENT = 1000;
const RT_SLIDE = 1006;
const RT_SLIDE_PERSIST = 1011;
const RT_TEXT_HEADER = 3999;
const RT_TEXT_CHARS = 4000;
const RT_TEXT_BYTES = 4008;
const RT_SLIDE_LIST = 4080;
const RT_USER_EDIT = 4085;
const RT_PERSIST_DIRECTORY = 6002;
const PLAIN_USER_TOKEN = 0xe391c05f;
const ENCRYPTED_USER_TOKEN = 0xf3d1c4df;
const MAX_EDITS = 4096;
const MAX_SLIDES = 5000;
const MAX_DEPTH = 24;
/** TextHeaderAtom text types that are titles: Title and CenterTitle. */
const TITLE_TYPES = new Set([0, 6]);

interface Atom {
	readonly version: number;
	readonly instance: number;
	readonly type: number;
	readonly body: number;
	readonly end: number;
}

function atomAt(bytes: Uint8Array, offset: number, limit: number): Atom {
	if (offset < 0 || offset + 8 > limit) throw corrupt("record header outside its container");
	const head = u16(bytes, offset);
	const end = offset + 8 + u32(bytes, offset + 4);
	if (end > limit) throw corrupt("record longer than its container");
	return { version: head & 0xf, instance: head >>> 4, type: u16(bytes, offset + 2), body: offset + 8, end };
}

interface TextRun {
	readonly title: boolean;
	readonly text: string;
}

function readRun(bytes: Uint8Array, atom: Atom, title: boolean): TextRun {
	const slice = bytes.subarray(atom.body, atom.end);
	const text = atom.type === RT_TEXT_CHARS ? new TextDecoder("utf-16le").decode(slice.subarray(0, slice.length & ~1)) : new TextDecoder("windows-1252").decode(slice);
	return { title, text };
}

/** Every text atom under `start..end`, each tagged with the TextHeaderAtom type that precedes it. */
function collectRuns(bytes: Uint8Array, start: number, end: number, depth: number, runs: TextRun[], budget: { left: number }): void {
	let pending = -1;
	for (let offset = start; offset < end; ) {
		const atom = atomAt(bytes, offset, end);
		if (atom.version === 0xf) {
			if (depth < MAX_DEPTH) collectRuns(bytes, atom.body, atom.end, depth + 1, runs, budget);
		} else if (atom.type === RT_TEXT_HEADER) {
			pending = u32(bytes, atom.body);
		} else if (atom.type === RT_TEXT_CHARS || atom.type === RT_TEXT_BYTES) {
			budget.left -= atom.end - atom.body;
			if (budget.left < 0) return;
			runs.push(readRun(bytes, atom, TITLE_TYPES.has(pending)));
			pending = -1;
		}
		offset = atom.end;
	}
}

/** The newest offset of every persist id: a fast save appends edits that win over the ones before them. */
function readPersistOffsets(bytes: Uint8Array, firstEdit: number): { readonly offsets: Map<number, number>; readonly document: number } {
	const offsets = new Map<number, number>();
	const seen = new Set<number>();
	let document = -1;
	for (let edit = firstEdit; edit !== 0; ) {
		if (seen.has(edit) || seen.size >= MAX_EDITS) throw corrupt("edit chain loops");
		seen.add(edit);
		const atom = atomAt(bytes, edit, bytes.length);
		if (atom.type !== RT_USER_EDIT || atom.end - atom.body < 28) throw corrupt("bad edit record");
		if (document < 0) document = u32(bytes, atom.body + 16);
		const directory = atomAt(bytes, u32(bytes, atom.body + 12), bytes.length);
		if (directory.type !== RT_PERSIST_DIRECTORY) throw corrupt("bad persist directory");
		for (let at = directory.body; at < directory.end; ) {
			const head = u32(bytes, at);
			const base = head & 0xfffff;
			const count = head >>> 20;
			at += 4;
			if (at + count * 4 > directory.end) throw corrupt("persist directory entry overruns");
			for (let index = 0; index < count; index += 1) {
				if (!offsets.has(base + index)) offsets.set(base + index, u32(bytes, at + index * 4));
			}
			at += count * 4;
		}
		edit = u32(bytes, atom.body + 8);
	}
	if (document < 0) throw corrupt("no edit record");
	return { offsets, document };
}

interface ListedSlide {
	readonly persist: number;
	readonly runs: TextRun[];
}

/** The slides, in show order, from the Document's SlideListWithTexts (instance 0), with the placeholder text kept there. */
function readSlideList(bytes: Uint8Array, document: Atom, budget: { left: number }): ListedSlide[] {
	const slides: ListedSlide[] = [];
	for (let offset = document.body; offset < document.end; ) {
		const atom = atomAt(bytes, offset, document.end);
		if (atom.type === RT_SLIDE_LIST && atom.instance === 0) {
			let current: ListedSlide | null = null;
			let pending = -1;
			for (let at = atom.body; at < atom.end; ) {
				const child = atomAt(bytes, at, atom.end);
				if (child.type === RT_SLIDE_PERSIST) {
					if (slides.length >= MAX_SLIDES) return slides;
					current = { persist: u32(bytes, child.body), runs: [] };
					slides.push(current);
					pending = -1;
				} else if (child.type === RT_TEXT_HEADER) {
					pending = u32(bytes, child.body);
				} else if ((child.type === RT_TEXT_CHARS || child.type === RT_TEXT_BYTES) && current !== null) {
					budget.left -= child.end - child.body;
					if (budget.left < 0) return slides;
					current.runs.push(readRun(bytes, child, TITLE_TYPES.has(pending)));
					pending = -1;
				}
				at = child.end;
			}
		}
		offset = atom.end;
	}
	return slides;
}

function linesOf(text: string): string[] {
	return text
		.replace(/[\r\u000b]/g, "\n")
		.replace(/[\u0000-\u0008\u000c\u000e-\u001f\ufffc]/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function toSlide(runs: readonly TextRun[]): DeckSlide {
	const seen = new Set<string>();
	let title = "";
	const lines: string[] = [];
	for (const run of runs) {
		const own = linesOf(run.text);
		if (own.length === 0) continue;
		const joined = own.join(" ");
		if (run.title && title === "") {
			title = joined;
			seen.add(joined);
			continue;
		}
		for (const line of own) {
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
		}
	}
	return { title, lines };
}

export function readPowerPointDeck(file: Uint8Array, options: LegacyReadOptions = {}): DeckText {
	try {
		return readDeck(file, options.maxChars ?? LEGACY_TEXT_CHARS);
	} catch (error) {
		throw asLegacyError(error);
	}
}

function readDeck(file: Uint8Array, limit: number): DeckText {
	const container = openContainer(file);
	const user = container.stream("Current User");
	const stream = container.stream("PowerPoint Document");
	if (user === null || stream === null) throw new LegacyOfficeError("unsupported", "not a PowerPoint 97-2003 presentation");
	const token = u32(user, 12);
	if (token === ENCRYPTED_USER_TOKEN) throw new LegacyOfficeError("encrypted", "encrypted presentation");
	if (token !== PLAIN_USER_TOKEN) throw corrupt("unknown Current User record");

	const { offsets, document: documentId } = readPersistOffsets(stream, u32(user, 16));
	const documentOffset = offsets.get(documentId);
	if (documentOffset === undefined) throw corrupt("no document container");
	const document = atomAt(stream, documentOffset, stream.length);
	if (document.type !== RT_DOCUMENT) throw corrupt("bad document container");

	const budget = { left: limit };
	const listed = readSlideList(stream, document, budget);
	const slides: DeckSlide[] = [];
	let anyText = false;
	for (const entry of listed) {
		const runs: TextRun[] = [...entry.runs];
		const offset = offsets.get(entry.persist);
		if (offset !== undefined && budget.left > 0) {
			const slide = atomAt(stream, offset, stream.length);
			if (slide.type === RT_SLIDE) collectRuns(stream, slide.body, slide.end, 0, runs, budget);
		}
		const built = toSlide(runs);
		if (built.title !== "" || built.lines.length > 0) anyText = true;
		slides.push(built);
	}
	if (!anyText) throw new LegacyOfficeError("empty", "no text");
	return { slides, truncated: budget.left < 0 || listed.length >= MAX_SLIDES };
}
