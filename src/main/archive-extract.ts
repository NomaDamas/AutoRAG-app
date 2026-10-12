/**
 * Archive extraction entry points: dispatching on the format the shared
 * predicate decoded, a streaming zip reader, the gzip branch (a tar or a
 * single compressed file), and the wrapper-folder flattening every format
 * shares.
 *
 * The dispatcher writes into the directory it is given; the caller owns the
 * staging/rename dance so a failed run leaves no half-written output folder.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Unzip, UnzipInflate } from "fflate";
import type { ArchiveFormat } from "../shared/archive-formats";
import { ArchiveError, archiveEntryPath } from "./archive-guard.mjs";
import { ByteReader, writeChunk, type ArchiveLimits } from "./archive-common";
import { TAR_BLOCK_SIZE, extractTar, looksLikeTar } from "./tar-reader";
import { extractWithLibarchive } from "./libarchive-reader";

const CORRUPT_MESSAGE = "압축 파일이 손상되었습니다";
const ENCRYPTED_MESSAGE = "암호로 보호된 압축 파일은 풀 수 없습니다";
/** The central-directory scan is a guard, not a parser: a directory past this is left to fflate. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

/** Read a byte range with one positioned read. */
async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	await handle.read(buffer, 0, length, position);
	return buffer;
}

/** What the zip central directory says before any entry is read. */
interface ZipDirectoryScan {
	/** Any entry sets the "encrypted" general-purpose bit. */
	readonly encrypted: boolean;
	/** Names written without the UTF-8 flag, as fflate reports them: one Latin-1 character per original byte. */
	readonly legacyNames: ReadonlySet<string>;
}

/**
 * Read the central directory's flag bits. Encryption matters because fflate
 * would otherwise hand back raw ciphertext as if it were the file's contents.
 * The name-encoding bit matters because fflate reads an unflagged name as
 * Latin-1, which turns the CP949 names Korean Windows writes into `ÇÑ±Û.txt`.
 */
async function scanZipDirectory(path: string): Promise<ZipDirectoryScan> {
	const none: ZipDirectoryScan = { encrypted: false, legacyNames: new Set() };
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		if (size < 22) return none;
		const tailLength = Math.min(size, 22 + 0xffff);
		const tail = await readRange(handle, size - tailLength, tailLength);
		let eocd = -1;
		for (let index = tail.length - 22; index >= 0; index -= 1) {
			if (tail.readUInt32LE(index) === 0x06054b50) {
				eocd = index;
				break;
			}
		}
		if (eocd < 0) return none;
		const count = tail.readUInt16LE(eocd + 10);
		const directorySize = tail.readUInt32LE(eocd + 12);
		const directoryOffset = tail.readUInt32LE(eocd + 16);
		if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || directoryOffset > size) return none;
		if (directorySize > MAX_DIRECTORY_BYTES) return none;
		const tailStart = size - tailLength;
		const directory =
			directoryOffset >= tailStart && directoryOffset + directorySize <= size
				? tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize)
				: await readRange(handle, directoryOffset, directorySize);
		const legacyNames = new Set<string>();
		let offset = 0;
		for (let index = 0; index < count; index += 1) {
			if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) break;
			const flags = directory.readUInt16LE(offset + 8);
			if ((flags & 0x0001) !== 0) return { encrypted: true, legacyNames: new Set() };
			const nameStart = offset + 46;
			if ((flags & 0x0800) === 0) legacyNames.add(directory.toString("latin1", nameStart, nameStart + directory.readUInt16LE(offset + 28)));
			offset += 46 + directory.readUInt16LE(offset + 28) + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32);
		}
		return { encrypted: false, legacyNames };
	} finally {
		await handle.close();
	}
}

/**
 * Recover the real name of a zip entry written without the UTF-8 flag. fflate
 * returns those as Latin-1, so each character is one original byte. Many tools
 * (Info-ZIP on Linux, Python) write UTF-8 without the flag; Korean Windows
 * Explorer writes CP949. UTF-8 is tried first because it is strict — a CP949
 * name is almost never valid UTF-8 — and a name that is neither stays as read.
 */
function decodeLegacyZipName(name: string): string {
	if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
	const bytes = Buffer.from(name, "latin1");
	for (const label of ["utf-8", "euc-kr"]) {
		try {
			return new TextDecoder(label, { fatal: true }).decode(bytes);
		} catch {
			// Not this encoding; try the next.
		}
	}
	return name;
}

/**
 * Stream a zip into `destDir`. Entries write as they complete, so peak memory
 * tracks the largest member; an entry escaping `destDir` (zip-slip) or a name
 * with a NUL/absolute path sinks the whole extraction.
 */
async function readZip(source: string, destDir: string, limits: ArchiveLimits): Promise<void> {
	const scan = await scanZipDirectory(source);
	if (scan.encrypted) throw new ArchiveError(ENCRYPTED_MESSAGE);
	await mkdir(destDir, { recursive: true });
	const writes: Promise<void>[] = [];
	let failure: ArchiveError | null = null;
	let entries = 0;
	let bytes = 0;

	/** Resolve one entry, recording the first refusal instead of throwing out of the parser. */
	function resolveEntry(name: string): { readonly path: string; readonly directory: boolean } | null {
		if (failure !== null) return null;
		try {
			return archiveEntryPath(destDir, name);
		} catch (error) {
			failure = error instanceof ArchiveError ? error : new ArchiveError(CORRUPT_MESSAGE);
			return null;
		}
	}

	const unzipper = new Unzip((file) => {
		entries += 1;
		if (failure === null && entries > limits.maxEntries) failure = new ArchiveError("압축 파일의 항목 수가 너무 많습니다");
		const target = resolveEntry(scan.legacyNames.has(file.name) ? decodeLegacyZipName(file.name) : file.name);
		if (target === null || target.directory) {
			if (target !== null) writes.push(mkdir(target.path, { recursive: true }).then(() => undefined));
			file.ondata = () => {};
			file.start();
			return;
		}
		const chunks: Uint8Array[] = [];
		file.ondata = (error, chunk, final) => {
			if (error !== null) {
				failure = new ArchiveError(CORRUPT_MESSAGE);
				return;
			}
			chunks.push(chunk);
			if (!final) return;
			const body = Buffer.concat(chunks.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
			chunks.length = 0;
			bytes += body.length;
			if (bytes > limits.maxTotalBytes) {
				failure = new ArchiveError("압축 파일의 해제 용량이 너무 큽니다");
				return;
			}
			writes.push(mkdir(dirname(target.path), { recursive: true }).then(() => writeFile(target.path, body)));
		};
		file.start();
	});

	let parseError: unknown = null;
	try {
		unzipper.register(UnzipInflate);
		for await (const chunk of createReadStream(source)) {
			unzipper.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
		}
		unzipper.push(new Uint8Array(0), true);
	} catch (error) {
		parseError = error;
	}
	await Promise.all(writes);
	if (failure !== null) throw failure;
	if (parseError !== null) throw parseError instanceof ArchiveError ? parseError : new ArchiveError(CORRUPT_MESSAGE);
}

/** Inflate `source` and, if the stream is a tar, extract it; otherwise write it as one file. */
export async function extractGzipInto(sourcePath: string, destDir: string, stem: string, limits: ArchiveLimits): Promise<"folder" | "file"> {
	const reader = new ByteReader(createReadStream(sourcePath).pipe(createGunzip()));
	try {
		await reader.fill(TAR_BLOCK_SIZE);
		if (looksLikeTar(reader.peek(TAR_BLOCK_SIZE))) {
			await extractTar(reader, destDir, limits);
			return "folder";
		}
		await mkdir(destDir, { recursive: true });
		const sink = createWriteStream(join(destDir, stem));
		sink.on("error", () => {});
		try {
			for await (const chunk of reader.drain()) await writeChunk(sink, chunk);
			sink.end();
			await finished(sink);
		} catch (error) {
			sink.destroy();
			throw error;
		}
		return "file";
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(CORRUPT_MESSAGE);
	}
}

/** Extract a folder-shaped archive (everything but a bare `.gz`) into `destDir`. */
export async function extractIntoFolder(sourcePath: string, format: ArchiveFormat, destDir: string, limits: ArchiveLimits): Promise<void> {
	switch (format) {
		case "zip":
			return readZip(sourcePath, destDir, limits);
		case "tar":
			return extractTar(new ByteReader(createReadStream(sourcePath)), destDir, limits);
		case "tar.gz":
		case "tgz":
			try {
				return await extractTar(new ByteReader(createReadStream(sourcePath).pipe(createGunzip())), destDir, limits);
			} catch (error) {
				throw error instanceof ArchiveError ? error : new ArchiveError(CORRUPT_MESSAGE);
			}
		case "7z":
		case "rar":
		case "tar.bz2":
		case "tbz2":
		case "tar.xz":
		case "txz":
			return extractWithLibarchive(sourcePath, destDir, limits);
		case "gz":
			throw new ArchiveError("압축을 풀 수 없는 파일 형식입니다");
	}
}

/**
 * Strip a single wrapper folder: when `destDir` holds a top-level directory
 * named after the archive's stem, its children move up and the empty wrapper is
 * removed, so `docs.zip` restores `docs/`'s contents rather than nesting them
 * under another `docs/`. An archive whose stem does not name a top-level
 * directory is untouched, as is an archive with several top-level folders.
 */
export async function flattenWrapper(destDir: string, stem: string): Promise<void> {
	// Entry names are NFC (see archiveEntryPath); a Finder-made archive's stem may be NFD.
	const inner = join(destDir, stem.normalize("NFC"));
	const info = await lstat(inner).catch(() => null);
	if (info === null || !info.isDirectory()) return;
	for (const child of await readdir(inner)) await rename(join(inner, child), join(destDir, child));
	await rmdir(inner);
}
