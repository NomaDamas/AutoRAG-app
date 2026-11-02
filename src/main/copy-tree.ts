/**
 * Copy a file or folder tree: what `fs.cp(src, dest, { recursive: true })` produces, several times faster on a
 * folder of many small files. `fs.cp` walks one entry at a time and stats each entry three times; a Windows
 * folder of 2000 small files took 3 s through it and 0.8 s with parallel `copyFile`.
 *
 * Same results as `fs.cp`: file bytes and permissions, folder permissions (applied after the folder's content,
 * so a read-only folder is still filled), a symlink recreated as an absolute link to the original (or, with
 * `dereference`, the target copied in its place), a folder refused as a copy into itself, the first failure
 * reported and nothing started after it. It is meant for a destination that does not exist yet.
 */

import type { BigIntStats, Dirent, Stats } from "node:fs";
import { chmod, copyFile as fsCopyFile, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { hasErrorCode } from "./fs-entry";

export interface CopyTreeOptions {
	/** Copy what a symlink points at instead of recreating the link, at every level. */
	readonly dereference?: boolean;
	/** Most file-system calls in flight at once. Defaults to 16. */
	readonly concurrency?: number;
	/** Copies one file's bytes. Defaults to `fs.copyFile`; a test swaps it to watch the concurrency. */
	readonly copyFile?: (from: string, to: string) => Promise<void>;
}

const DEFAULT_CONCURRENCY = 16;

/** What `Dirent` and `Stats` both answer about an entry's type. */
interface TypeProbe {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	isCharacterDevice(): boolean;
	isBlockDevice(): boolean;
	isFIFO(): boolean;
	isSocket(): boolean;
}

function cpError(code: string, message: string, path: string): Error {
	return Object.assign(new Error(message), { code, syscall: "cp", path });
}

/** True when `dest` is `src` or lies inside it, judged by path text. */
function isInside(src: string, dest: string): boolean {
	const parts = (path: string): string[] => resolve(path).split(sep).filter(Boolean);
	const srcParts = parts(src);
	const destParts = parts(dest);
	return srcParts.every((part, index) => destParts[index] === part);
}

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => b.ino !== 0n && b.dev !== 0n && a.ino === b.ino && a.dev === b.dev;

/**
 * Refuse a folder copied into itself, including through a symlinked parent that leads back into it. Checking the
 * parents of `dest` by inode finds that case; the path text alone does not.
 */
async function rejectIntoSelf(src: string, dest: string, dereference: boolean): Promise<void> {
	// The messages are Node's own, as `fs.cp` raised them: the batch result shows them to the user verbatim.
	const intoSelf = (): Error => cpError("ERR_FS_CP_EINVAL", `cannot copy ${src} to a subdirectory of self ${dest}`, dest);
	if (resolve(src) === resolve(dest)) throw cpError("ERR_FS_CP_EINVAL", "src and dest cannot be the same", dest);
	if (isInside(src, dest)) throw intoSelf();
	const srcStat = await (dereference ? stat(src, { bigint: true }) : lstat(src, { bigint: true }));
	const srcParent = resolve(dirname(src));
	for (let parent = resolve(dirname(dest)); parent !== srcParent && parent !== parse(parent).root; parent = resolve(dirname(parent))) {
		let parentStat: BigIntStats;
		try {
			parentStat = await stat(parent, { bigint: true });
		} catch (error) {
			// A parent that does not exist yet cannot be the source; a farther one still can.
			if (hasErrorCode(error, "ENOENT")) continue;
			throw error;
		}
		if (sameFile(srcStat, parentStat)) throw intoSelf();
	}
}

export async function copyTree(src: string, dest: string, options: CopyTreeOptions = {}): Promise<void> {
	const dereference = options.dereference ?? false;
	const copyBytes = options.copyFile ?? ((from: string, to: string) => fsCopyFile(from, to));
	const maxActive = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
	const statOf = (path: string): Promise<Stats> => (dereference ? stat(path) : lstat(path));

	let failure: { readonly error: unknown } | undefined;
	let active = 0;
	const waiting: (() => void)[] = [];

	/** The first failure wins; every later caller rethrows it, so the batch reports one reason. */
	const abort = (error: unknown): never => {
		failure ??= { error };
		throw failure.error;
	};

	/** One file-system call, at most `maxActive` at a time, and none once something has failed. */
	async function run<T>(task: () => Promise<T>): Promise<T> {
		while (active >= maxActive) await new Promise<void>((resolveWait) => waiting.push(resolveWait));
		active += 1;
		try {
			if (failure !== undefined) throw failure.error;
			return await task();
		} catch (error) {
			return abort(error);
		} finally {
			active -= 1;
			waiting.shift()?.();
		}
	}

	/** Waits for every branch, so nothing is still writing when the rejection is delivered. */
	async function allDone(branches: readonly Promise<void>[]): Promise<void> {
		const results = await Promise.allSettled(branches);
		const rejected = results.find((result) => result.status === "rejected");
		if (rejected !== undefined) abort(rejected.reason);
	}

	async function copyEntry(from: string, to: string, probe: TypeProbe): Promise<void> {
		if (probe.isDirectory()) return copyFolder(from, to);
		if (probe.isFile() || probe.isCharacterDevice() || probe.isBlockDevice()) return run(() => copyBytes(from, to));
		if (probe.isSymbolicLink()) return copyLink(from, to);
		if (probe.isSocket()) return abort(cpError("ERR_FS_CP_SOCKET", `cannot copy a socket file: ${to}`, to));
		if (probe.isFIFO()) return abort(cpError("ERR_FS_CP_FIFO_PIPE", `cannot copy a FIFO pipe: ${to}`, to));
		return abort(cpError("ERR_FS_CP_UNKNOWN", `cannot copy an unknown file type: ${to}`, to));
	}

	async function copyFolder(from: string, to: string): Promise<void> {
		const info = await run(() => statOf(from));
		const created = await run(() => mkdir(to, { recursive: true }));
		const entries: Dirent[] = await run(() => readdir(from, { withFileTypes: true }));
		await allDone(
			entries.map(async (entry) => {
				const childFrom = join(from, entry.name);
				// Without `dereference` the directory listing already says what each entry is.
				const probe: TypeProbe = dereference && entry.isSymbolicLink() ? await run(() => stat(childFrom)) : entry;
				await copyEntry(childFrom, join(to, entry.name), probe);
			}),
		);
		// A folder made read-only is locked only after its content is in.
		if (created !== undefined) await run(() => chmod(to, info.mode));
	}

	async function copyLink(from: string, to: string): Promise<void> {
		let pointsAt = await run(() => readlink(from));
		if (!isAbsolute(pointsAt)) pointsAt = resolve(dirname(from), pointsAt);
		// A link whose target is gone is still copied (as a "file" link); only an existing folder makes it a "dir" link.
		const pointsAtFolder = await run(() =>
			stat(from).then(
				(info) => info.isDirectory(),
				() => false,
			),
		);
		await run(() => symlink(pointsAt, to, pointsAtFolder ? "dir" : "file"));
	}

	const top = await statOf(src);
	if (top.isDirectory()) await rejectIntoSelf(src, dest, dereference);
	await mkdir(dirname(dest), { recursive: true });
	await copyEntry(src, dest, top);
}
