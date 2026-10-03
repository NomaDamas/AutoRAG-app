import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { describeBinary } from "../shared/binary-kind";
import type { FileDetails } from "../shared/contract";
import { locationCrumbs } from "../shared/location";

const HEAD_BYTES = 4096;
/** UDIF disk images end with a 512-byte "koly" trailer. */
const TAIL_BYTES = 512;

let bootVolume: Promise<string | null> | null = null;

/** The startup disk's name ("Macintosh HD"): the `/Volumes` entry that resolves to `/`. */
function bootVolumeName(): Promise<string | null> {
	if (process.platform !== "darwin") return Promise.resolve(null);
	bootVolume ??= (async () => {
		try {
			for (const name of await readdir("/Volumes")) {
				if ((await realpath(join("/Volumes", name)).catch(() => "")) === "/") return name;
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
		return null;
	})();
	return bootVolume;
}

async function readEnds(path: string, size: number): Promise<{ readonly head: Uint8Array; readonly tail: Uint8Array | null }> {
	const handle = await open(path, "r");
	try {
		const head = new Uint8Array(Math.min(HEAD_BYTES, size));
		await handle.read(head, 0, head.length, 0);
		if (size < HEAD_BYTES + TAIL_BYTES) return { head, tail: null };
		const tail = new Uint8Array(TAIL_BYTES);
		await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
		return { head, tail };
	} finally {
		await handle.close();
	}
}

/** Creation date, Finder-style location, and (for executables and disk images) what the binary is. */
export async function fileDetails(path: string): Promise<FileDetails> {
	const info = await stat(path);
	// Filesystems without a birth time report the epoch; the inode change time is the closest stand-in.
	const created = info.birthtimeMs > 0 ? info.birthtime : info.ctime;
	const [volume, ends] = await Promise.all([bootVolumeName(), info.isFile() ? readEnds(path, info.size) : null]);
	return {
		createdAt: created.toISOString(),
		location: locationCrumbs(path, process.platform, volume),
		binary: ends === null ? null : describeBinary(ends.head, ends.tail),
	};
}

/** SHA-256 of a file, streamed; resolves null when `stopped` turns true mid-way. */
export async function sha256File(path: string, stopped: () => boolean): Promise<string | null> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
		if (stopped()) return null;
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}
