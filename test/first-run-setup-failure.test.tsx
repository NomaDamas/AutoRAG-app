// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRun, type FirstRunHost } from "../src/renderer/src/first-run/FirstRun";
import { setAppLanguage } from "../src/shared/i18n";
import type { SetupStatus } from "../src/shared/onboarding-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const status = (patch: Partial<SetupStatus>): SetupStatus => ({
	stage: "scanning",
	progress: 6,
	remainingMinutes: null,
	totalFiles: 4,
	processedFiles: 0,
	recentFile: null,
	excludedFolders: 0,
	demo: null,
	error: null,
	startedAt: null,
	finishedAt: null,
	...patch,
});

const host: FirstRunHost = {
	arrange: vi.fn(),
	focusAi: vi.fn(),
	typeDraft: vi.fn(),
	showFamily: vi.fn(),
	versionFamilies: vi.fn(async () => []),
	setCovered: vi.fn(),
} as unknown as FirstRunHost;

let listeners: ((next: SetupStatus) => void)[] = [];
let container: HTMLDivElement;
let root: Root;
const errors: unknown[] = [];

beforeEach(async () => {
	await setAppLanguage("ko");
	listeners = [];
	errors.length = 0;
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		onboarding: {
			pending: true,
			load: vi.fn(async () => ({ pending: true })),
			status: vi.fn(async () => status({})),
			start: vi.fn(async () => status({})),
			onProgress: vi.fn((listener: (next: SetupStatus) => void) => {
				listeners.push(listener);
				return () => undefined;
			}),
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	Reflect.deleteProperty(globalThis, "autorag");
	vi.restoreAllMocks();
});

describe("the setup screen when the run fails", () => {
	it("swaps the progress bar for the retry panel instead of leaving the window blank", async () => {
		await act(async () => {
			root.render(<FirstRun host={host} onDone={() => undefined} />);
		});
		expect(container.querySelector('.fr-root[data-screen="setup"] [role="progressbar"]')).not.toBeNull();

		await act(async () => {
			for (const listener of listeners) listener(status({ stage: "failed", progress: 20, error: "EACCES: permission denied" }));
		});

		expect(container.querySelector('[data-action="setup-retry"]')).not.toBeNull();
		expect(container.querySelector('[role="progressbar"]')).toBeNull();
		expect(errors.flat().map(String).join(" ")).not.toMatch(/Rendered fewer hooks|Minified React error #300/);
	});
});
