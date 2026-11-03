// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWithRightSidebar } from "./support/settings-right-sidebar";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import type { FsLocation, FsTagCatalog } from "../src/shared/fs-contract";
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
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return {
		settings,
		fs,
		appCustomizer,
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

const LOCATIONS: readonly FsLocation[] = [
	{ name: "me", path: "/Users/me", section: "favorites", icon: "home", available: true, scanned: false, ejectable: false },
	{ name: "Desktop", path: "/Users/me/Desktop", section: "favorites", icon: "desktop", available: true, scanned: true, ejectable: false },
	{ name: "Documents", path: "/Users/me/Documents", section: "favorites", icon: "documents", available: true, scanned: true, ejectable: false },
	{ name: "Downloads", path: "/Users/me/Downloads", section: "favorites", icon: "downloads", available: true, scanned: true, ejectable: false },
	{ name: "Music", path: "/Users/me/Music", section: "favorites", icon: "music", available: true, scanned: false, ejectable: false },
	{ name: "Movies", path: "/Users/me/Movies", section: "favorites", icon: "movies", available: true, scanned: false, ejectable: false },
	{ name: "iCloud Drive", path: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs", section: "cloud", icon: "icloud", available: true, scanned: true, ejectable: false },
	{ name: "Macintosh HD", path: "/", section: "locations", icon: "disk", available: true, scanned: false, ejectable: false },
];

const TAG_CATALOG: FsTagCatalog = {
	supported: true,
	colorNames: [],
	colorsDenied: false,
	tags: [{ name: "Work", color: 6, sidebar: true }],
};

let host: HTMLDivElement;
let root: Root;
let currentSettings: AppSettings;

function settle(): Promise<void> {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(async () => {
	await setAppLanguage("ko");
	currentSettings = structuredClone(DEFAULT_SETTINGS);
	bridge.clearListeners();
	bridge.settings.get.mockReset().mockImplementation(async () => currentSettings);
	bridge.settings.set.mockReset().mockImplementation(async (patch: Partial<AppSettings>) => {
		currentSettings = { ...currentSettings, ...patch, sidebar: patch.sidebar ?? currentSettings.sidebar };
		return currentSettings;
	});
	bridge.settings.configGet.mockReset().mockResolvedValue(CONFIG);
	bridge.settings.sourcesList.mockReset().mockResolvedValue(SOURCES);
	bridge.settings.refreshScheduleGet.mockReset().mockResolvedValue({});
	bridge.fs.locations.mockReset().mockResolvedValue(LOCATIONS);
	bridge.fs.tags.mockReset().mockResolvedValue(TAG_CATALOG);
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

describe("Settings → 사이드바 (Sidebar customization & AI Customizer in the right sidebar)", () => {
	it("renders the Sidebar tab with AI Search & Automations locked on, and toggles hideable items & presets", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		// Nav item exists and is active
		const navButtons = [...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
		expect(navButtons.some((btn) => btn.textContent?.includes("사이드바") && btn.classList.contains("is-active"))).toBe(true);

		// AI 검색 and 자동화 switches are checked and disabled (locked)
		const aiSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="app:aiSearch"]');
		const autoSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="app:automations"]');
		expect(aiSwitch).not.toBeNull();
		expect(autoSwitch).not.toBeNull();
		expect(aiSwitch?.disabled).toBe(true);
		expect(autoSwitch?.disabled).toBe(true);
		expect(aiSwitch?.getAttribute("aria-checked")).toBe("true");
		expect(autoSwitch?.getAttribute("aria-checked")).toBe("true");

		// Toggling Music hides `place:music`
		const musicSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="place:music"]');
		expect(musicSwitch).not.toBeNull();
		expect(musicSwitch?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			musicSwitch?.click();
		});
		await settle();
		expect(bridge.settings.set).toHaveBeenCalledWith(
			expect.objectContaining({
				sidebar: expect.objectContaining({
					hiddenItems: ["place:music"],
				}),
			}),
		);
		expect(host.querySelector<HTMLButtonElement>('[data-sidebar-switch="place:music"]')?.getAttribute("aria-checked")).toBe("false");

		// Reorder Downloads up
		const moveDownloadsUp = host.querySelector<HTMLButtonElement>('[data-action="move-up-place:downloads"]');
		expect(moveDownloadsUp).not.toBeNull();
		await act(async () => {
			moveDownloadsUp?.click();
		});
		await settle();
		expect(currentSettings.sidebar.favoritesOrder.indexOf("place:downloads")).toBeLessThan(
			currentSettings.sidebar.favoritesOrder.indexOf("place:documents"),
		);

		// Minimal preset hides applications, music, movies, pictures
		const minimalPreset = host.querySelector<HTMLButtonElement>('[data-action="sidebar-preset-minimal"]');
		await act(async () => {
			minimalPreset?.click();
		});
		await settle();
		expect(currentSettings.sidebar.hiddenItems).toEqual([
			"place:applications",
			"place:music",
			"place:movies",
			"place:pictures",
		]);

		// Favorites section switch is locked, Cloud section switch toggles hiddenSections
		const favSectionSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="section:favorites"]');
		expect(favSectionSwitch?.disabled).toBe(true);
		expect(favSectionSwitch?.getAttribute("aria-checked")).toBe("true");

		const cloudSectionSwitch = host.querySelector<HTMLButtonElement>('[data-sidebar-switch="section:cloud"]');
		await act(async () => {
			cloudSectionSwitch?.click();
		});
		await settle();
		expect(currentSettings.sidebar.hiddenSections).toEqual(["cloud"]);

		// Reset to default restores everything
		const resetBtn = host.querySelector<HTMLButtonElement>('[data-action="sidebar-reset-default"]');
		expect(resetBtn?.disabled).toBe(false);
		await act(async () => {
			resetBtn?.click();
		});
		await settle();
		expect(currentSettings.sidebar.hiddenItems).toEqual([]);
		expect(currentSettings.sidebar.hiddenSections).toEqual([]);
		expect(currentSettings.sidebar.favoritesOrder).toEqual([]);
	});

	it("shows the AI App Customizer in the window's right sidebar, sends a message to the pi agent, shows live shimmer progress, and renders applied changes", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		// No modal: the assistant fills the window's right sidebar, outside the Settings page, and is not a dialog.
		const dialog = host.querySelector<HTMLElement>('[data-testid="settings-assistant-slot"] [data-testid="app-customizer-panel"]:not([hidden])');
		expect(dialog).not.toBeNull();
		expect(dialog?.closest(".settings-view")).toBeNull();
		expect(dialog?.getAttribute("role")).not.toBe("dialog");
		// The hero that opened the old modal is redundant while the panel is shown
		expect(host.querySelector('[data-action="open-app-customizer"]')).toBeNull();

		const input = dialog?.querySelector<HTMLTextAreaElement>('textarea[data-testid="app-customizer-input"]');
		expect(input).not.toBeNull();

		// Type a customization request and submit
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setter?.call(input, "음악과 동영상을 사이드바에서 숨겨줘");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const sendBtn = dialog?.querySelector<HTMLButtonElement>('[data-action="send-customizer-message"]');
		await act(async () => {
			sendBtn?.click();
		});

		expect(bridge.appCustomizer.send).toHaveBeenCalledTimes(1);
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] as [string, { sessionId: string; message: string }];
		expect(request.message).toBe("음악과 동영상을 사이드바에서 숨겨줘");

		// Stream live intent progress
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "progress",
				runId,
				sessionId: request.sessionId,
				text: "음악 및 동영상 항목을 숨기는 중",
			});
		});
		expect(dialog?.textContent).toContain("음악 및 동영상 항목을 숨기는 중");

		// Agent finishes turn and updates settings
		const nextSettings: AppSettings = {
			...currentSettings,
			sidebar: {
				...currentSettings.sidebar,
				hiddenItems: ["place:music", "place:movies"],
			},
		};
		await act(async () => {
			bridge.emitSettingsChanged(nextSettings);
			bridge.emitCustomizerEvent({
				type: "turn-done",
				runId,
				sessionId: request.sessionId,
				reply: "음악과 동영상 폴더를 사이드바에서 숨겼습니다.",
				changes: [{ kind: "sidebar", summary: "음악, 동영상 숨김", fields: ["sidebar.hiddenItems"] }],
				settings: nextSettings,
			});
		});

		expect(dialog?.textContent).toContain("음악과 동영상 폴더를 사이드바에서 숨겼습니다.");
		expect(dialog?.textContent).toContain("음악, 동영상 숨김");
		// Underlying sidebar page switches reflect the live agent change
		expect(host.querySelector<HTMLButtonElement>('[data-sidebar-switch="place:music"]')?.getAttribute("aria-checked")).toBe("false");
		expect(host.querySelector<HTMLButtonElement>('[data-sidebar-switch="place:movies"]')?.getAttribute("aria-checked")).toBe("false");
	});

	it("adds and removes a custom folder in Favorites", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		const addBtn = host.querySelector<HTMLButtonElement>('[data-action="add-custom-favorite"]');
		await act(async () => {
			addBtn?.click();
		});

		const modalInput = document.body.querySelector<HTMLInputElement>(".settings-modal input");
		expect(modalInput).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(modalInput, "/Users/me/Workspace");
			modalInput?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirmBtn = document.body.querySelector<HTMLButtonElement>(".settings-modal .settings-btn-primary");
		await act(async () => {
			confirmBtn?.click();
		});
		await settle();

		expect(currentSettings.sidebar.customFavorites).toEqual([{ path: "/Users/me/Workspace" }]);
		const removeBtn = document.body.querySelector<HTMLButtonElement>('[data-action="remove-custom-/Users/me/Workspace"]');
		expect(removeBtn).not.toBeNull();
		await act(async () => {
			removeBtn?.click();
		});
		await settle();
		expect(currentSettings.sidebar.customFavorites).toEqual([]);
	});

	it("renders all 4 sidebar sections inside one unified .sidebar-sections-stack and uses the transparent Dazzi sunflower mark on AI surfaces", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		const sectionCards = [...host.querySelectorAll<HTMLElement>(".sidebar-sections-stack .sidebar-section-card")];
		expect(sectionCards.map((el) => el.getAttribute("data-sidebar-section"))).toEqual([
			"favorites",
			"cloud",
			"connections",
			"locations",
			"tags",
		]);
		// Favorites items live directly inside the `favorites` section card
		const favCard = sectionCards[0];
		expect(favCard?.querySelector('[data-sidebar-switch="app:aiSearch"]')).not.toBeNull();
		expect(favCard?.querySelector('[data-sidebar-switch="app:automations"]')).not.toBeNull();
		expect(favCard?.querySelector('[data-action="add-custom-favorite"]')).not.toBeNull();

		// The assistant has no header band: it shows the Dazzi mark once, centered in its empty state, and no notice
		const panel = host.querySelector<HTMLElement>('[data-testid="app-customizer-panel"]:not([hidden])');
		const marks = [...(panel?.querySelectorAll<HTMLImageElement>("img") ?? [])];
		expect(marks.map((img) => img.className)).toEqual(["customizer-panel__empty-logo"]);
		expect(panel?.querySelector("header")).toBeNull();
		expect(panel?.querySelector("h2")).toBeNull();
		expect(panel?.textContent).not.toContain("원하는 사이드바 구성이나 화면 설정을");
		expect(panel?.getAttribute("aria-label")).toBe("AI 앱 커스텀 어시스턴트");
		expect(panel?.querySelectorAll('[data-action="customizer-suggestion"]').length).toBe(4);
		expect(panel?.querySelector(".customizer-panel__foot")?.textContent).not.toContain("AI 검색과 자동화는 필수 기능");
		// New chat appears only once there is a conversation to discard
		expect(panel?.querySelector('[data-action="reset-customizer-chat"]')).toBeNull();

		// Hiding the right sidebar brings back the hero, whose button and banner use the transparent Dazzi mark
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
		});
		expect(host.querySelector<HTMLImageElement>("img.sidebar-ai-hero__logo")).not.toBeNull();
		expect(host.querySelector<HTMLImageElement>("img.sidebar-ai-hero__btn-logo")).not.toBeNull();
	});

	it("hides with the right sidebar, reopens from the hero, and follows the Settings section it belongs to", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		const panelOf = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="app-customizer-panel"]:not([hidden])');
		expect(panelOf()?.getAttribute("data-surface")).toBe("sidebar");

		// Escape inside the composer never collapses the panel (it is not a dialog)
		const input = panelOf()?.querySelector<HTMLTextAreaElement>('textarea[data-testid="app-customizer-input"]');
		await act(async () => {
			input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(panelOf()).not.toBeNull();

		// A turn started before hiding the right sidebar is still there after reopening it
		await act(async () => {
			panelOf()?.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		expect(panelOf()?.querySelectorAll(".customizer-turn").length).toBe(1);
		expect(panelOf()?.querySelector('.customizer-panel__foot [data-action="reset-customizer-chat"]')).not.toBeNull();

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
		});
		expect(panelOf()).toBeNull();
		expect(host.querySelector('[data-testid="settings-assistant-slot"]')).toBeNull();
		const reopen = host.querySelector<HTMLButtonElement>('[data-action="open-app-customizer"]');
		expect(reopen).not.toBeNull();
		await act(async () => {
			reopen?.click();
		});
		expect(panelOf()?.getAttribute("data-surface")).toBe("sidebar");
		expect(panelOf()?.querySelectorAll(".customizer-turn").length).toBe(1);
		expect(bridge.appCustomizer.cancel).not.toHaveBeenCalled();
		expect(document.activeElement?.getAttribute("data-testid")).toBe("app-customizer-input");
		expect(host.querySelector('[data-action="open-app-customizer"]')).toBeNull();

		const nav = (label: string): HTMLButtonElement | undefined =>
			[...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find((btn) => btn.textContent?.trim() === label);

		// Sections without an assistant leave the right sidebar to the Inspector
		await act(async () => {
			nav("일반")?.click();
		});
		await settle();
		expect(host.querySelector('[data-testid="settings-assistant-slot"]')).toBeNull();

		// Each customizable section shows its own assistant surface
		await act(async () => {
			nav("단축키")?.click();
		});
		await settle();
		expect(panelOf()?.getAttribute("data-surface")).toBe("shortcuts");
		expect(panelOf()?.getAttribute("aria-label")).toBe("AI 단축키 커스텀 어시스턴트");

		await act(async () => {
			nav("사이드바")?.click();
		});
		await settle();
		expect(panelOf()?.getAttribute("data-surface")).toBe("sidebar");
		expect(panelOf()?.querySelectorAll(".customizer-turn").length).toBe(1);

		await act(async () => {
			nav("우클릭 메뉴")?.click();
		});
		await settle();
		expect(panelOf()?.getAttribute("data-surface")).toBe("contextMenu");
	});

	it.each([
		{
			lang: "ko" as const,
			nav: "사이드바",
			heroBtn: "AI로 커스텀하기",
			sectionsTitle: "사이드바 섹션 및 항목",
			favoritesSection: "즐겨찾기",
			cloudSection: "클라우드",
			locationsSection: "위치",
			tagsSection: "태그",
			lockedBadge: "항상 표시",
			modalTitle: "AI 앱 커스텀 어시스턴트",
		},
		{
			lang: "en" as const,
			nav: "Sidebar",
			heroBtn: "Customize with AI",
			sectionsTitle: "Sidebar Sections & Items",
			favoritesSection: "Favorites",
			cloudSection: "Cloud",
			locationsSection: "Locations",
			tagsSection: "Tags",
			lockedBadge: "Always shown",
			modalTitle: "AI App Customizer",
		},
		{
			lang: "ja" as const,
			nav: "サイドバー",
			heroBtn: "AIでカスタム",
			sectionsTitle: "サイドバーのセクションと項目",
			favoritesSection: "お気に入り",
			cloudSection: "クラウド",
			locationsSection: "場所",
			tagsSection: "タグ",
			lockedBadge: "常時表示",
			modalTitle: "AI アプリカスタムアシスタント",
		},
		{
			lang: "zh" as const,
			nav: "侧边栏",
			heroBtn: "使用 AI 定制",
			sectionsTitle: "侧边栏分区与项目",
			favoritesSection: "个人收藏",
			cloudSection: "云端",
			locationsSection: "位置",
			tagsSection: "标签",
			lockedBadge: "始终显示",
			modalTitle: "AI 应用定制助手",
		},
	])("renders fully localized Sidebar settings and AI Customizer panel in $lang", async (spec) => {
		await setAppLanguage(spec.lang);
		currentSettings = { ...currentSettings, language: spec.lang };

		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		expect(host.querySelector("h1.linear-title")?.textContent).toBe(spec.nav);
		expect(host.textContent).toContain(spec.sectionsTitle);
		expect(host.textContent).toContain(spec.favoritesSection);
		expect(host.textContent).toContain(spec.cloudSection);
		expect(host.textContent).toContain(spec.locationsSection);
		expect(host.textContent).toContain(spec.tagsSection);
		expect(host.textContent).toContain(spec.lockedBadge);

		const panel = host.querySelector<HTMLElement>('[data-testid="app-customizer-panel"]:not([hidden])');
		expect(panel?.getAttribute("aria-label")).toBe(spec.modalTitle);

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
		});
		expect(host.querySelector('[data-action="open-app-customizer"]')?.textContent).toContain(spec.heroBtn);
	});

	it("normalizes Windows Copy-as-path quoted strings, ~\\ home prefixes, and trailing slashes when adding custom folders", async () => {
		const prevBridge: unknown = Reflect.get(globalThis, "autorag");
		Reflect.set(globalThis, "autorag", { ...(typeof prevBridge === "object" && prevBridge !== null ? prevBridge : {}), platform: "win32" });
		bridge.fs.locations.mockResolvedValue([
			{ name: "me", path: "C:\\Users\\me", section: "favorites", icon: "home", available: true, scanned: false, ejectable: false },
		]);
		try {
			await act(async () => {
				root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
			});
			await settle();

			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="add-custom-favorite"]')?.click();
			});
			await settle();

			const input = document.body.querySelector<HTMLInputElement>(".settings-modal-backdrop input")!;
			expect(input.getAttribute("placeholder")).toContain("C:\\Work");

			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			await act(async () => {
				setter?.call(input, '"~\\Projects\\ClientA\\"');
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await act(async () => {
				const buttons = [...document.body.querySelectorAll<HTMLButtonElement>(".settings-modal-backdrop button")];
				buttons.at(-1)?.click();
			});
			await settle();

			expect(currentSettings.sidebar.customFavorites).toEqual([{ path: "C:\\Users\\me\\Projects\\ClientA" }]);
		} finally {
			Reflect.set(globalThis, "autorag", prevBridge);
		}
	});
});
