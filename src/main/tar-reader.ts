/**
 * Streaming tar extractor. Reads a tar (optionally the inflated side of a
 * `.gz`/`.tgz`) one 512-byte header at a time and writes each regular file
 * straight to disk, so peak memory tracks a single chunk, never the archive.
 *
 * Only regular files and directories are created. Symlinks, hardlinks, device
 * nodes, and FIFOs are skipped outright — the extractor must never create a link
 * that could later be written "through" to escape the destination, and it never
 * applies a header's mode, so setuid/setgid bits cannot survive. GNU long-name
 * (`L`/`K`) and pax (`x`/`g`) headers are honored, since macOS and modern `tar`
 * write them.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	ArchiveError,
	archiveEntryPath,
	normalizeEntryName,
} from "./archive-guard.mjs";
import { t } from "../shared/i18n/core";
import { ByteReader, writeChunk, type ArchiveLimits } from "./archive-common";

/** Tar's fixed header/data block; also the size a `.gz` is peeked at to spot a tar. */
export const TAR_BLOCK_SIZE = 512;
const BLOCK_SIZE = TAR_BLOCK_SIZE;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
/** pax and GNU long-name bodies are short; a bogus huge size is corruption, not memory. */
const MAX_META_BYTES = 1 << 20;

const corruptMessage = (): string => t("main.archive.corrupt");

/** Trim a NUL-terminated field to its string. */
function cString(bytes: Buffer): string {
	const nul = bytes.indexOf(0);
	return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString("utf8");
}

/** A tar numeric field: octal, or GNU base-256 when the top bit is set. */
function numeric(block: Buffer, offset: number, length: number): number {
	if ((block[offset] ?? 0) & 0x80) {
		let value = 0;
		for (let index = 0; index < length; index += 1) {
			value = value * 256 + (index === 0 ? (block[offset] ?? 0) & 0x7f : (block[offset + index] ?? 0));
		}
		return value;
	}
	const text = cString(block.subarray(offset, offset + length)).trim();
	if (text.length === 0) return 0;
	const value = Number.parseInt(text, 8);
	return Number.isFinite(value) ? value : 0;
}

/** The header's stored checksum field, spaces treated as unset. */
function storedChecksum(block: Buffer): number {
	const text = block.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH).toString("ascii").replace(/[\0 ]/g, "");
	return text.length === 0 ? -1 : Number.parseInt(text, 8);
}

/** A header's checksum: every byte, with the checksum field read as spaces. */
function computedChecksum(block: Buffer): number {
	let sum = 0;
	for (let index = 0; index < BLOCK_SIZE; index += 1) {
		sum += index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH ? 0x20 : (block[index] ?? 0);
	}
	return sum;
}

/** Whether `block` is a well-formed tar header (its checksum matches). */
export function looksLikeTar(block: Buffer): boolean {
	return block.length === BLOCK_SIZE && storedChecksum(block) === computedChecksum(block);
}

/** All-zero block ends the archive. */
function isZeroBlock(block: Buffer): boolean {
	for (let index = 0; index < block.length; index += 1) if (block[index] !== 0) return false;
	return true;
}

/** The entry name, joining the ustar prefix when one is present. */
function headerName(block: Buffer): string {
	const name = cString(block.subarray(0, 100));
	const prefix = cString(block.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH));
	return prefix.length > 0 ? `${prefix}/${name}` : name;
}

/** Parse a pax header body (`<len> key=value\n` records) into its keys. */
function parsePax(data: Buffer): Record<string, string> {
	const text = data.toString("utf8");
	const out: Record<string, string> = {};
	let pos = 0;
	while (pos < text.length) {
		const space = text.indexOf(" ", pos);
		if (space < 0) break;
		const length = Number.parseInt(text.slice(pos, space), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = text.slice(space + 1, pos + length - 1);
		const equals = record.indexOf("=");
		if (equals >= 0) out[record.slice(0, equals)] = record.slice(equals + 1);
		pos += length;
	}
	return out;
}

/** Read `size` body bytes plus their block padding, bounded for meta records. */
async function readBody(reader: ByteReader, size: number): Promise<Buffer> {
	if (size > MAX_META_BYTES) throw new ArchiveError(corruptMessage());
	const parts: Buffer[] = [];
	let remaining = size;
	while (remaining > 0) {
		if (reader.available === 0) await reader.pull();
		if (reader.available === 0) throw new ArchiveError(corruptMessage());
		const take = Math.min(reader.available, remaining);
		parts.push(reader.consume(take));
		remaining -= take;
	}
	await skipPadding(reader, size);
	return Buffer.concat(parts);
}

/** Consume the zero padding that rounds `size` up to a block boundary. */
async function skipPadding(reader: ByteReader, size: number): Promise<void> {
	const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
	if (padding === 0) return;
	await reader.fill(padding);
	if (reader.consume(padding).length < padding) throw new ArchiveError(corruptMessage());
}

/** Discard `size` body bytes plus padding (a skipped entry's data). */
async function discard(reader: ByteReader, size: number): Promise<void> {
	let remaining = size;
	while (remaining > 0) {
		if (reader.available === 0) await reader.pull();
		if (reader.available === 0) throw new ArchiveError(corruptMessage());
		const take = Math.min(reader.available, remaining);
		reader.consume(take);
		remaining -= take;
	}
	await skipPadding(reader, size);
}

/** Stream one regular file's body into `reader`'s destination, counting output bytes. */
async function writeFileBody(reader: ByteReader, sink: Writable, size: number, limits: ArchiveLimits, used: { bytes: number }): Promise<void> {
	let remaining = size;
	while (remaining > 0) {
		if (reader.available === 0) await reader.pull();
		if (reader.available === 0) throw new ArchiveError(corruptMessage());
		const take = Math.min(reader.available, remaining);
		const chunk = reader.consume(take);
		used.bytes += take;
		if (used.bytes > limits.maxTotalBytes) {
			throw new ArchiveError(t("main.archive.tooLarge"));
		}
		await writeChunk(sink, chunk);
		remaining -= take;
	}
	await skipPadding(reader, size);
}

/** Extract a tar stream into `destDir`; the caller owns wrapper flattening and staging. */
export async function extractTar(reader: ByteReader, destDir: string, limits: ArchiveLimits): Promise<void> {
	const used = { bytes: 0 };
	let entries = 0;
	let pendingName: string | null = null;
	let pendingPax: Record<string, string> | null = null;
	let globalPax: Record<string, string> = {};

	const countEntry = (): void => {
		entries += 1;
		if (entries > limits.maxEntries) throw new ArchiveError(t("main.archive.tooManyEntries"));
	};

	for (;;) {
		await reader.fill(BLOCK_SIZE);
		const header = reader.peek(BLOCK_SIZE);
		if (header.length === 0) break;
		if (header.length < BLOCK_SIZE) throw new ArchiveError(corruptMessage());
		if (isZeroBlock(header)) {
			reader.consume(BLOCK_SIZE);
			break;
		}
		if (!looksLikeTar(header)) throw new ArchiveError(corruptMessage());
		reader.consume(BLOCK_SIZE);

		const type = String.fromCharCode(header[TYPEFLAG_OFFSET] ?? 0);
		const size = numeric(header, SIZE_OFFSET, SIZE_LENGTH);

		if (type === "L" || type === "K" || type === "x" || type === "g") {
			const body = await readBody(reader, size);
			// `L` carries the next entry's name; `K` carries a link target we never use.
			if (type === "L") pendingName = cString(body);
			else if (type === "x") pendingPax = parsePax(body);
			else globalPax = { ...globalPax, ...parsePax(body) };
			continue;
		}

		const rawName = pendingName ?? pendingPax?.path ?? globalPax.path ?? headerName(header);
		pendingName = null;
		const pax = pendingPax;
		pendingPax = null;
		const declaredSize = pax?.size !== undefined ? Number.parseInt(pax.size, 10) : size;
		const name = normalizeEntryName(rawName);

		if (name.length === 0) {
			await discard(reader, declaredSize);
			countEntry();
			continue;
		}

		const directory = type === "5" || rawName.endsWith("/");
		if (directory) {
			await mkdir(archiveEntryPath(destDir, name).path, { recursive: true });
			await discard(reader, declaredSize);
			countEntry();
			continue;
		}

		if (type === "0" || type === "\0" || type === "") {
			const target = archiveEntryPath(destDir, name);
			await mkdir(dirname(target.path), { recursive: true });
			const sink = createWriteStream(target.path);
			sink.on("error", () => {});
			try {
				await writeFileBody(reader, sink, Number.isFinite(declaredSize) ? declaredSize : 0, limits, used);
				sink.end();
				await finished(sink);
			} catch (error) {
				sink.destroy();
				throw error;
			}
			countEntry();
			continue;
		}

		// Hardlink, symlink, character/block device, FIFO, and vendor types: skip.
		await discard(reader, declaredSize);
		countEntry();
	}
}
