/**
 * Worker entry that lists an archive for the Quick Look panel: every entry's
 * name, size, and date, without reading a single member's data.
 *
 * Like `archive-worker.mjs` it runs the libarchive wasm engine on its own
 * thread, one archive per worker, so a wasm trap on a corrupt file cannot
 * reach the main process or a later listing. Around the engine it unwraps the
 * containers libarchive cannot open itself: a `.deb` (an `ar` archive whose
 * `data.tar.*` member is the payload), an `.rpm` (lead, two headers, then a
 * cpio payload), and zstd, which the engine lacks and Node's zlib supplies.
 *
 * It is plain JavaScript for the same reason as `archive-worker.mjs`: the
 * source and the bundled build spawn it by one URL.
 */

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";

/** A failure the panel explains; anything else the engine throws is a damaged archive. */
class Refusal extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
}

const AR_MAGIC = "!<arch>\n";
const AR_HEADER_BYTES = 60;
const RPM_LEAD_BYTES = 96;
const RPM_HEADER_MAGIC = 0x8eade801;

const isZstd = (bytes) => bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;

/** The bytes of a `.deb`'s `data.tar*` member. */
function debPayload(bytes) {
	let offset = AR_MAGIC.length;
	while (offset + AR_HEADER_BYTES <= bytes.length) {
		const header = bytes.toString("latin1", offset, offset + AR_HEADER_BYTES);
		const name = header.slice(0, 16).trim().replace(/\/$/, "");
		const size = Number.parseInt(header.slice(48, 58).trim(), 10);
		if (!Number.isSafeInteger(size) || size < 0) throw new Refusal("corrupt");
		const start = offset + AR_HEADER_BYTES;
		if (name === "data.tar" || name.startsWith("data.tar.")) {
			if (start + size > bytes.length) throw new Refusal("corrupt");
			return bytes.subarray(start, start + size);
		}
		offset = start + size + (size % 2);
	}
	throw new Refusal("corrupt");
}

/** One RPM header section's length: the 16-byte intro, its 16-byte index entries, and its data. */
function rpmHeaderLength(bytes, offset) {
	if (offset + 16 > bytes.length || bytes.readUInt32BE(offset) !== RPM_HEADER_MAGIC) throw new Refusal("corrupt");
	return 16 + bytes.readUInt32BE(offset + 8) * 16 + bytes.readUInt32BE(offset + 12);
}

/** The bytes of an `.rpm`'s payload: past the lead, the signature header (padded to 8 bytes), and the main header. */
function rpmPayload(bytes) {
	const signature = RPM_LEAD_BYTES + rpmHeaderLength(bytes, RPM_LEAD_BYTES);
	const main = signature + ((8 - (signature % 8)) % 8);
	const payload = main + rpmHeaderLength(bytes, main);
	if (payload >= bytes.length) throw new Refusal("corrupt");
	return bytes.subarray(payload);
}

/** Decompress zstd, which libarchive's wasm build cannot, within the output cap. */
function inflateZstd(bytes, maxOutputBytes) {
	try {
		return zstdDecompressSync(bytes, { maxOutputLength: maxOutputBytes });
	} catch (error) {
		throw new Refusal(error?.code === "ERR_BUFFER_TOO_LARGE" ? "tooLarge" : "corrupt");
	}
}

/** What libarchive should open: the payload of a deb or rpm, and any zstd layer, undone. */
function unwrap(file, limits) {
	let bytes = file;
	if (bytes.toString("latin1", 0, AR_MAGIC.length) === AR_MAGIC) bytes = debPayload(bytes);
	else if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0xedabeedb) bytes = rpmPayload(bytes);
	return isZstd(bytes) ? inflateZstd(bytes, limits.maxOutputBytes) : bytes;
}

async function list({ sourcePath, limits }) {
	const file = readFileSync(sourcePath);
	if (file.length > limits.maxInputBytes) throw new Refusal("tooLarge");
	const bytes = unwrap(file, limits);
	// The engine is the vendored rebuild (see scripts/libarchive-wasm/README.md).
	const wasmBinary = readFileSync(new URL("./vendor/libarchive.wasm", import.meta.url));
	const libarchive = await libarchiveWasm({ wasmBinary });
	const reader = new ArchiveReader(libarchive, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	try {
		const entries = [];
		for (const entry of reader.entries()) {
			if (entries.length >= limits.maxEntries) throw new Refusal("tooManyEntries");
			// The archive-level flag is only known once a header is read, so it is asked per entry.
			if (reader.hasEncryptedData() === true || entry.isEncrypted()) throw new Refusal("encrypted");
			const name = entry.getPathname();
			if (name.length === 0) continue;
			const modified = entry.getModificationTime();
			entries.push({
				name: entry.getFiletype() === "Directory" && !name.endsWith("/") ? `${name}/` : name,
				size: Math.max(0, entry.getSize()),
				modified: modified > 0 ? modified : null,
			});
		}
		// libarchive ends a damaged archive's header scan the way it ends an empty one.
		if (entries.length === 0) throw new Refusal("corrupt");
		return entries;
	} finally {
		try {
			reader.free();
		} catch {
			// A corrupt archive may leave the wasm in a bad state; freeing is best-effort.
		}
	}
}

try {
	parentPort.postMessage({ ok: true, entries: await list(workerData) });
} catch (error) {
	parentPort.postMessage({ ok: false, reason: error instanceof Refusal ? error.reason : "corrupt" });
}
