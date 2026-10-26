// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../src/renderer/src/onboarding/Onboarding";
import { setAppLanguage } from "../src/shared/i18n";
import type { IndexingStatus } from "../src/shared/onboarding-contract";

// Onboarding captures `window.autorag` while it is imported, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const progress: { listener: ((status: unknown) => void) | null } = { listener: null };
	const onboarding = {
		pending: true,
		load: vi.fn(),
		save: vi.fn(),
		permissions: vi.fn(),
		folderCandidates: vi.fn(),
		embedding: vi.fn(),
		onScanProgress: () => () => undefined,
		onIndexProgress: (listener: (status: unknown) => void) => {
			progress.listener = listener;
			return () => undefined;
		},
		onSourceDetected: () => () => undefined,
		onSourcesDone: () => () => undefined,
		scanFolders: vi.fn(),
		detectSources: vi.fn(),
		detectModels: vi.fn(),
		complete: vi.fn(),
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		onboarding,
		settings: { set: vi.fn() },
		account: {
			onChanged: () => () => undefined,
			status: () => Promise.withResolvers<never>().promise,
			refresh: () => Promise.withResolvers<never>().promise,
			checkout: vi.fn(),
		},
		smartIndexing: { onEvent: () => () => undefined, cancel: vi.fn(), analyze: vi.fn() },
	});
	return { onboarding, progress };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
const onComplete = vi.fn();

beforeEach(async () => {
	await setAppLanguage("en");
	onComplete.mockReset();
	bridge.progress.listener = null;
	bridge.onboarding.load.mockReset().mockResolvedValue({ pending: true, draft: null });
	bridge.onboarding.save.mockReset().mockResolvedValue(undefined);
	bridge.onboarding.permissions.mockReset().mockResolvedValue({ platform: "darwin", fullDiskAccess: false, launchAtLogin: true, notificationsSupported: true });
	bridge.onboarding.folderCandidates.mockReset().mockResolvedValue([]);
	bridge.onboarding.embedding.mockReset().mockRejectedValue(new Error("not needed here"));
	bridge.onboarding.scanFolders.mockReset().mockResolvedValue(undefined);
	bridge.onboarding.complete.mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<Onboarding onComplete={onComplete} />));
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const status = (patch: Partial<IndexingStatus>): IndexingStatus => ({
	state: "running",
	phase: "parsed",
	progress: 10,
	remainingMinutes: null,
	totalFiles: 10,
	processedFiles: 1,
	recentFile: null,
	recentFolder: null,
	failure: null,
	skipped: 0,
	sources: [],
	startedAt: "2026-10-26T05:00:00.000Z",
	finishedAt: null,
	error: null,
	...patch,
});

const push = async (next: IndexingStatus): Promise<void> => {
	await act(async () => {
		bridge.progress.listener?.(next);
		await Promise.resolve();
	});
};

describe("finishing the first index", () => {
	it("completes onboarding by itself once the index succeeds, with nobody pressing anything", async () => {
		await push(status({ state: "running" }));
		expect(bridge.onboarding.complete).not.toHaveBeenCalled();
		await push(status({ state: "success", phase: "finalizing", progress: 100, processedFiles: 10, finishedAt: "2026-10-26T05:03:00.000Z" }));
		expect(bridge.onboarding.complete).toHaveBeenCalledOnce();
	});

	it("keeps onboarding open when the index stops: only a success completes it", async () => {
		await push(status({ state: "failed", failure: { reason: "unknown", folders: [], code: null }, error: "raw" }));
		expect(bridge.onboarding.complete).not.toHaveBeenCalled();
	});

	it("does not tear the window down on completion; the Finder is another window", async () => {
		await push(status({ state: "success", progress: 100, finishedAt: "2026-10-26T05:03:00.000Z" }));
		expect(onComplete).not.toHaveBeenCalled();
	});
});
