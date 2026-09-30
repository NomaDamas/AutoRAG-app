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

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
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
		const service = createFsWatchService({ backend: fake.backend, onBatch: (batch) => batches.push(batch) });
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
		const service = createFsWatchService({ backend: fake.backend, onBatch: (batch) => batches.push(batch) });
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
		const service = createFsWatchService({ backend: fake.backend, onBatch: () => { } });
		await service.setWatchSet(["relative", "Recents", "Contacts", "/kakao/people", "/tmp/a", "/tmp/a"]);
		expect(fake.subscribe).toHaveBeenCalledTimes(1);
		expect(fake.subscribe).toHaveBeenCalledWith("/tmp/a", expect.any(Function), expect.any(Function));
		await service.setWatchSet(["/tmp/b"]);
		expect(fake.subscriptions.has("/tmp/a")).toBe(false);
		expect(fake.subscriptions.has("/tmp/b")).toBe(true);
		await service.setWatchSet(["/tmp/b"]);
		expect(fake.subscribe).toHaveBeenCalledTimes(2);
	});

	it("serializes interrupted watch-set updates and ends with the latest set", async () => {
		const firstSubscribe = vi.fn<(dir: string, onEvents: (events: readonly FsChange[]) => void, onError: (error: Error) => void) => Promise<() => Promise<void>>>();
		let release!: (unsubscribe: () => Promise<void>) => void;
		firstSubscribe.mockImplementationOnce(async () => new Promise((resolve) => { release = resolve; }));
		const fake = fakeBackend();
		const backend: WatchBackend = {
			subscribe: async (dir, onEvents, onError) => {
				if (dir === "/tmp/first") return firstSubscribe(dir, onEvents, onError);
				return fake.backend.subscribe(dir, onEvents, onError);
			},
		};
		const service = createFsWatchService({ backend, onBatch: () => { } });
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
			stat: async () => true,
		});
		await service.setWatchSet(["/tmp/rejected"]);
		await service.setWatchSet(["/tmp/works"]);
		expect(batches).toEqual([{ dir: "/tmp/rejected", changes: [], overflow: true, dirGone: false }]);
		expect(fake.subscriptions.has("/tmp/works")).toBe(true);
	});

	it("emits dirGone and unsubscribes when the watched directory is deleted", async () => {
		vi.useFakeTimers();
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const dir = "/tmp/gone";
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
			stat: async () => false,
		});
		await service.setWatchSet([dir]);
		fake.subscriptions.get(dir)?.emit([{ path: dir, type: "delete" }]);
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(batches).toEqual([{ dir, changes: [], overflow: false, dirGone: true }]);
		expect(fake.subscriptions.has(dir)).toBe(false);
	});

	it("emits overflow and logs the directory when the backend reports an error", async () => {
		const fake = fakeBackend();
		const batches: FsDirChange[] = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
		const dir = "/tmp/error";
		const service = createFsWatchService({
			backend: fake.backend,
			onBatch: (batch) => batches.push(batch),
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
		const service = createFsWatchService({ backend: fake.backend, onBatch: () => { } });
		await service.setWatchSet(["/tmp/a", "/tmp/b"]);
		await service.dispose();
		expect(fake.unsubscribed.sort()).toEqual(["/tmp/a", "/tmp/b"]);
		await service.setWatchSet(["/tmp/c"]);
		expect(fake.subscriptions.size).toBe(0);
	});
});
