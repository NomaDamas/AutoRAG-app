/**
 * Internet mail for the Quick Look preview: RFC 5322 headers, RFC 2045 MIME
 * (quoted-printable, base64, multipart), RFC 2047 encoded words, RFC 2231
 * parameters, plus Apple Mail `.emlx` and `mbox` containers. Nothing here
 * executes or fetches: HTML is returned raw for the caller to sanitize, and
 * attachments are listed by size without being decoded.
 */

export interface MailAttachment {
	readonly name: string;
	readonly size: number;
	readonly type: string;
}

export interface MailMessage {
	readonly subject: string;
	readonly from: readonly string[];
	readonly to: readonly string[];
	readonly cc: readonly string[];
	/** ISO instant when the Date header parses, else the header text; null when absent. */
	readonly date: string | null;
	readonly text: string | null;
	readonly html: string | null;
	readonly attachments: readonly MailAttachment[];
	/** `Content-ID` (no angle brackets) to a data URI, for small inline images only. */
	readonly inlineImages: Readonly<Record<string, string>>;
}

export interface MboxEntry {
	readonly start: number;
	readonly end: number;
	readonly subject: string;
	readonly from: string;
	readonly date: string | null;
}

export interface MboxListing {
	/** Messages seen in the bytes provided. */
	readonly count: number;
	/** False when the file was cut at the read cap, so `count` is a lower bound. */
	readonly complete: boolean;
	/** The first {@link MBOX_LIST_LIMIT} messages. */
	readonly messages: readonly MboxEntry[];
}

export const MBOX_LIST_LIMIT = 200;
const MAX_DEPTH = 8;
const MAX_PARTS = 400;
const MAX_INLINE_IMAGE = 512 * 1024;
const HEADER_SCAN = 64 * 1024;
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;

// ---------------------------------------------------------------------------
// Byte and charset helpers. Message structure is walked as a "binary string"
// (one char per byte) so offsets and boundaries are exact whatever the charset.

function toBinary(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return out;
}

function fromBinary(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
	return bytes;
}

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
	cp949: "euc-kr",
	"x-windows-949": "euc-kr",
	uhc: "euc-kr",
	ksc5601: "euc-kr",
	ks_c_5601: "euc-kr",
	"ks_c_5601-1989": "euc-kr",
	"x-euc-kr": "euc-kr",
	"us-ascii": "utf-8",
	ascii: "utf-8",
};

function decoderFor(charset: string | null): TextDecoder | null {
	if (charset === null) return null;
	const name = charset.trim().replace(/^"|"$/g, "").toLowerCase();
	try {
		return new TextDecoder(CHARSET_ALIASES[name] ?? name);
	} catch {
		return null;
	}
}

/** Strict UTF-8, else the Korean Windows code page, the way the text viewer falls back. */
function decodeGuess(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("euc-kr").decode(bytes);
	}
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
	const declared = decoderFor(charset);
	if (declared === null) return decodeGuess(bytes);
	const lowered = (charset ?? "").toLowerCase();
	// A mislabelled `us-ascii` body with high bytes is still text a person wrote.
	if ((lowered === "us-ascii" || lowered === "ascii") && bytes.some((byte) => byte > 0x7f)) return decodeGuess(bytes);
	return declared.decode(bytes);
}

function percentBytes(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const hex = text.slice(i + 1, i + 3);
		if (text[i] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
			out.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			out.push(text.charCodeAt(i) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

function qEncodedBytes(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const hex = text.slice(i + 1, i + 3);
		if (char === "_") out.push(0x20);
		else if (char === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
			out.push(Number.parseInt(hex, 16));
			i += 2;
		} else out.push(text.charCodeAt(i) & 0xff);
	}
	return Uint8Array.from(out);
}

function base64Bytes(text: string): Uint8Array {
	const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
	try {
		return fromBinary(atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "=")));
	} catch {
		return new Uint8Array();
	}
}

/** Decoded size of base64 text without decoding it. */
function base64Size(text: string): number {
	let chars = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47) chars += 1;
	}
	return Math.floor((chars * 3) / 4);
}

function quotedPrintableBytes(text: string): Uint8Array {
	return fromBinary(
		text
			.replace(/=[ \t]*\r?\n/g, "")
			.replace(/=([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
	);
}

const ENCODED_WORD = "=\\?[^?\\s]+\\?[bBqQ]\\?[^?\\s]*\\?=";
const ENCODED_RUN = new RegExp(`${ENCODED_WORD}(?:\\s+${ENCODED_WORD})*`, "g");
const ENCODED_PARTS = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** RFC 2047: `=?charset?B|Q?text?=` words, with the whitespace between adjacent words dropped. */
export function decodeEncodedWords(value: string): string {
	return value.replace(ENCODED_RUN, (run) =>
		// Whitespace between adjacent encoded words is not part of the text (RFC 2047 §6.2).
		run
			.split(/\s+/)
			.map((word) =>
				word.replace(ENCODED_PARTS, (whole, charset: string, kind: string, payload: string) => {
					const bytes = kind.toLowerCase() === "b" ? base64Bytes(payload) : qEncodedBytes(payload);
					const decoder = decoderFor(charset.split("*")[0] ?? charset);
					return decoder === null ? whole : decoder.decode(bytes);
				}),
			)
			.join(""),
	);
}

// ---------------------------------------------------------------------------
// Headers.

type Headers = Readonly<Record<string, string>>;

function splitHeaderBody(raw: string): { readonly head: string; readonly body: string } {
	const match = /\r?\n\r?\n/.exec(raw);
	if (match !== null) return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
	// No blank line: all headers when the first line looks like one, else all body.
	return /^[!-9;-~]+:/.test(raw) ? { head: raw, body: "" } : { head: "", body: raw };
}

function parseHeaders(head: string): Headers {
	const headers: Record<string, string> = {};
	const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
	for (const line of unfolded.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (!/^[!-9;-~]+$/.test(name)) continue;
		if (headers[name] === undefined) headers[name] = line.slice(colon + 1).trim();
	}
	return headers;
}

function decodeHeaderBlock(binaryHead: string): Headers {
	return parseHeaders(decodeGuess(fromBinary(binaryHead)));
}

interface HeaderValue {
	readonly value: string;
	readonly params: Readonly<Record<string, string>>;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
	const out: string[] = [];
	let current = "";
	let quoted = false;
	let angle = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		if (char === "\\" && quoted) {
			current += char + (text[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (char === '"') quoted = !quoted;
		else if (!quoted && separator === "," && char === "<") angle += 1;
		else if (!quoted && separator === "," && char === ">") angle = Math.max(0, angle - 1);
		if (char === separator && !quoted && angle === 0) {
			out.push(current);
			current = "";
		} else current += char;
	}
	out.push(current);
	return out;
}

function unquote(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
	return trimmed;
}

/** `value; name=param; name*=utf-8''enc; name*0=a; name*1=b` with RFC 2231 and 2047 folded in. */
function parseParameterised(raw: string | undefined): HeaderValue {
	const [first = "", ...rest] = splitOutsideQuotes(raw ?? "", ";");
	const plain: Record<string, string> = {};
	const pieces = new Map<string, Map<number, { readonly text: string; readonly extended: boolean }>>();
	for (const item of rest) {
		const equals = item.indexOf("=");
		if (equals <= 0) continue;
		let name = item.slice(0, equals).trim().toLowerCase();
		const value = unquote(item.slice(equals + 1));
		const star = /^(.*?)\*(\d+)?(\*)?$/.exec(name);
		if (star !== null) {
			name = star[1] ?? name;
			const map = pieces.get(name) ?? new Map<number, { readonly text: string; readonly extended: boolean }>();
			// `name*=` and `name*N*=` are percent-encoded; `name*N=` is a plain continuation.
			map.set(Number(star[2] ?? 0), { text: value, extended: star[3] !== undefined || star[2] === undefined });
			pieces.set(name, map);
		} else if (plain[name] === undefined) plain[name] = value;
	}
	const params: Record<string, string> = {};
	for (const [name, text] of Object.entries(plain)) params[name] = decodeEncodedWords(text);
	for (const [name, map] of pieces) {
		let charset: string | null = null;
		const bytes: number[] = [];
		for (const index of [...map.keys()].sort((a, b) => a - b)) {
			const piece = map.get(index);
			if (piece === undefined) continue;
			let text = piece.text;
			if (piece.extended) {
				if (index === 0) {
					const quote = /^([^']*)'[^']*'(.*)$/s.exec(text);
					if (quote !== null) {
						charset = quote[1] === "" ? null : (quote[1] ?? null);
						text = quote[2] ?? "";
					}
				}
				bytes.push(...percentBytes(text));
			} else {
				for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
			}
		}
		params[name] = decodeBytes(Uint8Array.from(bytes), charset ?? "utf-8");
	}
	return { value: first.trim().toLowerCase(), params };
}

function formatAddress(entry: string): string {
	const trimmed = entry.trim();
	const angled = /^(.*?)<([^<>]*)>\s*$/s.exec(trimmed);
	if (angled === null) return decodeEncodedWords(unquote(trimmed));
	const name = decodeEncodedWords(unquote(angled[1] ?? "")).trim();
	const address = (angled[2] ?? "").trim();
	return name === "" ? address : `${name} <${address}>`;
}

function addressList(value: string | undefined): readonly string[] {
	if (value === undefined || value.trim() === "") return [];
	return splitOutsideQuotes(value, ",")
		.map(formatAddress)
		.filter((entry) => entry !== "");
}

function normalizeDate(value: string | undefined): string | null {
	if (value === undefined || value === "") return null;
	const parsed = new Date(value.replace(/\s*\([^)]*\)\s*$/, ""));
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// MIME tree.

interface Collected {
	text: string[];
	html: string[];
	attachments: MailAttachment[];
	inlineImages: Record<string, string>;
	parts: number;
}

function transferBytes(body: string, encoding: string): Uint8Array {
	switch (encoding) {
		case "base64":
			return base64Bytes(body);
		case "quoted-printable":
			return quotedPrintableBytes(body);
		default:
			return fromBinary(body);
	}
}

function transferSize(body: string, encoding: string): number {
	switch (encoding) {
		case "base64":
			return base64Size(body);
		case "quoted-printable":
			return quotedPrintableBytes(body).length;
		default:
			return body.length;
	}
}

function splitMultipart(body: string, boundary: string): string[] {
	const delimiter = `--${boundary}`;
	const parts: string[] = [];
	let cursor = -1;
	let search = 0;
	for (;;) {
		const at = body.indexOf(delimiter, search);
		if (at < 0) break;
		search = at + delimiter.length;
		if (at !== 0 && body[at - 1] !== "\n") continue;
		const closing = body.startsWith("--", search);
		const lineEnd = body.indexOf("\n", search);
		const afterLine = lineEnd < 0 ? body.length : lineEnd + 1;
		if (cursor >= 0) {
			let end = at;
			if (body[end - 1] === "\n") end -= 1;
			if (body[end - 1] === "\r") end -= 1;
			parts.push(body.slice(cursor, Math.max(cursor, end)));
		}
		if (closing) return parts;
		cursor = afterLine;
		search = afterLine;
	}
	if (cursor >= 0 && cursor <= body.length) parts.push(body.slice(cursor));
	return parts;
}

function walk(raw: string, depth: number, out: Collected): Headers {
	const { head, body } = splitHeaderBody(raw);
	const headers = decodeHeaderBlock(head);
	out.parts += 1;
	const type = parseParameterised(headers["content-type"]);
	const disposition = parseParameterised(headers["content-disposition"]);
	const mime = type.value === "" ? "text/plain" : type.value;
	if (mime.startsWith("multipart/")) {
		const boundary = type.params["boundary"];
		if (boundary !== undefined && boundary !== "" && depth < MAX_DEPTH) {
			for (const part of splitMultipart(body, boundary)) {
				if (out.parts >= MAX_PARTS) break;
				walk(part, depth + 1, out);
			}
			return headers;
		}
		return headers;
	}
	const encoding = (headers["content-transfer-encoding"] ?? "7bit").trim().toLowerCase();
	const contentId = (headers["content-id"] ?? "").replace(/^<|>$/g, "").trim();
	const fileName = disposition.params["filename"] ?? type.params["name"];
	const isBody = mime.startsWith("text/") && disposition.value !== "attachment" && fileName === undefined;
	if (isBody) {
		const text = decodeBytes(transferBytes(body, encoding), type.params["charset"] ?? null);
		if (mime === "text/html") out.html.push(text);
		else if (mime === "text/plain" || mime.startsWith("text/")) out.text.push(text);
		return headers;
	}
	const size = transferSize(body, encoding);
	if (contentId !== "" && INLINE_IMAGE.test(mime) && encoding === "base64" && size <= MAX_INLINE_IMAGE) {
		out.inlineImages[contentId] = `data:${mime};base64,${body.replace(/\s+/g, "")}`;
	}
	out.attachments.push({ name: fileName ?? (contentId === "" ? "attachment" : contentId), size, type: mime });
	return headers;
}

/** Parses one RFC 5322 message. Total: hostile input yields an empty or partial result, never a throw. */
export function parseMail(bytes: Uint8Array): MailMessage {
	const out: Collected = { text: [], html: [], attachments: [], inlineImages: {}, parts: 0 };
	const headers = walk(toBinary(bytes), 0, out);
	return {
		subject: decodeEncodedWords(headers["subject"] ?? ""),
		from: addressList(headers["from"]),
		to: addressList(headers["to"]),
		cc: addressList(headers["cc"]),
		date: normalizeDate(headers["date"]),
		text: out.text.length === 0 ? null : out.text.join("\n\n"),
		html: out.html.length === 0 ? null : out.html.join("\n"),
		attachments: out.attachments,
		inlineImages: out.inlineImages,
	};
}

/** Apple Mail `.emlx`: a byte-count line, the message, then a property list. */
export function parseEmlx(bytes: Uint8Array): MailMessage {
	const newline = bytes.indexOf(0x0a);
	if (newline > 0) {
		const count = /^\s*(\d+)\s*$/.exec(new TextDecoder().decode(bytes.subarray(0, newline)));
		if (count !== null) return parseMail(bytes.subarray(newline + 1, newline + 1 + Number(count[1])));
	}
	return parseMail(bytes);
}

// ---------------------------------------------------------------------------
// mbox.

const FROM_LINE = [0x46, 0x72, 0x6f, 0x6d, 0x20];

function isFromLine(bytes: Uint8Array, at: number): boolean {
	if (at + FROM_LINE.length > bytes.length) return false;
	if (at > 0 && bytes[at - 1] !== 0x0a) return false;
	return FROM_LINE.every((byte, index) => bytes[at + index] === byte);
}

function summarize(bytes: Uint8Array, start: number, end: number): MboxEntry {
	const slice = bytes.subarray(start, Math.min(end, start + HEADER_SCAN));
	const { head } = splitHeaderBody(toBinary(slice));
	const headers = decodeHeaderBlock(head);
	return {
		start,
		end,
		subject: decodeEncodedWords(headers["subject"] ?? ""),
		from: addressList(headers["from"]).join(", "),
		date: normalizeDate(headers["date"]),
	};
}

/**
 * Counts every message in `bytes` with a byte scan and summarises only the
 * first {@link MBOX_LIST_LIMIT}, so a file that hit the read cap stays bounded.
 * Lines that start with `From ` separate messages (mboxrd quotes the rest).
 */
export function listMbox(bytes: Uint8Array, truncated: boolean): MboxListing {
	const starts: number[] = [];
	for (let at = bytes.indexOf(0x46); at >= 0; at = bytes.indexOf(0x46, at + 1)) {
		if (isFromLine(bytes, at)) starts.push(at);
	}
	if (starts.length === 0) {
		return { count: bytes.length === 0 ? 0 : 1, complete: !truncated, messages: bytes.length === 0 ? [] : [summarize(bytes, 0, bytes.length)] };
	}
	const messages: MboxEntry[] = [];
	for (let index = 0; index < Math.min(starts.length, MBOX_LIST_LIMIT); index++) {
		const lineEnd = bytes.indexOf(0x0a, starts[index] ?? 0);
		const bodyStart = lineEnd < 0 ? bytes.length : lineEnd + 1;
		messages.push(summarize(bytes, bodyStart, starts[index + 1] ?? bytes.length));
	}
	return { count: starts.length, complete: !truncated, messages };
}

/** Opens one listed message, undoing mboxrd's `>From ` quoting. */
export function readMboxMessage(bytes: Uint8Array, entry: MboxEntry): MailMessage {
	const raw = toBinary(bytes.subarray(entry.start, entry.end)).replace(/^>(>*From )/gm, "$1");
	return parseMail(fromBinary(raw));
}
