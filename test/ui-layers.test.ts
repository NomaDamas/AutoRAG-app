import { describe, expect, it } from "vitest";
import type { LiveMessage, LiveResync } from "../src/shared/live-contract";
import {
	adoptInvoke,
	adoptMessage,
	adoptResync,
	EMPTY_LAYER_STORE,
	selectDupey,
	type LayerStore,
} from "../src/renderer/src/state/layers";
import { createFixtureSource } from "../src/renderer/src/data/source";
import {
	applyVersionStacks,
	buildVersionFamilies,
	EMPTY_VERSION_FAMILIES,
} from "../src/renderer/src/state/version-family";

function message(overrides: Partial<LiveMessage> = {}): LiveMessage {
	return { seq: 1, dirs: [], layers: [], reconciled: [], ...overrides };
}

function resync(overrides: Partial<LiveResync> = {}): LiveResync {
	return { seq: 1, layers: [], reconciled: [], ...overrides };
}

const publication = (layer: string, version: number, data: unknown) => ({ layer, version, data });

describe("renderer layer adoption", () => {
	it("ignores older and equal versions and adopts newer publications", () => {
		const initial: LayerStore = {
			versions: { dupey: 2 },
			data: { dupey: "old" },
			pendingThrough: {},
		};
		const older = adoptMessage(initial, message({ layers: [publication("dupey", 1, "older")] }));
		expect(older).toEqual(initial);
		const equal = adoptMessage(initial, message({ layers: [publication("dupey", 2, "equal")] }));
		expect(equal).toEqual(initial);
		expect(adoptMessage(initial, message({ layers: [publication("dupey", 3, "new")] }))).toMatchObject({
			versions: { dupey: 3 },
			data: { dupey: "new" },
		});
	});

	it("adopts an invoke result only when no live publication intervened", () => {
		const requested = adoptInvoke(EMPTY_LAYER_STORE, "dupey", "invoke", 0);
		expect(requested.data.dupey).toBe("invoke");
		const liveFirst = adoptMessage(EMPTY_LAYER_STORE, message({
			layers: [publication("dupey", 1, "live")],
		}));
		expect(adoptInvoke(liveFirst, "dupey", "invoke", 0)).toBe(liveFirst);
	});

	it("fences a layer missing from a non-empty reconciled message", () => {
		const next = adoptMessage(EMPTY_LAYER_STORE, message({
			seq: 4,
			dirs: [{ dir: "/tmp", changes: [], overflow: false, dirGone: false }],
			layers: [],
			reconciled: [],
		}));
		expect(next.pendingThrough.dupey).toBe(4);
	});

	it("clears a fence only when reconciled at or after its sequence", () => {
		const fenced = adoptMessage(EMPTY_LAYER_STORE, message({
			seq: 4,
			dirs: [{ dir: "/tmp", changes: [], overflow: false, dirGone: false }],
		}));
		const lower = adoptMessage(fenced, message({ seq: 3, reconciled: ["dupey"] }));
		expect(lower.pendingThrough.dupey).toBe(4);
		const cleared = adoptMessage(fenced, message({ seq: 4, reconciled: ["dupey"] }));
		expect(cleared.pendingThrough.dupey).toBeUndefined();
		const resynced = adoptResync(fenced, resync({ seq: 5, reconciled: ["dupey"] }));
		expect(resynced.pendingThrough.dupey).toBeUndefined();
	});

	it("keeps an unreconciled resync fenced", () => {
		const fenced = adoptMessage(EMPTY_LAYER_STORE, message({
			seq: 4,
			dirs: [{ dir: "/tmp", changes: [], overflow: false, dirGone: false }],
		}));
		expect(adoptResync(fenced, resync({ seq: 5 })).pendingThrough.dupey).toBe(4);
		expect(adoptResync(fenced, resync({ seq: 3, reconciled: ["dupey"] })).pendingThrough.dupey).toBe(4);
		expect(adoptResync(fenced, resync({ seq: 4, reconciled: ["dupey"] })).pendingThrough.dupey).toBeUndefined();
	});

	it("does not let an older batch lower an existing fence", () => {
		const dirs = [{ dir: "/tmp", changes: [], overflow: false, dirGone: false }];
		const fenced = adoptMessage(EMPTY_LAYER_STORE, message({ seq: 5, dirs }));
		const older = adoptMessage(fenced, message({ seq: 2, dirs }));
		expect(older.pendingThrough.dupey).toBe(5);
		expect(adoptMessage(older, message({ seq: 3, reconciled: ["dupey"] })).pendingThrough.dupey).toBe(5);
	});

	it("keeps versions and fences unchanged when adopting an invoke", () => {
		const store: LayerStore = {
			versions: { dupey: 2 },
			data: { dupey: "old" },
			pendingThrough: { dupey: 5 },
		};
		expect(adoptInvoke(store, "dupey", "invoke", 2)).toEqual({
			...store,
			data: { dupey: "invoke" },
		});
	});

	it("renders fixture-only families and removes stack badges while fenced", async () => {
		const source = createFixtureSource();
		const result = await source.versionFamilies();
		const adopted = adoptInvoke(EMPTY_LAYER_STORE, "dupey", result, 0);
		const family = selectDupey(adopted).result.families[0];
		expect(family).toBeDefined();
		if (family === undefined) throw new Error("fixture family missing");
		const head = family.entriesByPath[family.head];
		expect(head).toBeDefined();
		if (head === undefined) throw new Error("fixture head missing");
		const rows = [head];
		const render = (store: LayerStore) => {
			const dupey = selectDupey(store);
			return applyVersionStacks(rows, {
				families: dupey.fenced ? EMPTY_VERSION_FAMILIES : buildVersionFamilies(dupey.result.families),
				manualOpen: new Set([head.path]),
				selectedKeys: [],
			});
		};
		expect(render(adopted)[0]?.stackCount).toBeGreaterThan(0);
		const fenced = adoptMessage(adopted, message({
			seq: 4,
			dirs: [{ dir: head.location, changes: [{ path: head.path, type: "delete" }], overflow: false, dirGone: false }],
		}));
		expect(selectDupey(fenced).result).toBe(result);
		expect(render(fenced).every((row) => row.stackCount === 0 && !row.child)).toBe(true);
		expect(render(fenced)).toHaveLength(1);
	});

	it("selects empty dupey families while fenced", () => {
		const store = adoptMessage(EMPTY_LAYER_STORE, message({
			seq: 4,
			dirs: [{ dir: "/tmp", changes: [], overflow: false, dirGone: false }],
		}));
		const withData = adoptMessage(store, message({
			seq: 5,
			layers: [publication("dupey", 1, {
				families: [{ head: "/tmp/a", members: [], entriesByPath: {} }],
				scannedAt: null,
				error: null,
			})],
			reconciled: ["dupey"],
		}));
		expect(selectDupey(withData)).toMatchObject({ fenced: false });
		expect(selectDupey(withData).result.families).toHaveLength(1);
		expect(selectDupey(store)).toMatchObject({ fenced: true, result: { families: [] } });
	});
});
