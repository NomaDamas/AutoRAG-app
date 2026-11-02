// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../src/renderer/src/onboarding/Onboarding";
import { setAppLanguage } from "../src/shared/i18n";

// Onboarding captures window.autorag at import time, so install the bridge in the hoisted setup.
const bridge = vi.hoisted(() => {
	const settingsSet = vi.fn();
	const onboarding = {
		pending: true,
		load: vi.fn(),
		save: vi.fn(),
		permissions: vi.fn(),
		openFullDiskAccess: vi.fn(),
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
	bridge.onboarding.openFullDiskAccess.mockReset().mockResolvedValue(undefined);
	bridge.onboarding.folderCandidates.mockReset().mockResolvedValue([]);
	bridge.onboarding.embedding.mockReset().mockRejectedValue(new Error("not needed here"));
	bridge.onboarding.scanFolders.mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<Onboarding onComplete={() => undefined} />));
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	act(() => continueButton().click());
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function continueButton(): HTMLButtonElement {
	const element = host.querySelector<HTMLButtonElement>(".onb .footer .footer-actions button:last-child");
	if (element === null) throw new Error("no continue button");
	return element;
}

function openSettingsButton(): HTMLButtonElement {
	const element = host.querySelector<HTMLButtonElement>(".onb .permission-list button");
	if (element === null) throw new Error("no Full Disk Access settings button");
	return element;
}

describe("Full Disk Access onboarding", () => {
	it("opens System Settings immediately without showing a permission modal", () => {
		act(() => openSettingsButton().click());
		expect(bridge.onboarding.openFullDiskAccess).toHaveBeenCalledExactlyOnceWith();
		expect(host.querySelector(".onb .modal")).toBeNull();
		expect(host.querySelector(".onb .scrim")?.hasAttribute("hidden")).toBe(true);
	});

	it("then offers the restart a Full Disk Access grant needs, in the same row", () => {
		act(() => openSettingsButton().click());
		const row = host.querySelector(".onb .permission-list .permission-row");
		expect(row?.querySelector(".state.warn")).not.toBeNull();
		expect(row?.querySelectorAll("button")).toHaveLength(1);
	});

	it("has no separate link to a permission explanation modal", () => {
		expect(host.querySelector(".onb .permissions-why")).toBeNull();
	});
});
