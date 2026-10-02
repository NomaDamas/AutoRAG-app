export interface TarEntry {
	readonly name: string;
	readonly size: number;
}

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

export function listTarEntries(bytes: Uint8Array): readonly TarEntry[] | null {
	if (bytes.length < 512) return null;
	const entries: TarEntry[] = [];
	let offset = 0;
	while (offset + 512 <= bytes.length && entries.length < 500) {
		const header = bytes.subarray(offset, offset + 512);
		const name = readField(header, 0, 100);
		if (name === "") break;
		const prefix = readField(header, 345, 155);
		const size = readOctal(header, 124, 12);
		entries.push({ name: prefix === "" ? name : `${prefix}/${name}`, size });
		offset += 512 * (1 + Math.ceil(size / 512));
	}
	return entries.length === 0 ? null : entries;
}
