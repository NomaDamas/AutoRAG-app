// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWithRightSidebar } from "./support/settings-right-sidebar";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot, type DataSourcesSnapshot } from "../src/shared/settings-contract";
import { t } from "../src/shared/i18n/core";

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
	const magicAction = {
		verify: vi.fn(),
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings,
		fs,
		appCustomizer,
		magicAction,
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return {
		settings,
		fs,
		appCustomizer,
		magicAction,
		emitSettingsChanged: (next: AppSettings) => {
			for (const fn of settingsListeners) fn(next);
		},
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
	bridge.magicAction.verify.mockReset();

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

		// Move `magic` section to the very top: its drag handle also moves it with ↑
		const magicGrip = host.querySelector<HTMLButtonElement>('[data-cmenu-section-grip="magic"]');
		expect(magicGrip).not.toBeNull();
		await act(async () => {
			magicGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
		});
		await settle();
		expect(currentSettings.contextMenu.sectionOrder[0]).toBe("magic");

		// 매직 액션 만들기 opens the new-action card in the assistant beside the page (the 자동화 form set to 우클릭하면), not a modal.
		const addBtn = host.querySelector<HTMLButtonElement>('[data-action="add-magic-action"]');
		await act(async () => {
			addBtn?.click();
		});
		await settle();
		expect(document.querySelector('[data-testid="magic-action-editor-modal"]')).toBeNull();
		const starter = document.querySelector('[data-magic-starter]');
		expect(starter?.textContent).toContain(t("settingsCore.contextMenu.assistant.starterUser"));
		const card = starter!.querySelector('[data-automation-request]')!;
		// The trigger is fixed here (plain text, no chip), and a new action has no permission chip.
		expect(card.querySelector('[data-testid="automation-request-rc-event"]')?.textContent).toBe(t("rightClickWhen.event"));
		expect(card.querySelector('[data-testid="automation-request-event"]')).toBeNull();
		expect(card.querySelector('[data-testid="magic-editor-agent-mode"]')).toBeNull();

		await act(async () => {
			setInputValue(card.querySelector<HTMLTextAreaElement>('[data-testid="automation-request-task"]')!, "PDF 3줄 요약");
		});
		// The file-kind chip takes a typed extension list: Enter turns it into the chip's label. Its menu opens in a layer of its own.
		await act(async () => {
			card.querySelector<HTMLButtonElement>('[data-testid="automation-request-rc-kind"]')?.click();
		});
		await act(async () => {
			setInputValue(document.querySelector<HTMLInputElement>('[data-testid="automation-request-rc-ext"]')!, ".pdf, md");
		});
		await act(async () => {
			document.querySelector<HTMLInputElement>('[data-testid="automation-request-rc-ext"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(card.querySelector('[data-testid="automation-request-rc-kind"]')?.textContent).toBe(t("rightClickWhen.custom", { exts: "PDF/MD" }));
		expect(card.querySelector('[data-testid="automation-request-rc-count"]')?.textContent).toBe(t("rightClickWhen.count.single"));
		await act(async () => {
			card.querySelector<HTMLButtonElement>('[data-action="automation-request-add"]')?.click();
		});
		await settle();
		// Submitting the starter card hands the request to the Settings assistant so it verifies in a sandbox and saves via tool call.
		expect(bridge.appCustomizer.send).toHaveBeenCalledTimes(1);
		expect(bridge.appCustomizer.send.mock.calls[0]?.[1]).toMatchObject({
			surface: "contextMenu",
			message: expect.stringContaining("PDF 3줄 요약"),
		});
		// Simulate the Settings assistant saving the verified right-click automation, then re-sync settings state.
		await act(async () => {
			await bridge.settings.set({
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
							execution: { kind: "agent", mode: "read", prompt: "PDF 3줄 요약", useSkills: true, useMcp: true },
						},
					],
				},
			});
			bridge.emitSettingsChanged(currentSettings);
		});
		await settle();

		expect(currentSettings.contextMenu.magicActions).toHaveLength(1);
		expect(currentSettings.contextMenu.magicActions[0]).toMatchObject({
			label: "PDF 3줄 요약",
			selection: "single",
			targetKind: "file",
			extensions: ["pdf", "md"],
			execution: { kind: "agent", mode: "read", prompt: "PDF 3줄 요약" },
		});

		const actionId = currentSettings.contextMenu.magicActions[0]!.id;
		expect(host.querySelector(`[data-magic-row="${actionId}"]`)?.textContent).not.toContain("MCP");

		// 나만의 매직 액션 edits (수정 · 삭제, no switch); 우클릭 메뉴 섹션 및 항목 only turns it on or off. Neither shows a kind badge.
		const [cardRow, sectionRow] = [...host.querySelectorAll<HTMLElement>(`[data-magic-row="${actionId}"]`)];
		expect(cardRow?.querySelector(`[data-action="edit-magic-${actionId}"]`)).not.toBeNull();
		expect(cardRow?.querySelector(`[data-action="remove-magic-${actionId}"]`)).not.toBeNull();
		expect(cardRow?.querySelector(`[data-sidebar-switch="magic:${actionId}"]`)).toBeNull();
		expect(sectionRow?.querySelector(`[data-sidebar-switch="magic:${actionId}"]`)).not.toBeNull();
		expect(sectionRow?.querySelector("button[data-action]")).toBeNull();
		expect(sectionRow?.textContent).toBe("PDF 3줄 요약");
		expect(host.querySelector(".sidebar-always-badge.is-plain")).toBeNull();

		// Editing shows the permission chip; allowing file changes keeps the skills and MCP the action had.
		await act(async () => {
			host.querySelector<HTMLButtonElement>(`[data-action="edit-magic-${actionId}"]`)?.click();
		});
		await settle();
		const editModal = document.querySelector('[data-testid="magic-action-editor-modal"]');
		expect(editModal?.querySelector('[data-testid="magic-editor-rc-kind"]')?.textContent).toBe(t("rightClickWhen.custom", { exts: "PDF/MD" }));
		await act(async () => {
			editModal?.querySelector<HTMLButtonElement>('[data-testid="magic-editor-agent-mode"]')?.click();
		});
		await act(async () => {
			document.querySelector<HTMLButtonElement>('[data-testid="magic-editor-agent-mode-organize"]')?.click();
		});
		await settle();
		await act(async () => {
			editModal?.querySelector<HTMLButtonElement>('[data-action="save-magic-editor"]')?.click();
		});
		await settle();
		expect(currentSettings.contextMenu.magicActions).toHaveLength(1);
		expect(currentSettings.contextMenu.magicActions[0]?.id).toBe(actionId);
		expect(currentSettings.contextMenu.magicActions[0]?.execution).toMatchObject({
			kind: "agent",
			mode: "organize",
			useSkills: true,
			useMcp: true,
		});
		// Remove Magic Action: the X asks first; 취소 keeps it, 삭제 removes it.
		const askRemove = async (): Promise<void> => {
			await act(async () => {
				host.querySelector<HTMLButtonElement>(`[data-action="remove-magic-${actionId}"]`)?.click();
			});
		};
		await askRemove();
		expect(document.body.textContent).toContain("‘PDF 3줄 요약’ 자동화를 삭제할까요?");
		expect(currentSettings.contextMenu.magicActions).toHaveLength(1);
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>(".linear-btn")].find((button) => button.textContent === "취소")?.click();
		});
		expect(document.querySelector('[data-action="confirm-remove-magic"]')).toBeNull();
		expect(currentSettings.contextMenu.magicActions).toHaveLength(1);
		await askRemove();
		await act(async () => {
			document.querySelector<HTMLButtonElement>('[data-action="confirm-remove-magic"]')?.click();
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
		// The welcome rises in like chat messages: the mark, title, line and first suggestion together (step 0), then each next suggestion one step later.
		const step = (element: Element | null | undefined): string | undefined => (element as HTMLElement | null | undefined)?.style.getPropertyValue("--rise-i");
		expect(["orb", "title", "desc"].map((part) => step(panel?.querySelector(`.customizer-panel__empty-${part}.customizer-rise`)))).toEqual(["0", "0", "0"]);
		const chips = [...(panel?.querySelectorAll('[data-action="customizer-suggestion"]') ?? [])];
		expect(chips.length).toBeGreaterThan(1);
		expect(chips.map(step)).toEqual(chips.map((_, index) => String(index)));

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
				messages: ["PDF 3줄 요약 자동화를 추가했습니다."],
				changes: [{ kind: "contextMenu", summary: "자동화 저장: PDF 3줄 요약", fields: ["contextMenu.magicActions"] }],
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
				contextMenu: {
					...currentSettings.contextMenu,
					magicActions: [{ id: "hash", label: "해시 보기", enabled: true, selection: "single", targetKind: "file", extensions: [], execution: { kind: "script", command: "Get-FileHash $args[0]" } }],
				},
			};
			await act(async () => {
				root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
			});
			await settle();

			expect(host.querySelector('[data-cmenu-row="builtin:quickLook"]')?.textContent).toContain("Alt+P");
			expect(host.querySelector('[data-cmenu-row="builtin:rename"]')?.textContent).toContain("F2");

			// A script automation (made by the assistant) is edited as one: no AI | 스크립트 choice, the command in PowerShell.
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="edit-magic-hash"]')?.click();
			});
			await settle();
			const editModal = document.querySelector('[data-testid="magic-action-editor-modal"]')!;
			expect(editModal.querySelector('[data-testid="magic-editor-kind"]')).toBeNull();
			const cmdInput = editModal.querySelector<HTMLTextAreaElement>('[data-testid="magic-editor-command"]')!;
			expect(cmdInput.value).toBe("Get-FileHash $args[0]");
			expect(cmdInput.getAttribute("placeholder")).toContain("Get-FileHash");
			expect(cmdInput.getAttribute("placeholder")).not.toContain('"$@"');
		} finally {
			Reflect.set(globalThis, "autorag", prevBridge);
		}
	});

	it("lets the user test a Magic Action in a temporary folder inside the editor modal and shows pass/fail + diff", async () => {
		bridge.magicAction.verify
			.mockResolvedValueOnce({
				ok: false,
				executionKind: "script",
				exitCode: 127,
				timedOut: false,
				durationMs: 25,
				output: "",
				stderr: "bad_cmd: command not found",
				error: "bad_cmd: command not found",
				targetPaths: ["sample.txt"],
				diff: { created: [], modified: [], deleted: [], unchanged: ["sample.txt"] },
			})
			.mockResolvedValueOnce({
				ok: true,
				executionKind: "script",
				exitCode: 0,
				timedOut: false,
				durationMs: 18,
				output: "2 sample.txt",
				targetPaths: ["sample.txt"],
				diff: {
					created: [{ path: "out.txt", kind: "file", size: 12, contentPreview: "2 sample.txt" }],
					modified: [],
					deleted: [],
					unchanged: ["sample.txt"],
				},
			});

		currentSettings = {
			...DEFAULT_SETTINGS,
			contextMenu: {
				...DEFAULT_SETTINGS.contextMenu,
				magicActions: [
					{
						id: "count-lines",
						label: "줄 수 세기",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["txt"],
						execution: { kind: "script", command: 'bad_cmd "$@"' },
					},
				],
			},
		};

		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory="contextMenu" />);
		});
		await settle();

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="edit-magic-count-lines"]')?.click();
		});
		await settle();

		const editor = document.body.querySelector('[data-testid="magic-action-editor-modal"]')!;
		expect(editor).not.toBeNull();
		expect(editor.querySelector('[data-testid="magic-editor-kind"]')).toBeNull();

		await act(async () => {
			editor.querySelector<HTMLButtonElement>('[data-action="test-magic-editor"]')?.click();
		});
		await settle();

		const failBox = editor.querySelector('[data-testid="magic-editor-verify-result"]')!;
		expect(failBox.getAttribute("data-verify-ok")).toBe("false");
		expect(failBox.textContent).toContain("bad_cmd: command not found");

		await act(async () => {
			setInputValue(editor.querySelector<HTMLTextAreaElement>('[data-testid="magic-editor-command"]')!, 'wc -l "$@"');
		});
		await settle();
		await act(async () => {
			editor.querySelector<HTMLButtonElement>('[data-action="test-magic-editor"]')?.click();
		});
		await settle();

		const okBox = editor.querySelector('[data-testid="magic-editor-verify-result"]')!;
		expect(okBox.getAttribute("data-verify-ok")).toBe("true");
		expect(okBox.textContent).toContain("2 sample.txt");
		expect(okBox.textContent).toContain("out.txt");
		expect(bridge.magicAction.verify).toHaveBeenCalledTimes(2);
	});
});
