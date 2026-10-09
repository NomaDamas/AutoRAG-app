/**
 * Worker entry for the libarchive wasm engine (7z, tar.bz2, tar.xz).
 *
 * The wasm runs in this worker thread, never the Electron main thread, and one
 * worker handles one extraction — so a wasm trap on a corrupt archive cannot
 * poison a later run. It reads the archive, writes only regular files and
 * directories into the staging directory the caller passed (every entry name
 * validated by the shared guard), and reports success or a Korean refusal.
 *
 * It is plain JavaScript on purpose: the shared guard lives in the sibling
 * `archive-guard.mjs`, which both this worker and the TypeScript extractors
 * import, so the security rules cannot drift apart.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";
import { ArchiveError, archiveEntryPath, normalizeEntryName } from "./archive-guard.mjs";

const ENCRYPTED_MESSAGE = "암호로 보호된 압축 파일은 풀 수 없습니다";
const COMBINED_MESSAGE = "압축 파일이 손상되었거나 암호로 보호되어 있습니다";

async function extract({ sourcePath, destDir, limits }) {
	const buffer = readFileSync(sourcePath);
	const data = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const libarchive = await libarchiveWasm();
	const reader = new ArchiveReader(libarchive, data);
	try {
		if (reader.hasEncryptedData() === true) throw new ArchiveError(ENCRYPTED_MESSAGE);
		let entries = 0;
		let bytes = 0;
		for (const entry of reader.entries()) {
			const name = normalizeEntryName(entry.getPathname());
			if (name.length === 0) continue;
			entries += 1;
			if (entries > limits.maxEntries) throw new ArchiveError("압축 파일의 항목 수가 너무 많습니다");
			const target = archiveEntryPath(destDir, name);
			const type = entry.getFiletype();
			if (type === "Directory") {
				mkdirSync(target.path, { recursive: true });
				continue;
			}
			if (type !== "File") continue;
			if (entry.isEncrypted()) throw new ArchiveError(ENCRYPTED_MESSAGE);
			const size = entry.getSize();
			if (size > limits.maxEngineBytes) throw new ArchiveError("이 형식의 압축 파일은 너무 커서 풀 수 없습니다");
			bytes += size;
			if (bytes > limits.maxTotalBytes) throw new ArchiveError("압축 파일의 해제 용량이 너무 큽니다");
			mkdirSync(dirname(target.path), { recursive: true });
			const content = entry.readData();
			writeFileSync(target.path, content === undefined ? Buffer.alloc(0) : Buffer.from(content));
		}
		if (entries === 0) throw new ArchiveError("압축 파일이 손상되었거나 비어 있습니다");
	} finally {
		try {
			reader.free();
		} catch {
			// A corrupt archive may leave the wasm in a bad state; freeing is best-effort.
		}
	}
}

try {
	await extract(workerData);
	parentPort.postMessage({ ok: true });
} catch (error) {
	parentPort.postMessage({ ok: false, message: error instanceof ArchiveError ? error.message : COMBINED_MESSAGE });
}
