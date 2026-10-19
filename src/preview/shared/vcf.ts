/** vCard 2.1 / 3.0 / 4.0 contacts for the Quick Look preview. */

export interface ContactValue {
	/** Comma-joined TYPE parameters (`CELL`, `WORK, VOICE`); empty when untyped. */
	readonly type: string;
	readonly value: string;
}

export interface Contact {
	readonly name: string;
	readonly org: string;
	readonly title: string;
	readonly phones: readonly ContactValue[];
	readonly emails: readonly ContactValue[];
	readonly addresses: readonly ContactValue[];
	readonly note: string;
	/** `data:image/...` URI of an embedded photo; null for no photo or an unsafe one. */
	readonly photo: string | null;
}

const MAX_CONTACTS = 500;
const MAX_PHOTO_CHARS = 2 * 1024 * 1024;
const SAFE_PHOTO = /^(png|jpe?g|gif|webp)$/i;

interface Line {
	readonly name: string;
	readonly params: Readonly<Record<string, string>>;
	readonly value: string;
}

function decodeBytes(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("euc-kr").decode(bytes);
	}
}

/** Joins folded lines, and the `=` soft breaks of v2.1 quoted-printable values. */
function unfold(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const last = lines.length - 1;
		if ((raw.startsWith(" ") || raw.startsWith("\t")) && last >= 0) lines[last] += raw.slice(1);
		else if (last >= 0 && /;ENCODING=QUOTED-PRINTABLE/i.test(lines[last] ?? "") && /=$/.test(lines[last] ?? "")) lines[last] = (lines[last] ?? "").slice(0, -1) + raw;
		else lines.push(raw);
	}
	return lines;
}

function parseLine(line: string): Line | null {
	let quoted = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === '"') quoted = !quoted;
		else if (line[i] === ":" && !quoted) {
			colon = i;
			break;
		}
	}
	if (colon <= 0) return null;
	const [head = "", ...rawParams] = line.slice(0, colon).split(";");
	const params: Record<string, string> = {};
	for (const item of rawParams) {
		const equals = item.indexOf("=");
		// v2.1 writes bare type words: `TEL;CELL;VOICE`.
		const key = equals < 0 ? "type" : item.slice(0, equals).toLowerCase();
		const value = (equals < 0 ? item : item.slice(equals + 1)).replace(/^"|"$/g, "");
		params[key] = params[key] === undefined ? value : `${params[key]},${value}`;
	}
	return { name: (head.split(".").pop() ?? head).toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeValue(value: string): string {
	return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

/** Splits on unescaped `;` (structured values) and unescapes each part. */
function components(value: string): string[] {
	return value.split(/(?<!\\);/).map(unescapeValue);
}

function qpDecode(line: Line): string {
	if (!/quoted-printable/i.test(line.params["encoding"] ?? "")) return line.value;
	const bytes = Uint8Array.from(
		line.value.replace(/=([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
		(char) => char.charCodeAt(0) & 0xff,
	);
	const charset = line.params["charset"];
	try {
		return charset === undefined ? decodeBytes(bytes) : new TextDecoder(charset).decode(bytes);
	} catch {
		return decodeBytes(bytes);
	}
}

function typeOf(line: Line): string {
	return (line.params["type"] ?? "")
		.split(",")
		.map((word) => word.trim().toUpperCase())
		.filter((word) => word !== "" && word !== "PREF" && word !== "INTERNET")
		.join(", ");
}

function photoOf(line: Line): string | null {
	const value = line.value.trim();
	const uri = /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(value);
	if (uri !== null) return SAFE_PHOTO.test(uri[1] ?? "") && value.length <= MAX_PHOTO_CHARS ? `data:image/${(uri[1] ?? "").toLowerCase()};base64,${(uri[2] ?? "").replace(/\s+/g, "")}` : null;
	const encoded = /^b(ase64)?$/i.test(line.params["encoding"] ?? "");
	const kind = (line.params["type"] ?? "").split(",")[0] ?? "";
	if (!encoded || !SAFE_PHOTO.test(kind) || value.length > MAX_PHOTO_CHARS || !/^[A-Za-z0-9+/=\s]*$/.test(value)) return null;
	return `data:image/${kind.toLowerCase()};base64,${value.replace(/\s+/g, "")}`;
}

function build(lines: readonly Line[]): Contact {
	let formatted = "";
	let structured: string[] = [];
	let org = "";
	let title = "";
	let note = "";
	let photo: string | null = null;
	const phones: ContactValue[] = [];
	const emails: ContactValue[] = [];
	const addresses: ContactValue[] = [];
	for (const line of lines) {
		const text = qpDecode(line);
		switch (line.name) {
			case "FN":
				formatted = unescapeValue(text).trim();
				break;
			case "N":
				structured = components(text);
				break;
			case "ORG":
				org = components(text).filter((part) => part !== "").join(", ");
				break;
			case "TITLE":
				title = unescapeValue(text);
				break;
			case "NOTE":
				note = unescapeValue(text);
				break;
			case "TEL":
				phones.push({ type: typeOf(line), value: unescapeValue(text) });
				break;
			case "EMAIL":
				emails.push({ type: typeOf(line), value: unescapeValue(text) });
				break;
			case "ADR":
				// Post-office box, extended, street, locality, region, postal code, country.
				addresses.push({ type: typeOf(line), value: components(text).filter((part) => part.trim() !== "").join(", ") });
				break;
			case "PHOTO":
				photo ??= photoOf(line);
				break;
			default:
				break;
		}
	}
	const [family = "", given = "", additional = "", prefix = "", suffix = ""] = structured;
	const composed = [prefix, given, additional, family, suffix].filter((part) => part !== "").join(" ");
	return { name: formatted === "" ? composed : formatted, org, title, phones, emails, addresses, note, photo };
}

/** Reads every `BEGIN:VCARD` card (up to a cap). Junk yields an empty list. */
export function parseVcf(bytes: Uint8Array): Contact[] {
	const contacts: Contact[] = [];
	let current: Line[] | null = null;
	for (const raw of unfold(decodeBytes(bytes))) {
		const upper = raw.trim().toUpperCase();
		if (upper === "BEGIN:VCARD") current = [];
		else if (upper === "END:VCARD") {
			if (current !== null) contacts.push(build(current));
			current = null;
			if (contacts.length >= MAX_CONTACTS) break;
		} else if (current !== null) {
			const line = parseLine(raw);
			if (line !== null) current.push(line);
		}
	}
	return contacts;
}
