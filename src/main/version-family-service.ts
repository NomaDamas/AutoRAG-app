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
 * A scan that fails stays that folder's problem. Each location is scanned on its
 * own; a location whose scan failed keeps the families the last good scan found
 * there and is reported in `scanFailures` (shown only while that folder is in
 * view), and every other location's result is written as usual. A cloud drive
 * (iCloud Drive and the like) whose whole-root scan fails is scanned folder by
 * folder from then on, so one slow or huge folder no longer costs the rest.
 *
 * A modification that lands after dupey read a file but before its post-scan
 * probe keeps the old relation until the next scan unless a live event for it
 * was seen (the fence covers watched folders only). Renames whose destination
 * is outside every watched folder degrade to prune after 2000 ms.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DupeyScanResult } from "@autorag/librarian";
import type {
	FsEntry,
	FsLocation,
	FsVersionFamiliesResult,
	FsVersionFamily,
	FsVersionFamilyError,
	FsVersionFamilyScanFailure,
	FsVersionMember,
	FsVersionRelation,
} from "../shared/fs-contract";
import type { FsDirChange } from "../shared/live-contract";
import { type DupeyScanOptions, scanScopeCovers, type VersionScanScope } from "../shared/version-scan-scope";
import { createDupeyProbe, DUPEY_INSTALL_COMMAND, type DupeyProbe } from "./dupey";
import { DIRTY_STAMP, lstatProbe, remapRenames, sameContent, verifyFamilies, type FileStamp, type Probe } from "./version-family-verify";
import { type StoredVersionFamilies, VERSION_FAMILY_STORE_VERSION, type VersionFamilyStore } from "./version-family-store";

export const DEFAULT_SCAN_INTERVAL_MINUTES = 60;

/** dupey kills itself with this message when a scan outlasts the librarian's time limit (`timeoutMs`, 120 s by default). */
export function isDupeyTimeout(message: string): boolean {
	return /dupey timed out/i.test(message);
}

interface DupeyMemberInfo {
	readonly path?: string;
	readonly relation?: string;
	readonly exact_hash?: string;
	readonly joined_with?: string;
}

/** The immediate subfolders of `dir`. A symbolic link is not one: dupey does not follow them either. */
async function defaultListFolders(dir: string): Promise<readonly string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
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
		const mtimes = new Map(family.entries.map((entry) => [entry.path, entry.mtimeMs]));
		const members = family.members.filter((member) => !removed.has(member.path));
		const head = removed.has(family.head) ? newestPath(members, mtimes) : family.head;
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
	mtimes: ReadonlyMap<string, number>,
): string | null {
	let best: string | null = null;
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const member of members) {
		const at = mtimes.get(member.path) ?? Number.NEGATIVE_INFINITY;
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
	/**
	 * Scans one folder with the dupey CLI. Injected, not imported: the scan lives in `@autorag/librarian`, which takes
	 * ~2 s to load, and the fs worker answers folder listings on the thread this module runs on (see `librarian-client.ts`).
	 */
	readonly scanDuplicates: (dir: string, options?: DupeyScanOptions) => Promise<DupeyScanResult>;
	/**
	 * Names of the immediate subfolders of a folder: a directory listing that reads no file's content. Defaults to
	 * `readdir`; used to split a cloud drive whose whole-root scan failed.
	 */
	readonly listFolders?: (dir: string) => Promise<readonly string[]>;
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
	/**
	 * Runs a scan, persists the snapshot, and reports the outcome. This is the person asking ("Check again"), so folders
	 * that timed out earlier are tried again; the scheduled scans leave them alone until then. A scan already running is
	 * joined, not started twice.
	 */
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
	const { scanDuplicates } = deps;
	const listFolders = deps.listFolders ?? defaultListFolders;
	const dupey = deps.dupey ?? createDupeyProbe();
	const probe = deps.probe ?? lstatProbe();
	const now = deps.now ?? (() => new Date());
	const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

	let snapshot: StoredVersionFamilies | null | undefined;
	let published: FsVersionFamiliesResult | undefined;
	let lastError: FsVersionFamilyError | null = null;
	let lastFailures: readonly FsVersionFamilyScanFailure[] = [];
	/** Cloud drives scanned folder by folder; seeded from the snapshot before the first scan. */
	const splitLocations = new Set<string>();
	let splitLoaded = false;
	/** Scans that hit dupey's time limit, by scope. A scheduled scan reuses them instead of asking the drive for the same files again. */
	const timedOut = new Map<string, FsVersionFamilyScanFailure>();
	let scanning: Promise<FsVersionFamiliesResult> | null = null;
	let timer: unknown = null;
	let mutationSeq = 0;
	const touchedAt = new Map<string, number>();
	/** Paths deleted by a live event while their rename/recreate outcome is still unknown. */
	const pendingRename = new Set<string>();
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
			scanFailures: lastFailures,
		};
	}

	function sameFamilies(a: readonly FsVersionFamily[], b: readonly FsVersionFamily[]): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function sameError(a: FsVersionFamilyError | null, b: FsVersionFamilyError | null): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function sameFailures(a: readonly FsVersionFamilyScanFailure[], b: readonly FsVersionFamilyScanFailure[]): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}

	function emit(result: FsVersionFamiliesResult): void {
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
			families: pruneVersionFamilies(current.families, new Set([...pendingRename, ...trashedPaths])),
		};
		const changed =
			previous !== undefined &&
			(previous.scannedAt !== current.scannedAt ||
				!sameError(previous.error, current.error) ||
				!sameFailures(previous.scanFailures, current.scanFailures) ||
				!sameFamilies(previous.families, current.families));
		emit(current);
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
				if (!pendingRename.has(path)) return;
				clearPendingRename(path);
				const stored = await load();
				if (stored === null) return;
				const current = await probe(path);
				if (current !== null) {
					// The path exists again (delete+recreate or an atomic save): never
					// trash it. Mark it dirty only when the content actually changed, so
					// the next scan re-includes an untouched path instead of hiding it.
					const recorded = stored.stamps?.[path];
					const changed = recorded !== undefined && !sameContent(current, recorded);
					const nextStored: StoredVersionFamilies = changed
						? { ...stored, stamps: { ...(stored.stamps ?? {}), [path]: DIRTY_STAMP } }
						: stored;
					if (changed) {
						await deps.store.write(nextStored);
						snapshot = nextStored;
					}
					touchedAt.set(path, ++mutationSeq);
					await publishVerified(nextStored);
					deps.onChanged?.();
					return;
				}
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

	/** Seeds `splitLocations` from the snapshot, once: a restart must not retry the whole-root scan that already failed. */
	async function loadSplitLocations(): Promise<void> {
		if (splitLoaded) return;
		splitLoaded = true;
		for (const path of (await load())?.splitLocations ?? []) splitLocations.add(path);
	}

	function unitKey(unit: VersionScanScope): string {
		return [unit.path, ...unit.excludeDirs].join("\u0000");
	}

	/** dupey families to the app's: entries built, members that vanished dropped, every path stamped. */
	async function familiesFrom(
		scan: DupeyScanResult,
	): Promise<{ readonly families: readonly FsVersionFamily[]; readonly stamps: Record<string, FileStamp> }> {
		const families: FsVersionFamily[] = [];
		const stamps: Record<string, FileStamp> = {};
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
			const members = mapped.members.filter((member) => entries.some((entry) => entry.path === member.path));
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
		return { families, stamps };
	}

	interface UnitScan {
		readonly name: string;
		readonly scope: VersionScanScope;
	}

	type UnitResult =
		| { readonly ok: true; readonly families: readonly FsVersionFamily[]; readonly stamps: Record<string, FileStamp> }
		| { readonly ok: false; readonly failure: FsVersionFamilyScanFailure };

	/** One dupey call over one scope. Never throws: a failure comes back as the scope's `FsVersionFamilyScanFailure`. */
	async function scanUnit(unit: UnitScan, retryTimedOut: boolean): Promise<UnitResult> {
		const { scope } = unit;
		const key = unitKey(scope);
		const known = timedOut.get(key);
		if (known !== undefined && !retryTimedOut) return { ok: false, failure: known };
		try {
			const scan =
				scope.excludeDirs.length === 0
					? await scanDuplicates(scope.path)
					: await scanDuplicates(scope.path, { excludeDirs: scope.excludeDirs });
			const built = await familiesFrom(scan);
			timedOut.delete(key);
			return { ok: true, ...built };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dupey scan failed for ${scope.path}: ${message}`);
			const failure: FsVersionFamilyScanFailure = {
				name: unit.name,
				path: scope.path,
				excludeDirs: scope.excludeDirs,
				reason: isDupeyTimeout(message) ? "timeout" : "error",
				message,
			};
			if (failure.reason === "timeout") timedOut.set(key, failure);
			else timedOut.delete(key);
			return { ok: false, failure };
		}
	}

	interface LocationScan {
		readonly families: readonly FsVersionFamily[];
		readonly stamps: Record<string, FileStamp>;
		/** Scans of this location that ran to the end. */
		readonly read: number;
		readonly failures: readonly FsVersionFamilyScanFailure[];
	}

	/**
	 * A whole location is one dupey call. A cloud drive whose call fails is scanned folder by folder instead: each of its
	 * top-level folders is its own call, and the files in its root are one more that skips those folders. A folder that
	 * is too slow or too large then fails alone, and the others still report. The price is that a family whose files sit
	 * in two different top-level folders is no longer found: dupey only groups files it scanned in one call.
	 */
	async function scanLocation(location: FsLocation, retryTimedOut: boolean): Promise<LocationScan> {
		const cloud = location.section === "cloud";
		const whole: UnitScan = { name: location.name, scope: { path: location.path, excludeDirs: [] } };
		let wholeFailure: FsVersionFamilyScanFailure | null = null;
		if (!(cloud && splitLocations.has(location.path))) {
			const result = await scanUnit(whole, retryTimedOut);
			if (result.ok) return { families: result.families, stamps: result.stamps, read: 1, failures: [] };
			if (!cloud) return { families: [], stamps: {}, read: 0, failures: [result.failure] };
			wholeFailure = result.failure;
			timedOut.delete(unitKey(whole.scope));
		}
		let folders: readonly string[];
		try {
			folders = await listFolders(location.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failure = wholeFailure ?? { ...whole.scope, name: whole.name, reason: "error" as const, message };
			return { families: [], stamps: {}, read: 0, failures: [failure] };
		}
		// Nothing to split into: the whole-root call that just failed is all there is.
		if (folders.length === 0 && wholeFailure !== null) {
			return { families: [], stamps: {}, read: 0, failures: [wholeFailure] };
		}
		splitLocations.add(location.path);
		const units: UnitScan[] = [
			{ name: location.name, scope: { path: location.path, excludeDirs: folders } },
			...folders.map((folder) => ({ name: folder, scope: { path: join(location.path, folder), excludeDirs: [] } })),
		];
		const families: FsVersionFamily[] = [];
		const stamps: Record<string, FileStamp> = {};
		const failures: FsVersionFamilyScanFailure[] = [];
		let read = 0;
		for (const unit of units) {
			const result = await scanUnit(unit, retryTimedOut);
			if (!result.ok) {
				failures.push(result.failure);
				continue;
			}
			read += 1;
			families.push(...result.families);
			Object.assign(stamps, result.stamps);
		}
		return { families, stamps, read, failures };
	}

	async function scanLocations(retryTimedOut: boolean): Promise<{
		readonly families: readonly FsVersionFamily[];
		readonly locations: readonly string[];
		readonly read: number;
		readonly failures: readonly FsVersionFamilyScanFailure[];
		readonly stamps: Record<string, FileStamp>;
	}> {
		await loadSplitLocations();
		const families: FsVersionFamily[] = [];
		const locations: string[] = [];
		const failures: FsVersionFamilyScanFailure[] = [];
		const stamps: Record<string, FileStamp> = {};
		let read = 0;
		for (const location of await deps.locations()) {
			// Only content folders and cloud drives: Recents is virtual, and a
			// home folder or whole disk is far too large for dupey to scan.
			if (!location.available || !location.scanned) continue;
			locations.push(location.path);
			// One location's failure is that location's failure: the loop goes on.
			const scan = await scanLocation(location, retryTimedOut);
			families.push(...scan.families);
			Object.assign(stamps, scan.stamps);
			failures.push(...scan.failures);
			read += scan.read;
		}
		return { families, locations, read, failures, stamps };
	}

	/**
	 * The last snapshot's families that a scan which failed over their folder cannot speak for. They stay published (and
	 * are still verified against the disk like any other), so a timeout does not make a folder's stacks disappear.
	 */
	function keepFromFailedScopes(
		stored: StoredVersionFamilies | null,
		failures: readonly FsVersionFamilyScanFailure[],
	): { readonly families: readonly FsVersionFamily[]; readonly stamps: Record<string, FileStamp> } {
		const families: FsVersionFamily[] = [];
		const stamps: Record<string, FileStamp> = {};
		if (stored === null || failures.length === 0) return { families, stamps };
		for (const family of stored.families) {
			const paths = familyPaths(family);
			if (!failures.some((failure) => paths.every((path) => scanScopeCovers(failure, path)))) continue;
			families.push(family);
			for (const path of paths) {
				const stamp = stored.stamps?.[path];
				if (stamp !== undefined) stamps[path] = stamp;
			}
		}
		return { families, stamps };
	}

	async function runScan(retryTimedOut: boolean): Promise<FsVersionFamiliesResult> {
		const status = await dupey.status();
		if (!status.available) {
			return serialize(async () => {
				const previous = published;
				lastError = {
					code: "dupey-missing",
					message: `dupey CLI is required for version stacks: ${status.error ?? "not found on PATH"}`,
					installCommand: DUPEY_INSTALL_COMMAND,
				};
				lastFailures = [];
				const changed = (await publishVerified(await load())) || previous === undefined;
				if (changed) deps.onChanged?.();
				return published ?? envelope(null);
			});
		}
		// A scan reads the disk over seconds; a trash that landed meanwhile must
		// win, or the deleted duplicate comes back until the next interval.
		const startedAtSeq = mutationSeq;
		const { families: scanned, locations, read, failures, stamps: scannedStamps } = await scanLocations(retryTimedOut);
		if (read === 0 && failures.length > 0) {
			// Nothing was read: the snapshot (and its scannedAt) stays as it was, and the failures are reported.
			return serialize(async () => {
				lastError = null;
				lastFailures = failures;
				const previous = published;
				const currentBase =
					previous ?? (await verifyStored(await load())).result;
				const current: FsVersionFamiliesResult = { ...currentBase, error: null, scanFailures: failures };
				const changed =
					previous === undefined ||
					previous.scannedAt !== current.scannedAt ||
					!sameError(previous.error, current.error) ||
					!sameFailures(previous.scanFailures, current.scanFailures) ||
					!sameFamilies(previous.families, current.families);
				published = current;
				if (changed) deps.onChanged?.();
				return current;
			});
		}
		await serialize(async () => {
			lastError = null;
			lastFailures = failures;
			const kept = keepFromFailedScopes(await load(), failures);
			const merged = [...scanned, ...kept.families];
			const stampsOfMerged = { ...kept.stamps, ...scannedStamps };
			const honored = new Set(trashedPaths);
			const fencedPaths = new Set(
				merged.flatMap((family) =>
					familyPaths(family).filter((path) => (touchedAt.get(path) ?? -1) > startedAtSeq),
				),
			);
			for (const path of fencedPaths) stampsOfMerged[path] = DIRTY_STAMP;
			const split = [...splitLocations].filter((path) => locations.includes(path));
			const stored: StoredVersionFamilies = {
				version: VERSION_FAMILY_STORE_VERSION,
				scannedAt: now().toISOString(),
				locations,
				families: pruneVersionFamilies(merged, honored),
				stamps: stampsOfMerged,
				...(split.length === 0 ? {} : { splitLocations: split }),
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
		return result();
	}

	/** One scan at a time: a cloud drive scanned folder by folder can outlast the interval. */
	function scan(retryTimedOut: boolean): Promise<FsVersionFamiliesResult> {
		scanning ??= runScan(retryTimedOut).finally(() => {
			scanning = null;
		});
		return scanning;
	}

	async function refresh(): Promise<FsVersionFamiliesResult> {
		return scan(true);
	}

	function arm(): void {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		const minutes = Math.max(1, Math.floor(deps.intervalMinutes()));
		timer = setTimer(() => {
			void scan(false);
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
			emit(current);
			deps.onChanged?.();
			return current;
		});
	}

	async function reverify(): Promise<boolean> {
		return serialize(async () => {
			const stored = await load();
			if (stored === null) {
				const changed = published !== undefined && published.families.length > 0;
				emit(envelope(null));
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
			let deletedPublished = false;
			for (const path of deleted) {
				if (!claimed.has(path) || pendingRename.has(path)) continue;
				pendingRename.add(path);
				schedulePendingRename(path);
				const next = pruneVersionFamilies(published?.families ?? [], new Set([path]));
				deletedPublished = deletedPublished || !sameFamilies(published?.families ?? [], next);
				emit({ ...(published ?? envelope(stored)), families: next });
			}

			// A create on a path the snapshot already claims is a delete+recreate or
			// an atomic rename-over save: verify and detach it like an update. Clearing
			// its pending delete keeps the recreated path out of the trash set, so the
			// next scan re-includes it.
			const recreated = new Set<string>();
			for (const path of created) {
				if (!claimed.has(path) && !pendingRename.has(path)) continue;
				clearPendingRename(path);
				updates.add(path);
				recreated.add(path);
			}

			const candidates = created.filter((path) => !recreated.has(path));
			if (candidates.length > 0 && pendingRename.size > 0) {
				const remapped = await remapRenames(
					stored.families,
					stored.stamps ?? {},
					[...pendingRename],
					candidates,
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
			// Updates detach a member only when its probed stamp proves the content
			// changed; a metadata-only touch (chmod/xattr) leaves the family intact.
			const affected = affectedFamilyPaths(stored.families, new Set([...updates, ...deleted]));
			for (const path of pendingRename) affected.delete(path);
			if (affected.size === 0) return deletedPublished;
			const changed = await publishVerified(stored, affected);
			// A delete already pruned and published the stack; the hub must send it now
			// rather than waiting out the rename window.
			return deletedPublished || changed;
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
			for (const path of pendingRename) schedulePendingRename(path);
			return scan(false);
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
