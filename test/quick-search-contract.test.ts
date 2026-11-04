import { describe, expect, it } from "vitest";
import { chordToAccelerator, DEFAULT_QUICK_SEARCH_SETTINGS, isGlobalChord, normalizeQuickSearchSettings } from "../src/shared/quick-search-contract";

describe("quick search shortcut", () => {
	it("turns canonical chords into Electron accelerators", () => {
		expect(chordToAccelerator("Alt+Space")).toBe("Alt+Space");
		expect(chordToAccelerator("Mod+Shift+K")).toBe("CommandOrControl+Shift+K");
		expect(chordToAccelerator("Mod+Alt+ArrowUp")).toBe("CommandOrControl+Alt+Up");
		expect(chordToAccelerator("Mod+Enter")).toBe("CommandOrControl+Return");
	});

	it("refuses a chord without ⌘/Ctrl or ⌥/Alt: it would take the key from every other app", () => {
		expect(isGlobalChord("Space")).toBe(false);
		expect(isGlobalChord("Shift+F5")).toBe(false);
		expect(chordToAccelerator("F2")).toBeNull();
		expect(isGlobalChord("Alt+Space")).toBe(true);
	});

	it("repairs stored settings: unknown shapes and non-global chords fall back, a valid choice survives", () => {
		expect(normalizeQuickSearchSettings(undefined)).toEqual(DEFAULT_QUICK_SEARCH_SETTINGS);
		expect(normalizeQuickSearchSettings({ enabled: false, chord: "Space" })).toEqual({ enabled: false, chord: "Alt+Space" });
		expect(normalizeQuickSearchSettings({ enabled: true, chord: "Ctrl+Shift+P" })).toEqual({ enabled: true, chord: "Mod+Shift+P" });
		expect(normalizeQuickSearchSettings({ chord: 3 })).toEqual(DEFAULT_QUICK_SEARCH_SETTINGS);
	});
});
