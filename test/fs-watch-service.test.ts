import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsChange, FsDirChange } from "../src/shared/live-contract";
import { createFsWatchService } from "../src/main/fs-watch-service";
import type { WatchBackend } from "../src/main/watch-backend";

interface FakeSubscription {
	readonly dir: string;
	readonly emit: (events: readonly FsChange[]) => void;
	readonly fail: (error: Error) => void;
	readonly unsubscribe: () => Promise<void>;
}

function fakeBackend() {
	const subscriptions = new Map<string, FakeSubscription>();
	const unsubscribed: string[] = [];
	const subscribe = vi.fn(async (dir: string, onEvents: (events: readonly FsChange[]) => void, onError: (error: Error) => void): Promise<() => Promise<void>> => {
		const unsubscribe = vi.fn<() => Promise<void>>(async () => {
			subscriptions.delete(dir);
			unsubscribed.push(dir);
		});
		const subscription: FakeSubscription = {
			dir,
			emit: onEvents,
			fail: onError,
			unsubscribe,
		};
		subscriptions.set(dir, subscription);
		return subscription.unsubscribe;
	});
	const backend: WatchBackend = { subscribe };
	return { backend, subscribe, subscriptions, unsubscribed };
}

async function settle(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

const identity = async (dir: string): Promise<string> => dir;

/** Backend + canonicalization that model a directory that can be deleted and recreated. */
function recreatableDir(initial: boolean) {
	const state = { exists: initial };
	return {
		state,
		canonicalize: async (dir: string): Promise<string> => {
			if (!state.exists) throw new Error("ENOENT");
			return dir;
		},
		stat: async (): Promise<boolean> => state.exists,
	};
}

describe("FsWatchService", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("filters child events and flushes after the trailing debounce", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/watch";
		const service = createFsWatchService({ backend: fake.backend, onBatch: (batch) => batches.push(batch), canonicalize: identity });
		await service.setWatchSet([dir]);
		fake.subscriptions.get(dir)?.emit([
			{ path: join(dir, "a.txt"), type: "create" },
			{ path: join(dir, "nested", "b.txt"), type: "update" },
		]);
		await vi.advanceTimersByTimeAsync(149);
		expect(batches).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(batches).toEqual([{ dir, changes: [{ path: join(dir, "a.txt"), type: "create" }], overflow: false, dirGone: false }]);
	});

	it("uses the one-second max wait during a continuous stream", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/watch-max";
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: identity,
			now: () => Date.now(),
		});
		await service.setWatchSet([dir]);
		for (let time = 0; time < 1000; time += 100) {
			fake.subscriptions.get(dir)?.emit([{ path: join(dir, `${time}.txt`), type: "create" }]);
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(batches).toHaveLength(1);
		expect(batches[0]?.changes).toHaveLength(10);
	});

	it("collapses adjacent duplicate events but preserves delete-create rename pairs", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/watch-order";
		const service = createFsWatchService({ backend: fake.backend, onBatch: (batch) => batches.push(batch), canonicalize: identity });
		await service.setWatchSet([dir]);
		fake.subscriptions.get(dir)?.emit([
			{ path: join(dir, "old.txt"), type: "delete" },
			{ path: join(dir, "old.txt"), type: "delete" },
			{ path: join(dir, "new.txt"), type: "create" },
			{ path: join(dir, "new.txt"), type: "create" },
			{ path: join(dir, "old.txt"), type: "delete" },
		]);
		await vi.advanceTimersByTimeAsync(150);
		expect(batches[0]?.changes).toEqual([
			{ path: join(dir, "old.txt"), type: "delete" },
			{ path: join(dir, "new.txt"), type: "create" },
			{ path: join(dir, "old.txt"), type: "delete" },
		]);
	});

	it("diffs, deduplicates, and ignores virtual watch paths", async () => {
		const fake = fakeBackend();
		const service = createFsWatchService({ backend: fake.backend, onBatch: () => { }, canonicalize: identity });
		await service.setWatchSet(["relative", "Recents", "/kakao/people", "/tmp/a", "/tmp/a"]);
		expect(fake.subscribe).toHaveBeenCalledTimes(1);
		expect(fake.subscribe).toHaveBeenCalledWith("/tmp/a", expect.any(Function), expect.any(Function));
		await service.setWatchSet(["/tmp/b"]);
		expect(fake.subscriptions.has("/tmp/a")).toBe(false);
		expect(fake.subscriptions.has("/tmp/b")).toBe(true);
		await service.setWatchSet(["/tmp/b"]);
		expect(fake.subscribe).toHaveBeenCalledTimes(2);
	});

	it("watches the real path and translates events back to the user-visible alias", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const alias = "/tmp/link";
		const canonical = "/private/tmp/real";
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: async (dir) => (dir === alias ? canonical : dir),
		});
		await service.setWatchSet([alias]);
		expect(fake.subscribe).toHaveBeenCalledWith(canonical, expect.any(Function), expect.any(Function));
		fake.subscriptions.get(canonical)?.emit([
			{ path: join(canonical, "a.txt"), type: "create" },
			{ path: join(canonical, "nested", "b.txt"), type: "update" },
			{ path: canonical, type: "update" },
		]);
		await vi.advanceTimersByTimeAsync(150);
		expect(batches).toEqual([
			{
				dir: alias,
				changes: [
					{ path: join(alias, "a.txt"), type: "create" },
					{ path: alias, type: "update" },
				],
				overflow: false,
				dirGone: false,
			},
		]);
	});

	it("serializes interrupted watch-set updates and ends with the latest set", async () => {
		const firstSubscribe = vi.fn<(dir: string, onEvents: (events: readonly FsChange[]) => void, onError: (error: Error) => void) => Promise<() => Promise<void>>>();
		let release!: (unsubscribe: () => Promise<void>) => void;
		firstSubscribe.mockImplementationOnce(async () => {
			const { promise, resolve } = Promise.withResolvers<() => Promise<void>>();
			release = resolve;
			return promise;
		});
		const fake = fakeBackend();
		const backend: WatchBackend = {
			subscribe: async (dir, onEvents, onError) => {
				if (dir === "/tmp/first") return firstSubscribe(dir, onEvents, onError);
				return fake.backend.subscribe(dir, onEvents, onError);
			},
		};
		const service = createFsWatchService({ backend, onBatch: () => { }, canonicalize: identity });
		const first = service.setWatchSet(["/tmp/first"]);
		const latest = service.setWatchSet(["/tmp/latest"]);
		await settle();
		expect(fake.subscriptions.has("/tmp/latest")).toBe(false);
		release(async () => { });
		await first;
		await latest;
		expect(fake.subscriptions.has("/tmp/latest")).toBe(true);
	});

	it("recovers from rejected subscriptions without wedging later updates", async () => {
		const fake = fakeBackend();
		fake.subscribe.mockRejectedValueOnce(new Error("EPERM"));
		const batches: FsDirChange[] = [];
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: identity,
			stat: async () => true,
		});
		await service.setWatchSet(["/tmp/rejected"]);
		await service.setWatchSet(["/tmp/works"]);
		expect(batches).toEqual([{ dir: "/tmp/rejected", changes: [], overflow: true, dirGone: false }]);
		expect(fake.subscriptions.has("/tmp/works")).toBe(true);
	});

	it("emits dirGone and drops the subscription when the watched directory is deleted", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/gone";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		state.state.exists = false;
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await settle();
		expect(batches).toEqual([{ dir, changes: [], overflow: false, dirGone: true }]);
		expect(fake.subscriptions.has(dir)).toBe(false);
		await service.dispose();
	});

	it("reattaches a recreated directory without an explicit watch-set resend", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/recreate";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		state.state.exists = false;
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await settle();
		expect(fake.subscriptions.has(dir)).toBe(false);

		state.state.exists = true;
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(fake.subscriptions.has(dir)).toBe(true);
		expect(batches[batches.length - 1]).toEqual({ dir, changes: [], overflow: true, dirGone: false });

		fake.subscriptions.get(dir)?.emit([{ path: join(dir, "new.txt"), type: "create" }]);
		await vi.advanceTimersByTimeAsync(150);
		expect(batches[batches.length - 1]?.changes).toEqual([{ path: join(dir, "new.txt"), type: "create" }]);
	});

	it("reattaches a gone directory when the same watch set is re-sent", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/focus";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		state.state.exists = false;
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await settle();
		expect(fake.subscriptions.has(dir)).toBe(false);
		expect(batches).toEqual([{ dir, changes: [], overflow: false, dirGone: true }]);

		state.state.exists = true;
		await service.setWatchSet([dir]);
		expect(fake.subscriptions.has(dir)).toBe(true);
		expect(batches).toEqual([
			{ dir, changes: [], overflow: false, dirGone: true },
			{ dir, changes: [], overflow: true, dirGone: false },
		]);
	});

	it("ignores late events from a subscription superseded by a root recreate", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/supersede";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		const superseded = fake.subscriptions.get(dir);
		state.state.exists = false;
		superseded?.emit([{ path: dir, type: "delete" }]);
		await settle();
		state.state.exists = true;
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		const settled = batches.length;
		superseded?.emit([{ path: join(dir, "stale.txt"), type: "create" }]);
		await vi.advanceTimersByTimeAsync(150);
		expect(batches.length).toBe(settled);
	});

	it("retries only missing wanted roots and stops once none are wanted", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/gone-retry";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		state.state.exists = false;
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await settle();
		const afterGone = fake.subscribe.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(fake.subscribe.mock.calls.length).toBe(afterGone);

		await service.setWatchSet([]);
		const afterRemove = fake.subscribe.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(fake.subscribe.mock.calls.length).toBe(afterRemove);
	});

	it("releases the retry timer on dispose", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const dir = "/tmp/gone-dispose";
		const state = recreatableDir(true);
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: () => { },
			canonicalize: state.canonicalize,
			stat: state.stat,
		});
		await service.setWatchSet([dir]);
		state.state.exists = false;
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await settle();
		await service.dispose();
		const afterDispose = fake.subscribe.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(fake.subscribe.mock.calls.length).toBe(afterDispose);
	});

	it("emits overflow and logs the directory when the backend reports an error", async () => {
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
		const dir = "/tmp/error";
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			canonicalize: identity,
			stat: async () => true,
		});
		await service.setWatchSet([dir]);
		fake.subscriptions.get(dir)?.fail(new Error("overflow"));
		await settle();
		expect(batches).toEqual([{ dir, changes: [], overflow: true, dirGone: false }]);
		expect(errorSpy).toHaveBeenCalledWith(`[fs-watch] ${dir}: overflow`);
	});

	it("unsubscribes every active directory on dispose", async () => {
		const fake = fakeBackend();
		const service = createFsWatchService({ backend: fake.backend, onBatch: () => { }, canonicalize: identity });
		await service.setWatchSet(["/tmp/a", "/tmp/b"]);
		await service.dispose();
		expect(fake.unsubscribed.sort()).toEqual(["/tmp/a", "/tmp/b"]);
		await service.setWatchSet(["/tmp/c"]);
		expect(fake.subscriptions.size).toBe(0);
	});
});
