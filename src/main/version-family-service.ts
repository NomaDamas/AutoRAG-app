/**
 * dupey version-family scanning, scheduling, and the SSOT hand-off.
 *
 * Flow: dupey CLI -> persisted snapshot (userData) -> UI. The UI is always
 * served from the snapshot; scans run once at startup and then on a repeating
 * interval that the app Settings control. Trashing a file is the one mutation
 * that reacts here: the snapshot is pruned in place (no scan, no CLI) so a
 * deleted duplicate leaves the UI immediately and stays gone across a scan
 * that was already reading the disk.
 *
 * A modification that lands after dupey read a file but before its post-scan
 * probe keeps the old relation until the next scan unless a live event for it
 * was seen (the fence covers watched folders only). Renames whose destination
 * is outside every watched folder degrade to prune after 2000 ms.
 */

import { scanWithDupey, type DupeyScanResult } from "@autorag/librarian";
import type {
	FsEntry,
	FsLocation,
	FsVersionFamiliesResult,
	FsVersionFamily,
	FsVersionFamilyError,
	FsVersionMember,
	FsVersionRelation,
} from "../shared/fs-contract";
import { RECENTS_PATH } from "../shared/fs-contract";
import type { FsDirChange } from "../shared/live-contract";
import { createDupeyProbe, DUPEY_INSTALL_COMMAND, type DupeyProbe } from "./dupey";
import { DIRTY_STAMP, lstatProbe, remapRenames, verifyFamilies, type FileStamp, type Probe } from "./version-family-verify";
import type { StoredVersionFamilies, VersionFamilyStore } from "./version-family-store";

export const DEFAULT_SCAN_INTERVAL_MINUTES = 60;

interface DupeyMemberInfo {
	readonly path?: string;
	readonly relation?: string;
	readonly exact_hash?: string;
	readonly joined_with?: string;
}

function clampRelation(value: string | undefined): FsVersionRelation {
	return value === "exact" || value === "contains" ? value : "near";
}

/**
 * Drops trashed paths from a snapshot without re-scanning. A family that lost
 * its head re-heads to its newest remaining member (dupey's own pick rule); a
 * family with no members left is no longer a family and disappears.
 */
export function pruneVersionFamilies(
	families: readonly FsVersionFamily[],
	removed: ReadonlySet<string>,
): readonly FsVersionFamily[] {
	if (removed.size === 0) return families;
	const out: FsVersionFamily[] = [];
	for (const family of families) {
		const entries = family.entries.filter((entry) => !removed.has(entry.path));
		if (entries.length === 0) continue;
		const modifiedAt = new Map(family.entries.map((entry) => [entry.path, entry.modifiedAt]));
		const members = family.members.filter((member) => !removed.has(member.path));
		const head = removed.has(family.head) ? newestPath(members, modifiedAt) : family.head;
		if (head === null) continue;
		const rest = members.filter((member) => member.path !== head);
		if (rest.length === 0) continue;
		out.push({ head, members: rest, entries });
	}
	return out;
}

/** The member with the newest mtime, path as the deterministic tie-break. */
function newestPath(
	members: readonly FsVersionMember[],
	modifiedAt: ReadonlyMap<string, string>,
): string | null {
	let best: string | null = null;
	let bestAt = "";
	for (const member of members) {
		const at = modifiedAt.get(member.path) ?? "";
		if (best === null || at > bestAt || (at === bestAt && member.path < best)) {
			best = member.path;
			bestAt = at;
		}
	}
	return best;
}

/** dupey family (pick-keeper head + per-member relations) to the app contract. */
export function mapDupeyFamily(
	family: DupeyScanResult["families"][number],
): { readonly head: string; readonly members: readonly FsVersionMember[] } | null {
	const head =
		(family.pick as { readonly ranked?: readonly { readonly path?: string }[] } | undefined)?.ranked?.[0]
			?.path ?? family.files[0];
	if (typeof head !== "string" || head.length === 0) return null;
	const memberInfos = new Map<string, DupeyMemberInfo>();
	for (const member of family.members as readonly DupeyMemberInfo[]) {
		if (typeof member?.path === "string") memberInfos.set(member.path, member);
	}
	const headHash = memberInfos.get(head)?.exact_hash;
	const members: FsVersionMember[] = [];
	for (const path of family.files) {
		if (path === head) continue;
		const info = memberInfos.get(path);
		const relation =
			info?.exact_hash !== undefined && headHash !== undefined && info.exact_hash === headHash
				? "exact"
				: clampRelation(info?.relation);
		members.push({ path, relation });
	}
	return { head, members };
}

export interface VersionFamilyServiceDeps {
	readonly locations: () => Promise<readonly FsLocation[]>;
	readonly store: VersionFamilyStore;
	readonly buildEntry: (path: string) => Promise<FsEntry>;
	/** Defaults to the dupey CLI; tests inject fixture scans. */
	readonly scanDuplicates?: (dir: string) => Promise<DupeyScanResult>;
	readonly dupey?: DupeyProbe;
	/** Current interval in minutes, read from app Settings on every arm. */
	readonly intervalMinutes: () => number;
	/** Fired after a verified snapshot mutation for the ChangeHub integration. */
	readonly onChanged?: () => void;
	/** Filesystem metadata probe; defaults to bigint lstat without content reads. */
	readonly probe?: Probe;
	readonly now?: () => Date;
	readonly setTimer?: (handler: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

export interface VersionFamilyService {
	/** Snapshot read (memory, then disk). Never scans. */
	result(): Promise<FsVersionFamiliesResult>;
	/** Runs a scan, persists the snapshot, and reports the outcome. */
	refresh(): Promise<FsVersionFamiliesResult>;
	/** Startup scan plus the repeating interval. */
	start(): Promise<FsVersionFamiliesResult>;
	stop(): void;
	/** Re-reads the interval from Settings and re-arms the timer. */
	reschedule(): void;
	/**
	 * Drops trashed paths from the snapshot and publishes it. Never scans and
	 * never touches the dupey CLI: a deletion must land in the UI immediately.
	 */
	removePaths(paths: readonly string[]): Promise<FsVersionFamiliesResult>;
	/** Re-verifies the published families against current filesystem metadata. */
	reverify(): Promise<boolean>;
	/** Applies ordered filesystem changes without running a dupey scan. */
	applyDirChanges(dirs: readonly FsDirChange[]): Promise<boolean>;
}

export function createVersionFamilyService(deps: VersionFamilyServiceDeps): VersionFamilyService {
	const scanDuplicates = deps.scanDuplicates ?? ((dir: string) => scanWithDupey(dir));
	const dupey = deps.dupey ?? createDupeyProbe();
	const probe = deps.probe ?? lstatProbe();
	const now = deps.now ?? (() => new Date());
	const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

	let snapshot: StoredVersionFamilies | null | undefined;
	let published: FsVersionFamiliesResult | undefined;
	let lastError: FsVersionFamilyError | null = null;
	let timer: unknown = null;
	let mutationSeq = 0;
	const touchedAt = new Map<string, number>();
	const pendingRename = new Map<
		string,
		{ readonly stamp: FileStamp; readonly family: FsVersionFamily; readonly at: number }
	>();
	const pendingRenameTimers = new Map<string, unknown>();
	/** Paths trashed since the last completed scan; a fresh scan must not resurrect them. */
	const trashedPaths = new Set<string>();
	/**
	 * Snapshot writes run one at a time: a scan that finished while a delete was
	 * landing must not overwrite that delete (or the other way round).
	 */
	let writeQueue: Promise<unknown> = Promise.resolve();

	function serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = writeQueue.then(work, work);
		writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function load(): Promise<StoredVersionFamilies | null> {
		if (snapshot === undefined) snapshot = await deps.store.read();
		return snapshot;
	}

	function envelope(stored: StoredVersionFamilies | null): FsVersionFamiliesResult {
		return {
			families: stored?.families ?? [],
			scannedAt: stored?.scannedAt ?? null,
			error: lastError,
		};
	}

	function sameFamilies(a: readonly FsVersionFamily[], b: readonly FsVersionFamily[]): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function sameError(a: FsVersionFamilyError | null, b: FsVersionFamilyError | null): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function emit(result: FsVersionFamiliesResult, _changed: boolean): void {
		published = result;
	}

	async function verifyStored(
		stored: StoredVersionFamilies | null,
		only?: ReadonlySet<string>,
	): Promise<{ readonly result: FsVersionFamiliesResult; readonly vanished: readonly string[] }> {
		if (stored === null) {
			return { result: envelope(null), vanished: [] };
		}
		const verified = await verifyFamilies(stored.families, stored.stamps ?? {}, probe, only);
		const families = verified.families.map((family) => ({
			...family,
			entries: family.entries.filter(
				(entry) => entry.path === family.head || family.members.some((member) => member.path === entry.path),
			),
		}));
		return { result: { ...envelope(stored), families }, vanished: verified.vanished };
	}

	async function publishVerified(
		stored: StoredVersionFamilies | null,
		only?: ReadonlySet<string>,
	): Promise<boolean> {
		const previous = published;
		const verified = await verifyStored(stored, only);
		let current = verified.result;
		if (stored !== null && verified.vanished.length > 0) {
			const vanished = new Set(verified.vanished.filter((path) => !pendingRename.has(path)));
			if (vanished.size > 0) {
				const pruned: StoredVersionFamilies = {
					...stored,
					families: pruneVersionFamilies(stored.families, vanished),
					stamps: Object.fromEntries(
						Object.entries(stored.stamps ?? {}).filter(([path]) => !vanished.has(path)),
					),
				};
				await deps.store.write(pruned);
				snapshot = pruned;
				current = (await verifyStored(pruned, only)).result;
			}
		}
		if (only !== undefined && previous !== undefined && stored !== null) {
			const affected = affectedFamilyPaths(stored.families, only);
			current = {
				...current,
				families: [
					...previous.families.filter((family) => !familyPaths(family).some((path) => affected.has(path))),
					...current.families.filter((family) => familyPaths(family).some((path) => affected.has(path))),
				],
			};
		}
		current = {
			...current,
			families: pruneVersionFamilies(current.families, new Set([...pendingRename.keys(), ...trashedPaths])),
		};
		const changed =
			previous !== undefined &&
			(previous.scannedAt !== current.scannedAt ||
				!sameError(previous.error, current.error) ||
				!sameFamilies(previous.families, current.families));
		emit(current, changed);
		return changed;
	}

	function familyPaths(family: FsVersionFamily): readonly string[] {
		return [family.head, ...family.members.map((member) => member.path)];
	}

	function affectedFamilyPaths(
		families: readonly FsVersionFamily[],
		paths: ReadonlySet<string>,
	): Set<string> {
		const affected = new Set<string>();
		for (const family of families) {
			if (familyPaths(family).some((path) => paths.has(path))) {
				for (const path of familyPaths(family)) affected.add(path);
			}
		}
		return affected;
	}

	async function rebuildRemappedEntries(
		families: readonly FsVersionFamily[],
		remapped: ReadonlyMap<string, string>,
	): Promise<readonly FsVersionFamily[]> {
		if (remapped.size === 0) return families;
		return Promise.all(
			families.map(async (family) => ({
				...family,
				entries: await Promise.all(
					family.entries.map(async (entry) => {
						if (![...remapped.values()].includes(entry.path)) return entry;
						try {
							return await deps.buildEntry(entry.path);
						} catch (error) {
							console.warn(
								`dupey entry rebuild failed for ${entry.path}: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
							return entry;
						}
					}),
				),
			})),
		);
	}

	function clearPendingRename(path: string): void {
		const timerHandle = pendingRenameTimers.get(path);
		if (timerHandle !== undefined) clearTimer(timerHandle);
		pendingRenameTimers.delete(path);
		pendingRename.delete(path);
	}

	function schedulePendingRename(path: string): void {
		const timerHandle = setTimer(() => {
			void serialize(async () => {
				const pending = pendingRename.get(path);
				if (pending === undefined) return;
				clearPendingRename(path);
				const stored = await load();
				if (stored === null) return;
				trashedPaths.add(path);
				touchedAt.set(path, ++mutationSeq);
				const pruned: StoredVersionFamilies = {
					...stored,
					families: pruneVersionFamilies(stored.families, new Set([path])),
					stamps: Object.fromEntries(
						Object.entries(stored.stamps ?? {}).filter(([candidate]) => candidate !== path),
					),
				};
				await deps.store.write(pruned);
				snapshot = pruned;
				await publishVerified(pruned);
				deps.onChanged?.();
			});
		}, 2000);
		pendingRenameTimers.set(path, timerHandle);
	}

	async function result(): Promise<FsVersionFamiliesResult> {
		if (published !== undefined) return published;
		return serialize(async () => {
			if (published !== undefined) return published;
			await publishVerified(await load());
			return published ?? envelope(null);
		});
	}

	async function scanLocations(): Promise<{
		readonly families: readonly FsVersionFamily[];
		readonly locations: readonly string[];
		readonly errors: readonly string[];
		readonly stamps: Record<string, FileStamp>;
	}> {
		const families: FsVersionFamily[] = [];
		const locations: string[] = [];
		const errors: string[] = [];
		const stamps: Record<string, FileStamp> = {};
		for (const location of await deps.locations()) {
			// The virtual Recents location is a listing of recorded paths, not a
			// directory dupey could scan.
			if (!location.available || location.path === RECENTS_PATH) continue;
			locations.push(location.path);
			try {
				const scan = await scanDuplicates(location.path);
				for (const raw of scan.families) {
					const mapped = mapDupeyFamily(raw);
					if (mapped === null || mapped.members.length === 0) continue;
					const entries: FsEntry[] = [];
					try {
						entries.push(await deps.buildEntry(mapped.head));
					} catch {
						continue;
					}
					for (const member of mapped.members) {
						try {
							entries.push(await deps.buildEntry(member.path));
						} catch {
							continue;
						}
					}
					const members = mapped.members.filter((member) =>
						entries.some((entry) => entry.path === member.path),
					);
					if (members.length === 0) continue;
					const family = { head: mapped.head, members, entries };
					const paths = [family.head, ...family.members.map((member) => member.path)];
					const currentStamps = await Promise.all(paths.map(async (path) => [path, await probe(path)] as const));
					if (currentStamps.some(([, stamp]) => stamp === null)) continue;
					for (const [path, stamp] of currentStamps) {
						if (stamp !== null) stamps[path] = stamp;
					}
					families.push(family);
				}
			} catch (error) {
				const message = `dupey scan failed for ${location.path}: ${
					error instanceof Error ? error.message : String(error)
				}`;
				console.error(message);
				errors.push(message);
			}
		}
		return { families, locations, errors, stamps };
	}

	async function refresh(): Promise<FsVersionFamiliesResult> {
		const status = await dupey.status();
		if (!status.available) {
			return serialize(async () => {
				lastError = {
					code: "dupey-missing",
					message: `dupey CLI is required for version stacks: ${status.error ?? "not found on PATH"}`,
					installCommand: DUPEY_INSTALL_COMMAND,
				};
				await publishVerified(await load());
				const current = published ?? envelope(null);
				return current;
			});
		}
		// A scan reads the disk over seconds; a trash that landed meanwhile must
		// win, or the deleted duplicate comes back until the next interval.
		const startedAtSeq = mutationSeq;
		const { families: scanned, locations, errors, stamps: scannedStamps } = await scanLocations();
		const scanError =
			errors.length === 0 ? null : { code: "scan-failed" as const, message: errors.join("\n"), installCommand: null };
		if (scanned.length > 0 || errors.length === 0) {
			await serialize(async () => {
				lastError = scanError;
				const honored = new Set(trashedPaths);
				const fencedPaths = new Set(
					scanned.flatMap((family) =>
						familyPaths(family).filter((path) => (touchedAt.get(path) ?? -1) > startedAtSeq),
					),
				);
				for (const path of fencedPaths) scannedStamps[path] = DIRTY_STAMP;
				const stored: StoredVersionFamilies = {
					version: 1,
					scannedAt: now().toISOString(),
					locations,
					families: pruneVersionFamilies(scanned, honored),
					stamps: scannedStamps,
				};
				const verified = await verifyStored(stored);
				const persisted: StoredVersionFamilies = {
					...stored,
					families: pruneVersionFamilies(stored.families, new Set(verified.vanished)),
					stamps: Object.fromEntries(
						Object.entries(stored.stamps ?? {}).filter(([path]) => !verified.vanished.includes(path)),
					),
				};
				await deps.store.write(persisted);
				snapshot = persisted;
				emit(
					{ ...verified.result, families: pruneVersionFamilies(verified.result.families, honored) },
					true,
				);
				deps.onChanged?.();
				for (const path of honored) {
					if ((touchedAt.get(path) ?? -1) <= startedAtSeq) {
						trashedPaths.delete(path);
					}
				}
				for (const [path, sequence] of touchedAt) {
					if (sequence <= startedAtSeq) touchedAt.delete(path);
				}
			});
		}
		if (scanned.length === 0 && scanError !== null) {
			return serialize(async () => {
				lastError = scanError;
				const previous = published;
				const currentBase =
					previous ?? (await verifyStored(await load())).result;
				const current: FsVersionFamiliesResult = { ...currentBase, error: scanError };
				const changed =
					previous === undefined ||
					previous.scannedAt !== current.scannedAt ||
					!sameError(previous.error, current.error) ||
					!sameFamilies(previous.families, current.families);
				published = current;
				if (changed) deps.onChanged?.();
				return current;
			});
		}
		const current = await result();
		return current;
	}

	function arm(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		const minutes = Math.max(1, Math.floor(deps.intervalMinutes()));
		timer = setTimer(() => {
			void refresh();
		}, minutes * 60_000);
	}

	async function removePaths(paths: readonly string[]): Promise<FsVersionFamiliesResult> {
		const sequence = ++mutationSeq;
		if (paths.length === 0) return result();
		for (const path of paths) {
			trashedPaths.add(path);
			touchedAt.set(path, sequence);
		}
		return serialize(async () => {
			const stored = await load();
			if (stored === null) return envelope(stored);
			if (published === undefined) published = (await verifyStored(stored)).result;
			const removed = new Set(paths);
			const touched = stored.families.some(
				(family) => removed.has(family.head) || family.members.some((member) => removed.has(member.path)),
			);
			if (!touched) return published ?? envelope(stored);
			// scannedAt still names the scan these families came from; the prune only
			// subtracts paths the user sent to the Trash.
			const pruned: StoredVersionFamilies = {
				...stored,
				families: pruneVersionFamilies(stored.families, removed),
				stamps: Object.fromEntries(
					Object.entries(stored.stamps ?? {}).filter(([path]) => !removed.has(path)),
				),
			};
			await deps.store.write(pruned);
			snapshot = pruned;
			const current: FsVersionFamiliesResult = {
				...envelope(pruned),
				families: pruneVersionFamilies(published?.families ?? [], removed),
			};
			emit(current, true);
			deps.onChanged?.();
			return current;
		});
	}

	async function reverify(): Promise<boolean> {
		return serialize(async () => {
			const stored = await load();
			if (stored === null) {
				const changed = published !== undefined && published.families.length > 0;
				emit(envelope(null), changed);
				return changed;
			}
			const only = new Set(
				stored.families.flatMap((family) => familyPaths(family).filter((path) => !pendingRename.has(path))),
			);
			return publishVerified(stored, only);
		});
	}

	async function applyDirChanges(dirs: readonly FsDirChange[]): Promise<boolean> {
		const sequence = ++mutationSeq;
		const changes = dirs.flatMap((dir) => dir.changes);
		for (const change of changes) touchedAt.set(change.path, sequence);
		return serialize(async () => {
			const stored = await load();
			if (stored === null) return false;
			if (published === undefined) published = (await verifyStored(stored)).result;

			const deleted = changes.filter((change) => change.type === "delete").map((change) => change.path);
			const created = changes.filter((change) => change.type === "create").map((change) => change.path);
			const updates = new Set(
				changes.filter((change) => change.type === "update").map((change) => change.path),
			);
			const claimed = new Set(stored.families.flatMap((family) => familyPaths(family)));
			for (const path of deleted) {
				if (!claimed.has(path) || pendingRename.has(path)) continue;
				const stamp = stored.stamps?.[path] ?? DIRTY_STAMP;
				const family = stored.families.find((candidate) => familyPaths(candidate).includes(path));
				if (family === undefined) continue;
				pendingRename.set(path, { stamp, family, at: now().getTime() });
				schedulePendingRename(path);
				const next = pruneVersionFamilies(published?.families ?? [], new Set([path]));
				emit({ ...(published ?? envelope(stored)), families: next }, !sameFamilies(published?.families ?? [], next));
			}

			if (created.length > 0 && pendingRename.size > 0) {
				const remapped = await remapRenames(
					stored.families,
					stored.stamps ?? {},
					[...pendingRename.keys()],
					created,
					probe,
				);
				if (remapped.remapped.size > 0) {
					for (const [oldPath, newPath] of remapped.remapped) {
						clearPendingRename(oldPath);
						updates.add(newPath);
					}
					const nextStored: StoredVersionFamilies = {
						...stored,
						families: await rebuildRemappedEntries(remapped.families, remapped.remapped),
						stamps: remapped.stamps,
					};
					await deps.store.write(nextStored);
					snapshot = nextStored;
					const only = affectedFamilyPaths(nextStored.families, new Set([...updates, ...deleted]));
					return publishVerified(nextStored, only);
				}
			}

			if (dirs.some((dir) => dir.dirGone || dir.overflow)) {
				const only = new Set(
					stored.families.flatMap((family) =>
						familyPaths(family).filter((path) => !pendingRename.has(path)),
					),
				);
				return publishVerified(stored, only);
			}
			const affected = affectedFamilyPaths(stored.families, new Set([...updates, ...deleted]));
			for (const path of pendingRename.keys()) affected.delete(path);
			if (affected.size === 0) return false;
			if (updates.size > 0) {
				const nextStamps = { ...(stored.stamps ?? {}) };
				for (const path of updates) {
					if (claimed.has(path)) nextStamps[path] = DIRTY_STAMP;
				}
				const nextStored: StoredVersionFamilies = { ...stored, stamps: nextStamps };
				await deps.store.write(nextStored);
				snapshot = nextStored;
				return publishVerified(nextStored, affected);
			}
			return publishVerified(stored, affected);
		});
	}

	return {
		result,
		refresh,
		removePaths,
		reverify,
		applyDirChanges,
		async start(): Promise<FsVersionFamiliesResult> {
			arm();
			for (const path of pendingRename.keys()) schedulePendingRename(path);
			return refresh();
		},
		stop(): void {
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			for (const handle of pendingRenameTimers.values()) clearTimer(handle);
			pendingRenameTimers.clear();
		},
		reschedule: arm,
	};
}
