import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DupeyScanResult } from "@autorag/librarian";
import { createDupeyProbe, DUPEY_INSTALL_COMMAND } from "../src/main/dupey";
import {
	createVersionFamilyService,
	DEFAULT_SCAN_INTERVAL_MINUTES,
	isDupeyTimeout,
	mapDupeyFamily,
	pruneVersionFamilies,
	type VersionFamilyServiceDeps,
} from "../src/main/version-family-service";
import {
	createFileVersionFamilyStore,
	type StoredVersionFamilies,
	VERSION_FAMILY_STORE_VERSION,
} from "../src/main/version-family-store";
import { DIRTY_STAMP, type FileStamp } from "../src/main/version-family-verify";
import { RECENTS_PATH, type FsEntry, type FsLocation, type FsVersionFamily } from "../src/shared/fs-contract";

const dupeyAvailable = { status: async () => ({ available: true, version: "dupey 0.1.2", error: null }) };
const dupeyMissing = { status: async () => ({ available: false, version: null, error: "spawn dupey ENOENT" }) };
const fixtureStamp = (path: string, overrides: Partial<FileStamp> = {}): FileStamp => ({
	dev: "fixture",
	ino: path,
	size: "4",
	mtimeNs: "1",
	ctimeNs: "1",
	...overrides,
});

function fsEntry(path: string): FsEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "txt",
		size: 4,
		mtimeMs: Date.parse("2026-09-29T00:00:00.000Z"),
		flags: 0,
	};
}

function scanOf(families: readonly Record<string, unknown>[]): DupeyScanResult {
	return { dir: "/x", files: [], families: families as unknown as DupeyScanResult["families"], errors: [] };
}

function family(head: string, member: string, relation = "exact"): Record<string, unknown> {
	return {
		id: 0,
		relation: "mixed",
		files: [head, member],
		members: [
			{ path: head, exact_hash: "h" },
			{ path: member, exact_hash: "h", relation },
		],
		pick: { ranked: [{ path: head }] },
	};
}

interface Harness {
	readonly deps: VersionFamilyServiceDeps;
	readonly changes: number;
	readonly timers: { ms: number; fire: () => void }[];
	readonly scans: string[];
	readonly writes: number;
	readonly persisted: () => StoredVersionFamilies | null;
}

function harness(
	overrides: Partial<VersionFamilyServiceDeps> = {},
	seed: StoredVersionFamilies | null = null,
): Harness {
	let changes = 0;
	const timers: { ms: number; fire: () => void }[] = [];
	const scans: string[] = [];
	const state = { writes: 0 };
	let snapshot: unknown = seed;
	const locations: FsLocation[] = [
		{ name: "Desktop", path: "/home/Desktop", section: "favorites", icon: "desktop", available: true, scanned: true, ejectable: false },
	];
	const deps: VersionFamilyServiceDeps = {
		locations: async () => locations,
		store: {
			read: async () => (snapshot as never) ?? null,
			write: async (value) => {
				snapshot = value;
				state.writes += 1;
			},
		},
		buildEntry: async (path) => fsEntry(path),
		dupey: dupeyAvailable,
		scanDuplicates: async (dir) => {
			scans.push(dir);
			return scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]);
		},
		intervalMinutes: () => DEFAULT_SCAN_INTERVAL_MINUTES,
		probe: async (path) => fixtureStamp(path),
		onChanged: () => {
			changes += 1;
		},
		now: () => new Date("2026-09-29T10:00:00.000Z"),
		setTimer: (handler, ms) => {
			timers.push({ ms, fire: handler });
			return timers.length;
		},
		clearTimer: () => { },
		...overrides,
	};
	return {
		deps,
		get changes() {
			return changes;
		},
		timers,
		scans,
		get writes() {
			return state.writes;
		},
		persisted: () => snapshot as StoredVersionFamilies | null,
	};
}

describe("dupey probe", () => {
	it("reports the version when the CLI answers", async () => {
		const probe = createDupeyProbe({ run: async () => "dupey 0.1.2" });
		expect(await probe.status()).toEqual({ available: true, version: "dupey 0.1.2", error: null });
	});

	it("reports the spawn failure when the CLI is missing", async () => {
		const probe = createDupeyProbe({
			run: async () => {
				throw new Error("spawn dupey ENOENT");
			},
		});
		const status = await probe.status();
		expect(status.available).toBe(false);
		expect(status.error).toContain("ENOENT");
	});

	it("caches the result within the TTL and re-probes after it", async () => {
		let calls = 0;
		let clock = 0;
		const probe = createDupeyProbe({
			run: async () => {
				calls += 1;
				return "dupey 0.1.2";
			},
			ttlMs: 1000,
			now: () => clock,
		});
		await probe.status();
		clock = 500;
		await probe.status();
		expect(calls).toBe(1);
		clock = 1500;
		await probe.status();
		expect(calls).toBe(2);
	});
});

describe("mapDupeyFamily", () => {
	it("uses the pick keeper as head", () => {
		const mapped = mapDupeyFamily(family("/x/b.txt", "/x/a.txt") as never);
		expect(mapped?.head).toBe("/x/b.txt");
		expect(mapped?.members).toEqual([{ path: "/x/a.txt", relation: "exact" }]);
	});

	it("clamps unknown relations to near", () => {
		const mapped = mapDupeyFamily({
			id: 0,
			relation: "mixed",
			files: ["/x/head.txt", "/x/e.txt"],
			members: [{ path: "/x/head.txt" }, { path: "/x/e.txt", relation: "weird" }],
			pick: { ranked: [{ path: "/x/head.txt" }] },
		} as never);
		expect(mapped?.members).toEqual([{ path: "/x/e.txt", relation: "near" }]);
	});

	it("returns null without a head", () => {
		expect(mapDupeyFamily({ id: 0, relation: "mixed", files: [], members: [] } as never)).toBeNull();
	});
});

describe("version-family service — SSOT", () => {
	it("serves the persisted snapshot without scanning", async () => {
		const h = harness({
			store: {
				read: async () => ({
					version: 2 as const,
					scannedAt: "2026-09-28T00:00:00.000Z",
					locations: ["/home/Desktop"],
					families: [{ head: "/home/Desktop/a.txt", members: [{ path: "/home/Desktop/b.txt", relation: "exact" as const }], entries: [] }],
				}),
				write: async () => { },
			},
		});
		const service = createVersionFamilyService(h.deps);
		const result = await service.result();
		expect(h.scans).toEqual([]);
		expect(result.scannedAt).toBe("2026-09-28T00:00:00.000Z");
		expect(result.families).toHaveLength(1);
		expect(result.error).toBeNull();
	});

	it("scans, persists, and publishes on refresh", async () => {
		const h = harness();
		const service = createVersionFamilyService(h.deps);
		const result = await service.refresh();
		expect(h.scans).toEqual(["/home/Desktop"]);
		expect(result.families).toHaveLength(1);
		expect(result.scannedAt).toBe("2026-09-29T10:00:00.000Z");
		expect(h.writes).toBe(1);
		expect(h.changes).toBe(1);
	});

	it("reports dupey-missing and keeps the last snapshot", async () => {
		const h = harness({ dupey: dupeyMissing });
		const service = createVersionFamilyService(h.deps);
		const result = await service.refresh();
		expect(result.families).toEqual([]);
		expect(result.error?.code).toBe("dupey-missing");
		expect(result.error?.installCommand).toBe(DUPEY_INSTALL_COMMAND);
		expect(h.scans).toEqual([]);
		expect(h.writes).toBe(0);
	});

	it("fires onChanged when the dupey CLI turns missing", async () => {
		const h = harness({ dupey: dupeyMissing });
		const service = createVersionFamilyService(h.deps);
		await service.refresh();
		expect(h.changes).toBe(1);
		// The same missing error and empty families publish nothing further.
		await service.refresh();
		expect(h.changes).toBe(1);
	});

	it("reports the failed folders and keeps the stored snapshot when every root fails", async () => {
		const h = harness({
			store: {
				read: async () => ({
					version: 2 as const,
					scannedAt: "2026-09-28T00:00:00.000Z",
					locations: ["/home/Desktop"],
					families: [{ head: "/home/Desktop/old.txt", members: [{ path: "/home/Desktop/old2.txt", relation: "near" as const }], entries: [] }],
				}),
				write: async () => {
					throw new Error("write should not happen");
				},
			},
			scanDuplicates: async () => {
				throw new Error("dupey scan exploded");
			},
		});
		const service = createVersionFamilyService(h.deps);
		const result = await service.refresh();
		expect(result.error).toBeNull();
		expect(result.scanFailures).toEqual([
			{ name: "Desktop", path: "/home/Desktop", excludeDirs: [], reason: "error", message: "dupey scan exploded" },
		]);
		expect(result.families.map((f) => f.head)).toEqual(["/home/Desktop/old.txt"]);
		expect(result.scannedAt).toBe("2026-09-28T00:00:00.000Z");
	});
});

describe("version-family service — schedule", () => {
	it("arms the timer at the configured interval on start", async () => {
		const h = harness();
		const service = createVersionFamilyService(h.deps);
		await service.start();
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]?.ms).toBe(DEFAULT_SCAN_INTERVAL_MINUTES * 60_000);
		expect(h.scans).toEqual(["/home/Desktop"]);
	});

	it("re-arms with the new interval on reschedule", async () => {
		let minutes = 60;
		const cleared: unknown[] = [];
		const h = harness({
			intervalMinutes: () => minutes,
			clearTimer: (handle) => cleared.push(handle),
		});
		const service = createVersionFamilyService(h.deps);
		await service.start();
		minutes = 15;
		service.reschedule();
		expect(h.timers.map((t) => t.ms)).toEqual([3_600_000, 900_000]);
		expect(cleared).toEqual([1]);
	});

	it("scans again when the interval fires", async () => {
		const h = harness();
		const service = createVersionFamilyService(h.deps);
		await service.start();
		h.timers[0]?.fire();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.scans).toEqual(["/home/Desktop", "/home/Desktop"]);
	});

	it("stops the timer", async () => {
		const cleared: unknown[] = [];
		const h = harness({ clearTimer: (handle) => cleared.push(handle) });
		const service = createVersionFamilyService(h.deps);
		await service.start();
		service.stop();
		expect(cleared).toEqual([1]);
	});
});

describe("version-family service — location scope", () => {
	it("scans only the scanned locations — never Recents, the home folder, or a whole disk", async () => {
		const scanned: string[] = [];
		const h = harness({
			locations: async () => [
				{ name: RECENTS_PATH, path: RECENTS_PATH, section: "favorites", icon: "recents", available: true, scanned: false, ejectable: false },
				{ name: "me", path: "/home", section: "favorites", icon: "home", available: true, scanned: false, ejectable: false },
				{ name: "Desktop", path: "/home/Desktop", section: "favorites", icon: "desktop", available: true, scanned: true, ejectable: false },
				{ name: "SSD1", path: "/Volumes/SSD1", section: "locations", icon: "disk", available: true, scanned: false, ejectable: true },
			],
			scanDuplicates: async (dir) => {
				scanned.push(dir);
				return scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]);
			},
		});
		const service = createVersionFamilyService(h.deps);
		const result = await service.refresh();
		expect(scanned).toEqual(["/home/Desktop"]);
		expect(result.families).toHaveLength(1);
	});
});

describe("version-family service — a failed scan stays local", () => {
	const place = (name: string, path: string, section: FsLocation["section"] = "favorites"): FsLocation => ({
		name,
		path,
		section,
		icon: "documents",
		available: true,
		scanned: true,
		ejectable: false,
	});
	const timeout = (): Error => new Error("dupey timed out.");
	const stack = (head: string, member: string): FsVersionFamily => ({
		head,
		members: [{ path: member, relation: "exact" }],
		entries: [fsEntry(head), fsEntry(member)],
	});
	const stored = (families: FsVersionFamily[], extra: Partial<StoredVersionFamilies> = {}): StoredVersionFamilies => ({
		version: 2,
		scannedAt: "2026-09-28T00:00:00.000Z",
		locations: [],
		families,
		stamps: Object.fromEntries(
			families.flatMap((entry) => [entry.head, ...entry.members.map((member) => member.path)]).map((path) => [path, fixtureStamp(path)]),
		),
		...extra,
	});
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	it("writes the other locations' families when one location's scan fails", async () => {
		const h = harness({
			locations: async () => [place("Desktop", "/home/Desktop"), place("Documents", "/home/Documents")],
			scanDuplicates: async (dir) => {
				if (dir === "/home/Desktop") throw timeout();
				return scanOf([family("/home/Documents/a.txt", "/home/Documents/b.txt")]);
			},
		});
		const result = await createVersionFamilyService(h.deps).refresh();
		// The failure is the folder's, not the feature's: no feature-wide error is raised.
		expect(result.error).toBeNull();
		expect(result.scanFailures).toEqual([
			{ name: "Desktop", path: "/home/Desktop", excludeDirs: [], reason: "timeout", message: "dupey timed out." },
		]);
		expect(result.families.map((entry) => entry.head)).toEqual(["/home/Documents/a.txt"]);
		expect(h.persisted()?.families.map((entry) => entry.head)).toEqual(["/home/Documents/a.txt"]);
		expect(h.persisted()?.scannedAt).toBe("2026-09-29T10:00:00.000Z");
	});

	it("keeps what the last good scan found in a location whose scan fails, and replaces the rest", async () => {
		const h = harness(
			{
				locations: async () => [place("Desktop", "/home/Desktop"), place("Documents", "/home/Documents")],
				scanDuplicates: async (dir) => {
					if (dir === "/home/Desktop") throw timeout();
					return scanOf([family("/home/Documents/c.txt", "/home/Documents/d.txt")]);
				},
			},
			stored([
				stack("/home/Desktop/old.txt", "/home/Desktop/old2.txt"),
				stack("/home/Documents/gone.txt", "/home/Documents/gone2.txt"),
			]),
		);
		const result = await createVersionFamilyService(h.deps).refresh();
		expect(result.families.map((entry) => entry.head).sort()).toEqual([
			"/home/Desktop/old.txt",
			"/home/Documents/c.txt",
		]);
		expect(h.persisted()?.stamps?.["/home/Desktop/old.txt"]).toEqual(fixtureStamp("/home/Desktop/old.txt"));
		expect(result.scanFailures.map((failure) => failure.path)).toEqual(["/home/Desktop"]);
	});

	it("leaves the snapshot's families and its scannedAt alone when no location could be read", async () => {
		const h = harness(
			{ scanDuplicates: async () => { throw new Error("dupey failed with exit code 1"); } },
			stored([stack("/home/Desktop/old.txt", "/home/Desktop/old2.txt")]),
		);
		const result = await createVersionFamilyService(h.deps).refresh();
		expect(h.writes).toBe(0);
		expect(result.scannedAt).toBe("2026-09-28T00:00:00.000Z");
		expect(result.families.map((entry) => entry.head)).toEqual(["/home/Desktop/old.txt"]);
		expect(result.scanFailures).toHaveLength(1);
	});

	it("clears a failure on the next scan that reads the folder", async () => {
		let failing = true;
		const h = harness({
			scanDuplicates: async () => {
				if (failing) throw new Error("dupey failed with exit code 1");
				return scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]);
			},
		});
		const service = createVersionFamilyService(h.deps);
		expect((await service.refresh()).scanFailures[0]?.reason).toBe("error");
		failing = false;
		const recovered = await service.refresh();
		expect(recovered.scanFailures).toEqual([]);
		expect(recovered.families).toHaveLength(1);
	});

	describe("a cloud drive", () => {
		interface CloudRun {
			readonly calls: [string, readonly string[] | undefined][];
			readonly h: Harness;
			readonly service: ReturnType<typeof createVersionFamilyService>;
		}

		/**
		 * iCloud Drive: the whole-root scan times out (or fails as `wholeRoot` says), so does Desktop on its own;
		 * Documents reads fine. A whole-root scan that succeeds finds the stack that spans the two folders.
		 */
		function cloud(
			options: {
				desktopFails?: () => boolean;
				wholeRoot?: () => Error | null;
				seed?: StoredVersionFamilies | null;
				folders?: string[];
			} = {},
		): CloudRun {
			const calls: [string, readonly string[] | undefined][] = [];
			const desktopFails = options.desktopFails ?? (() => true);
			const wholeRoot = options.wholeRoot ?? (() => timeout());
			const h = harness(
				{
					locations: async () => [place("iCloud Drive", "/icloud", "cloud")],
					listFolders: async () => options.folders ?? ["Documents", "Desktop"],
					scanDuplicates: async (dir, scanOptions) => {
						calls.push([dir, scanOptions?.excludeDirs]);
						if (dir === "/icloud" && scanOptions === undefined) {
						const failure = wholeRoot();
						if (failure !== null) throw failure;
						return scanOf([family("/icloud/Documents/a.txt", "/icloud/Desktop/x.txt")]);
					}
						if (dir === "/icloud/Desktop" && desktopFails()) throw timeout();
						if (dir === "/icloud/Documents") return scanOf([family("/icloud/Documents/a.txt", "/icloud/Documents/b.txt")]);
						if (dir === "/icloud/Desktop") return scanOf([family("/icloud/Desktop/x.txt", "/icloud/Desktop/y.txt")]);
						return scanOf([]);
					},
				},
				options.seed ?? null,
			);
			return { calls, h, service: createVersionFamilyService(h.deps) };
		}

		it("scans folder by folder when the whole root fails, so one slow folder does not cost the rest", async () => {
			const run = cloud();
			const result = await run.service.refresh();
			expect(run.calls).toEqual([
				["/icloud", undefined],
				["/icloud", ["Documents", "Desktop"]],
				["/icloud/Documents", undefined],
				["/icloud/Desktop", undefined],
			]);
			expect(result.families.map((entry) => entry.head)).toEqual(["/icloud/Documents/a.txt"]);
			expect(result.scanFailures).toEqual([
				{ name: "Desktop", path: "/icloud/Desktop", excludeDirs: [], reason: "timeout", message: "dupey timed out." },
			]);
			expect(result.error).toBeNull();
			expect(run.h.persisted()?.splitLocations).toEqual(["/icloud"]);
		});

		it("does not scan the whole root again, nor re-run a folder that timed out, until it is asked to", async () => {
			let desktopFails = true;
			const run = cloud({ desktopFails: () => desktopFails });
			await run.service.start();
			run.calls.length = 0;

			run.h.timers[0]?.fire();
			await settle();
			expect(run.calls).toEqual([
				["/icloud", ["Documents", "Desktop"]],
				["/icloud/Documents", undefined],
			]);
			expect((await run.service.result()).scanFailures.map((failure) => failure.path)).toEqual(["/icloud/Desktop"]);

			// "Check again": the whole root is tried once more (and times out again), then Desktop is read once more, and now succeeds.
			desktopFails = false;
			run.calls.length = 0;
			const retried = await run.service.refresh();
			expect(run.calls.map(([dir, excluded]) => [dir, excluded?.length])).toEqual([
				["/icloud", undefined],
				["/icloud", 2],
				["/icloud/Documents", undefined],
				["/icloud/Desktop", undefined],
			]);
			expect(retried.scanFailures).toEqual([]);
			expect(retried.families.map((entry) => entry.head).sort()).toEqual([
				"/icloud/Desktop/x.txt",
				"/icloud/Documents/a.txt",
			]);
		});

		it("starts from the folder scans after a restart instead of asking the drive for the whole root again", async () => {
			const run = cloud({ seed: stored([], { locations: ["/icloud"], splitLocations: ["/icloud"] }) });
			await run.service.start();
			expect(run.calls.map(([dir]) => dir)).toEqual(["/icloud", "/icloud/Documents", "/icloud/Desktop"]);
			expect(run.calls[0]?.[1]).toEqual(["Documents", "Desktop"]);
		});

		it("does not split a drive whose whole-root scan failed for any reason but the time limit", async () => {
			let failing = true;
			const run = cloud({ wholeRoot: () => (failing ? new Error("dupey failed with exit code 1: Operation not permitted") : null) });

			const failed = await run.service.refresh();

			expect(run.calls).toEqual([["/icloud", undefined]]);
			expect(failed.scanFailures).toEqual([
				{
					name: "iCloud Drive",
					path: "/icloud",
					excludeDirs: [],
					reason: "error",
					message: "dupey failed with exit code 1: Operation not permitted",
				},
			]);
			expect(run.h.persisted()?.splitLocations).toBeUndefined();

			// The next scan reads the whole drive again, finds it readable, and never splits it.
			failing = false;
			run.calls.length = 0;
			const recovered = await run.service.refresh();
			expect(run.calls).toEqual([["/icloud", undefined]]);
			expect(recovered.scanFailures).toEqual([]);
			expect(recovered.families.map((entry) => entry.head)).toEqual(["/icloud/Documents/a.txt"]);
			expect(run.h.persisted()?.splitLocations).toBeUndefined();
		});

		it("reads a split drive whole again when asked to check again, and is whole from then on", async () => {
			// Given a drive that was split by a time-out, with one folder that timed out on its own
			let wholeTimesOut = true;
			const run = cloud({ wholeRoot: () => (wholeTimesOut ? timeout() : null) });
			await run.service.start();
			expect(run.h.persisted()?.splitLocations).toEqual(["/icloud"]);
			expect(run.h.persisted()?.timedOutScopes?.map((scope) => scope.path)).toEqual(["/icloud/Desktop"]);

			// When the person checks again and the whole drive now reads in time
			wholeTimesOut = false;
			run.calls.length = 0;
			const result = await run.service.refresh();

			// Then it is one scan, the stack across two folders is back, and nothing is remembered as split or timed out
			expect(run.calls).toEqual([["/icloud", undefined]]);
			expect(result.families.map((entry) => entry.head)).toEqual(["/icloud/Documents/a.txt"]);
			expect(result.scanFailures).toEqual([]);
			expect(run.h.persisted()?.splitLocations).toBeUndefined();
			expect(run.h.persisted()?.timedOutScopes).toBeUndefined();

			// And the scheduled scans read the whole drive too
			run.calls.length = 0;
			run.h.timers[0]?.fire();
			await settle();
			expect(run.calls).toEqual([["/icloud", undefined]]);
		});

		it("keeps a split drive split, and does not remember the whole-root time-out, when reading it whole fails again", async () => {
			const run = cloud({ seed: stored([], { locations: ["/icloud"], splitLocations: ["/icloud"] }) });

			await run.service.refresh();

			expect(run.h.persisted()?.splitLocations).toEqual(["/icloud"]);
			expect(run.h.persisted()?.timedOutScopes?.map((scope) => scope.path)).toEqual(["/icloud/Desktop"]);
		});

		it("goes on with the folder scans when the whole drive fails to read for another reason on check again", async () => {
			const run = cloud({
				seed: stored([], { locations: ["/icloud"], splitLocations: ["/icloud"] }),
				wholeRoot: () => new Error("dupey failed with exit code 1"),
			});

			const result = await run.service.refresh();

			expect(run.calls.map(([dir]) => dir)).toEqual(["/icloud", "/icloud", "/icloud/Documents", "/icloud/Desktop"]);
			expect(result.scanFailures.map((failure) => failure.path)).toEqual(["/icloud/Desktop"]);
			expect(run.h.persisted()?.splitLocations).toEqual(["/icloud"]);
		});

		it("remembers a whole-drive time-out when there are no folders to split into, and leaves the drive alone on the schedule", async () => {
			const run = cloud({ folders: [] });
			await run.service.start();
			expect(run.h.persisted()?.timedOutScopes?.map((scope) => scope.path)).toEqual(["/icloud"]);
			expect(run.h.persisted()?.splitLocations).toBeUndefined();
			run.calls.length = 0;

			run.h.timers[0]?.fire();
			await settle();

			expect(run.calls).toEqual([]);
			expect((await run.service.result()).scanFailures.map((failure) => failure.reason)).toEqual(["timeout"]);
		});

		it("forgets a folder's time-out once the folder is gone from the drive", async () => {
			const gone = { name: "Gone", path: "/icloud/Gone", excludeDirs: [], message: "dupey timed out.", at: "2026-09-28T00:00:00.000Z" };
			const run = cloud({
				seed: stored([], { locations: ["/icloud"], splitLocations: ["/icloud"], timedOutScopes: [gone] }),
				desktopFails: () => false,
			});

			await run.service.start();

			expect(run.h.persisted()?.timedOutScopes).toBeUndefined();
		});

		it("recognizes the root files' time-out whatever order the folders are listed in", async () => {
			let order = ["Documents", "Desktop"];
			const calls: string[] = [];
			const h = harness({
				locations: async () => [place("iCloud Drive", "/icloud", "cloud")],
				listFolders: async () => order,
				scanDuplicates: async (dir, scanOptions) => {
					calls.push(scanOptions?.excludeDirs === undefined ? dir : `${dir}+root`);
					if (dir === "/icloud") throw timeout();
					return scanOf([]);
				},
			});
			const service = createVersionFamilyService(h.deps);
			await service.start();
			calls.length = 0;
			order = ["Desktop", "Documents"];

			h.timers[0]?.fire();
			await settle();

			// The root files' scan timed out before; listing the folders in another order does not make it a new scan.
			expect(calls).toEqual(["/icloud/Desktop", "/icloud/Documents"]);
		});

		it("splits along the real top-level folders of the drive, never the files", async () => {
			const root = await mkdtemp(join(tmpdir(), "vf-cloud-"));
			for (const name of ["Docs", "Desk"]) await mkdir(join(root, name));
			await writeFile(join(root, "loose.txt"), "x", "utf8");
			const calls: [string, readonly string[] | undefined][] = [];
			const h = harness({
				locations: async () => [place("Drive", root, "cloud")],
				scanDuplicates: async (dir, scanOptions) => {
					calls.push([dir, scanOptions?.excludeDirs]);
					if (scanOptions === undefined) throw timeout();
					return scanOf([]);
				},
			});
			await createVersionFamilyService(h.deps).refresh();
			expect(calls.slice(0, 2).map(([dir]) => dir)).toEqual([root, root]);
			expect([...(calls[1]?.[1] ?? [])].sort()).toEqual(["Desk", "Docs"]);
			expect(calls.slice(2).map(([dir]) => dir).sort()).toEqual([join(root, "Desk"), join(root, "Docs")]);
		});

		it("reports the whole-root failure when the drive has no folders to split into", async () => {
			const run = cloud({ folders: [] });
			const result = await run.service.refresh();
			expect(run.calls).toEqual([["/icloud", undefined]]);
			expect(result.scanFailures).toEqual([
				{ name: "iCloud Drive", path: "/icloud", excludeDirs: [], reason: "timeout", message: "dupey timed out." },
			]);
		});

		it("keeps the folder's last good families while its scan times out", async () => {
			const run = cloud({
				seed: stored([stack("/icloud/Desktop/old.txt", "/icloud/Desktop/old2.txt")], { locations: ["/icloud"] }),
			});
			const result = await run.service.refresh();
			expect(result.families.map((entry) => entry.head).sort()).toEqual([
				"/icloud/Desktop/old.txt",
				"/icloud/Documents/a.txt",
			]);
		});
	});

	it("does not split a location that is not a cloud drive", async () => {
		const listed: string[] = [];
		const h = harness({
			listFolders: async (dir) => {
				listed.push(dir);
				return ["a"];
			},
			scanDuplicates: async () => {
				throw timeout();
			},
		});
		const result = await createVersionFamilyService(h.deps).refresh();
		expect(listed).toEqual([]);
		expect(result.scanFailures).toHaveLength(1);
	});

	it("leaves a timed-out location alone on the schedule, and tries it again when asked", async () => {
		const h = harness({
			scanDuplicates: async (dir) => {
				h.scans.push(dir);
				throw timeout();
			},
		});
		const service = createVersionFamilyService(h.deps);
		await service.start();
		h.timers[0]?.fire();
		await settle();
		expect(h.scans).toEqual(["/home/Desktop"]);
		expect((await service.result()).scanFailures).toHaveLength(1);
		await service.refresh();
		expect(h.scans).toEqual(["/home/Desktop", "/home/Desktop"]);
	});

	describe("a folder that timed out is remembered across a restart", () => {
		const desktopTimedOut = (): Partial<VersionFamilyServiceDeps> => ({
			locations: async () => [place("Desktop", "/home/Desktop"), place("Documents", "/home/Documents")],
			scanDuplicates: async (dir) => {
				if (dir === "/home/Desktop") throw timeout();
				return scanOf([family("/home/Documents/a.txt", "/home/Documents/b.txt")]);
			},
		});
		const desktopRecord = {
			name: "Desktop",
			path: "/home/Desktop",
			excludeDirs: [],
			message: "dupey timed out.",
			at: "2026-09-29T10:00:00.000Z",
		};

		it("writes the folder, its message and the time it timed out into the snapshot", async () => {
			const h = harness(desktopTimedOut());

			await createVersionFamilyService(h.deps).refresh();

			expect(h.persisted()?.timedOutScopes).toEqual([desktopRecord]);
		});

		it("does not scan the folder again after a restart, but still reports it", async () => {
			const first = harness(desktopTimedOut());
			await createVersionFamilyService(first.deps).refresh();
			const scanned: string[] = [];

			// A new process: a new service reading the snapshot the first one wrote.
			const restarted = harness(
				{
					...desktopTimedOut(),
					scanDuplicates: async (dir) => {
						scanned.push(dir);
						return scanOf([]);
					},
				},
				first.persisted(),
			);
			const result = await createVersionFamilyService(restarted.deps).start();

			expect(scanned).toEqual(["/home/Documents"]);
			expect(result.scanFailures).toEqual([
				{ name: "Desktop", path: "/home/Desktop", excludeDirs: [], reason: "timeout", message: "dupey timed out." },
			]);
		});

		it("scans the folder after a restart once the person asks, and forgets it when it reads", async () => {
			const first = harness(desktopTimedOut());
			await createVersionFamilyService(first.deps).refresh();
			const scanned: string[] = [];
			const restarted = harness(
				{
					...desktopTimedOut(),
					scanDuplicates: async (dir) => {
						scanned.push(dir);
						return scanOf([family(`${dir}/x.txt`, `${dir}/y.txt`)]);
					},
				},
				first.persisted(),
			);

			const result = await createVersionFamilyService(restarted.deps).refresh();

			expect(scanned).toEqual(["/home/Desktop", "/home/Documents"]);
			expect(result.scanFailures).toEqual([]);
			expect(restarted.persisted()?.timedOutScopes).toBeUndefined();
		});

		it("writes the memory when no location could be read, with the snapshot's families and scannedAt as they were", async () => {
			const h = harness(
				{ scanDuplicates: async () => { throw timeout(); } },
				stored([stack("/home/Desktop/old.txt", "/home/Desktop/old2.txt")]),
			);

			await createVersionFamilyService(h.deps).refresh();

			expect(h.writes).toBe(1);
			expect(h.persisted()?.scannedAt).toBe("2026-09-28T00:00:00.000Z");
			expect(h.persisted()?.families.map((entry) => entry.head)).toEqual(["/home/Desktop/old.txt"]);
			expect(h.persisted()?.timedOutScopes).toEqual([desktopRecord]);
		});

		it("keeps the memory of a first scan that read nothing, as a snapshot that was never scanned", async () => {
			const h = harness({ scanDuplicates: async () => { throw timeout(); } });
			await createVersionFamilyService(h.deps).refresh();
			expect(h.persisted()).toMatchObject({ version: 2, scannedAt: null, families: [], timedOutScopes: [desktopRecord] });
			const scanned: string[] = [];

			const restarted = harness(
				{ scanDuplicates: async (dir) => { scanned.push(dir); return scanOf([]); } },
				h.persisted(),
			);
			const result = await createVersionFamilyService(restarted.deps).start();

			expect(scanned).toEqual([]);
			expect(result.scannedAt).toBeNull();
			expect(result.scanFailures.map((failure) => failure.reason)).toEqual(["timeout"]);
		});

		it("does not rewrite the snapshot when a scheduled scan learned nothing new", async () => {
			const h = harness({ scanDuplicates: async () => { throw timeout(); } });
			const service = createVersionFamilyService(h.deps);
			await service.start();
			expect(h.writes).toBe(1);

			h.timers[0]?.fire();
			await settle();

			expect(h.writes).toBe(1);
		});

		it("does not remember a scan that failed for another reason", async () => {
			const h = harness({
				...desktopTimedOut(),
				scanDuplicates: async (dir) => {
					if (dir === "/home/Desktop") throw new Error("dupey failed with exit code 1");
					return scanOf([]);
				},
			});

			await createVersionFamilyService(h.deps).refresh();

			expect(h.persisted()?.timedOutScopes).toBeUndefined();
		});

		it("forgets a folder that is no longer under a scanned location", async () => {
			const h = harness(
				{ ...desktopTimedOut(), locations: async () => [place("Documents", "/home/Documents")] },
				stored([], { timedOutScopes: [desktopRecord] }),
			);

			await createVersionFamilyService(h.deps).refresh();

			expect(h.persisted()?.timedOutScopes).toBeUndefined();
		});
	});

	it("runs one scan at a time", async () => {
		const h = harness();
		const service = createVersionFamilyService(h.deps);
		await Promise.all([service.refresh(), service.refresh()]);
		expect(h.scans).toEqual(["/home/Desktop"]);
	});
});

describe("isDupeyTimeout", () => {
	it("recognizes the librarian's time-limit message and nothing else", () => {
		expect(isDupeyTimeout("dupey timed out.")).toBe(true);
		expect(isDupeyTimeout("dupey failed with exit code 1: boom")).toBe(false);
	});
});

describe("version-family service — trash prune", () => {
	function entryAt(path: string, mtimeMs: number): FsEntry {
		return { ...fsEntry(path), mtimeMs };
	}

	function threeFileFamily(): FsVersionFamily {
		return {
			head: "/home/Desktop/a.txt",
			members: [
				{ path: "/home/Desktop/b.txt", relation: "exact" },
				{ path: "/home/Desktop/c.txt", relation: "near" },
			],
			entries: [
				entryAt("/home/Desktop/a.txt", Date.parse("2026-09-29T03:00:00.000Z")),
				entryAt("/home/Desktop/b.txt", Date.parse("2026-09-29T01:00:00.000Z")),
				entryAt("/home/Desktop/c.txt", Date.parse("2026-09-29T02:00:00.000Z")),
			],
		};
	}

	function seeded(families: readonly FsVersionFamily[]): StoredVersionFamilies {
		return { version: 2, scannedAt: "2026-09-29T09:00:00.000Z", locations: ["/home/Desktop"], families };
	}

	it("drops a trashed duplicate from the snapshot without scanning", async () => {
		const h = harness({}, seeded([threeFileFamily()]));
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/b.txt"]);
		expect(h.scans).toEqual([]);
		expect(h.writes).toBe(1);
		expect(h.changes).toBe(1);
		expect(result.families[0]?.head).toBe("/home/Desktop/a.txt");
		expect(result.families[0]?.members.map((member) => member.path)).toEqual(["/home/Desktop/c.txt"]);
		expect(result.families[0]?.entries.map((entry) => entry.path)).toEqual([
			"/home/Desktop/a.txt",
			"/home/Desktop/c.txt",
		]);
		// Persisted as well, so a restart cannot resurrect the deleted file.
		expect(h.persisted()?.families).toEqual(result.families);
		expect(h.persisted()?.scannedAt).toBe("2026-09-29T09:00:00.000Z");
	});

	it("re-heads to the newest remaining member when the head is trashed", async () => {
		const h = harness({}, seeded([threeFileFamily()]));
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/a.txt"]);
		expect(result.families[0]?.head).toBe("/home/Desktop/c.txt");
		expect(result.families[0]?.members.map((member) => member.path)).toEqual(["/home/Desktop/b.txt"]);
	});

	it("drops the family once every member is gone", async () => {
		const h = harness({}, seeded([threeFileFamily()]));
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/b.txt", "/home/Desktop/c.txt"]);
		expect(result.families).toEqual([]);
		expect(h.persisted()?.families).toEqual([]);
	});

	it("ignores a path no family claims", async () => {
		const h = harness({}, seeded([threeFileFamily()]));
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/unrelated.txt"]);
		expect(h.writes).toBe(0);
		expect(h.changes).toBe(0);
		expect(result.families).toHaveLength(1);
	});

	it("serves the empty snapshot without writing when nothing was ever scanned", async () => {
		const h = harness();
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/a.txt"]);
		expect(h.writes).toBe(0);
		expect(result.families).toEqual([]);
	});

	it("prunes even when the dupey CLI is missing", async () => {
		const h = harness({ dupey: dupeyMissing }, seeded([threeFileFamily()]));
		const service = createVersionFamilyService(h.deps);
		const result = await service.removePaths(["/home/Desktop/b.txt"]);
		expect(result.families[0]?.members.map((member) => member.path)).toEqual(["/home/Desktop/c.txt"]);
		expect(h.scans).toEqual([]);
	});

	it("keeps a delete that lands while the scan is writing the snapshot", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let writeStarted!: () => void;
		const writing = new Promise<void>((resolve) => {
			writeStarted = resolve;
		});
		let stored: StoredVersionFamilies | null = seeded([threeFileFamily()]);
		let writes = 0;
		const h = harness({
			store: {
				read: async () => stored,
				write: async (value) => {
					writes += 1;
					if (writes === 1) {
						writeStarted();
						await gate;
					}
					stored = value;
				},
			},
			scanDuplicates: async () => scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]),
		});
		const service = createVersionFamilyService(h.deps);
		const refreshed = service.refresh();
		await writing;
		const removed = service.removePaths(["/home/Desktop/b.txt"]);
		release();
		await refreshed;
		await removed;
		expect(writes).toBe(2);
		expect(stored?.families).toEqual([]);
	});

	it("does not resurrect a path trashed while a scan was reading the disk", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scanned = 0;
		const h = harness(
			{
				scanDuplicates: async () => {
					scanned += 1;
					await gate;
					// The scan's view of the disk predates the deletion.
					return scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]);
				},
			},
			seeded([threeFileFamily()]),
		);
		const service = createVersionFamilyService(h.deps);
		const refreshed = service.refresh();
		await service.removePaths(["/home/Desktop/b.txt"]);
		release();
		await refreshed;
		expect(scanned).toBe(1);
		// The scan reported the deleted file; the trash still wins.
		expect(h.persisted()?.families).toEqual([]);
	});

	it("detaches a changed head without running another dupey scan", async () => {
		let changed = false;
		const h = harness(
			{
				probe: async (path) =>
					changed && path === "/home/Desktop/a.txt"
						? fixtureStamp(path, { size: "5" })
						: fixtureStamp(path),
			},
			{
				...seeded([threeFileFamily()]),
				stamps: {
					"/home/Desktop/a.txt": fixtureStamp("/home/Desktop/a.txt"),
					"/home/Desktop/b.txt": fixtureStamp("/home/Desktop/b.txt"),
					"/home/Desktop/c.txt": fixtureStamp("/home/Desktop/c.txt"),
				},
			},
		);
		const service = createVersionFamilyService(h.deps);
		await service.result();
		changed = true;

		const applied = await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [{ path: "/home/Desktop/a.txt", type: "update" }],
			overflow: false,
			dirGone: false,
		}]);

		expect(applied).toBe(true);
		expect(h.scans).toEqual([]);
		expect((await service.result()).families).toEqual([]);
		// A real content change detaches the published family but leaves the stored
		// stamp intact, so the next scan re-verifies it instead of hiding it.
		expect(h.persisted()?.families).toHaveLength(1);
		expect(h.persisted()?.stamps?.["/home/Desktop/a.txt"]).toEqual(
			fixtureStamp("/home/Desktop/a.txt"),
		);
	});

	it("remaps a rename before expiry and prunes an unmatched rename at 2000 ms", async () => {
		let clock = 0;
		const oldPath = "/home/Desktop/b.txt";
		const newPath = "/home/Desktop/renamed.txt";
		const oldStamp = fixtureStamp(oldPath);
		const h = harness(
			{
				now: () => new Date(clock),
				probe: async (path) => (path === newPath ? oldStamp : fixtureStamp(path)),
			},
			{
				...seeded([threeFileFamily()]),
				stamps: {
					"/home/Desktop/a.txt": fixtureStamp("/home/Desktop/a.txt"),
					[oldPath]: oldStamp,
					"/home/Desktop/c.txt": fixtureStamp("/home/Desktop/c.txt"),
				},
			},
		);
		const service = createVersionFamilyService(h.deps);
		await service.result();
		await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [{ path: oldPath, type: "delete" }],
			overflow: false,
			dirGone: false,
		}]);
		clock = 1999;
		await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [{ path: newPath, type: "create" }],
			overflow: false,
			dirGone: false,
		}]);
		expect((await service.result()).families[0]?.members.map((member) => member.path)).toContain(newPath);

		clock = 2000;
		await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [{ path: newPath, type: "delete" }],
			overflow: false,
			dirGone: false,
		}]);
		const expiry = h.timers.find((timer) => timer.ms === 2000);
		expect(expiry).toBeDefined();
		expiry?.fire();
		await Promise.resolve();
		await Promise.resolve();
		expect((await service.result()).families[0]?.members.map((member) => member.path)).not.toContain(newPath);
	});

	it("fences a path updated while a scan is in flight", async () => {
		let releaseScan!: () => void;
		const scanStarted = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		let continueScan!: () => void;
		const scanGate = new Promise<void>((resolve) => {
			continueScan = resolve;
		});
		const h = harness(
			{
				scanDuplicates: async () => {
					releaseScan();
					await scanGate;
					return scanOf([family("/home/Desktop/a.txt", "/home/Desktop/b.txt")]);
				},
			},
			{
				...seeded([threeFileFamily()]),
				stamps: {
					"/home/Desktop/a.txt": fixtureStamp("/home/Desktop/a.txt"),
					"/home/Desktop/b.txt": fixtureStamp("/home/Desktop/b.txt"),
					"/home/Desktop/c.txt": fixtureStamp("/home/Desktop/c.txt"),
				},
			},
		);
		const service = createVersionFamilyService(h.deps);
		const refresh = service.refresh();
		await scanStarted;
		await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [{ path: "/home/Desktop/b.txt", type: "update" }],
			overflow: false,
			dirGone: false,
		}]);
		continueScan();
		await refresh;

		expect(h.persisted()?.stamps?.["/home/Desktop/b.txt"]).toEqual(DIRTY_STAMP);
		expect((await service.result()).families).toEqual([]);
	});

	it("reverifies all families for an overflow without scanning", async () => {
		let missing = false;
		const h = harness(
			{
				probe: async (path) => (missing && path === "/home/Desktop/b.txt" ? null : fixtureStamp(path)),
			},
			{
				...seeded([threeFileFamily()]),
				stamps: {
					"/home/Desktop/a.txt": fixtureStamp("/home/Desktop/a.txt"),
					"/home/Desktop/b.txt": fixtureStamp("/home/Desktop/b.txt"),
					"/home/Desktop/c.txt": fixtureStamp("/home/Desktop/c.txt"),
				},
			},
		);
		const service = createVersionFamilyService(h.deps);
		await service.result();
		missing = true;
		const applied = await service.applyDirChanges([{
			dir: "/home/Desktop",
			changes: [],
			overflow: true,
			dirGone: false,
		}]);

		expect(applied).toBe(true);
		expect(h.scans).toEqual([]);
		expect((await service.result()).families[0]?.members.map((member) => member.path)).toEqual([
			"/home/Desktop/c.txt",
		]);
	});
});

describe("pruneVersionFamilies", () => {
	it("breaks a mtime tie by path when re-heading", () => {
		const families: FsVersionFamily[] = [
			{
				head: "/x/z.txt",
				members: [
					{ path: "/x/b.txt", relation: "exact" },
					{ path: "/x/a.txt", relation: "exact" },
				],
				entries: [
					{ ...fsEntry("/x/z.txt") },
					{ ...fsEntry("/x/b.txt"), mtimeMs: Date.parse("2026-09-29T00:00:00.000Z") },
					{ ...fsEntry("/x/a.txt"), mtimeMs: Date.parse("2026-09-29T00:00:00.000Z") },
				],
			},
		];
		const pruned = pruneVersionFamilies(families, new Set(["/x/z.txt"]));
		expect(pruned[0]?.head).toBe("/x/a.txt");
	});

	it("returns the same array when nothing was removed", () => {
		const families: FsVersionFamily[] = [];
		expect(pruneVersionFamilies(families, new Set())).toBe(families);
	});
});

describe("file version-family store", () => {
	it("round-trips a snapshot through the userData directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
		const store = createFileVersionFamilyStore(dir);
		expect(await store.read()).toBeNull();
		const snapshot = {
			version: 2 as const,
			scannedAt: "2026-09-29T10:00:00.000Z",
			locations: ["/home/Desktop"],
			families: [
				{
					head: "/home/Desktop/a.txt",
					members: [{ path: "/home/Desktop/b.txt", relation: "exact" as const }],
					entries: [fsEntry("/home/Desktop/a.txt")],
				},
			],
		};
		await store.write(snapshot);
		expect(await store.read()).toEqual(snapshot);
		expect(JSON.parse(await readFile(join(dir, "version-families.json"), "utf8"))).toEqual(snapshot);
	});

	it("returns null for a corrupt snapshot", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
		await writeFile(join(dir, "version-families.json"), "{ not json", "utf8");
		expect(await createFileVersionFamilyStore(dir).read()).toBeNull();
	});

	describe("the timed-out folders a snapshot remembers", () => {
		const timedOutScope = {
			name: "Desktop",
			path: "/icloud/Desktop",
			excludeDirs: ["Archive"],
			message: "dupey timed out.",
			at: "2026-09-29T10:00:00.000Z",
		};
		const base = {
			version: 2 as const,
			scannedAt: "2026-09-29T10:00:00.000Z",
			locations: ["/icloud"],
			families: [],
		};

		it("round-trips them, and a snapshot that was never scanned", async () => {
			const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
			const store = createFileVersionFamilyStore(dir);
			const snapshot = { ...base, scannedAt: null, splitLocations: ["/icloud"], timedOutScopes: [timedOutScope] };

			await store.write(snapshot);

			expect(await store.read()).toEqual(snapshot);
		});

		it("still reads a snapshot written before they existed, at the same format version", async () => {
			const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
			await writeFile(join(dir, "version-families.json"), JSON.stringify({ ...base, splitLocations: ["/icloud"] }), "utf8");

			const read = await createFileVersionFamilyStore(dir).read();

			expect(read).toEqual({ ...base, splitLocations: ["/icloud"] });
			expect(read?.timedOutScopes).toBeUndefined();
			expect(VERSION_FAMILY_STORE_VERSION).toBe(2);
		});

		it("drops an entry that is not a well-formed folder and keeps the rest of the snapshot", async () => {
			const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
			const broken = [{ name: "x" }, "Desktop", null, { ...timedOutScope, excludeDirs: [1] }, { ...timedOutScope, at: 5 }];
			await writeFile(
				join(dir, "version-families.json"),
				JSON.stringify({ ...base, timedOutScopes: [...broken, timedOutScope] }),
				"utf8",
			);

			const read = await createFileVersionFamilyStore(dir).read();

			expect(read?.timedOutScopes).toEqual([timedOutScope]);
			expect(read?.locations).toEqual(["/icloud"]);
		});

		it("treats a field that is not a list as no memory at all", async () => {
			const dir = await mkdtemp(join(tmpdir(), "vf-store-"));
			await writeFile(join(dir, "version-families.json"), JSON.stringify({ ...base, timedOutScopes: "Desktop" }), "utf8");

			expect(await createFileVersionFamilyStore(dir).read()).toEqual(base);
		});
	});
});
