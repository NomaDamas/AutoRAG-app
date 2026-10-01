import { lstat } from "node:fs/promises";
import type { FsEntry, FsVersionFamily, FsVersionMember } from "../shared/fs-contract";
import { pruneVersionFamilies } from "./version-family-service";

/** From lstat(path, { bigint: true }); decimal strings so JSON persistence is lossless. */
export interface FileStamp {
	readonly dev: string;
	readonly ino: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
}

/** Sentinel written for a path touched by a live event after its scan started: always treated as changed until the next scan. */
export const DIRTY_STAMP: FileStamp = { dev: "", ino: "", size: "", mtimeNs: "", ctimeNs: "" };

export type Probe = (path: string) => Promise<FileStamp | null>;

export function lstatProbe(): Probe {
	return async (path: string): Promise<FileStamp | null> => {
		try {
			const value = await lstat(path, { bigint: true });
			return {
				dev: value.dev.toString(),
				ino: value.ino.toString(),
				size: value.size.toString(),
				mtimeNs: value.mtimeNs.toString(),
				ctimeNs: value.ctimeNs.toString(),
			};
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR")
			) {
				return null;
			}
			throw error;
		}
	};
}

export function sameIdentity(a: FileStamp, b: FileStamp): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

export function sameContent(a: FileStamp, b: FileStamp): boolean {
	return (
		!isDirty(a) &&
		!isDirty(b) &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

/** Like sameContent but ignores ctimeNs — for rename detection where the kernel changes ctime on rename(2). */
function sameContentForRename(a: FileStamp, b: FileStamp): boolean {
	return (
		!isDirty(a) &&
		!isDirty(b) &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs
	);
}

function isDirty(stamp: FileStamp): boolean {
	return (
		stamp.dev === "" &&
		stamp.ino === "" &&
		stamp.size === "" &&
		stamp.mtimeNs === "" &&
		stamp.ctimeNs === ""
	);
}

export interface Verified {
	readonly families: readonly FsVersionFamily[];
	readonly vanished: readonly string[];
}

const VERIFY_CONCURRENCY = 64;

async function probeAll(paths: readonly string[], probe: Probe): Promise<ReadonlyMap<string, FileStamp | null>> {
	const result = new Map<string, FileStamp | null>();
	for (let index = 0; index < paths.length; index += VERIFY_CONCURRENCY) {
		const batch = paths.slice(index, index + VERIFY_CONCURRENCY);
		const values = await Promise.all(batch.map(async (path) => [path, await probe(path)] as const));
		for (const [path, stamp] of values) result.set(path, stamp);
	}
	return result;
}

function familyPaths(family: FsVersionFamily): readonly string[] {
	return [family.head, ...family.members.map((member) => member.path)];
}

function uniquePaths(families: readonly FsVersionFamily[], only?: ReadonlySet<string>): string[] {
	const paths = new Set<string>();
	for (const family of families) {
		for (const path of familyPaths(family)) {
			if (only === undefined || only.has(path)) paths.add(path);
		}
	}
	return [...paths];
}

function detachChanged(
	families: readonly FsVersionFamily[],
	stamps: Readonly<Record<string, FileStamp>>,
	current: ReadonlyMap<string, FileStamp | null>,
	only?: ReadonlySet<string>,
): readonly FsVersionFamily[] {
	const verified: FsVersionFamily[] = [];
	for (const family of families) {
		const headStamp = current.get(family.head);
		const recordedHead = stamps[family.head];
		const headChanged =
			headStamp !== undefined &&
			headStamp !== null &&
			recordedHead !== undefined &&
			!sameContent(headStamp, recordedHead);
		if (headChanged) continue;
		const members = family.members.filter((member) => {
			if (only !== undefined && !only.has(member.path)) return true;
			const currentStamp = current.get(member.path);
			const recorded = stamps[member.path];
			return (
				currentStamp !== undefined &&
				currentStamp !== null &&
				(recorded === undefined || sameContent(currentStamp, recorded))
			);
		});
		if (members.length === 0) continue;
		verified.push({ ...family, members });
	}
	return verified;
}

export async function verifyFamilies(
	families: readonly FsVersionFamily[],
	stamps: Readonly<Record<string, FileStamp>>,
	probe: Probe,
	only?: ReadonlySet<string>,
): Promise<Verified> {
	const paths = uniquePaths(families, only);
	const current = await probeAll(paths, probe);
	const vanished = paths.filter((path) => current.get(path) === null);
	const pruned = pruneVersionFamilies(families, new Set(vanished));
	return {
		families: detachChanged(pruned, stamps, current, only),
		vanished,
	};
}

function replacePath(value: string, oldPath: string, newPath: string): string {
	return value === oldPath ? newPath : value;
}

function rewriteEntry(entry: FsEntry, oldPath: string, newPath: string): FsEntry {
	return entry.path === oldPath ? { ...entry, path: newPath } : entry;
}

function rewriteMember(member: FsVersionMember, oldPath: string, newPath: string): FsVersionMember {
	return member.path === oldPath ? { ...member, path: newPath } : member;
}

function rewriteFamilies(
	families: readonly FsVersionFamily[],
	oldPath: string,
	newPath: string,
): readonly FsVersionFamily[] {
	return families.map((family) => ({
		...family,
		head: replacePath(family.head, oldPath, newPath),
		members: family.members.map((member) => rewriteMember(member, oldPath, newPath)),
		entries: family.entries.map((entry) => rewriteEntry(entry, oldPath, newPath)),
	}));
}

export async function remapRenames(
	families: readonly FsVersionFamily[],
	stamps: Readonly<Record<string, FileStamp>>,
	deleted: readonly string[],
	created: readonly string[],
	probe: Probe,
): Promise<{
	readonly families: readonly FsVersionFamily[];
	readonly stamps: Readonly<Record<string, FileStamp>>;
	readonly remapped: ReadonlyMap<string, string>;
}> {
	const candidates = await probeAll(created, probe);
	let nextFamilies = families;
	const nextStamps: Record<string, FileStamp> = { ...stamps };
	const remapped = new Map<string, string>();
	const claimed = new Set<string>();
	for (const oldPath of deleted) {
		const oldStamp = stamps[oldPath];
		if (oldStamp === undefined) continue;
		const matches = created.filter(
			(path) => !claimed.has(path) && candidates.get(path) !== null && sameIdentity(oldStamp, candidates.get(path)!),
		);
		if (matches.length !== 1) continue;
		const newPath = matches[0]!;
		claimed.add(newPath);
		nextFamilies = rewriteFamilies(nextFamilies, oldPath, newPath);
		delete nextStamps[oldPath];
		const newStamp = candidates.get(newPath)!;
		nextStamps[newPath] = sameContentForRename(oldStamp, newStamp) ? newStamp : DIRTY_STAMP;
		remapped.set(oldPath, newPath);
	}
	return { families: nextFamilies, stamps: nextStamps, remapped };
}
