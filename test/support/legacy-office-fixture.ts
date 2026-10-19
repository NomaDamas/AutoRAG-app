import { CFB } from "xlsx";

/** A compound file (OLE2 container) holding `streams`, written by the same library Excel parsing uses. */
export function buildCompoundFile(streams: Readonly<Record<string, Uint8Array>>): Uint8Array {
	const container = CFB.utils.cfb_new();
	for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(container, name, data);
	return new Uint8Array(CFB.write(container, { type: "buffer" }));
}

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function utf16(text: string): number[] {
	return Array.from(text, (_char, index) => u16(text.charCodeAt(index))).flat();
}

export interface WordPiece {
	readonly text: string;
	/** 8-bit pieces store cp1252 bytes; the default is 16-bit UTF-16. */
	readonly compressed?: boolean;
}

export interface WordOptions {
	readonly tableStream?: "0Table" | "1Table";
	readonly encrypted?: boolean;
	readonly nFib?: number;
	/** Characters beyond the main document (footnotes, headers) appended after the main text. */
	readonly trailing?: string;
	/** A Prc clause placed before the piece table, which readers must skip. */
	readonly prefixPrc?: boolean;
}

const FIB_SIZE = 0x400;

/** The cp1252 bytes Word writes for characters outside Latin-1 that these fixtures use. */
const CP1252_EXTRA: Readonly<Record<string, number>> = { "\u2018": 0x91, "\u2019": 0x92, "\u201c": 0x93, "\u201d": 0x94, "\u2013": 0x96, "\u2014": 0x97 };

function cp1252(text: string): number[] {
	return Array.from(text, (char) => {
		const code = char.charCodeAt(0);
		const extra = CP1252_EXTRA[char];
		if (extra !== undefined) return extra;
		if (code > 0xff) throw new Error(`"${char}" is not cp1252`);
		return code;
	});
}

/**
 * A Word 97-2003 document laid out the way [MS-DOC] describes it: a File
 * Information Block in `WordDocument`, the text pieces after it, and the piece
 * table (Clx) in `0Table`/`1Table`. Every piece is one `Pcd`; its CPs follow
 * each other, so `pieces` read in order are the document text.
 */
export function buildWordDocument(pieces: readonly WordPiece[], options: WordOptions = {}): Uint8Array {
	const table = options.tableStream ?? "1Table";
	const fib = new Uint8Array(FIB_SIZE);
	const set = (offset: number, bytes: readonly number[]): void => fib.set(bytes, offset);
	set(0, u16(0xa5ec));
	set(2, u16(options.nFib ?? 0x00c1));
	set(10, u16((table === "1Table" ? 0x0200 : 0) | (options.encrypted === true ? 0x0100 : 0)));
	set(32, u16(14));
	set(62, u16(22));
	set(152, u16(93));

	const body: number[] = [];
	const cps = [0];
	const pcds: number[] = [];
	const all: WordPiece[] = options.trailing === undefined ? [...pieces] : [...pieces, { text: options.trailing, compressed: false }];
	let cp = 0;
	let mainLength = 0;
	all.forEach((piece, index) => {
		const compressed = piece.compressed === true;
		const fc = FIB_SIZE + body.length;
		for (const byte of compressed ? cp1252(piece.text) : utf16(piece.text)) body.push(byte);
		cp += piece.text.length;
		cps.push(cp);
		pcds.push(...u16(0), ...u32(compressed ? ((fc * 2) | 0x40000000) >>> 0 : fc), ...u16(0));
		if (index < pieces.length) mainLength = cp;
	});
	set(76, u32(mainLength));

	const plc = [...cps.flatMap(u32), ...pcds];
	const pcdt = [0x02, ...u32(plc.length), ...plc];
	const prc = options.prefixPrc === true ? [0x01, ...u16(3), 0xaa, 0xbb, 0xcc] : [];
	const clx = [...prc, ...pcdt];
	set(418, u32(0));
	set(422, u32(clx.length));

	const wordDocument = new Uint8Array(FIB_SIZE + body.length);
	wordDocument.set(fib);
	wordDocument.set(body, FIB_SIZE);
	return buildCompoundFile({ WordDocument: wordDocument, [table]: new Uint8Array(clx) });
}

const RT = { document: 1000, slide: 1006, slwt: 4080, spa: 1011, textHeader: 3999, textChars: 4000, textBytes: 4008, clientTextbox: 0xf00d, drawing: 1036, userEdit: 4085, persistDirectory: 6002 } as const;

function record(type: number, body: readonly number[], options: { version?: number; instance?: number } = {}): number[] {
	return [...u16((options.version ?? 0) | ((options.instance ?? 0) << 4)), ...u16(type), ...u32(body.length), ...body];
}

export interface PowerPointFixtureSlide {
	/** Text boxes drawn on the slide itself; a `title` text box carries TextHeaderAtom type 0. */
	readonly boxes: readonly { readonly text: string; readonly title?: boolean; readonly bytes?: boolean }[];
	/** Text the slide list (SlideListWithTexts) keeps for the slide's placeholders. */
	readonly listText?: readonly { readonly text: string; readonly title?: boolean }[];
}

function textAtoms(text: string, title: boolean, eightBit: boolean): number[] {
	return [
		...record(RT.textHeader, u32(title ? 0 : 1)),
		...(eightBit ? record(RT.textBytes, cp1252(text)) : record(RT.textChars, utf16(text))),
	];
}

function slideContainer(slide: PowerPointFixtureSlide): number[] {
	const boxes = slide.boxes.map((box) => record(RT.clientTextbox, textAtoms(box.text, box.title === true, box.bytes === true), { version: 0xf })).flat();
	return record(RT.slide, record(RT.drawing, boxes, { version: 0xf }), { version: 0xf });
}

export interface PowerPointFixtureEdit {
	/** Slides rewritten by this edit, by index into the deck. */
	readonly replace: Readonly<Record<number, PowerPointFixtureSlide>>;
}

/**
 * A PowerPoint 97-2003 deck: slide containers and the Document container in
 * `PowerPoint Document`, reached through `Current User` → UserEditAtom →
 * PersistDirectoryAtom as [MS-PPT] describes. Each `edit` appends an
 * incremental save (fast save) that rewrites some slides and links back to the
 * previous edit, which is how real files accumulate stale slides.
 */
export function buildPowerPoint(
	slides: readonly PowerPointFixtureSlide[],
	options: { readonly edits?: readonly PowerPointFixtureEdit[]; readonly encrypted?: boolean; readonly brokenCurrentUser?: boolean } = {},
): Uint8Array {
	const stream: number[] = [];
	const slidePersist = slides.map((_slide, index) => index + 2);
	const offsets = new Map<number, number>();
	const place = (persist: number, bytes: readonly number[]): void => {
		offsets.set(persist, stream.length);
		stream.push(...bytes);
	};

	slides.forEach((slide, index) => place(slidePersist[index] ?? 0, slideContainer(slide)));
	const listAtoms = slides
		.map((slide, index) => [
			...record(RT.spa, [...u32(slidePersist[index] ?? 0), ...u32(0), ...u32(slide.listText?.length ?? 0), ...u32(256 + index), ...u32(0)]),
			...(slide.listText ?? []).flatMap((entry) => textAtoms(entry.text, entry.title === true, false)),
		])
		.flat();
	place(1, record(RT.document, record(RT.slwt, listAtoms, { version: 0xf, instance: 0 }), { version: 0xf }));

	const directory = (entries: ReadonlyMap<number, number>): number[] =>
		record(
			RT.persistDirectory,
			[...entries].flatMap(([persist, offset]) => [...u32((persist & 0xfffff) | (1 << 20)), ...u32(offset)]),
		);
	const userEdit = (directoryOffset: number, lastEdit: number): number[] =>
		record(RT.userEdit, [...u32(0), ...u16(0), 0, 3, ...u32(lastEdit), ...u32(directoryOffset), ...u32(1), ...u32(slides.length + 2), ...u16(1), ...u16(0)]);

	let lastEdit = 0;
	let current = stream.length;
	let live = new Map(offsets);
	const writeEdit = (entries: ReadonlyMap<number, number>): void => {
		const directoryOffset = stream.length;
		stream.push(...directory(entries));
		current = stream.length;
		stream.push(...userEdit(directoryOffset, lastEdit));
		lastEdit = current;
	};
	writeEdit(live);
	for (const edit of options.edits ?? []) {
		const changed = new Map<number, number>();
		for (const [index, slide] of Object.entries(edit.replace)) {
			const persist = slidePersist[Number(index)] ?? 0;
			changed.set(persist, stream.length);
			stream.push(...slideContainer(slide));
		}
		live = new Map([...live, ...changed]);
		writeEdit(changed);
	}

	const token = options.encrypted === true ? 0xf3d1c4df : 0xe391c05f;
	const currentUser = record(0x0ff6, [...u32(20), ...u32(token), ...u32(options.brokenCurrentUser === true ? 0x7fffff00 : current), ...u16(0), ...u16(0x3f4), 3, 0, ...u16(0)]);
	return buildCompoundFile({ "PowerPoint Document": new Uint8Array(stream), "Current User": new Uint8Array(currentUser) });
}
