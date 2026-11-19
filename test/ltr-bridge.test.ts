import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcRenderer, IpcRendererEvent } from "electron";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	app: { getPath: () => "/tmp" },
	BrowserWindow: { getAllWindows: () => [] },
	nativeImage: {},
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, handler);
		},
	},
}));

import { registerLtrIpcHandlers } from "../src/main/ipc";
import { buildRemoteBootstrapScript } from "../src/main/remote/bootstrap";
import { createLtrBridge } from "../src/preload/ltr-bridge";
import { EMPTY_LTR_SNAPSHOT, LTR_CHANNELS, type LtrBridge, type LtrSnapshot, type LtrTrainOutcome } from "../src/shared/ltr-contract";
import type { LtrService } from "../src/main/ltr-service";

function service(overrides: Partial<LtrService> = {}): LtrService {
	return {
		get: vi.fn(async () => EMPTY_LTR_SNAPSHOT),
		train: vi.fn(async () => ({ status: "insufficient-data", reason: "0 usable", model: null, eligibleRuns: 0, loggedRuns: 0, snapshot: EMPTY_LTR_SNAPSHOT }) satisfies LtrTrainOutcome),
		deleteModel: vi.fn(async () => EMPTY_LTR_SNAPSHOT),
		autoTrainIfDue: vi.fn(async () => null),
		...overrides,
	};
}

function call(channel: string, ...args: unknown[]): unknown {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args);
}

beforeEach(() => handlers.clear());

describe("registerLtrIpcHandlers", () => {
	it("serves the snapshot, a training run and a deletion from the service", async () => {
		const ltr = service();
		registerLtrIpcHandlers(ltr);

		await expect(call(LTR_CHANNELS.get)).resolves.toBe(EMPTY_LTR_SNAPSHOT);
		await expect(call(LTR_CHANNELS.train)).resolves.toMatchObject({ status: "insufficient-data" });
		await call(LTR_CHANNELS.deleteModel, "xgb-1");

		expect(ltr.get).toHaveBeenCalledTimes(1);
		expect(ltr.train).toHaveBeenCalledTimes(1);
		expect(ltr.deleteModel).toHaveBeenCalledWith("xgb-1");
	});

	it("refuses a model id that is not a string before the service sees it", () => {
		const ltr = service();
		registerLtrIpcHandlers(ltr);

		for (const bad of [undefined, null, 7, {}, [], ""]) {
			expect(() => call(LTR_CHANNELS.deleteModel, bad)).toThrow(/model id/iu);
		}
		expect(ltr.deleteModel).not.toHaveBeenCalled();
	});

	it("ignores extra arguments a compromised renderer might add to a call", async () => {
		const ltr = service();
		registerLtrIpcHandlers(ltr);

		await call(LTR_CHANNELS.train, "--evil", { x: 1 });
		await call(LTR_CHANNELS.get, "--evil");

		expect(ltr.train).toHaveBeenCalledWith();
		expect(ltr.get).toHaveBeenCalledWith();
	});
});

describe("createLtrBridge", () => {
	function renderer(): { readonly ipc: IpcRenderer; readonly invoke: ReturnType<typeof vi.fn>; readonly emit: (channel: string, payload: unknown) => void } {
		const invoke = vi.fn(async () => EMPTY_LTR_SNAPSHOT);
		const listeners = new Map<string, Set<(event: IpcRendererEvent, payload: unknown) => void>>();
		const ipc = {
			invoke,
			on: (channel: string, listener: (event: IpcRendererEvent, payload: unknown) => void) => {
				let set = listeners.get(channel);
				if (set === undefined) listeners.set(channel, (set = new Set()));
				set.add(listener);
			},
			removeListener: (channel: string, listener: (event: IpcRendererEvent, payload: unknown) => void) => listeners.get(channel)?.delete(listener),
		} as unknown as IpcRenderer;
		return { ipc, invoke, emit: (channel, payload) => listeners.get(channel)?.forEach((listener) => listener({} as IpcRendererEvent, payload)) };
	}

	it("maps each method to its channel", async () => {
		const { ipc, invoke } = renderer();
		const bridge: LtrBridge = createLtrBridge(ipc);

		await bridge.get();
		await bridge.train();
		await bridge.deleteModel("xgb-1");

		expect(invoke.mock.calls).toEqual([[LTR_CHANNELS.get], [LTR_CHANNELS.train], [LTR_CHANNELS.deleteModel, "xgb-1"]]);
	});

	it("hands the listener the running flag and returns a working unsubscribe", () => {
		const { ipc, emit } = renderer();
		const bridge = createLtrBridge(ipc);
		const seen: boolean[] = [];

		const stop = bridge.onTraining((running) => seen.push(running));
		emit(LTR_CHANNELS.training, true);
		emit(LTR_CHANNELS.training, false);
		stop();
		emit(LTR_CHANNELS.training, true);

		expect(seen).toEqual([true, false]);
	});
});

describe("remote browser sessions", () => {
	it("get the same ltr bridge as the desktop window", () => {
		const script = buildRemoteBootstrapScript({ token: "T", platform: "darwin", appearance: "light", language: "en", version: "0.1.0" });

		expect(script).toContain('"ltr"');
		expect(script).toContain(LTR_CHANNELS.training);
	});
});

// The snapshot type is part of what the page renders; keep one literal here so a contract change is a compile error.
const _snapshot: LtrSnapshot = EMPTY_LTR_SNAPSHOT;
void _snapshot;
