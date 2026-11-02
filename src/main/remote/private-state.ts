/**
 * Durable atomic replacement of private security records (`remote-devices.json`),
 * adapted from Ovis (`devswha/ovis`, MIT).
 *
 * A unique 0600 temporary file is created with O_EXCL in a 0700 directory,
 * written completely, fsynced, closed, and renamed over the target before any
 * in-memory authorization change takes effect.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function writePrivateState(
	path: string,
	value: unknown,
	platform: NodeJS.Platform = process.platform,
): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const existing = platform === "win32" ? undefined : statSync(path, { throwIfNoEntry: false });
	const mode = existing === undefined ? 0o600 : existing.mode & 0o600;
	let fd: number | null = openSync(temporary, "wx", mode);
	try {
		for (let written = 0; written < bytes.length; ) {
			const count = writeSync(fd, bytes, written, bytes.length - written);
			if (count <= 0) throw new Error(`wrote no bytes to ${temporary}`);
			written += count;
		}
		fsyncSync(fd);
		const closing = fd;
		fd = null;
		closeSync(closing);
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* reported through error */
			}
		}
		try {
			unlinkSync(temporary);
		} catch {
			/* reported through error */
		}
		throw error;
	}
	if (platform !== "win32") {
		let dirFd: number | null = null;
		try {
			dirFd = openSync(directory, "r");
			fsyncSync(dirFd);
		} catch {
			/* directory fsync is best-effort on filesystems that disallow it */
		} finally {
			if (dirFd !== null) {
				try {
					closeSync(dirFd);
				} catch {
					/* ignore */
				}
			}
		}
	}
}
