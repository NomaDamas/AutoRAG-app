// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../src/renderer/src/onboarding/Onboarding";
import { setAppLanguage } from "../src/shared/i18n";

// Onboarding captures `window.autorag` while it is imported, so the bridge must exist first.
// Its functions are re-armed per test; the object identity is what the module captured.
const bridge = vi.hoisted(() => {
	const settingsSet = vi.fn();
	const onboarding = {
		pending: true,
		load: vi.fn(),
		save: vi.fn(),
		permissions: vi.fn(),
		folderCandidates: vi.fn(),
		embedding: vi.fn(),
		onScanProgress: () => () => undefined,
		onIndexProgress: () => () => undefined,
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
		settings: { set: settingsSet },
		account: {
			onChanged: () => () => undefined,
			status: () => new Promise(() => undefined),
			refresh: () => new Promise(() => undefined),
			checkout: vi.fn(),
		},
		smartIndexing: { onEvent: () => () => undefined, cancel: vi.fn(), analyze: vi.fn() },
	});
	return { onboarding, settingsSet };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.settingsSet.mockReset().mockResolvedValue(undefined);
	bridge.onboarding.load.mockReset().mockResolvedValue({ pending: true, draft: null });
	bridge.onboarding.save.mockReset().mockResolvedValue(undefined);
	bridge.onboarding.permissions.mockReset().mockResolvedValue({ platform: "darwin", fullDiskAccess: false, launchAtLogin: true, notificationsSupported: true });
	bridge.onboarding.folderCandidates.mockReset().mockResolvedValue([]);
	bridge.onboarding.embedding.mockReset().mockRejectedValue(new Error("not needed here"));
	bridge.onboarding.scanFolders.mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

/** Render the shell and let the first `load()` answer land, so the welcome step is on screen. */
async function openWelcome(): Promise<void> {
	act(() => root.render(<Onboarding onComplete={() => undefined} />));
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const consents = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>(".onb .usage-consent input[type=checkbox]")];
const continueButton = (): HTMLButtonElement => {
	const element = host.querySelector<HTMLButtonElement>(".onb .footer button.primary");
	if (element === null) throw new Error("no continue button");
	return element;
};

describe("the welcome step's privacy choices", () => {
	it("starts with both anonymous usage statistics and error reports ticked", async () => {
		await openWelcome();
		expect(consents()).toHaveLength(2);
		expect(consents().map((box) => box.checked)).toEqual([true, true]);
	});

	it("saves both as on when the user continues without touching them", async () => {
		await openWelcome();
		act(() => continueButton().click());
		expect(bridge.settingsSet).toHaveBeenCalledExactlyOnceWith({ usageAnalytics: true, errorReporting: true });
	});

	it("keeps each choice independent: a box the user unticked is saved as off", async () => {
		await openWelcome();
		act(() => consents()[0]?.click());
		expect(consents().map((box) => box.checked)).toEqual([false, true]);
		act(() => continueButton().click());
		expect(bridge.settingsSet).toHaveBeenCalledExactlyOnceWith({ usageAnalytics: false, errorReporting: true });
	});

	it("saves nothing while the user has not continued, so a pre-ticked box alone consents to nothing", async () => {
		await openWelcome();
		expect(consents().map((box) => box.checked)).toEqual([true, true]);
		expect(bridge.settingsSet).not.toHaveBeenCalled();
	});
});
