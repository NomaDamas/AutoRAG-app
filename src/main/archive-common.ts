/**
 * Primitives shared by the archive extractors that are not the security guard
 * (which lives in `archive-guard.mjs` for the worker to share): the resource
 * caps and a small pull reader plus backpressure writer over a byte stream.
 *
 * The caps abort an extraction with a Korean message rather than letting a
 * crafted archive exhaust the machine.
 */

import { once } from "node:events";
import type { Writable } from "node:stream";

/**
 * Resource caps. Every one aborts the extraction with a Korean message rather
 * than letting a crafted archive exhaust the machine.
 */
export interface ArchiveLimits {
	/**
	 * Decompression-bomb guard: the total number of bytes written across all
	 * entries. 20 GiB is far beyond any real archive a user opens by hand but
	 * bounds a zip bomb's output.
	 */
	readonly maxTotalBytes: number;
	/**
	 * The most entries an archive may hold; a directory-of-a-million-files attack
	 * would otherwise spend the machine on inode churn alone.
	 */
	readonly maxEntries: number;
	/**
	 * The wasm engine (7z, tar.bz2, tar.xz) decompresses in memory, so the
	 * *compressed* archive — and any single member — must fit too; larger inputs
	 * are refused rather than risking an out-of-memory crash. The pure-Node
	 * tar/gzip path streams and has no such limit.
	 */
	readonly maxEngineBytes: number;
}

const GIB = 1024 ** 3;

/** The production caps; tests inject their own small values to exercise the refusals. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
	maxTotalBytes: 20 * GIB,
	maxEntries: 100_000,
	maxEngineBytes: 1 * GIB,
};

/**
 * A pull reader over an async byte stream. Headers are peeked without consuming
 * and file bodies are handed out chunk by chunk, so a whole archive never sits
 * in memory.
 */
export class ByteReader {
	private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
	private buffer: Buffer = Buffer.alloc(0);
	private done = false;

	constructor(source: AsyncIterable<Buffer | Uint8Array>) {
		this.iterator = source[Symbol.asyncIterator]();
	}

	/** Bytes currently buffered and ready to read. */
	get available(): number {
		return this.buffer.length;
	}

	/** Pull the next chunk if any; false once the stream ends. */
	async pull(): Promise<boolean> {
		if (this.done) return false;
		const { value, done } = await this.iterator.next();
		if (done === true || value === undefined) {
			this.done = true;
			return false;
		}
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		return true;
	}

	/** Buffer at least `count` bytes (or everything left at EOF). */
	async fill(count: number): Promise<void> {
		while (this.buffer.length < count && !this.done) await this.pull();
	}

	/** The next `count` bytes without consuming them. */
	peek(count: number): Buffer {
		return this.buffer.subarray(0, Math.min(count, this.buffer.length));
	}

	/** Take `count` bytes off the front. */
	consume(count: number): Buffer {
		const out = this.buffer.subarray(0, count);
		this.buffer = this.buffer.subarray(count);
		return out;
	}

	/** Yield everything buffered, then every remaining chunk, without copying. */
	async *drain(): AsyncGenerator<Buffer> {
		if (this.buffer.length > 0) {
			yield this.buffer;
			this.buffer = Buffer.alloc(0);
		}
		while (await this.pull()) {
			const chunk = this.buffer;
			this.buffer = Buffer.alloc(0);
			yield chunk;
		}
	}
}

/** Write a chunk to a sink, honoring the stream's backpressure. */
export async function writeChunk(sink: Writable, chunk: Buffer): Promise<void> {
	if (!sink.write(chunk)) await once(sink, "drain");
}
