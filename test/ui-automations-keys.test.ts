import { describe, expect, it } from "vitest";
import { ruleKeyAction, type RuleKeyContext } from "../src/renderer/src/state/automations-keys";

const idle: RuleKeyContext = { typing: false, overlay: "none", hasSelection: true };
const press = (key: string, extra: Partial<{ meta: boolean; shift: boolean; alt: boolean }> = {}) => ({ key, meta: false, shift: false, alt: false, ...extra });

describe("ruleKeyAction", () => {
	it("moves the selection with the arrow keys, and Space looks at the selected rule", () => {
		expect(ruleKeyAction(press("ArrowDown"), idle)).toEqual({ type: "step", direction: 1 });
		expect(ruleKeyAction(press("ArrowUp"), idle)).toEqual({ type: "step", direction: -1 });
		expect(ruleKeyAction(press(" "), idle)).toEqual({ type: "preview" });
	});

	it("opens the edit draft on Enter and asks to delete on Delete, Backspace, and ⌘⌫", () => {
		expect(ruleKeyAction(press("Enter"), idle)).toEqual({ type: "edit" });
		expect(ruleKeyAction(press("Backspace", { meta: true }), idle)).toEqual({ type: "delete" });
		expect(ruleKeyAction(press("Backspace"), idle)).toEqual({ type: "delete" });
		expect(ruleKeyAction(press("Delete"), idle)).toEqual({ type: "delete" });
	});

	it("needs a selected rule for everything except stepping, which picks the first or last", () => {
		const none = { ...idle, hasSelection: false };
		expect(ruleKeyAction(press("ArrowDown"), none)).toEqual({ type: "step", direction: 1 });
		for (const key of [" ", "Enter", "Delete"]) expect(ruleKeyAction(press(key), none), key).toBeNull();
	});

	it("leaves every key to a text field while one is focused", () => {
		const typing = { ...idle, typing: true };
		for (const key of ["ArrowDown", " ", "Enter", "Backspace", "Escape"]) expect(ruleKeyAction(press(key), typing), key).toBeNull();
	});

	it("lets Escape close whichever layer is open, and ignores Escape when nothing is", () => {
		for (const overlay of ["preview", "menu", "confirm"] as const) expect(ruleKeyAction(press("Escape"), { ...idle, overlay }), overlay).toEqual({ type: "dismiss" });
		expect(ruleKeyAction(press("Escape"), idle)).toBeNull();
	});

	it("keeps Quick Look following the arrows, and closes it again on Space", () => {
		const open = { ...idle, overlay: "preview" as const };
		expect(ruleKeyAction(press("ArrowDown"), open)).toEqual({ type: "step", direction: 1 });
		expect(ruleKeyAction(press(" "), open)).toEqual({ type: "preview" });
	});

	it("freezes the list behind a menu or the delete confirm: only Escape reaches it", () => {
		for (const overlay of ["menu", "confirm"] as const) {
			for (const key of ["ArrowDown", " ", "Enter", "Delete"]) expect(ruleKeyAction(press(key), { ...idle, overlay }), `${overlay} ${key}`).toBeNull();
		}
	});

	it("does not take shortcuts that belong to the window or the OS", () => {
		expect(ruleKeyAction(press(" ", { meta: true }), idle)).toBeNull();
		expect(ruleKeyAction(press("ArrowDown", { meta: true }), idle)).toBeNull();
		expect(ruleKeyAction(press("Enter", { alt: true }), idle)).toBeNull();
		expect(ruleKeyAction(press("a"), idle)).toBeNull();
	});
});
