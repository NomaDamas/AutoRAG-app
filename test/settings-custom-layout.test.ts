import { describe, expect, it } from "vitest";
import {
	contextMenuPresetLayout,
	contextMenuPresetOf,
	DEFAULT_CONTEXT_MENU_SETTINGS,
	normalizeContextMenuSettings,
	withContextMenuLayout,
} from "../src/shared/context-menu-contract";
import { activeShortcutPreset, normalizeShortcutSettings, shortcutSettingsForPreset } from "../src/shared/shortcuts-contract";
import {
	DEFAULT_SIDEBAR_SETTINGS,
	normalizeSidebarSettings,
	sidebarPresetLayout,
	sidebarPresetOf,
	withSidebarLayout,
} from "../src/shared/sidebar-contract";

describe("사용자 지정 in the sidebar's 빠른 구성", () => {
	it("has nothing to remember until the layout differs from every preset", () => {
		expect(normalizeSidebarSettings(DEFAULT_SIDEBAR_SETTINGS).custom).toBeUndefined();
		expect(sidebarPresetOf(normalizeSidebarSettings(withSidebarLayout(DEFAULT_SIDEBAR_SETTINGS, sidebarPresetLayout("minimal"))))).toBe("minimal");
		expect(normalizeSidebarSettings(withSidebarLayout(DEFAULT_SIDEBAR_SETTINGS, sidebarPresetLayout("minimal"))).custom).toBeUndefined();
	});

	it("remembers a hand-made layout, keeps it through both presets, and brings it back", () => {
		const own = normalizeSidebarSettings({ ...DEFAULT_SIDEBAR_SETTINGS, hiddenSections: ["tags"], sectionOrder: ["cloud", "favorites"] });
		expect(sidebarPresetOf(own)).toBeNull();
		expect(own.custom).toMatchObject({ hiddenSections: ["tags"] });

		const all = withSidebarLayout(own, sidebarPresetLayout("all"));
		expect(sidebarPresetOf(all)).toBe("all");
		expect(all.custom).toEqual(own.custom);

		const minimal = withSidebarLayout(all, sidebarPresetLayout("minimal"));
		expect(minimal.custom).toEqual(own.custom);

		const back = withSidebarLayout(minimal, minimal.custom!);
		expect(back.hiddenSections).toEqual(["tags"]);
		expect(back.sectionOrder.slice(0, 2)).toEqual(["cloud", "favorites"]);
	});

	it("keeps pinned folders when a preset is applied, since they are content and not layout", () => {
		const pinned = normalizeSidebarSettings({ ...DEFAULT_SIDEBAR_SETTINGS, customFavorites: [{ path: "/Work" }], hiddenSections: ["tags"] });
		expect(withSidebarLayout(pinned, sidebarPresetLayout("all")).customFavorites).toEqual([{ path: "/Work" }]);
	});

	it("replaces what it remembers with the next layout made by hand", () => {
		const first = normalizeSidebarSettings({ ...DEFAULT_SIDEBAR_SETTINGS, hiddenSections: ["tags"] });
		const second = normalizeSidebarSettings({ ...withSidebarLayout(first, sidebarPresetLayout("all")), hiddenSections: ["cloud"] });
		expect(second.custom?.hiddenSections).toEqual(["cloud"]);
	});
});

describe("사용자 지정 in the context menu's 빠른 구성", () => {
	it("remembers a hand-made layout through the presets and keeps magic actions out of it", () => {
		const own = normalizeContextMenuSettings({ ...DEFAULT_CONTEXT_MENU_SETTINGS, hiddenSections: ["magic"] });
		expect(contextMenuPresetOf(own)).toBeNull();
		const all = withContextMenuLayout(own, contextMenuPresetLayout("all"));
		expect(contextMenuPresetOf(all)).toBe("all");
		expect(all.custom).toEqual(own.custom);
		expect(withContextMenuLayout(all, all.custom!).hiddenSections).toEqual(["magic"]);
		expect(own.custom).not.toHaveProperty("magicActions");
	});
});

describe("사용자 지정 in the shortcuts' 빠른 구성", () => {
	it("remembers bindings set by hand through a preset and through 모두 기본값으로", () => {
		const own = normalizeShortcutSettings({ overrides: { rename: "F6" } });
		expect(activeShortcutPreset(own)).toBeNull();
		expect(own.custom).toEqual({ rename: "F6" });

		const mac = normalizeShortcutSettings({ ...shortcutSettingsForPreset("macFinder"), custom: own.custom });
		expect(activeShortcutPreset(mac)).toBe("macFinder");
		expect(mac.custom).toEqual({ rename: "F6" });

		const reset = normalizeShortcutSettings({ ...shortcutSettingsForPreset("default"), custom: mac.custom });
		expect(activeShortcutPreset(reset)).toBe("default");
		expect(reset.custom).toEqual({ rename: "F6" });
	});

	it("has nothing to remember for a preset alone", () => {
		expect(normalizeShortcutSettings(shortcutSettingsForPreset("windowsExplorer")).custom).toBeUndefined();
	});
});
