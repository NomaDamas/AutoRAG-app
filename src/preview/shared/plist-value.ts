/**
 * Property lists as structured values, for previews that need more than the
 * XML text `plist.ts` renders: `.webloc` bookmarks, `.textclipping` clippings,
 * and `.webarchive` archives keep their payload in a plist. Binary input is
 * converted with the bounds-checked reader in `./plist`, then parsed by a small
 * non-validating XML reader. The reader never fetches or expands external
 * entities, and it caps input size and nesting because the file is arbitrary.
 */

import { bplistToXml, isBinaryPlist } from "./plist";

export interface PlistDictionary {
	readonly [key: string]: PlistValue;
}

export type PlistValue = string | number | boolean | Date | Uint8Array | readonly PlistValue[] | PlistDictionary;

const MAX_BYTES = 16 * 1024 * 1024;
/** Mirrors the conversion cap in `./plist`, so both paths reject the same nesting. */
const MAX_DEPTH = 64;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^([+-]?)(0[xX][0-9a-fA-F]+|\d+)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NAME = /[-A-Za-z0-9_:.]/;

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

class Reader {
	private at = 0;

	constructor(private readonly text: string) {}

	parse(): PlistValue {
		this.skipMisc();
		if (this.text[this.at] !== "<") this.fail("Expected a property list document");
		const root = this.start();
		if (root.name !== "plist") this.fail("Expected a <plist> root element");
		if (root.selfClosing) this.fail("A property list needs one value");
		const parsed = this.value(0);
		this.skipMisc();
		this.end("plist");
		this.skipMisc();
		if (this.at < this.text.length) this.fail("Unexpected content after the property list");
		return parsed;
	}

	private value(depth: number): PlistValue {
		if (depth > MAX_DEPTH) this.fail("Property list is nested too deeply");
		this.skipMisc();
		if (this.text[this.at] !== "<" || this.text.startsWith("</", this.at)) this.fail("Expected a property list value");
		const tag = this.start();
		switch (tag.name) {
			case "dict":
				return tag.selfClosing ? {} : this.dict(depth);
			case "array":
				return tag.selfClosing ? [] : this.array(depth);
			case "key":
				return this.fail("<key> is only valid inside a dictionary");
			case "string":
				return tag.selfClosing ? "" : this.textOf("string");
			case "data":
				return this.data(tag.selfClosing ? "" : this.textOf("data"));
			case "date":
				return this.date(tag.selfClosing ? "" : this.textOf("date"));
			case "integer":
				return this.integer(tag.selfClosing ? "" : this.textOf("integer"));
			case "real":
				return this.real(tag.selfClosing ? "" : this.textOf("real"));
			case "true":
				return this.bool(tag.selfClosing, "true", true);
			case "false":
				return this.bool(tag.selfClosing, "false", false);
			default:
				return this.fail(`Unsupported property list element <${tag.name}>`);
		}
	}

	private dict(depth: number): Readonly<Record<string, PlistValue>> {
		const entries = Object.create(null) as Record<string, PlistValue>;
		for (;;) {
			this.skipMisc();
			if (this.text.startsWith("</", this.at)) {
				this.end("dict");
				return entries;
			}
			if (this.text[this.at] !== "<") this.fail("Expected a dictionary key");
			const tag = this.start();
			if (tag.name !== "key") this.fail("Expected a dictionary key");
			const key = tag.selfClosing ? "" : this.textOf("key");
			entries[key] = this.value(depth + 1);
		}
	}

	private array(depth: number): readonly PlistValue[] {
		const items: PlistValue[] = [];
		for (;;) {
			this.skipMisc();
			if (this.text.startsWith("</", this.at)) {
				this.end("array");
				return items;
			}
			items.push(this.value(depth + 1));
		}
	}

	private bool(selfClosing: boolean, tag: string, result: boolean): boolean {
		if (!selfClosing && this.textOf(tag).trim() !== "") this.fail(`Unexpected content in <${tag}>`);
		return result;
	}

	private data(raw: string): Uint8Array {
		const compact = raw.replace(/\s+/g, "");
		if (compact.length === 0) return new Uint8Array(0);
		if (!BASE64.test(compact) || compact.length % 4 === 1) this.fail("Invalid property list data");
		let binary: string;
		try {
			binary = atob(compact);
		} catch {
			return this.fail("Invalid property list data");
		}
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	}

	private date(raw: string): Date {
		const text = raw.trim();
		const time = DATE.test(text) ? Date.parse(text) : Number.NaN;
		if (Number.isNaN(time)) this.fail("Invalid property list date");
		return new Date(time);
	}

	private integer(raw: string): number {
		const match = INTEGER.exec(raw.trim());
		if (match === null) this.fail("Invalid property list integer");
		const magnitude = BigInt(match[2] ?? "");
		return Number(match[1] === "-" ? -magnitude : magnitude);
	}

	private real(raw: string): number {
		const text = raw.trim().toLowerCase();
		if (text === "nan") return Number.NaN;
		if (text === "infinity" || text === "+infinity" || text === "inf" || text === "+inf") return Number.POSITIVE_INFINITY;
		if (text === "-infinity" || text === "-inf") return Number.NEGATIVE_INFINITY;
		if (!REAL.test(text)) this.fail("Invalid property list real");
		return Number(text);
	}

	/** Literal character data up to the closing tag; entities and CDATA are honoured, child elements are not. */
	private textOf(tag: string): string {
		let out = "";
		for (;;) {
			const next = this.text.indexOf("<", this.at);
			if (next < 0) this.fail(`Unclosed <${tag}> element`);
			out += this.entities(this.text.slice(this.at, next));
			this.at = next;
			if (this.text.startsWith("</", next)) {
				this.end(tag);
				return out;
			}
			if (this.text.startsWith("<![CDATA[", next)) {
				const close = this.text.indexOf("]]>", next + 9);
				if (close < 0) this.fail("Unclosed CDATA section");
				out += this.text.slice(next + 9, close);
				this.at = close + 3;
				continue;
			}
			this.fail(`Unexpected element inside <${tag}>`);
		}
	}

	private entities(raw: string): string {
		if (!raw.includes("&")) return raw;
		let out = "";
		let at = 0;
		for (;;) {
			const amp = raw.indexOf("&", at);
			if (amp < 0) return out + raw.slice(at);
			out += raw.slice(at, amp);
			const semi = raw.indexOf(";", amp + 1);
			if (semi < 0 || semi - amp > 12) this.fail("Malformed entity reference");
			const body = raw.slice(amp + 1, semi);
			if (/^#\d+$/.test(body)) out += this.character(Number(body.slice(1)));
			else if (/^#x[0-9a-fA-F]+$/.test(body)) out += this.character(Number.parseInt(body.slice(2), 16));
			else if (Object.hasOwn(NAMED, body)) out += NAMED[body] ?? "";
			else this.fail(`Unsupported entity &${body};`);
			at = semi + 1;
		}
	}

	private character(code: number): string {
		const valid = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
		if (!valid) this.fail("Invalid character reference");
		return String.fromCodePoint(code);
	}

	private skipMisc(): void {
		for (;;) {
			this.space();
			if (this.text.startsWith("<!--", this.at)) {
				const close = this.text.indexOf("-->", this.at + 4);
				if (close < 0) this.fail("Unclosed comment");
				this.at = close + 3;
				continue;
			}
			if (this.text.startsWith("<?", this.at)) {
				const close = this.text.indexOf("?>", this.at + 2);
				if (close < 0) this.fail("Unclosed processing instruction");
				this.at = close + 2;
				continue;
			}
			if (this.text.startsWith("<!", this.at)) {
				this.declaration();
				continue;
			}
			return;
		}
	}

	/** Skips `<!DOCTYPE ...>`, including an internal subset, without processing any declaration. */
	private declaration(): void {
		let brackets = 0;
		let quote = "";
		for (let at = this.at + 2; at < this.text.length; at += 1) {
			const character = this.text[at] ?? "";
			if (quote !== "") {
				if (character === quote) quote = "";
				continue;
			}
			if (character === '"' || character === "'") quote = character;
			else if (character === "[") brackets += 1;
			else if (character === "]") brackets -= 1;
			else if (character === ">" && brackets <= 0) {
				this.at = at + 1;
				return;
			}
		}
		this.fail("Unclosed declaration");
	}

	private space(): void {
		for (;;) {
			const code = this.text.charCodeAt(this.at);
			if (code !== 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return;
			this.at += 1;
		}
	}

	private start(): { readonly name: string; readonly selfClosing: boolean } {
		this.at += 1;
		const name = this.name();
		let quote = "";
		for (;;) {
			const character = this.text[this.at];
			if (character === undefined) this.fail(`Unclosed <${name}> element`);
			this.at += 1;
			if (quote !== "") {
				if (character === quote) quote = "";
				continue;
			}
			if (character === '"' || character === "'") quote = character;
			else if (character === ">") return { name, selfClosing: false };
			else if (character === "/" && this.text[this.at] === ">") {
				this.at += 1;
				return { name, selfClosing: true };
			} else if (character === "<") this.fail(`Malformed <${name}> element`);
		}
	}

	private end(tag: string): void {
		if (!this.text.startsWith("</", this.at)) this.fail(`Expected </${tag}>`);
		this.at += 2;
		if (this.name() !== tag) this.fail(`Expected </${tag}>`);
		this.space();
		if (this.text[this.at] !== ">") this.fail(`Expected </${tag}>`);
		this.at += 1;
	}

	private name(): string {
		const start = this.at;
		for (;;) {
			const character = this.text[this.at];
			if (character === undefined || !NAME.test(character)) break;
			if (this.at === start && !/[A-Za-z_:]/.test(character)) break;
			this.at += 1;
		}
		if (this.at === start) this.fail("Expected an element name");
		return this.text.slice(start, this.at);
	}

	private fail(message: string): never {
		throw new Error(message);
	}
}

function decodeText(bytes: Uint8Array): string {
	try {
		if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
		if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("Invalid property list text encoding");
	}
}

/** Parses an XML or binary (`bplist00`) property list. Throws an `Error` for malformed input. */
export function parsePlist(bytes: Uint8Array): PlistValue {
	if (bytes.byteLength > MAX_BYTES) throw new Error("Property list is too large to parse");
	const xml = isBinaryPlist(bytes) ? bplistToXml(bytes, Math.ceil(bytes.byteLength * 1.5) + 65_536) : decodeText(bytes);
	return new Reader(xml).parse();
}
