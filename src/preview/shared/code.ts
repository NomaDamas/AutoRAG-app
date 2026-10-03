/** Identifiers right before a `(`: calls (and definitions) the grammar left plain. */
const CALL = /\b([A-Za-z_][\w$]*)(?=\s*\()/g;
/** SCREAMING_CASE names read as constants, as Xcode colors them. */
const CONSTANT = /\b([A-Z][A-Z0-9_]+)\b/g;
const TAG = /<span[^>]*>|<\/span>|\n/g;

/** Classifies a run of plain (unspanned) highlighted text; it is already HTML-escaped. */
function markPlain(text: string): string {
	return text
		.replace(CALL, '<span class="ql-call">$1</span>')
		.replace(CONSTANT, (match, name: string, offset: number, whole: string) => {
			// Skip names already wrapped as calls: they sit right after `ql-call">`.
			if (whole.slice(Math.max(0, offset - 2), offset) === '">') return match;
			return `<span class="ql-const">${name}</span>`;
		});
}

/**
 * Splits highlight.js output into one balanced HTML string per source line:
 * spans open at a newline are closed there and reopened on the next line.
 * Text outside any span gets call and constant classes, which the grammars
 * leave out. A final newline does not start an extra line.
 */
export function splitHighlighted(html: string): readonly string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let line = "";
	let last = 0;
	const flushText = (end: number): void => {
		const text = html.slice(last, end);
		line += open.length === 0 ? markPlain(text) : text;
	};
	for (const match of html.matchAll(TAG)) {
		const index = match.index;
		flushText(index);
		last = index + match[0].length;
		const tag = match[0];
		if (tag === "\n") {
			lines.push(line + "</span>".repeat(open.length));
			line = open.join("");
		} else if (tag === "</span>") {
			open.pop();
			line += tag;
		} else {
			open.push(tag);
			line += tag;
		}
	}
	flushText(html.length);
	if (line !== "" || lines.length === 0) lines.push(line);
	return lines;
}

export type TextEncodingName = "UTF-8" | "UTF-8 BOM" | "UTF-16 LE" | "UTF-16 BE" | "EUC-KR";

function decodeWith(label: string, bytes: Uint8Array, fatal: boolean): string {
	// `stream` keeps a character cut by the 4MB prefix from turning into an error.
	return new TextDecoder(label, { fatal }).decode(bytes, { stream: true });
}

/**
 * Decodes a text file the way an editor would: a byte order mark wins, then
 * strict UTF-8, then the Korean Windows code page (CP949, which Chromium
 * serves as EUC-KR) for legacy files saved on Windows.
 */
export function decodeText(bytes: Uint8Array): { readonly text: string; readonly encoding: TextEncodingName } {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: decodeWith("utf-8", bytes.subarray(3), false), encoding: "UTF-8 BOM" };
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decodeWith("utf-16le", bytes.subarray(2), false), encoding: "UTF-16 LE" };
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decodeWith("utf-16be", bytes.subarray(2), false), encoding: "UTF-16 BE" };
	try {
		return { text: decodeWith("utf-8", bytes, true), encoding: "UTF-8" };
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return { text: decodeWith("euc-kr", bytes, false), encoding: "EUC-KR" };
	}
}

/** The line ending of the first line break; a single-line file counts as LF. */
export function lineEnding(text: string): "LF" | "CRLF" | "CR" {
	const index = text.search(/\r\n|\r|\n/);
	if (index < 0 || text[index] === "\n") return "LF";
	return text[index + 1] === "\n" ? "CRLF" : "CR";
}
