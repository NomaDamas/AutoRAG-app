// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/renderer/src/components/SettingsView";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot, type DataSourcesSnapshot } from "../src/shared/settings-contract";

const bridge = vi.hoisted(() => {
	const settingsListeners = new Set<(settings: AppSettings) => void>();
	const customizerListeners = new Set<(event: AppCustomizerEvent) => void>();
	const settings = {
		get: vi.fn(),
		set: vi.fn(),
		onChanged: (fn: (s: AppSettings) => void) => {
			settingsListeners.add(fn);
			return () => settingsListeners.delete(fn);
		},
		configGet: vi.fn(),
		sourcesList: vi.fn(),
		refreshScheduleGet: vi.fn(),
	};
	const fs = {
		locations: vi.fn(),
		tags: vi.fn(),
	};
	const appCustomizer = {
		send: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
		onEvent: (fn: (event: AppCustomizerEvent) => void) => {
			customizerListeners.add(fn);
			return () => customizerListeners.delete(fn);
		},
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings,
		fs,
		appCustomizer,
		appUpdate: { get: () => Promise.withResolvers<never>().promise, onChange: () => () => undefined },
	});
	return {
		settings,
		fs,
		appCustomizer,
		emitCustomizerEvent: (event: AppCustomizerEvent) => {
			for (const fn of customizerListeners) fn(event);
		},
		clearListeners: () => {
			settingsListeners.clear();
			customizerListeners.clear();
		},
	};
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: AutoRagConfigSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	config: { datasources: {}, searchPaths: ["/docs"] },
};

const SOURCES: DataSourcesSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	refresh: { state: "idle", phase: null, finishedAt: null },
	local: { documentCount: 0, updatedAt: null },
	sources: [],
};

let host: HTMLDivElement;
let root: Root;
let currentSettings: AppSettings;

function settle(): Promise<void> {
	return act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

beforeEach(async () => {
	await setAppLanguage("ko");
	currentSettings = structuredClone(DEFAULT_SETTINGS);
	bridge.clearListeners();
	bridge.settings.get.mockReset().mockImplementation(async () => currentSettings);
	bridge.settings.set.mockReset().mockImplementation(async (patch: Partial<AppSettings>) => {
		currentSettings = {
			...currentSettings,
			...patch,
			sidebar: patch.sidebar ?? currentSettings.sidebar,
			shortcuts: patch.shortcuts ?? currentSettings.shortcuts,
		};
		return currentSettings;
	});
	bridge.settings.configGet.mockReset().mockResolvedValue(CONFIG);
	bridge.settings.sourcesList.mockReset().mockResolvedValue(SOURCES);
	bridge.settings.refreshScheduleGet.mockReset().mockResolvedValue({});
	bridge.fs.locations.mockReset().mockResolvedValue([]);
	bridge.fs.tags.mockReset().mockResolvedValue({ supported: true, colorNames: [], colorsDenied: false, tags: [] });
	bridge.appCustomizer.send.mockReset().mockResolvedValue(undefined);
	bridge.appCustomizer.cancel.mockReset().mockResolvedValue(undefined);
	bridge.appCustomizer.reset.mockReset().mockResolvedValue(undefined);

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

describe("Settings → 단축키 (Key-press recording, UI editing, conflict swap, and AI Shortcut Customizer modal)", () => {
	it("records a shortcut by pressing keys directly, cancels on Escape, and swaps on conflict", async () => {
		await act(async () => {
			root.render(<SettingsView initialCategory={"shortcuts" as never} />);
		});
		await settle();

		// Locked Esc row is present
		const lockedRow = host.querySelector('[data-shortcut-row="dismiss"]');
		expect(lockedRow).not.toBeNull();

		// Click key-press recorder on 'rename' (default ⌘R)
		const renameRecordBtn = host.querySelector<HTMLButtonElement>('[data-shortcut-record="rename"]');
		expect(renameRecordBtn).not.toBeNull();
		expect(renameRecordBtn?.textContent).toContain("⌘R");

		await act(async () => {
			renameRecordBtn?.click();
		});

		// Press Escape -> cancels recording without saving
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
		});
		expect(bridge.settings.set).not.toHaveBeenCalled();

		// Enter recording again and press ⌘⇧P (even with Korean IME glyph 'ㅍ' on KeyP)
		await act(async () => {
			renameRecordBtn?.click();
		});
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ㅍ",
					code: "KeyP",
					metaKey: true,
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		await settle();

		expect(currentSettings.shortcuts.overrides.rename).toBe("Mod+Shift+P");
		expect(host.querySelector('[data-shortcut-record="rename"]')?.textContent).toContain("⌘⇧P");

		// Record conflicting chord ⌘D (used by duplicate) -> shows conflict notice + swap button
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-shortcut-record="rename"]')?.click();
		});
		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "d",
					code: "KeyD",
					metaKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		await settle();

		const swapBtn = host.querySelector<HTMLButtonElement>('[data-action="swap-shortcut-conflict"]');
		expect(swapBtn).not.toBeNull();

		await act(async () => {
			swapBtn?.click();
		});
		await settle();

		expect(currentSettings.shortcuts.overrides.rename).toBe("Mod+D");
		expect(currentSettings.shortcuts.overrides.duplicate).toBe("Mod+Shift+P");
	});

	it("supports pointer-only UI editing with modifier toggles and key selector, plus per-row and full reset", async () => {
		await act(async () => {
			root.render(<SettingsView initialCategory={"shortcuts" as never} />);
		});
		await settle();

		const uiEditBtn = host.querySelector<HTMLButtonElement>('[data-shortcut-ui-edit="focusSearch"]');
		expect(uiEditBtn).not.toBeNull();

		await act(async () => {
			uiEditBtn?.click();
		});

		// Toggle Shift modifier on and select key 'P'
		const shiftChip = host.querySelector<HTMLButtonElement>('[data-shortcut-mod="shift"]');
		const keySelect = host.querySelector<HTMLSelectElement>('[data-testid="shortcut-key-select"]');
		expect(shiftChip).not.toBeNull();
		expect(keySelect).not.toBeNull();

		await act(async () => {
			shiftChip?.click();
		});
		await act(async () => {
			if (keySelect !== null) {
				keySelect.value = "P";
				keySelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="save-ui-shortcut"]')?.click();
		});
		await settle();

		expect(currentSettings.shortcuts.overrides.focusSearch).toBe("Mod+Shift+P");

		// Per-row reset restores focusSearch to ⌘F
		const resetRowBtn = host.querySelector<HTMLButtonElement>('[data-action="reset-shortcut-focusSearch"]');
		expect(resetRowBtn).not.toBeNull();
		await act(async () => {
			resetRowBtn?.click();
		});
		await settle();
		expect(currentSettings.shortcuts.overrides.focusSearch).toBeUndefined();
	});

	it("renders the three quick presets (Mac Finder, Windows File Explorer, Default) and switches cleanly between them", async () => {
		await act(async () => {
			root.render(<SettingsView initialCategory={"shortcuts" as never} />);
		});
		await settle();

		const presetButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sidebar-presets-bar .sidebar-preset-pill"));
		expect(presetButtons.map((btn) => btn.getAttribute("data-action"))).toEqual([
			"shortcuts-preset-mac-finder",
			"shortcuts-preset-windows-explorer",
			"shortcuts-preset-default",
		]);
		expect(presetButtons[2]?.classList.contains("is-active")).toBe(true);

		await act(async () => {
			presetButtons[0]?.click();
		});
		await settle();
		expect(currentSettings.shortcuts.overrides.rename).toBe("Enter");
		expect(currentSettings.shortcuts.overrides.trash).toBe("Mod+Backspace");
		expect(host.querySelector('[data-action="shortcuts-preset-mac-finder"]')?.classList.contains("is-active")).toBe(true);

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="shortcuts-preset-windows-explorer"]')?.click();
		});
		await settle();
		expect(currentSettings.shortcuts.overrides.rename).toBe("F2");
		expect(currentSettings.shortcuts.overrides.editPath).toBe("Alt+D");
		expect(host.querySelector('[data-action="shortcuts-preset-windows-explorer"]')?.classList.contains("is-active")).toBe(true);

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="shortcuts-preset-default"]')?.click();
		});
		await settle();
		expect(currentSettings.shortcuts.overrides).toEqual({});
		expect(host.querySelector('[data-action="shortcuts-preset-default"]')?.classList.contains("is-active")).toBe(true);
	});

	it("clears any pending conflict banner when switching to a Quick Preset", async () => {
		await act(async () => {
			root.render(<SettingsView initialCategory={"shortcuts" as never} />);
		});
		await settle();

		// Trigger a conflict banner on focusSearch by pressing ⌘V (bound to paste)
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-shortcut-record="focusSearch"]')?.click();
		});
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", metaKey: true, bubbles: true, cancelable: true }));
		});
		await settle();
		expect(host.querySelector('[data-action="swap-shortcut-conflict"]')).not.toBeNull();

		// Clicking Windows File Explorer preset clears the stale conflict banner immediately
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="shortcuts-preset-windows-explorer"]')?.click();
		});
		await settle();
		expect(host.querySelector('[data-action="swap-shortcut-conflict"]')).toBeNull();
	});
	it("opens the AI Shortcut Customizer modal with surface='shortcuts' and applies agent updates live", async () => {
		await act(async () => {
			root.render(<SettingsView initialCategory={"shortcuts" as never} />);
		});
		await settle();

		const openModalBtn = host.querySelector<HTMLButtonElement>('[data-action="open-shortcut-customizer"]');
		expect(openModalBtn).not.toBeNull();
		await act(async () => {
			openModalBtn?.click();
		});

		const modal = document.body.querySelector('[data-testid="app-customizer-modal"]');
		expect(modal).not.toBeNull();

		const suggestionChip = modal?.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]');
		expect(suggestionChip).not.toBeNull();
		await act(async () => {
			suggestionChip?.click();
		});

		expect(bridge.appCustomizer.send).toHaveBeenCalledTimes(1);
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] as [string, { sessionId: string; surface?: string; message: string }];
		expect(request.surface).toBe("shortcuts");

		const updatedSettings: AppSettings = {
			...currentSettings,
			shortcuts: { overrides: { rename: "F2" } },
		};
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "turn-done",
				runId,
				sessionId: request.sessionId,
				reply: "이름 변경 단축키를 F2로 설정했습니다.",
				changes: [{ kind: "shortcuts", summary: "단축키 변경 (이름 변경)", fields: ["shortcuts.overrides.rename"] }],
				settings: updatedSettings,
			});
		});
		await settle();

		expect(host.querySelector('[data-shortcut-record="rename"]')?.textContent).toContain("F2");
	});
});
