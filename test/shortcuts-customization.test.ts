import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsService } from "../src/main/settings-service";
import { resolveKeyAction } from "../src/renderer/src/state/keymap";
import {
	chordFromKeyEvent,
	DEFAULT_SHORTCUT_SETTINGS,
	findShortcutConflict,
	formatShortcutChord,
	isDefaultShortcutSettings,
	isLockedShortcutId,
	isShortcutId,
	normalizeShortcutActionId,
	normalizeShortcutSettings,
	parseShortcutChord,
	resolveEffectiveShortcuts,
	SHORTCUT_CATALOG,
	SHORTCUT_IDS,
	swapShortcutBinding,
} from "../src/shared/shortcuts-contract";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("shortcuts-contract fixed catalog & normalization", () => {
	it("contains only existing default-bound shortcuts, keeps dismiss (Esc) locked, and rejects arbitrary unknown actions", () => {
		expect(SHORTCUT_IDS.length).toBe(26);
		expect(SHORTCUT_CATALOG.map((item) => item.id)).toEqual([...SHORTCUT_IDS]);

		for (const locked of ["dismiss", "escape", "esc", "닫기", "취소"]) {
			expect(isLockedShortcutId(locked), locked).toBe(true);
		}
		expect(isLockedShortcutId("rename")).toBe(false);

		expect(normalizeShortcutActionId("이름 변경")).toBe("rename");
		expect(normalizeShortcutActionId("새 폴더")).toBe("newFolder");
		expect(normalizeShortcutActionId("AI 검색")).toBe("focusComposer");
		expect(normalizeShortcutActionId("훑어보기")).toBe("quickLook");
		expect(normalizeShortcutActionId("다시 실행")).toBe("redo");

		// Arbitrary/unbound actions do not resolve to any catalog ID
		expect(normalizeShortcutActionId("터미널 열기")).toBeNull();
		expect(normalizeShortcutActionId("openTerminal")).toBeNull();
		expect(normalizeShortcutActionId("compressArchive")).toBeNull();
		expect(isShortcutId("openTerminal")).toBe(false);
	});

	it("parses canonical, platform-glyph, and natural chords and formats them per platform", () => {
		expect(parseShortcutChord("⌘⇧P")).toEqual({ ok: true, chord: "Mod+Shift+P" });
		expect(parseShortcutChord("Ctrl+Shift+p")).toEqual({ ok: true, chord: "Mod+Shift+P" });
		expect(parseShortcutChord("Cmd + Alt + N")).toEqual({ ok: true, chord: "Mod+Alt+N" });
		expect(parseShortcutChord("⌥↑")).toEqual({ ok: true, chord: "Alt+ArrowUp" });
		expect(parseShortcutChord("F2")).toEqual({ ok: true, chord: "F2" });
		expect(parseShortcutChord("Space")).toEqual({ ok: true, chord: "Space" });
		expect(parseShortcutChord("↩")).toEqual({ ok: true, chord: "Enter" });

		// Invalid chords
		expect(parseShortcutChord("Escape")).toEqual({ ok: false, reason: "reserved-escape" });
		expect(parseShortcutChord("ArrowDown")).toEqual({ ok: false, reason: "reserved-navigation" });
		expect(parseShortcutChord("a")).toEqual({ ok: false, reason: "missing-modifier" });
		expect(parseShortcutChord("Shift+A")).toEqual({ ok: false, reason: "missing-modifier" });
		expect(parseShortcutChord("Cmd+Shift")).toEqual({ ok: false, reason: "modifier-only" });

		// Formatting
		expect(formatShortcutChord("Mod+Shift+P", "darwin")).toBe("⌘⇧P");
		expect(formatShortcutChord("Mod+Shift+P", "win32")).toBe("Ctrl+Shift+P");
		expect(formatShortcutChord("Alt+ArrowUp", "darwin")).toBe("⌥↑");
		expect(formatShortcutChord("Alt+ArrowUp", "win32")).toBe("Alt+↑");
		expect(formatShortcutChord("Enter", "darwin")).toBe("↩");
		expect(formatShortcutChord("Enter", "win32")).toBe("Enter");
		expect(formatShortcutChord("Backspace", "darwin")).toBe("⌫");
	});

	it("records live keyboard events accurately across modifier-only holds, Escape cancel, Korean IME, and macOS Option dead-keys", () => {
		expect(
			chordFromKeyEvent({ key: "Meta", code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }),
		).toEqual({
			kind: "modifier-only",
			mod: true,
			alt: false,
			shift: true,
		});

		expect(
			chordFromKeyEvent({ key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
		).toEqual({ kind: "cancel" });

		// Korean 2-set IME pressing ⌘ㅍ on physical KeyP
		expect(
			chordFromKeyEvent({ key: "ㅍ", code: "KeyP", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }),
		).toEqual({ kind: "valid", chord: "Mod+P" });

		// macOS Option+Command+V producing '√' on physical KeyV
		expect(
			chordFromKeyEvent({ key: "√", code: "KeyV", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }),
		).toEqual({ kind: "valid", chord: "Mod+Alt+V" });

		// Function key without modifiers (Windows Explorer-style F2 rename)
		expect(
			chordFromKeyEvent({ key: "F2", code: "F2", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
		).toEqual({ kind: "valid", chord: "F2" });

		// Bare character key rejected with reason
		expect(
			chordFromKeyEvent({ key: "p", code: "KeyP", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
		).toEqual({ kind: "invalid", reason: "missing-modifier", rawChord: "P" });
	});

	it("detects scope-aware conflicts and supports atomic swaps without leaving any action unbound", () => {
		// newFolder (finder) using Mod+N does NOT conflict with aiNewChat (aiSearch, Mod+N)
		expect(findShortcutConflict("newFolder", "Mod+N", DEFAULT_SHORTCUT_SETTINGS)).toBeNull();

		// rename (finder) using Mod+D conflicts with duplicate (finder)
		expect(findShortcutConflict("rename", "Mod+D", DEFAULT_SHORTCUT_SETTINGS)).toBe("duplicate");

		// newFolder (finder) using Mod+T conflicts with newTab (window)
		expect(findShortcutConflict("newFolder", "Mod+T", DEFAULT_SHORTCUT_SETTINGS)).toBe("newTab");

		// Swapping rename <-> duplicate gives rename=Mod+D and duplicate=Mod+R
		const swapped = swapShortcutBinding(DEFAULT_SHORTCUT_SETTINGS, "rename", "Mod+D");
		const effective = resolveEffectiveShortcuts(swapped);
		expect(effective.rename).toBe("Mod+D");
		expect(effective.duplicate).toBe("Mod+R");
		expect(findShortcutConflict("rename", "Mod+D", swapped)).toBeNull();
	});

	it("sanitizes unknown keys, default-matching overrides, invalid chords, and persisted conflicts in settings-state.json", async () => {
		const normalized = normalizeShortcutSettings({
			overrides: {
				rename: "f2",
				focusSearch: "Mod+F", // matches default -> stripped from overrides
				openTerminal: "Mod+J", // unknown -> stripped
				dismiss: "Mod+Q", // locked/unknown -> stripped
				undo: "Escape", // invalid -> stripped
				copy: "Mod+D", // conflicts with duplicate's default unless duplicate changed -> wait: copy overrides Mod+D? No: copy has explicit override Mod+D, duplicate has no override (default Mod+D) -> conflict!
			},
		});

		expect(normalized.overrides.rename).toBe("F2");
		expect(normalized.overrides.focusSearch).toBeUndefined();
		expect("openTerminal" in normalized.overrides).toBe(false);
		expect(normalized.overrides.undo).toBeUndefined();
		// Explicit override conflicting with an untouched default action is dropped so defaults never break silently
		expect(normalized.overrides.copy).toBeUndefined();
		expect(isDefaultShortcutSettings(normalized)).toBe(false);
		expect(isDefaultShortcutSettings(DEFAULT_SHORTCUT_SETTINGS)).toBe(true);

		const dir = await mkdtemp(join(tmpdir(), "shortcuts-settings-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const file = join(dir, "settings-state.json");
		await writeFile(
			file,
			JSON.stringify({
				settings: {
					shortcuts: {
						overrides: {
							rename: "⌘⇧R",
							redo: "Ctrl+Y",
							nonExistentFeature: "Mod+9",
						},
					},
				},
				permissions: {},
			}),
			"utf8",
		);

		const service = createSettingsService({
			directory: dir,
			dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
			models: { resolve: vi.fn(), catalog: vi.fn() } as never,
			config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
			refreshConfig: vi.fn() as never,
			credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
		});

		const loaded = await service.get();
		expect(loaded.shortcuts.overrides).toEqual({
			rename: "Mod+Shift+R",
			redo: "Mod+Y",
		});

		await service.set({ shortcuts: { overrides: { focusSearch: "Mod+P" } } });
		const rawOnDisk = JSON.parse(await readFile(file, "utf8"));
		expect(rawOnDisk.settings.shortcuts).toEqual({ overrides: { focusSearch: "Mod+P" } });
	});
});

describe("resolveKeyAction with custom ShortcutSettings", () => {
	it("dispatches customized bindings while unbinding replaced defaults and keeping typing/zone guards intact", () => {
		const custom = normalizeShortcutSettings({
			overrides: {
				focusSearch: "Mod+P",
				rename: "F2",
				redo: "Mod+Y",
			},
		});

		// Customized Mod+P triggers focusSearch even while typing; old Mod+F no longer triggers focusSearch
		expect(resolveKeyAction({ key: "p", meta: true, shift: false, alt: false }, { zone: "finder", typing: true }, custom)).toEqual({
			type: "focusSearch",
		});
		expect(resolveKeyAction({ key: "f", meta: true, shift: false, alt: false }, { zone: "finder", typing: false }, custom)).toBeNull();

		// Customized F2 triggers rename in finder zone when not typing, ignored while typing
		expect(resolveKeyAction({ key: "F2", meta: false, shift: false, alt: false }, { zone: "finder", typing: false }, custom)).toEqual({
			type: "rename",
		});
		expect(resolveKeyAction({ key: "F2", meta: false, shift: false, alt: false }, { zone: "finder", typing: true }, custom)).toBeNull();
		expect(resolveKeyAction({ key: "r", meta: true, shift: false, alt: false }, { zone: "finder", typing: false }, custom)).toBeNull();

		// Customized Mod+Y triggers redo; Undo remains Mod+Z
		expect(resolveKeyAction({ key: "y", meta: true, shift: false, alt: false }, { zone: "finder", typing: false }, custom)).toEqual({
			type: "redo",
		});
		expect(resolveKeyAction({ key: "z", meta: true, shift: false, alt: false }, { zone: "finder", typing: false }, custom)).toEqual({
			type: "undo",
		});

		// Escape always dismisses
		expect(resolveKeyAction({ key: "Escape", meta: false, shift: false, alt: false }, { zone: "finder", typing: true }, custom)).toEqual({
			type: "dismiss",
		});
	});
});
