export interface ZipEntry {
	readonly name: string;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
}

function u16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
	return u16(bytes, offset) | (u16(bytes, offset + 2) << 16);
}

function findEocd(bytes: Uint8Array): number {
	const min = Math.max(0, bytes.length - 22 - 65535);
	for (let index = bytes.length - 22; index >= min; index -= 1) {
		if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
			return index;
		}
	}
	return -1;
}

export function listZipEntries(bytes: Uint8Array): readonly ZipEntry[] | null {
	const eocd = findEocd(bytes);
	if (eocd < 0) return null;
	const count = Math.min(u16(bytes, eocd + 10), 500);
	let offset = u32(bytes, eocd + 16);
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) break;
		const compressedSize = u32(bytes, offset + 20);
		const uncompressedSize = u32(bytes, offset + 24);
		const nameLength = u16(bytes, offset + 28);
		const extraLength = u16(bytes, offset + 30);
		const commentLength = u16(bytes, offset + 32);
		const nameStart = offset + 46;
		const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, nameStart + nameLength));
		if (!name.endsWith("/")) entries.push({ name, compressedSize, uncompressedSize });
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}
