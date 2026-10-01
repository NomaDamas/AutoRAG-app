import { describe, expect, it, vi } from "vitest";
import type { DupeyScanResult } from "@autorag/librarian";
import { createDupeyLayer } from "../src/main/dupey-layer";
import { createVersionFamilyService, type VersionFamilyService, type VersionFamilyServiceDeps } from "../src/main/version-family-service";
import type { FsDirChange, FsChangeType } from "../src/shared/live-contract";
import type { FsEntry, FsVersionFamiliesResult, FsLocation } from "../src/shared/fs-contract";
import type { FileStamp } from "../src/main/version-family-verify";
import type { StoredVersionFamilies } from "../src/main/version-family-store";

const ROOT = "/fixture";
const HEAD = `${ROOT}/head.txt`;
const MEMBER = `${ROOT}/member.txt`;
const RENAMED = `${ROOT}/renamed.txt`;

function stamp(ino: string, size = "4"): FileStamp {
	return { dev: "dev", ino, size, mtimeNs: "mtime", ctimeNs: "ctime" };
}

function entry(path: string): FsEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "txt",
		size: 4,
		modifiedAt: "2026-09-29T00:00:00.000Z",
		isSymlink: false,
		osKind: null,
		iconDataUrl: null,
	};
}

function rawFamily(): DupeyScanResult["families"][number] {
	return {
		id: 0,
		relation: "mixed",
		files: [HEAD, MEMBER],
		members: [
			{ path: HEAD, exact_hash: "same" },
			{ path: MEMBER, exact_hash: "same", relation: "exact" },
		],
		edges: [],
		pick: { ranked: [{ path: HEAD }] },
	};
}

function dirChanges(...changes: readonly [string, FsChangeType][]): readonly FsDirChange[] {
	return [{ dir: ROOT, changes: changes.map(([path, type]) => ({ path, type })), overflow: false, dirGone: false }];
}

interface Fixture {
	readonly service: ReturnType<typeof createVersionFamilyService>;
	readonly probeState: Map<string, FileStamp | null>;
	readonly probeCalls: string[];
	readonly stored: () => StoredVersionFamilies | null;
	readonly writes: () => number;
	readonly changed: () => number;
	readonly fireTimers: (ms: number) => void;
	readonly timers: readonly { ms: number; handler: () => void }[];
}

function fixture(options: {
	readonly seed?: StoredVersionFamilies | null;
	readonly scan?: () => Promise<DupeyScanResult>;
	readonly onChanged?: () => void;
} = {}): Fixture {
	const probeState = new Map<string, FileStamp | null>([
		[HEAD, stamp("head")],
		[MEMBER, stamp("member")],
	]);
	const probeCalls: string[] = [];
	let stored = options.seed ?? null;
	let writes = 0;
	let changed = 0;
	const timers: { ms: number; handler: () => void }[] = [];
	const locations: readonly FsLocation[] = [{ name: "Fixture", path: ROOT, section: "favorites", available: true }];
	const deps: VersionFamilyServiceDeps = {
		locations: async () => locations,
		store: {
			read: async () => stored,
			write: async (value) => {
				stored = value;
				writes += 1;
			},
		},
		buildEntry: async (path) => entry(path),
		scanDuplicates: options.scan ?? (async () => ({
			dir: ROOT,
			files: [{ path: HEAD }, { path: MEMBER }],
			families: [rawFamily()],
			errors: [],
		})),
		dupey: { status: async () => ({ available: true, version: "fixture", error: null }) },
		intervalMinutes: () => 60,
		probe: async (path) => {
			probeCalls.push(path);
			return probeState.get(path) ?? null;
		},
		onChanged: () => {
			changed += 1;
			options.onChanged?.();
		},
		setTimer: (handler, ms) => {
			const timer = { ms, handler };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			const index = timers.indexOf(handle as (typeof timers)[number]);
			if (index >= 0) timers.splice(index, 1);
		},
		now: () => new Date("2026-09-30T00:00:00.000Z"),
	};
	const service = createVersionFamilyService(deps);
	return {
		service,
		probeState,
		probeCalls,
		stored: () => stored,
		writes: () => writes,
		changed: () => changed,
		timers,
		fireTimers: (ms) => {
			for (const timer of [...timers].filter((candidate) => candidate.ms === ms)) timer.handler();
		},
	};
}

async function scannedFixture(): Promise<Fixture> {
	const fixtureState = fixture();
	await fixtureState.service.refresh();
	return fixtureState;
}

async function flushQueue(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("dupey derived layer", () => {
	it("delegates snapshot, changes, and resync to the service", async () => {
		const service = {
			result: vi.fn(async (): Promise<FsVersionFamiliesResult> => ({ families: [], scannedAt: null, error: null })),
			applyDirChanges: vi.fn(async () => true),
			reverify: vi.fn(async () => true),
			refresh: vi.fn(async () => ({ families: [], scannedAt: null, error: null })),
			start: vi.fn(async () => ({ families: [], scannedAt: null, error: null })),
			stop: vi.fn(),
			reschedule: vi.fn(),
			removePaths: vi.fn(async () => ({ families: [], scannedAt: null, error: null })),
		};
		const layer = createDupeyLayer(service satisfies VersionFamilyService);
		expect(layer.id).toBe("dupey");
		expect(await layer.snapshot()).toEqual({ families: [], scannedAt: null, error: null });
		expect(await layer.applyChanges(dirChanges([MEMBER, "update"]))).toBe(true);
		expect(await layer.resync?.()).toBe(true);
		expect(service.result).toHaveBeenCalledOnce();
		expect(service.applyDirChanges).toHaveBeenCalledOnce();
		expect(service.reverify).toHaveBeenCalledOnce();
	});
});

describe("dupey live reconciliation", () => {
	it("publishes scan errors after a successful refresh while keeping verified families", async () => {
		let scanCount = 0;
		const h = fixture({
			scan: async () => {
				scanCount += 1;
				if (scanCount === 1) {
					return {
						dir: ROOT,
						files: [{ path: HEAD }, { path: MEMBER }],
						families: [rawFamily()],
						errors: [],
					};
				}
				throw new Error("second scan failed");
			},
		});

		const first = await h.service.refresh();
		expect(first.error).toBeNull();
		expect(first.families).toHaveLength(1);
		const persisted = h.stored();
		const second = await h.service.refresh();
		const expectedError = {
			code: "scan-failed" as const,
			message: "dupey scan failed for /fixture: second scan failed",
			installCommand: null,
		};
		expect(second.error).toEqual(expectedError);
		expect(second.families).toEqual(first.families);
		expect(second.scannedAt).toBe(first.scannedAt);
		expect(await h.service.result()).toEqual(second);
		expect(h.stored()).toBe(persisted);
		expect(h.writes()).toBe(1);
		expect(h.changed()).toBe(2);

		const repeated = await h.service.refresh();
		expect(repeated).toEqual(second);
		expect(await h.service.result()).toEqual(repeated);
		expect(h.changed()).toBe(2);
	});

	it("hides a deleted member immediately and prunes it after the rename window", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		await h.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		expect((await h.service.result()).families).toEqual([]);
		h.fireTimers(2000);
		await flushQueue();
		expect(h.stored()?.families).toEqual([]);
		expect(h.stored()?.stamps?.[MEMBER]).toBeUndefined();
	});

	it("remaps a same-identity rename in a later batch without pruning", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		await h.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		h.probeState.set(RENAMED, stamp("member"));
		await h.service.applyDirChanges(dirChanges([RENAMED, "create"]));
		const result = await h.service.result();
		expect(result.families[0]?.members.map((member) => member.path)).toEqual([RENAMED]);
		expect(h.stored()?.families[0]?.members.map((member) => member.path)).toEqual([RENAMED]);
		expect(h.stored()?.stamps?.[RENAMED]?.ino).toBe("member");
	});

	it("remaps a same-identity rename in one batch", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		h.probeState.set(RENAMED, stamp("member"));
		await h.service.applyDirChanges(dirChanges([MEMBER, "delete"], [RENAMED, "create"]));
		expect((await h.service.result()).families[0]?.members[0]?.path).toBe(RENAMED);
		expect(h.stored()?.families[0]?.members[0]?.path).toBe(RENAMED);
	});

	it("does not remap a different identity and expires the old path", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		await h.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		h.probeState.set(RENAMED, stamp("other"));
		await h.service.applyDirChanges(dirChanges([RENAMED, "create"]));
		h.fireTimers(2000);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.stored()?.families).toEqual([]);
	});

	it("detaches changed members and heads while retaining persisted families", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, stamp("member", "5"));
		await h.service.applyDirChanges(dirChanges([MEMBER, "update"]));
		expect((await h.service.result()).families).toEqual([]);
		expect(h.stored()?.families).toHaveLength(1);

		const second = await scannedFixture();
		second.probeState.set(HEAD, stamp("head", "5"));
		await second.service.applyDirChanges(dirChanges([HEAD, "update"]));
		expect((await second.service.result()).families).toEqual([]);
		expect(second.stored()?.families).toHaveLength(1);
	});

	it("limits probes to the affected family and reverify catches an unseen disappearance", async () => {
		const h = await scannedFixture();
		h.probeCalls.length = 0;
		await h.service.applyDirChanges(dirChanges([MEMBER, "update"]));
		expect(h.probeCalls).toEqual(expect.arrayContaining([HEAD, MEMBER]));
		expect(h.probeCalls).not.toContain(`${ROOT}/unrelated.txt`);
		const unseen = await scannedFixture();
		unseen.probeState.set(MEMBER, null);
		expect(await unseen.service.reverify()).toBe(true);
		expect((await unseen.service.result()).families).toEqual([]);
	});

	it("cancels pending rename timers on stop", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		await h.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		const timerCount = h.timers.length;
		h.service.stop();
		expect(h.timers.length).toBeLessThan(timerCount);
		h.fireTimers(2000);
		expect(h.stored()?.families).toHaveLength(1);
	});

	it("loads snapshots without stamps and does not resurrect missing paths", async () => {
		const seed: StoredVersionFamilies = {
			version: 1,
			scannedAt: "2026-09-29T00:00:00.000Z",
			locations: [ROOT],
			families: [{
				head: HEAD,
				members: [{ path: MEMBER, relation: "exact" }],
				entries: [entry(HEAD), entry(MEMBER)],
			}],
		};
		const h = fixture({ seed });
		h.probeState.set(MEMBER, null);
		expect((await h.service.result()).families).toEqual([]);
	});

	it("does not resurrect a pruned path after loading the persisted snapshot again", async () => {
		const first = await scannedFixture();
		first.probeState.set(MEMBER, null);
		await first.service.reverify();
		const persisted = first.stored();
		expect(persisted?.families).toEqual([]);
		const restarted = fixture({ seed: persisted });
		expect((await restarted.service.result()).families).toEqual([]);
	});

	it("fully re-verifies every family on overflow or directory disappearance", async () => {
		const h = await scannedFixture();
		h.probeState.set(MEMBER, null);
		expect(
			await h.service.applyDirChanges([{ dir: ROOT, changes: [], overflow: true, dirGone: false }]),
		).toBe(true);
		expect((await h.service.result()).families).toEqual([]);

		const second = await scannedFixture();
		second.probeState.set(MEMBER, null);
		expect(
			await second.service.applyDirChanges([{ dir: ROOT, changes: [], overflow: false, dirGone: true }]),
		).toBe(true);
		expect((await second.service.result()).families).toEqual([]);
	});

	it("fires onChanged for scan, trash, and expiry but not live apply", async () => {
		const h = fixture();
		await h.service.refresh();
		const afterScan = h.changed();
		expect(afterScan).toBe(1);
		await h.service.applyDirChanges(dirChanges([MEMBER, "update"]));
		expect(h.changed()).toBe(afterScan);
		await h.service.removePaths([MEMBER]);
		expect(h.changed()).toBe(afterScan + 1);

		const second = await scannedFixture();
		second.probeState.set(MEMBER, null);
		await second.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		second.fireTimers(2000);
		await flushQueue();
		expect(second.changed()).toBeGreaterThan(1);
	});

	it("does not resurrect a deletion that lands during an in-flight scan", async () => {
		let release!: () => void;
		let scanStarted!: () => void;
		const scanGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			scanStarted = resolve;
		});
		const h = fixture({
			scan: async () => {
				scanStarted();
				await scanGate;
				return { dir: ROOT, files: [{ path: HEAD }, { path: MEMBER }], families: [rawFamily()], errors: [] };
			},
		});
		const refreshing = h.service.refresh();
		await started;
		h.probeState.set(MEMBER, null);
		const changed = h.service.applyDirChanges(dirChanges([MEMBER, "delete"]));
		release();
		await Promise.all([refreshing, changed]);
		expect((await h.service.result()).families).toEqual([]);
		expect(h.stored()?.families).toEqual([]);
	});

	it("persists a dirty fence for an update during an in-flight scan", async () => {
		let release!: () => void;
		let scanStarted!: () => void;
		const scanGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			scanStarted = resolve;
		});
		const h = fixture({
			scan: async () => {
				scanStarted();
				await scanGate;
				return { dir: ROOT, files: [{ path: HEAD }, { path: MEMBER }], families: [rawFamily()], errors: [] };
			},
		});
		const refreshing = h.service.refresh();
		await started;
		h.probeState.set(MEMBER, stamp("member", "5"));
		const changed = h.service.applyDirChanges(dirChanges([MEMBER, "update"]));
		release();
		await Promise.all([refreshing, changed]);
		expect(h.stored()?.stamps?.[MEMBER]).toEqual({
			dev: "",
			ino: "",
			size: "",
			mtimeNs: "",
			ctimeNs: "",
		});
		expect((await h.service.result()).families).toEqual([]);

		await h.service.refresh();
		expect((await h.service.result()).families).toHaveLength(1);
	});

	it("fences a recreated path during an in-flight scan", async () => {
		let release!: () => void;
		let scanStarted!: () => void;
		const scanGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			scanStarted = resolve;
		});
		const h = fixture({
			scan: async () => {
				scanStarted();
				await scanGate;
				return { dir: ROOT, files: [{ path: HEAD }, { path: MEMBER }], families: [rawFamily()], errors: [] };
			},
		});
		const refreshing = h.service.refresh();
		await started;
		h.probeState.set(MEMBER, stamp("recreated"));
		const changed = h.service.applyDirChanges(dirChanges([MEMBER, "delete"], [MEMBER, "create"]));
		release();
		await Promise.all([refreshing, changed]);
		expect(h.stored()?.stamps?.[MEMBER]).toEqual({
			dev: "",
			ino: "",
			size: "",
			mtimeNs: "",
			ctimeNs: "",
		});
		expect((await h.service.result()).families).toEqual([]);
	});
});
