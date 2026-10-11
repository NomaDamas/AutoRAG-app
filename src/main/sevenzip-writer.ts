/**
 * Minimal 7z container writer. Every file is its own folder (one Deflate coder
 * each), so peak memory tracks the largest member — the same bound as the zip
 * writer — and nothing is solid-compressed. Deflate and the CRC come from
 * `node:zlib`; no archive library is linked, and the output opens in 7-Zip,
 * libarchive, and py7zr.
 *
 * Layout (7-Zip's `7zFormat.txt`): a 32-byte signature header, the packed
 * streams, then one plain header describing them. The signature header is
 * written last, once the header's offset, size, and CRC are known. Directories
 * and empty files carry no stream: they are `kEmptyStream` entries, told apart
 * by `kEmptyFile`.
 *
 * Deflate rather than LZMA: no permissively licensed, maintained LZMA encoder
 * ships in this build, and Deflate is a standard 7z method every reader accepts.
 */

import { lstat, open, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);

/** One file or directory to write, with its archive-relative "/"-separated path. */
export interface SevenZipMember {
	readonly source: string;
	/** Directories carry a trailing "/", which is not stored. */
	readonly entry: string;
	readonly directory: boolean;
}

const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
const SIGNATURE_HEADER_SIZE = 32;
/** One simple coder, three-byte id 04 01 08 (Deflate), no properties. */
const DEFLATE_CODER = Buffer.from([0x01, 0x03, 0x04, 0x01, 0x08]);
/** Milliseconds from 1601-01-01 (FILETIME epoch) to the Unix epoch. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;
const DEFLATE_LEVEL = 6;

/** FILE_ATTRIBUTE_DIRECTORY / _ARCHIVE, and 7-Zip's flag saying the high 16 bits hold a Unix st_mode. */
const WIN_DIRECTORY = 0x10;
const WIN_ARCHIVE = 0x20;
const UNIX_EXTENSION = 0x8000;

/** Property and structure ids from 7zFormat.txt. */
const ID = {
	end: 0x00,
	header: 0x01,
	mainStreamsInfo: 0x04,
	filesInfo: 0x05,
	packInfo: 0x06,
	unpackInfo: 0x07,
	subStreamsInfo: 0x08,
	size: 0x09,
	crc: 0x0a,
	folder: 0x0b,
	codersUnpackSize: 0x0c,
	emptyStream: 0x0e,
	emptyFile: 0x0f,
	names: 0x11,
	mTime: 0x14,
	winAttributes: 0x15,
} as const;

/**
 * 7z's variable-length UINT64: the first byte's leading 1-bits count the extra
 * little-endian bytes that follow, and its low bits hold the value's high part.
 */
function number(value: number): Buffer {
	const v = BigInt(value);
	let first = 0;
	let mask = 0x80;
	let extra = 0;
	for (; extra < 8; extra += 1) {
		if (v < 1n << BigInt(7 * (extra + 1))) {
			first |= Number(v >> BigInt(8 * extra));
			break;
		}
		first |= mask;
		mask >>= 1;
	}
	const out = Buffer.alloc(1 + extra);
	out[0] = first;
	for (let i = 0; i < extra; i += 1) out[1 + i] = Number((v >> BigInt(8 * i)) & 0xffn);
	return out;
}

/** A MSB-first bit vector, as 7z stores `kEmptyStream` and `kEmptyFile`. */
function bitVector(bits: readonly boolean[]): Buffer {
	const out = Buffer.alloc(Math.ceil(bits.length / 8));
	bits.forEach((set, index) => {
		if (set) out[index >> 3] = (out[index >> 3] ?? 0) | (0x80 >> (index & 7));
	});
	return out;
}

/** One FilesInfo property: id, byte size, payload. */
function property(id: number, payload: Buffer): Buffer {
	return Buffer.concat([Buffer.from([id]), number(payload.length), payload]);
}

/** What the writer recorded for one file that has a stream. */
interface PackedFile {
	readonly packedSize: number;
	readonly unpackedSize: number;
	readonly crc: number;
}

/**
 * Write `members` as a 7z archive at `target`. Each file is read and deflated
 * before the next starts; a failed write removes the partial archive.
 */
export async function writeSevenZip(target: string, members: readonly SevenZipMember[]): Promise<void> {
	const handle = await open(target, "w");
	try {
		await handle.write(Buffer.alloc(SIGNATURE_HEADER_SIZE));
		const packed: PackedFile[] = [];
		const emptyStream: boolean[] = [];
		const mtimes = Buffer.alloc(8 * members.length);
		const attributes = Buffer.alloc(4 * members.length);
		let packedBytes = 0;

		for (const [index, member] of members.entries()) {
			const stats = await lstat(member.source);
			mtimes.writeBigUInt64LE((BigInt(Math.trunc(stats.mtimeMs)) + FILETIME_EPOCH_MS) * 10_000n, 8 * index);
			// Windows attribute bits, plus 7-Zip's Unix extension: type and permissions in the high 16 bits.
			const unixMode = member.directory ? 0o040000 | (stats.mode & 0o777) | 0o700 : 0o100000 | (stats.mode & 0o777);
			attributes.writeUInt32LE(((unixMode << 16) | UNIX_EXTENSION | (member.directory ? WIN_DIRECTORY : WIN_ARCHIVE)) >>> 0, 4 * index);
			const content = member.directory ? Buffer.alloc(0) : await readFile(member.source);
			emptyStream.push(content.length === 0);
			if (content.length === 0) continue;
			const body = await deflate(content, { level: DEFLATE_LEVEL });
			await handle.write(body);
			packed.push({ packedSize: body.length, unpackedSize: content.length, crc: crc32(content) });
			packedBytes += body.length;
		}

		const parts: Buffer[] = [Buffer.from([ID.header])];
		if (packed.length > 0) {
			const crcs = Buffer.alloc(4 * packed.length);
			packed.forEach((file, i) => crcs.writeUInt32LE(file.crc, 4 * i));
			parts.push(
				Buffer.from([ID.mainStreamsInfo, ID.packInfo]),
				number(0),
				number(packed.length),
				Buffer.from([ID.size]),
				...packed.map((file) => number(file.packedSize)),
				Buffer.from([ID.end, ID.unpackInfo, ID.folder]),
				number(packed.length),
				Buffer.from([0x00]),
				...packed.map(() => DEFLATE_CODER),
				Buffer.from([ID.codersUnpackSize]),
				...packed.map((file) => number(file.unpackedSize)),
				Buffer.from([ID.end, ID.subStreamsInfo, ID.crc, 0x01]),
				crcs,
				Buffer.from([ID.end, ID.end]),
			);
		}

		parts.push(Buffer.from([ID.filesInfo]), number(members.length));
		if (emptyStream.some(Boolean)) {
			parts.push(property(ID.emptyStream, bitVector(emptyStream)));
			// kEmptyFile covers only the empty-stream entries: set = empty file, clear = directory.
			const emptyFiles = members.filter((_, i) => emptyStream[i] === true).map((member) => !member.directory);
			if (emptyFiles.some(Boolean)) parts.push(property(ID.emptyFile, bitVector(emptyFiles)));
		}
		const names = Buffer.concat(
			members.map((member) => Buffer.from(`${member.directory ? member.entry.replace(/\/$/, "") : member.entry}\0`, "utf16le")),
		);
		parts.push(
			property(ID.names, Buffer.concat([Buffer.from([0x00]), names])),
			property(ID.mTime, Buffer.concat([Buffer.from([0x01, 0x00]), mtimes])),
			property(ID.winAttributes, Buffer.concat([Buffer.from([0x01, 0x00]), attributes])),
			Buffer.from([ID.end, ID.end]),
		);

		const header = Buffer.concat(parts);
		await handle.write(header);

		const start = Buffer.alloc(20);
		start.writeBigUInt64LE(BigInt(packedBytes), 0);
		start.writeBigUInt64LE(BigInt(header.length), 8);
		start.writeUInt32LE(crc32(header), 16);
		const signature = Buffer.alloc(SIGNATURE_HEADER_SIZE);
		SIGNATURE.copy(signature, 0);
		signature.writeUInt32LE(crc32(start), 8);
		start.copy(signature, 12);
		await handle.write(signature, 0, SIGNATURE_HEADER_SIZE, 0);
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(target, { force: true });
		throw error;
	}
}
