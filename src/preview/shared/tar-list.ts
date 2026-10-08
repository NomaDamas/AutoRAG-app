export interface TarEntry {
	readonly name: string;
	readonly size: number;
	/** Modification time in ms since the epoch; null when the header carries none. */
	readonly modified: number | null;
}

/** Entries read before the listing stops; a tar has no index, so every header is a 512-byte hop. */
const MAX_ENTRIES = 20_000;

function readField(bytes: Uint8Array, offset: number, length: number): string {
	let end = offset;
	const stop = Math.min(bytes.length, offset + length);
	while (end < stop && bytes[end] !== 0) end += 1;
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(offset, end));
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
	const text = readField(bytes, offset, length).trim();
	if (text === "") return 0;
	const value = Number.parseInt(text, 8);
	return Number.isFinite(value) ? value : 0;
}

/** `length key=value\n` records of a pax extended header; only the keys a listing needs. */
function readPax(bytes: Uint8Array): { readonly path: string | null; readonly mtime: number | null } {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	let path: string | null = null;
	let mtime: number | null = null;
	for (const line of text.split("\n")) {
		const record = line.slice(line.indexOf(" ") + 1);
		const equals = record.indexOf("=");
		if (equals < 0) continue;
		const key = record.slice(0, equals);
		const value = record.slice(equals + 1);
		if (key === "path") path = value;
		if (key === "mtime" && Number.isFinite(Number(value))) mtime = Math.round(Number(value) * 1000);
	}
	return { path, mtime };
}

/**
 * The entries of an uncompressed tar. Extended headers (pax `x`/`g`, which
 * macOS's tar writes before every file, and GNU `L` long names) are not
 * entries: their path and date are applied to the entry that follows.
 */
export function listTarEntries(bytes: Uint8Array): readonly TarEntry[] | null {
	if (bytes.length < 512) return null;
	const entries: TarEntry[] = [];
	let offset = 0;
	let pending: { path: string | null; mtime: number | null } = { path: null, mtime: null };
	while (offset + 512 <= bytes.length && entries.length < MAX_ENTRIES) {
		const header = bytes.subarray(offset, offset + 512);
		const name = readField(header, 0, 100);
		if (name === "") break;
		const size = readOctal(header, 124, 12);
		const flag = String.fromCharCode(header[156] ?? 0);
		const next = offset + 512 * (1 + Math.ceil(size / 512));
		const body = bytes.subarray(offset + 512, Math.min(bytes.length, offset + 512 + size));
		if (flag === "x") {
			pending = readPax(body);
		} else if (flag === "L") {
			pending = { ...pending, path: readField(body, 0, body.length) };
		} else if (flag !== "g" && flag !== "K") {
			const prefix = readField(header, 345, 155);
			const seconds = readOctal(header, 136, 12);
			const modified = pending.mtime ?? (seconds > 0 ? seconds * 1000 : null);
			entries.push({ name: pending.path ?? (prefix === "" ? name : `${prefix}/${name}`), size, modified });
			pending = { path: null, mtime: null };
		}
		offset = next;
	}
	return entries.length === 0 ? null : entries;
}
