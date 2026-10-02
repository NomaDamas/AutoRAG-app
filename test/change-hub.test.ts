import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createChangeHub,
	type DerivedLayer,
} from "../src/main/change-hub";
import type { FsDirChange, LiveMessage } from "../src/shared/live-contract";

const firstBatch: FsDirChange = {
	dir: "/watched",
	changes: [{ path: "/watched/one.txt", type: "update" }],
	overflow: false,
	dirGone: false,
};
const secondBatch: FsDirChange = {
	dir: "/watched",
	changes: [{ path: "/watched/two.txt", type: "create" }],
	overflow: false,
	dirGone: false,
};
const thirdBatch: FsDirChange = {
	dir: "/watched",
	changes: [{ path: "/watched/three.txt", type: "delete" }],
	overflow: false,
	dirGone: false,
};

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function layer<T>(
	id: string,
	snapshotValue: T,
	applyChanges: DerivedLayer<T>["applyChanges"] = async () => false,
	resync?: DerivedLayer<T>["resync"],
): DerivedLayer<T> {
	return {
		id,
		snapshot: async () => snapshotValue,
		applyChanges,
		...(resync === undefined ? {} : { resync }),
	};
}

function createMessages(): {
	messages: LiveMessage[];
	send: (message: LiveMessage) => void;
	waitForMessage: (after: number) => Promise<LiveMessage>;
} {
	const messages: LiveMessage[] = [];
	const waiters: { readonly after: number; readonly resolve: (message: LiveMessage) => void }[] = [];
	return {
		messages,
		send: (message) => {
			messages.push(message);
			for (const waiter of [...waiters]) {
				const next = messages[waiter.after];
				if (next === undefined) continue;
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				waiter.resolve(next);
			}
		},
		waitForMessage: (after) => {
			const message = messages[after];
			return message === undefined
				? new Promise<LiveMessage>((resolve) => waiters.push({ after, resolve }))
				: Promise.resolve(message);
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("createChangeHub", () => {
	it("sends ordered messages after layers apply and omits unchanged publications", async () => {
		vi.useFakeTimers();
		const messages: LiveMessage[] = [];
		const applied: string[] = [];
		let sendSawApplied = false;
		let resolveSent: (message: LiveMessage) => void = () => undefined;
		const sent = new Promise<LiveMessage>((resolve) => {
			resolveSent = resolve;
		});
		const send = (message: LiveMessage): void => {
			sendSawApplied = applied.length === 2;
			messages.push(message);
			resolveSent(message);
		};
		const changedLayer = layer("changed", { value: 1 }, async () => {
			applied.push("changed");
			return true;
		});
		const unchangedLayer = layer("unchanged", { value: 2 }, async () => {
			applied.push("unchanged");
			return false;
		});
		const hub = createChangeHub({ send });
		hub.register(changedLayer);
		hub.register(unchangedLayer);
		hub.ingest(firstBatch);
		await sent;

		expect(messages).toHaveLength(1);
		expect(sendSawApplied).toBe(true);
		expect(messages[0]).toMatchObject({
			seq: 1,
			dirs: [firstBatch],
			layers: [{ layer: "changed", version: 1, data: { value: 1 } }],
			reconciled: ["changed", "unchanged"],
		});
		expect(applied).toEqual(["changed", "unchanged"]);
	});

	it("coalesces an event burst into one next job while the current job runs", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const firstApply = deferred<boolean>();
		const firstApplyStarted = deferred<void>();
		const applyCalls: FsDirChange[][] = [];
		const testLayer = layer("layer", { value: 1 }, async (dirs) => {
			applyCalls.push([...dirs]);
			if (applyCalls.length === 1) {
				firstApplyStarted.resolve();
				return firstApply.promise;
			}
			return false;
		});
		const hub = createChangeHub({ send });
		hub.register(testLayer);
		hub.ingest(firstBatch);
		await firstApplyStarted.promise;
		hub.ingest(secondBatch);
		hub.ingest(thirdBatch);
		const secondMessage = waitForMessage(1);
		firstApply.resolve(true);
		await secondMessage;

		expect(messages).toHaveLength(2);
		expect(messages.map((message) => message.seq)).toEqual([1, 2]);
		expect(messages[1]?.dirs).toEqual([secondBatch, thirdBatch]);
		expect(applyCalls).toEqual([[firstBatch], [secondBatch, thirdBatch]]);
	});

	it("uses the configured batch window before starting an ingest job", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const timers: { readonly handler: () => void; readonly ms: number }[] = [];
		const hub = createChangeHub({
			send,
			batchWindowMs: 1000,
			setTimer: (handler, ms) => {
				timers.push({ handler, ms });
				return timers.length;
			},
			clearTimer: () => undefined,
		});
		hub.register(layer("layer", null, async () => false));
		hub.ingest(firstBatch);
		expect(messages).toHaveLength(0);

		hub.ingest(secondBatch);
		await Promise.resolve();
		expect(timers[0]?.ms).toBe(1000);
		expect(timers).toHaveLength(1);
		expect(messages).toHaveLength(0);
		const message = waitForMessage(0);
		timers.shift()?.handler();
		await message;

		expect(messages).toHaveLength(1);
		expect(messages[0]?.dirs).toEqual([firstBatch, secondBatch]);
	});

	it("lets later layers and messages pass a hung layer after its timeout", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const hung = deferred<boolean>();
		const hungStarted = deferred<void>();
		const applied: string[] = [];
		const hungLayer = layer("hung", null, async () => {
			hungStarted.resolve();
			return hung.promise;
		});
		const readyLayer = layer("ready", { value: 2 }, async () => {
			applied.push("ready");
			return true;
		});
		const hub = createChangeHub({ send, layerTimeoutMs: 100 });
		hub.register(hungLayer);
		hub.register(readyLayer);
		hub.ingest(firstBatch);
		await hungStarted.promise;
		const message = waitForMessage(0);
		await vi.advanceTimersByTimeAsync(100);
		await message;

		expect(applied).toEqual(["ready"]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			seq: 1,
			layers: [{ layer: "ready", version: 1 }],
			reconciled: ["ready"],
		});
		expect(messages[0]?.reconciled).not.toContain("hung");

		const laterMessage = waitForMessage(1);
		hub.publish("ready");
		await laterMessage;
		expect(messages[1]?.seq).toBe(2);
	});

	it("publishes a late timeout completion with A3 reconciliation", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const apply = deferred<boolean>();
		const applyStarted = deferred<void>();
		const testLayer = layer("late", { value: 1 }, async () => {
			applyStarted.resolve();
			return apply.promise;
		});
		const hub = createChangeHub({ send, layerTimeoutMs: 50 });
		hub.register(testLayer);
		hub.ingest(firstBatch);
		await applyStarted.promise;
		const firstMessage = waitForMessage(0);
		await vi.advanceTimersByTimeAsync(50);
		await firstMessage;
		expect(messages[0]?.reconciled).toEqual([]);

		const lateMessage = waitForMessage(1);
		apply.resolve(true);
		await lateMessage;

		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			seq: 2,
			dirs: [],
			layers: [{ layer: "late", version: 1, data: { value: 1 } }],
			reconciled: ["late"],
		});
	});

	it("does not reconcile a publish while the layer apply is outstanding", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const apply = deferred<boolean>();
		const applyStarted = deferred<void>();
		const testLayer = layer("pending", { value: 1 }, async () => {
			applyStarted.resolve();
			return apply.promise;
		});
		const hub = createChangeHub({ send, layerTimeoutMs: 50 });
		hub.register(testLayer);
		hub.ingest(firstBatch);
		await applyStarted.promise;
		const firstMessage = waitForMessage(0);
		await vi.advanceTimersByTimeAsync(50);
		await firstMessage;

		const publishMessage = waitForMessage(1);
		hub.publish("pending");
		await publishMessage;
		expect(messages[1]).toMatchObject({
			seq: 2,
			dirs: [],
			layers: [{ layer: "pending", version: 1 }],
			reconciled: [],
		});

		const lateMessage = waitForMessage(2);
		apply.resolve(true);
		await lateMessage;
		expect(messages[2]?.reconciled).toEqual(["pending"]);
	});

	it("logs throwing layers and still publishes the other layers", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const failure = new Error("layer exploded");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const throwingLayer = layer("throwing", null, async () => {
			throw failure;
		});
		const healthyLayer = layer("healthy", { value: 2 }, async () => true);
		const hub = createChangeHub({ send });
		hub.register(throwingLayer);
		hub.register(healthyLayer);
		const message = waitForMessage(0);
		hub.ingest(firstBatch);
		await message;

		expect(error).toHaveBeenCalledWith("[change-hub] layer throwing failed:", failure);
		expect(messages[0]).toMatchObject({
			layers: [{ layer: "healthy", version: 1, data: { value: 2 } }],
			reconciled: ["healthy"],
		});
		await hub.current();
		expect(messages).toHaveLength(1);
	});

	it("keeps publish actions in FIFO order after an ingest job", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const apply = deferred<boolean>();
		const applyStarted = deferred<void>();
		const testLayer = layer("layer", { value: 1 }, async () => {
			if (messages.length === 0) {
				applyStarted.resolve();
				return apply.promise;
			}
			return false;
		});
		const hub = createChangeHub({ send });
		hub.register(testLayer);
		hub.ingest(firstBatch);
		await applyStarted.promise;
		hub.publish("layer");
		const secondMessage = waitForMessage(1);
		apply.resolve(true);
		await secondMessage;

		expect(messages.map((message) => [message.seq, message.dirs])).toEqual([
			[1, [firstBatch]],
			[2, []],
		]);
		expect(messages[1]?.layers[0]?.version).toBe(2);
	});

	it("returns current publications with monotonic versions", async () => {
		vi.useFakeTimers();
		const { send, waitForMessage } = createMessages();
		let value = 1;
		const testLayer = layer("layer", { value }, async () => true);
		const hub = createChangeHub({ send });
		hub.register(testLayer);
		const firstMessage = waitForMessage(0);
		hub.ingest(firstBatch);
		await firstMessage;
		value = 2;
		hub.publish("layer");
		const current = await hub.current();

		expect(current).toEqual({
			seq: 2,
			layers: [{ layer: "layer", version: 2, data: { value: 1 } }],
		});
	});

	it("resyncs each optional layer once without sending a message", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const resyncCalls: string[] = [];
		const changed = layer("changed", { value: 1 }, async () => true, async () => {
			resyncCalls.push("changed");
			return true;
		});
		const unchanged = layer("unchanged", { value: 2 }, async () => true, async () => {
			resyncCalls.push("unchanged");
			return false;
		});
		const noResync = layer("none", { value: 3 }, async () => true);
		const hub = createChangeHub({ send });
		hub.register(changed);
		hub.register(unchanged);
		hub.register(noResync);
		const firstMessage = waitForMessage(0);
		hub.ingest(firstBatch);
		await firstMessage;
		const before = messages.length;
		const result = await hub.resync();

		expect(resyncCalls).toEqual(["changed", "unchanged"]);
		expect(messages).toHaveLength(before);
		expect(result).toEqual({
			seq: 1,
			layers: [
				{ layer: "changed", version: 2, data: { value: 1 } },
				{ layer: "unchanged", version: 1, data: { value: 2 } },
				{ layer: "none", version: 1, data: { value: 3 } },
			],
			reconciled: ["changed", "unchanged"],
		});
	});

	it("publishes a late true resync after its timeout", async () => {
		vi.useFakeTimers();
		const { messages, send, waitForMessage } = createMessages();
		const resync = deferred<boolean>();
		const resyncStarted = deferred<void>();
		const testLayer = layer("late-resync", { value: 1 }, async () => false, async () => {
			resyncStarted.resolve();
			return resync.promise;
		});
		const hub = createChangeHub({ send, layerTimeoutMs: 25 });
		hub.register(testLayer);
		const resultPromise = hub.resync();
		await resyncStarted.promise;
		await vi.advanceTimersByTimeAsync(25);

		const result = await resultPromise;
		expect(result).toEqual({ seq: 0, layers: [], reconciled: [] });
		const lateMessage = waitForMessage(0);
		resync.resolve(true);
		await lateMessage;

		expect(messages[0]).toMatchObject({
			seq: 1,
			dirs: [],
			layers: [{ layer: "late-resync", version: 1, data: { value: 1 } }],
			reconciled: ["late-resync"],
		});
	});

	it("excludes timed-out and throwing resync layers from reconciliation", async () => {
		vi.useFakeTimers();
		const { messages, send } = createMessages();
		const timedOut = deferred<boolean>();
		const resyncStarted = deferred<void>();
		const failure = new Error("resync exploded");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const timeoutLayer = layer("timeout", null, async () => false, async () => {
			resyncStarted.resolve();
			return timedOut.promise;
		});
		const throwingLayer = layer("throwing", null, async () => false, async () => {
			throw failure;
		});
		const hub = createChangeHub({ send, layerTimeoutMs: 25 });
		hub.register(timeoutLayer);
		hub.register(throwingLayer);
		const resyncPromise = hub.resync();
		await resyncStarted.promise;
		await vi.advanceTimersByTimeAsync(25);
		const result = await resyncPromise;

		expect(result.reconciled).toEqual([]);
		expect(warn).toHaveBeenCalledWith("[change-hub] layer timeout exceeded 25ms");
		expect(error).toHaveBeenCalledWith("[change-hub] layer throwing failed:", failure);
		timedOut.resolve(false);
		await hub.current();
		expect(messages).toHaveLength(0);
	});

	it("rejects duplicate layer registration", () => {
		const { send } = createMessages();
		const hub = createChangeHub({ send });
		hub.register(layer("duplicate", null));

		expect(() => hub.register(layer("duplicate", null))).toThrow("Duplicate layer id: duplicate");
	});
});
