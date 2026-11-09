/**
 * Streaming one large file into an archive, for both writers.
 *
 * `readFile` refuses anything past 2 GiB, and holding a multi-gigabyte video in
 * memory (several times over: the read, the compressor's input, its output) is
 * no better. A file past the writers' in-memory limit is read in chunks, CRC'd
 * as it goes, and either stored or deflated by `node:zlib` straight to the
 * archive, so memory stays at a few chunks whatever the file's size.
 *
 * Whether to deflate is decided up front from a head/middle/tail sample: a
 * video, a disk image of compressed data, or an archive would cost minutes of
 * CPU to shrink by nothing.
 */

import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createDeflateRaw, crc32, deflateRaw } from "node:zlib";

const deflate = promisify(deflateRaw);

/** zlib's tuned default balance of size and time. */
export const DEFLATE_LEVEL = 6;
/** 1 MiB reads: large enough that per-call overhead vanishes, small enough to stay out of the way. */
export const CHUNK_BYTES = 1024 ** 2;
const PROBE_SLICE_BYTES = 256 * 1024;
/** A sample that deflates by less than 3% means the data is already compressed. */
const INCOMPRESSIBLE_RATIO = 0.97;

/** What the container needs about a streamed file once it is written. */
export interface StreamedFile {
	readonly method: "store" | "deflate";
	readonly crc: number;
	/** Bytes read from the source. */
	readonly size: number;
	/** Bytes written to the archive. */
	readonly packedSize: number;
}

/** Progress and cancellation, shared by both writers. */
export interface ArchiveProgress {
	/** Aborting stops the write between chunks; the writer then removes the partial archive. */
	readonly signal?: AbortSignal;
	/** Hears every source byte once, as it is consumed. */
	readonly onBytes?: (bytes: number) => void;
}

/** Whether deflate would shrink the file at `handle`, judged from three slices of it. */
async function worthDeflating(handle: FileHandle, size: number): Promise<boolean> {
	const starts = size <= 3 * PROBE_SLICE_BYTES ? [0] : [0, Math.floor((size - PROBE_SLICE_BYTES) / 2), size - PROBE_SLICE_BYTES];
	const length = size <= 3 * PROBE_SLICE_BYTES ? size : PROBE_SLICE_BYTES;
	const slices: Buffer[] = [];
	for (const start of starts) {
		const slice = Buffer.alloc(length);
		const { bytesRead } = await handle.read(slice, 0, length, start);
		slices.push(slice.subarray(0, bytesRead));
	}
	const sample = Buffer.concat(slices);
	if (sample.length === 0) return false;
	const packed = await deflate(sample, { level: 1 });
	return packed.length < sample.length * INCOMPRESSIBLE_RATIO;
}

/**
 * Copy the file open at `handle` (`size` bytes by its stat) into the archive
 * through `write`, deflated when a sample says it pays.
 */
export async function streamFile(
	handle: FileHandle,
	size: number,
	write: (data: Uint8Array) => Promise<void>,
	chunkBytes: number = CHUNK_BYTES,
	progress: ArchiveProgress = {},
): Promise<StreamedFile> {
	const method = (await worthDeflating(handle, size)) ? "deflate" : "store";
	let crc = 0;
	let read = 0;
	let packedSize = 0;
	const source = handle.createReadStream({ start: 0, highWaterMark: chunkBytes, autoClose: false });
	async function* counted(): AsyncGenerator<Buffer> {
		for await (const chunk of source as AsyncIterable<Buffer>) {
			progress.signal?.throwIfAborted();
			crc = crc32(chunk, crc);
			read += chunk.length;
			progress.onBytes?.(chunk.length);
			yield chunk;
		}
	}
	const sink = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
		for await (const chunk of chunks) {
			await write(chunk);
			packedSize += chunk.length;
		}
	};
	if (method === "deflate") await pipeline(counted, createDeflateRaw({ level: DEFLATE_LEVEL, chunkSize: chunkBytes }), sink);
	else await sink(counted());
	return { method, crc, size: read, packedSize };
}
