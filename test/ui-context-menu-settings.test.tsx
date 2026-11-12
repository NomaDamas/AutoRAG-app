// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWithRightSidebar } from "./support/settings-right-sidebar";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot, type DataSourcesSnapshot } from "../src/shared/settings-contract";
import { t } from "../src/shared/i18n/core";
import { pickSelectOption } from "./select-field-driver";

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
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
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
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
	const proto =
		el instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: el instanceof HTMLSelectElement
				? HTMLSelectElement.prototype
				: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
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
			contextMenu: patch.contextMenu ?? currentSettings.contextMenu,
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

describe("Settings → 우클릭 메뉴 (Context Menu customization & Magic Actions)", () => {
	it("renders Tags locked on, toggles built-in items & presets, reorders sections, and adds/edits/removes custom Magic Actions", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
		});
		await settle();

		// Nav item exists and is active
		const navButtons = [...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
		expect(navButtons.some((btn) => btn.textContent?.includes("우클릭 메뉴") && btn.classList.contains("is-active"))).toBe(true);

		// Tags item switch & section switch are checked and disabled (locked)
		const tagsItemSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="builtin:tags"]');
		const tagsSectionSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="cmenu-section:tags"]');
		expect(tagsItemSwitch?.disabled).toBe(true);
		expect(tagsItemSwitch?.getAttribute("aria-checked")).toBe("true");
		expect(tagsSectionSwitch?.disabled).toBe(true);
		expect(tagsSectionSwitch?.getAttribute("aria-checked")).toBe("true");

		// Toggling 7z로 압축 hides `builtin:compress7z`
		const c7zSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="builtin:compress7z"]');
		expect(c7zSwitch?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			c7zSwitch?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.hiddenItems).toEqual(["builtin:compress7z"]);

		// Move `magic` section to the very top
		const moveMagicUp = host.querySelector<HTMLButtonElement>('[data-action="move-cmenu-section-up-magic"]');
		await act(async () => {
			moveMagicUp?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.sectionOrder[0]).toBe("magic");

		// Open Magic Action editor modal and create a single-file PDF AI summary action
		const addBtn = host.querySelector<HTMLButtonElement>('[data-action="add-magic-action"]');
		await act(async () => {
			addBtn?.click();
		});
		await settle();

		const editor = document.querySelector('[data-testid="magic-action-editor-modal"]');
		expect(editor).not.toBeNull();
		// Skills & MCP switches default to ON (`aria-checked="true"`)
		const skillsSwitch = editor!.querySelector<HTMLButtonElement>('[data-sidebar-switch="magic-editor:useSkills"]');
		const mcpSwitch = editor!.querySelector<HTMLButtonElement>('[data-sidebar-switch="magic-editor:useMcp"]');
		expect(skillsSwitch?.getAttribute("aria-checked")).toBe("true");
		expect(mcpSwitch?.getAttribute("aria-checked")).toBe("true");

		await act(async () => {
			setInputValue(editor!.querySelector<HTMLInputElement>('[data-testid="magic-editor-label"]')!, "PDF 3줄 요약");
			setInputValue(editor!.querySelector<HTMLTextAreaElement>('[data-testid="magic-editor-prompt"]')!, "핵심 3줄 요약해줘");
			setInputValue(editor!.querySelector<HTMLInputElement>('[data-testid="magic-editor-extensions"]')!, ".pdf, md");
		});
		await pickSelectOption(editor!.querySelector('[data-testid="magic-editor-selection"]'), t("settingsCore.contextMenu.condSingle"));
		await settle();

		await act(async () => {
			editor!.querySelector<HTMLButtonElement>('[data-action="save-magic-editor"]')?.click();
		});
		await settle();

		expect(currentSettings.contextMenu.magicActions).toHaveLength(1);
		expect(currentSettings.contextMenu.magicActions[0]).toMatchObject({
			label: "PDF 3줄 요약",
			selection: "single",
			targetKind: "file",
			extensions: ["pdf", "md"],
			execution: { kind: "agent", mode: "read", prompt: "핵심 3줄 요약해줘", useSkills: true, useMcp: true },
		});

		const actionId = currentSettings.contextMenu.magicActions[0]!.id;
		expect(host.querySelector(`[data-magic-row="${actionId}"]`)?.textContent).toContain("MCP");

		// Edit the Magic Action and toggle MCP off
		await act(async () => {
			host.querySelector<HTMLButtonElement>(`[data-action="edit-magic-${actionId}"]`)?.click();
		});
		await settle();
		const editModal = document.querySelector('[data-testid="magic-action-editor-modal"]');
		await act(async () => {
			editModal?.querySelector<HTMLButtonElement>('[data-sidebar-switch="magic-editor:useMcp"]')?.click();
		});
		await settle();
		await act(async () => {
			editModal?.querySelector<HTMLButtonElement>('[data-action="save-magic-editor"]')?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.magicActions[0]?.execution).toMatchObject({
			kind: "agent",
			useSkills: true,
			useMcp: false,
		});
		// Remove Magic Action
		await act(async () => {
			host.querySelector<HTMLButtonElement>(`[data-action="remove-magic-${actionId}"]`)?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.magicActions).toHaveLength(0);
	});

	it("lists 사이드바에 고정 / 제거 in the actions section and shows or hides it on its own", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
		});
		await settle();

		const row = host.querySelector<HTMLElement>('[data-cmenu-row="builtin:pinToSidebar"]');
		expect(row?.textContent).toContain("사이드바에 고정 / 제거");
		const rows = [...host.querySelectorAll<HTMLElement>("[data-cmenu-row]")].map((entry) => entry.dataset.cmenuRow);
		expect(rows.indexOf("builtin:pinToSidebar")).toBe(rows.indexOf("builtin:newFolder") + 1);

		const pinSwitch = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[data-sidebar-switch="builtin:pinToSidebar"]');
		expect(pinSwitch()?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			pinSwitch()?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.hiddenItems).toEqual(["builtin:pinToSidebar"]);
		expect(pinSwitch()?.getAttribute("aria-checked")).toBe("false");

		await act(async () => {
			pinSwitch()?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.hiddenItems).toEqual([]);
	});

	it("docks the AI Customizer panel in contextMenu mode with context-menu prompt suggestions and applies agent changes", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
		});
		await settle();

		const panel = host.querySelector('[data-testid="app-customizer-panel"]:not([hidden])');
		expect(panel).not.toBeNull();
		expect(panel?.getAttribute("data-surface")).toBe("contextMenu");
		expect(panel?.textContent).toContain("세 줄로 요약");

		const suggestion = panel?.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]');
		await act(async () => {
			suggestion?.click();
		});
		await settle();

		expect(bridge.appCustomizer.send).toHaveBeenCalledTimes(1);
		const [runId, req] = bridge.appCustomizer.send.mock.calls[0] as [string, { sessionId: string; message: string }];

		const nextSettings: AppSettings = {
			...currentSettings,
			contextMenu: {
				...currentSettings.contextMenu,
				magicActions: [
					{
						id: "pdf-3-summary",
						label: "PDF 3줄 요약",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["pdf", "md"],
						execution: { kind: "agent", mode: "read", prompt: "3줄 요약" },
					},
				],
			},
		};
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "turn-done",
				runId,
				sessionId: req.sessionId,
				messages: ["PDF 3줄 요약 매직 액션을 추가했습니다."],
				changes: [{ kind: "contextMenu", summary: "매직 액션 저장: PDF 3줄 요약", fields: ["contextMenu.magicActions"] }],
				settings: nextSettings,
			});
		});
		await settle();

		expect(host.textContent).toContain("PDF 3줄 요약");
	});

	it("displays customized shortcut keycaps and Windows PowerShell guidance on win32", async () => {
		const prevBridge: unknown = Reflect.get(globalThis, "autorag");
		Reflect.set(globalThis, "autorag", { ...(typeof prevBridge === "object" && prevBridge !== null ? prevBridge : {}), platform: "win32" });
		try {
			currentSettings = {
				...currentSettings,
				shortcuts: { overrides: { quickLook: "Alt+P", rename: "F2" } },
			};
			await act(async () => {
				root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
			});
			await settle();

			expect(host.querySelector('[data-cmenu-row="builtin:quickLook"]')?.textContent).toContain("Alt+P");
			expect(host.querySelector('[data-cmenu-row="builtin:rename"]')?.textContent).toContain("F2");

			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="add-magic-action"]')?.click();
			});
			await settle();
			const editor = document.body.querySelector('[data-testid="magic-action-editor-modal"]')!;
			await pickSelectOption(editor.querySelector('[data-testid="magic-editor-kind"]'), t("settingsCore.contextMenu.editor.kindScript"));
			await settle();

			const cmdInput = editor.querySelector<HTMLTextAreaElement>('[data-testid="magic-editor-command"]')!;
			expect(cmdInput.getAttribute("placeholder")).toContain("Get-FileHash");
			expect(editor.textContent).toContain("PowerShell");
			expect(editor.textContent).not.toContain('"$@"');
		} finally {
			Reflect.set(globalThis, "autorag", prevBridge);
		}
	});
});
