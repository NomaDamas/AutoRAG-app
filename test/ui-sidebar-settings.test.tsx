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

describe("Settings → 사이드바 (Sidebar customization; the AI assistant lives on 우클릭 메뉴)", () => {
	it("renders the Sidebar tab with AI Chat & Automations locked on, and toggles hideable items & presets", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		// Nav item exists and is active
		const navButtons = [...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
		expect(navButtons.some((btn) => btn.textContent?.includes("사이드바") && btn.classList.contains("is-active"))).toBe(true);

		// AI 채팅 and 자동화 switches are checked and disabled (locked)
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

		// Reorder Downloads up from its drag handle with the keyboard (↑), as a keyboard user would
		const downloadsGrip = host.querySelector<HTMLButtonElement>('[data-sidebar-grip="place:downloads"]');
		expect(downloadsGrip).not.toBeNull();
		await act(async () => {
			downloadsGrip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
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

		// The hand-made layout is 사용자 지정; there is no separate 기본값으로 복원 any more.
		expect(host.querySelector('[data-action="sidebar-reset-default"]')).toBeNull();
		const customPreset = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[data-action="sidebar-preset-custom"]');
		expect(customPreset()?.classList.contains("is-active")).toBe(true);

		// 전체 표시 is the default layout: it restores everything, and 사용자 지정 still remembers the layout above.
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="sidebar-preset-all"]')?.click();
		});
		await settle();
		expect(currentSettings.sidebar.hiddenItems).toEqual([]);
		expect(currentSettings.sidebar.hiddenSections).toEqual([]);
		expect(currentSettings.sidebar.favoritesOrder).toEqual([]);
		expect(customPreset()?.disabled).toBe(false);
		expect(customPreset()?.classList.contains("is-active")).toBe(false);

		// 사용자 지정 brings the hand-made layout back.
		await act(async () => {
			customPreset()?.click();
		});
		await settle();
		expect(currentSettings.sidebar.hiddenSections).toEqual(["cloud"]);
		expect(currentSettings.sidebar.hiddenItems).toEqual(["place:applications", "place:music", "place:movies", "place:pictures"]);
	});

	it("offers no AI banner or assistant on 사이드바: the right sidebar stays the Inspector's, shown or hidden", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		expect(host.querySelector('[data-testid="settings-assistant-slot"]')).toBeNull();
		expect(host.querySelector('[data-testid="app-customizer-panel"]:not([hidden])')).toBeNull();
		expect(host.querySelector(".sidebar-ai-hero")).toBeNull();

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
		});
		expect(host.querySelector(".sidebar-ai-hero")).toBeNull();
		expect(host.querySelector('[data-action="open-app-customizer"]')).toBeNull();
	});

	it("keeps each intermediate assistant message visible and unfolds the shimmer below it while the agent keeps thinking", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"contextMenu" as never} />);
		});
		await settle();

		const panel = host.querySelector<HTMLElement>('[data-testid="app-customizer-panel"]:not([hidden])');
		await act(async () => {
			panel?.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] as [string, { sessionId: string; message: string }];
		const assistantRow = (): HTMLElement | null => panel?.querySelector<HTMLElement>(".customizer-turn__assistant-row") ?? null;

		// 1. Starts with shimmer only
		expect(assistantRow()?.querySelector(".customizer-turn__progress .shimmer")).not.toBeNull();

		// 2. Streams first assistant message (shimmer hides while words stream)
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "draft",
				runId,
				sessionId: request.sessionId,
				text: "현재 사이드바 설정을 먼저 살펴볼게요.",
			});
		});
		expect(assistantRow()?.querySelector(".customizer-turn__reply")?.textContent).toBe("현재 사이드바 설정을 먼저 살펴볼게요.");
		expect(assistantRow()?.querySelector(".customizer-turn__progress")).toBeNull();

		// 3. Agent enters tool call and keeps thinking: the message stays AND a new shimmer unfolds BELOW it
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "assistant-message",
				runId,
				sessionId: request.sessionId,
				text: "현재 사이드바 설정을 먼저 살펴볼게요.",
			});
			bridge.emitCustomizerEvent({
				type: "progress",
				runId,
				sessionId: request.sessionId,
				text: "사이드바 항목을 정리하는 중",
			});
		});
		const childrenDuringThink = [...(assistantRow()?.children ?? [])];
		expect(childrenDuringThink.map((el) => el.className)).toEqual([
			"customizer-turn__reply",
			"customizer-turn__progress",
		]);
		expect(childrenDuringThink[0]?.textContent).toBe("현재 사이드바 설정을 먼저 살펴볼게요.");
		expect(childrenDuringThink[1]?.querySelector(".shimmer")?.textContent).toBe("사이드바 항목을 정리하는 중");

		// 4. Final answer streams below the first bubble and both remain when the turn finishes
		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "draft",
				runId,
				sessionId: request.sessionId,
				text: "정리를 마쳤습니다.",
			});
		});
		expect([...(assistantRow()?.querySelectorAll(".customizer-turn__reply") ?? [])].map((el) => el.textContent)).toEqual([
			"현재 사이드바 설정을 먼저 살펴볼게요.",
			"정리를 마쳤습니다.",
		]);
		expect(assistantRow()?.querySelector(".customizer-turn__progress")).toBeNull();

		await act(async () => {
			bridge.emitCustomizerEvent({
				type: "turn-done",
				runId,
				sessionId: request.sessionId,
				messages: ["현재 사이드바 설정을 먼저 살펴볼게요.", "정리를 마쳤습니다."],
				changes: [{ kind: "sidebar", summary: "사이드바 정리됨", fields: ["sidebar.hiddenItems"] }],
				settings: currentSettings,
			});
		});
		expect([...(assistantRow()?.children ?? [])].map((el) => el.className)).toEqual([
			"customizer-turn__reply",
			"customizer-turn__changes",
			"customizer-turn__reply",
		]);
		expect([...(assistantRow()?.querySelectorAll(".customizer-turn__reply") ?? [])].map((el) => el.textContent)).toEqual([
			"현재 사이드바 설정을 먼저 살펴볼게요.",
			"정리를 마쳤습니다.",
		]);
		expect(assistantRow()?.querySelector(".customizer-turn__progress")).toBeNull();
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

	it("renders all 4 sidebar sections inside one unified .sidebar-sections-stack", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		const sectionCards = [...host.querySelectorAll<HTMLElement>(".sidebar-sections-stack .sidebar-section")];
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
	});

	it("hides with the right sidebar, reopens from the 우클릭 메뉴 hero, and shows only on 우클릭 메뉴", async () => {
		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"contextMenu" as never} />);
		});
		await settle();

		const panelOf = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="app-customizer-panel"]:not([hidden])');
		expect(panelOf()?.getAttribute("data-surface")).toBe("contextMenu");

		// The assistant has no header band: it shows the faded Dazzi mark once (a light and a dark image, one shown per
		// appearance), centered in its empty state
		const marks = [...(panelOf()?.querySelectorAll<HTMLImageElement>("img") ?? [])];
		expect(marks.map((img) => img.className)).toEqual([
			"customizer-panel__empty-logo customizer-panel__empty-logo--light",
			"customizer-panel__empty-logo customizer-panel__empty-logo--dark",
		]);
		expect(panelOf()?.querySelector("header")).toBeNull();
		expect(panelOf()?.querySelector('[data-action="reset-customizer-chat"]')).toBeNull();

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

		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
		});
		expect(panelOf()).toBeNull();
		expect(host.querySelector('[data-testid="settings-assistant-slot"]')).toBeNull();
		const reopen = host.querySelector<HTMLButtonElement>('[data-action="open-context-menu-customizer"]');
		expect(reopen).not.toBeNull();
		await act(async () => {
			reopen?.click();
		});
		expect(panelOf()?.getAttribute("data-surface")).toBe("contextMenu");
		expect(panelOf()?.querySelectorAll(".customizer-turn").length).toBe(1);
		expect(bridge.appCustomizer.cancel).not.toHaveBeenCalled();
		expect(document.activeElement?.getAttribute("data-testid")).toBe("app-customizer-input");
		expect(host.querySelector('[data-action="open-context-menu-customizer"]')).toBeNull();

		const nav = (label: string): HTMLButtonElement | undefined =>
			[...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find((btn) => btn.textContent?.trim() === label);

		// Every other section leaves the right sidebar to the Inspector, with no banner offering an assistant
		for (const label of ["일반", "단축키", "사이드바"]) {
			await act(async () => {
				nav(label)?.click();
			});
			await settle();
			expect(host.querySelector('[data-testid="settings-assistant-slot"]')).toBeNull();
			expect(host.querySelector(".sidebar-ai-hero")).toBeNull();
		}

		await act(async () => {
			nav("우클릭 메뉴")?.click();
		});
		await settle();
		expect(panelOf()?.getAttribute("data-surface")).toBe("contextMenu");
		expect(panelOf()?.querySelectorAll(".customizer-turn").length).toBe(1);
	});

	it.each([
		{
			lang: "ko" as const,
			nav: "사이드바",
			favoritesSection: "즐겨찾기",
			cloudSection: "클라우드",
			locationsSection: "위치",
			tagsSection: "태그",
			lockedBadge: "항상 표시",
		},
		{
			lang: "en" as const,
			nav: "Sidebar",
			favoritesSection: "Favorites",
			cloudSection: "Cloud",
			locationsSection: "Locations",
			tagsSection: "Tags",
			lockedBadge: "Always shown",
		},
		{
			lang: "ja" as const,
			nav: "サイドバー",
			favoritesSection: "お気に入り",
			cloudSection: "クラウド",
			locationsSection: "場所",
			tagsSection: "タグ",
			lockedBadge: "常時表示",
		},
		{
			lang: "zh" as const,
			nav: "侧边栏",
			favoritesSection: "个人收藏",
			cloudSection: "云端",
			locationsSection: "位置",
			tagsSection: "标签",
			lockedBadge: "始终显示",
		},
	])("renders fully localized Sidebar settings in $lang", async (spec) => {
		await setAppLanguage(spec.lang);
		currentSettings = { ...currentSettings, language: spec.lang };

		await act(async () => {
			root.render(<SettingsWithRightSidebar initialCategory={"sidebar" as never} />);
		});
		await settle();

		expect(host.querySelector("h1.linear-title")?.textContent).toBe(spec.nav);
		expect(host.textContent).toContain(spec.favoritesSection);
		expect(host.textContent).toContain(spec.cloudSection);
		expect(host.textContent).toContain(spec.locationsSection);
		expect(host.textContent).toContain(spec.tagsSection);
		expect(host.textContent).toContain(spec.lockedBadge);

		expect(host.querySelector(".sidebar-ai-hero")).toBeNull();
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
