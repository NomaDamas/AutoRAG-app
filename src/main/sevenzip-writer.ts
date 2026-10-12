/**
 * 7z container writer with solid LZMA compression.
 *
 * Files are packed into solid blocks: consecutive files are concatenated and
 * compressed as one LZMA stream, so redundancy *between* files is exploited —
 * the main reason 7z beats zip. A block is bounded (see `SOLID_BLOCK_BYTES`), so
 * peak memory stays near a few block sizes whatever the tree's size.
 *
 * Each block is one 7z "folder" with a single coder:
 * - LZMA, compressed in a worker thread (the encoder is synchronous WebAssembly).
 * - Copy, when a sample shows the data is already compressed (jpg, mp4, zip…) or
 *   LZMA would not shrink it. Skipping the encoder saves most of the time.
 * - Deflate (`node:zlib`) for single files over `LZMA_MAX_FILE_BYTES`, which would
 *   not fit the wasm encoder's 32-bit memory.
 *
 * Layout (7-Zip's `7zFormat.txt`): a 32-byte signature header, the packed
 * streams, then one plain header. The signature header is written last, once
 * the header's offset, size, and CRC are known. Directories and empty files
 * carry no stream: they are `kEmptyStream` entries, told apart by `kEmptyFile`.
 *
 * The encoder is `lzma-wasm` (MIT OR Apache-2.0, built on the Apache-2.0
 * `lzma-rust2`). 7-Zip's own LZMA SDK is public domain, but no maintained build
 * of it ships for Node; this one needs no external binary.
 */

import { lstat, open, readFile, rm } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);

/** One file or directory to write, with its archive-relative "/"-separated path. */
export interface SevenZipMember {
	readonly source: string;
	/** Directories carry a trailing "/", which is not stored. Callers pass NFC names. */
	readonly entry: string;
	readonly directory: boolean;
}

/** Limits that bound memory and time; tests lower them to exercise block boundaries. */
export interface SevenZipOptions {
	/** Bytes of file content gathered into one solid block before it is compressed. */
	readonly solidBlockBytes?: number;
	/** A single file larger than this is deflated on its own instead of LZMA-compressed. */
	readonly lzmaMaxFileBytes?: number;
}

/**
 * 32 MiB: past the 8 MiB dictionary, extra solid size buys little, while the
 * block is held several times over (read, concatenated, copied to the worker,
 * the encoder's own memory, the output).
 */
const SOLID_BLOCK_BYTES = 32 * 1024 ** 2;
/** The wasm encoder's linear memory is 32-bit: input, its copy, and output must fit. */
const LZMA_MAX_FILE_BYTES = 256 * 1024 ** 2;
/** 7-Zip's default preset (`-mx5`): 8 MiB dictionary. Level 6 gains under 1% for ~15% more time. */
const LZMA_LEVEL = 5;
const PROBE_LEVEL = 1;
/** The probe compresses head, middle, and tail slices of this size, so a block that starts with text still gets judged by its bulk. */
const PROBE_SLICE_BYTES = 256 * 1024;
/** A probe that saves less than 3% means the data is already compressed. */
const INCOMPRESSIBLE_RATIO = 0.97;
/** LZMA-Alone prefix: 5 property bytes + 8-byte uncompressed size; 7z stores only the properties. */
const LZMA_PROPS_BYTES = 5;
const LZMA_ALONE_HEADER_BYTES = 13;
const DEFLATE_LEVEL = 6;

const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
const SIGNATURE_HEADER_SIZE = 32;
/** Coder records inside a folder: coder count, flag byte (id size | 0x20 if it has properties), method id. */
const COPY_CODER = Buffer.from([0x01, 0x01, 0x00]);
const DEFLATE_CODER = Buffer.from([0x01, 0x03, 0x04, 0x01, 0x08]);
const LZMA_CODER_PREFIX = Buffer.from([0x01, 0x23, 0x03, 0x01, 0x01, LZMA_PROPS_BYTES]);
/** Milliseconds from 1601-01-01 (FILETIME epoch) to the Unix epoch. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;

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
	numUnpackStream: 0x0d,
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

/** One packed block as the header describes it. */
interface Folder {
	readonly coder: Buffer;
	readonly packedSize: number;
	/** Per file in the block, in order. */
	readonly sizes: readonly number[];
	readonly crcs: readonly number[];
}

/** A reply from `lzma-worker.mjs`. */
interface LzmaReply {
	readonly id: number;
	readonly ok: boolean;
	readonly data?: Uint8Array;
	readonly message?: string;
}

/** The LZMA worker thread: requests are answered one at a time, in order. */
class LzmaWorker {
	private readonly worker = new Worker(new URL("./lzma-worker.mjs", import.meta.url));
	private readonly waiting = new Map<number, { resolve(data: Uint8Array): void; reject(error: Error): void }>();
	private nextId = 0;

	constructor() {
		this.worker.on("message", (reply: LzmaReply) => {
			const request = this.waiting.get(reply.id);
			this.waiting.delete(reply.id);
			if (reply.ok && reply.data !== undefined) request?.resolve(reply.data);
			else request?.reject(new Error(reply.message ?? "LZMA 압축에 실패했습니다"));
		});
		const fail = (): void => {
			for (const request of this.waiting.values()) request.reject(new Error("LZMA 압축 작업이 중단되었습니다"));
			this.waiting.clear();
		};
		this.worker.on("error", fail);
		this.worker.on("exit", fail);
	}

	/** The LZMA-Alone encoding of `data`. */
	compress(data: Uint8Array, level: number): Promise<Uint8Array> {
		const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
		const id = this.nextId;
		this.nextId += 1;
		this.waiting.set(id, { resolve, reject });
		this.worker.postMessage({ id, level, data });
		return promise;
	}

	async close(): Promise<void> {
		await this.worker.terminate();
	}
}

/**
 * Write `members` as a 7z archive at `target`. Files are gathered into solid
 * blocks in member order; a failed write removes the partial archive.
 */
export async function writeSevenZip(target: string, members: readonly SevenZipMember[], options: SevenZipOptions = {}): Promise<void> {
	const blockBytes = options.solidBlockBytes ?? SOLID_BLOCK_BYTES;
	const maxLzmaFile = options.lzmaMaxFileBytes ?? LZMA_MAX_FILE_BYTES;
	const handle = await open(target, "w");
	/** Created on first use: archives of only tiny or incompressible files never start a thread. */
	const encoder: { worker: LzmaWorker | null } = { worker: null };
	try {
		await handle.write(Buffer.alloc(SIGNATURE_HEADER_SIZE));
		const folders: Folder[] = [];
		const emptyStream: boolean[] = [];
		const mtimes = Buffer.alloc(8 * members.length);
		const attributes = Buffer.alloc(4 * members.length);
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let packedBytes = 0;

		/** Pack `files` as one folder and append it to the output. */
		const writeFolder = async (files: readonly Buffer[], method: "lzma" | "deflate"): Promise<void> => {
			const data = files.length === 1 ? (files[0] as Buffer) : Buffer.concat(files);
			let coder = COPY_CODER;
			let body: Uint8Array = data;
			if (method === "deflate") {
				const packed = await deflate(data, { level: DEFLATE_LEVEL });
				if (packed.length < data.length) {
					coder = DEFLATE_CODER;
					body = packed;
				}
			} else {
				// Judge a head/middle/tail sample at the fast level first: already
				// compressed data (jpg, mp4, zip) would take seconds and shrink nothing.
				let compressible = true;
				if (data.length >= PROBE_SLICE_BYTES) {
					const middle = Math.max(0, (data.length - PROBE_SLICE_BYTES) >> 1);
					const sample =
						data.length <= 3 * PROBE_SLICE_BYTES
							? data
							: Buffer.concat([
									data.subarray(0, PROBE_SLICE_BYTES),
									data.subarray(middle, middle + PROBE_SLICE_BYTES),
									data.subarray(data.length - PROBE_SLICE_BYTES),
								]);
					const worker = (encoder.worker ??= new LzmaWorker());
					const probe = await worker.compress(sample, PROBE_LEVEL);
					compressible = probe.length - LZMA_ALONE_HEADER_BYTES < sample.length * INCOMPRESSIBLE_RATIO;
				}
				if (compressible) {
					const worker = (encoder.worker ??= new LzmaWorker());
					const packed = await worker.compress(data, LZMA_LEVEL);
					if (packed.length - LZMA_ALONE_HEADER_BYTES < data.length) {
						coder = Buffer.concat([LZMA_CODER_PREFIX, packed.subarray(0, LZMA_PROPS_BYTES)]);
						body = packed.subarray(LZMA_ALONE_HEADER_BYTES);
					}
				}
			}
			await handle.write(body);
			packedBytes += body.length;
			folders.push({ coder, packedSize: body.length, sizes: files.map((file) => file.length), crcs: files.map((file) => crc32(file)) });
		};

		const flush = async (): Promise<void> => {
			if (pending.length === 0) return;
			const files = pending;
			pending = [];
			pendingBytes = 0;
			await writeFolder(files, "lzma");
		};

		for (const [index, member] of members.entries()) {
			const stats = await lstat(member.source);
			mtimes.writeBigUInt64LE((BigInt(Math.trunc(stats.mtimeMs)) + FILETIME_EPOCH_MS) * 10_000n, 8 * index);
			// Windows attribute bits, plus 7-Zip's Unix extension: type and permissions in the high 16 bits.
			const unixMode = member.directory ? 0o040000 | (stats.mode & 0o777) | 0o700 : 0o100000 | (stats.mode & 0o777);
			attributes.writeUInt32LE(((unixMode << 16) | UNIX_EXTENSION | (member.directory ? WIN_DIRECTORY : WIN_ARCHIVE)) >>> 0, 4 * index);
			const content = member.directory ? Buffer.alloc(0) : await readFile(member.source);
			emptyStream.push(content.length === 0);
			if (content.length === 0) continue;
			if (content.length > maxLzmaFile) {
				// Folders are read back in order, so the pending block goes out first.
				await flush();
				await writeFolder([content], "deflate");
				continue;
			}
			if (pendingBytes > 0 && pendingBytes + content.length > blockBytes) await flush();
			pending.push(content);
			pendingBytes += content.length;
		}
		await flush();

		const parts: Buffer[] = [Buffer.from([ID.header])];
		if (folders.length > 0) {
			const streamCrcs = Buffer.alloc(4 * folders.reduce((sum, folder) => sum + folder.crcs.length, 0));
			folders.flatMap((folder) => folder.crcs).forEach((crc, i) => streamCrcs.writeUInt32LE(crc, 4 * i));
			// Within a folder every file but the last has its size listed; the last is the remainder.
			const innerSizes = folders.flatMap((folder) => folder.sizes.slice(0, -1));
			parts.push(
				Buffer.from([ID.mainStreamsInfo, ID.packInfo]),
				number(0),
				number(folders.length),
				Buffer.from([ID.size]),
				...folders.map((folder) => number(folder.packedSize)),
				Buffer.from([ID.end, ID.unpackInfo, ID.folder]),
				number(folders.length),
				Buffer.from([0x00]),
				...folders.map((folder) => folder.coder),
				Buffer.from([ID.codersUnpackSize]),
				...folders.map((folder) => number(folder.sizes.reduce((sum, size) => sum + size, 0))),
				Buffer.from([ID.end, ID.subStreamsInfo, ID.numUnpackStream]),
				...folders.map((folder) => number(folder.sizes.length)),
				...(innerSizes.length > 0 ? [Buffer.from([ID.size]), ...innerSizes.map((size) => number(size))] : []),
				Buffer.from([ID.crc, 0x01]),
				streamCrcs,
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
	} finally {
		await encoder.worker?.close();
	}
}
