// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { INDEX_MAP_REFRESH_MS, useLiveIndexMap, type LiveIndexMap } from "../src/renderer/src/components/settings/index-map/useLiveIndexMap";
import { emptyIndexMapCounts, type IndexMap } from "../src/shared/index-map-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

function mapOf(indexed: number): IndexMap {
	const counts = { ...emptyIndexMapCounts(), indexed };
	return { roots: ["/r"], nodes: [{ id: 0, parent: null, kind: "root", name: "/r", path: "/r", state: "indexed", weight: indexed, counts, depth: 0 }], totals: counts, truncated: false, folded: false };
}

interface Harness {
	live(): LiveIndexMap;
	read: Mock<() => Promise<IndexMap>>;
	refreshed(): Promise<void>;
	setRunning(running: boolean): Promise<void>;
}

/** Mounts the hook against a scripted `indexMap` read and a controllable "refresh settled" push. */
async function mount(reads: readonly (IndexMap | Error)[], running: boolean): Promise<Harness> {
	let latest: LiveIndexMap | undefined;
	let pushed: (() => void) | undefined;
	let call = 0;
	const read = vi.fn(async (): Promise<IndexMap> => {
		const next = reads[Math.min(call, reads.length - 1)]!;
		call += 1;
		if (next instanceof Error) throw next;
		return next;
	});
	function Probe({ active }: { readonly active: boolean }): null {
		latest = useLiveIndexMap({
			read,
			onRefreshed: (listener: () => void) => {
				pushed = listener;
				return () => {
					pushed = undefined;
				};
			},
			running: active,
		});
		return null;
	}
	const render = (active: boolean): Promise<void> => act(async () => root.render(<Probe active={active} />));
	await render(running);
	return {
		live: () => latest!,
		read,
		refreshed: () => act(async () => pushed?.()),
		setRunning: render,
	};
}

const tick = (ms: number): Promise<void> =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe("useLiveIndexMap", () => {
	it("reads once on open, then re-reads every interval while indexing runs", async () => {
		const harness = await mount([mapOf(1), mapOf(2), mapOf(3)], true);
		expect(harness.read).toHaveBeenCalledTimes(1);
		expect(harness.live().map?.totals.indexed).toBe(1);

		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.read).toHaveBeenCalledTimes(2);
		expect(harness.live().map?.totals.indexed).toBe(2);

		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.live().map?.totals.indexed).toBe(3);
	});

	it("does not poll while nothing is indexing", async () => {
		const harness = await mount([mapOf(1), mapOf(2)], false);
		await tick(INDEX_MAP_REFRESH_MS * 3);
		expect(harness.read).toHaveBeenCalledTimes(1);
		expect(harness.live().map?.totals.indexed).toBe(1);
	});

	it("reads at once when a run begins, keeps polling, and reads one last time when it ends", async () => {
		const harness = await mount([mapOf(1), mapOf(2), mapOf(3), mapOf(4), mapOf(5)], false);
		await tick(INDEX_MAP_REFRESH_MS * 2);
		expect(harness.read).toHaveBeenCalledTimes(1);

		await harness.setRunning(true);
		expect(harness.read).toHaveBeenCalledTimes(2);
		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.read).toHaveBeenCalledTimes(3);

		await harness.setRunning(false);
		// The run's last state is read once, so the finished map shows without waiting for anything else.
		expect(harness.read).toHaveBeenCalledTimes(4);
		expect(harness.live().map?.totals.indexed).toBe(4);
		await tick(INDEX_MAP_REFRESH_MS * 3);
		expect(harness.read).toHaveBeenCalledTimes(4);
	});

	it("keeps showing the last map when a re-read fails, and reports no error", async () => {
		const harness = await mount([mapOf(5), new Error("walk failed"), mapOf(6)], true);
		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.read).toHaveBeenCalledTimes(2);
		expect(harness.live().map?.totals.indexed).toBe(5);
		expect(harness.live().error).toBeNull();

		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.live().map?.totals.indexed).toBe(6);
	});

	it("shows the error only when there is no map to keep", async () => {
		const harness = await mount([new Error("walk failed")], false);
		expect(harness.live().map).toBeNull();
		expect(harness.live().error).toBe("walk failed");
	});

	it("keeps retrying while it has no map at all, then stops once it has one", async () => {
		// With no reload button, a first read that fails must heal itself even when nothing is indexing.
		const harness = await mount([new Error("busy"), new Error("busy"), mapOf(3)], false);
		expect(harness.live().error).toBe("busy");
		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.read).toHaveBeenCalledTimes(2);
		expect(harness.live().map).toBeNull();
		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.live().map?.totals.indexed).toBe(3);
		expect(harness.live().error).toBeNull();
		await tick(INDEX_MAP_REFRESH_MS * 3);
		expect(harness.read).toHaveBeenCalledTimes(3);
	});

	it("keeps the same map object when a re-read finds nothing changed", async () => {
		const harness = await mount([mapOf(4), mapOf(4)], true);
		const first = harness.live().map;
		await tick(INDEX_MAP_REFRESH_MS);
		expect(harness.read).toHaveBeenCalledTimes(2);
		// An unchanged answer must not rebuild the chart: the same reference, so nothing re-renders or flickers.
		expect(harness.live().map).toBe(first);
	});

	it("never overlaps reads: a slow scan is not asked again until it answers", async () => {
		const slow = Promise.withResolvers<IndexMap>();
		let call = 0;
		const read = vi.fn((): Promise<IndexMap> => {
			call += 1;
			return call === 1 ? Promise.resolve(mapOf(1)) : slow.promise;
		});
		function Probe(): null {
			useLiveIndexMap({ read, onRefreshed: () => () => {}, running: true });
			return null;
		}
		await act(async () => root.render(<Probe />));
		await tick(INDEX_MAP_REFRESH_MS);
		expect(read).toHaveBeenCalledTimes(2);
		// The second read stays in flight across three more intervals: nothing asks again.
		await tick(INDEX_MAP_REFRESH_MS * 3);
		expect(read).toHaveBeenCalledTimes(2);
		await act(async () => slow.resolve(mapOf(2)));
		await tick(INDEX_MAP_REFRESH_MS);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("re-reads at once when a refresh settles, without waiting for the interval", async () => {
		const harness = await mount([mapOf(1), mapOf(9)], false);
		await harness.refreshed();
		expect(harness.live().map?.totals.indexed).toBe(9);
	});

	it("reads once more after a push that arrives while a read is running", async () => {
		const slow = Promise.withResolvers<IndexMap>();
		let pushed: (() => void) | undefined;
		let call = 0;
		const read = vi.fn((): Promise<IndexMap> => {
			call += 1;
			return call === 1 ? slow.promise : Promise.resolve(mapOf(8));
		});
		let latest: LiveIndexMap | undefined;
		function Probe(): null {
			latest = useLiveIndexMap({ read, onRefreshed: (listener: () => void) => { pushed = listener; return () => {}; }, running: false });
			return null;
		}
		await act(async () => root.render(<Probe />));
		// The refresh settled while the first scan was still walking: that scan may have missed it, so ask again afterwards.
		await act(async () => pushed?.());
		expect(read).toHaveBeenCalledTimes(1);
		await act(async () => slow.resolve(mapOf(3)));
		expect(read).toHaveBeenCalledTimes(2);
		expect(latest?.map?.totals.indexed).toBe(8);
	});

	it("stops everything when the modal closes: a late answer schedules nothing", async () => {
		const slow = Promise.withResolvers<IndexMap>();
		const read = vi.fn((): Promise<IndexMap> => slow.promise);
		function Probe(): null {
			useLiveIndexMap({ read, onRefreshed: () => () => {}, running: true });
			return null;
		}
		await act(async () => root.render(<Probe />));
		act(() => root.unmount());
		root = createRoot(host);
		await act(async () => slow.resolve(mapOf(7)));
		await tick(INDEX_MAP_REFRESH_MS * 5);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
