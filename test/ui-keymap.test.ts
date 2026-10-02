import { describe, expect, it } from "vitest";
import { resolveKeyAction } from "../src/renderer/src/state/keymap";

const finder = { zone: "finder" as const, typing: false };
const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
	key: k,
	meta: mods.meta ?? false,
	ctrl: mods.ctrl ?? false,
	shift: mods.shift ?? false,
	alt: mods.alt ?? false,
});

describe("resolveKeyAction", () => {
	it("toggles Quick Look with space in the Finder zone", () => {
		expect(resolveKeyAction(key(" "), finder)).toEqual({ type: "quickLook" });
	});

	it("never steals space while the user is typing", () => {
		expect(resolveKeyAction(key(" "), { ...finder, typing: true })).toBeNull();
	});

	it("moves the selection with the arrow keys", () => {
		expect(resolveKeyAction(key("ArrowDown"), finder)).toEqual({ type: "moveSelection", delta: 1 });
		expect(resolveKeyAction(key("ArrowUp"), finder)).toEqual({ type: "moveSelection", delta: -1 });
	});

	it("moves the evidence number in the evidence zone", () => {
		const evidence = { zone: "evidence" as const, typing: false };
		expect(resolveKeyAction(key("ArrowDown"), evidence)).toEqual({ type: "moveEvidence", delta: 1 });
		expect(resolveKeyAction(key("ArrowLeft"), evidence)).toEqual({ type: "moveEvidence", delta: -1 });
		expect(resolveKeyAction(key("ArrowRight"), evidence)).toEqual({ type: "moveEvidence", delta: 1 });
	});

	it("discloses folders with left and right in the Finder zone, never while typing", () => {
		expect(resolveKeyAction(key("ArrowRight"), finder)).toEqual({ type: "disclose", direction: "expand" });
		expect(resolveKeyAction(key("ArrowLeft"), finder)).toEqual({ type: "disclose", direction: "collapse" });
		expect(resolveKeyAction(key("ArrowLeft"), { ...finder, typing: true })).toBeNull();
	});

	it("opens the selection with Enter", () => {
		expect(resolveKeyAction(key("Enter"), finder)).toEqual({ type: "open" });
		expect(resolveKeyAction(key("Enter"), { ...finder, typing: true })).toBeNull();
	});

	it("trashes with Delete and Backspace, never while typing", () => {
		expect(resolveKeyAction(key("Delete"), finder)).toEqual({ type: "trash" });
		expect(resolveKeyAction(key("Backspace"), finder)).toEqual({ type: "trash" });
		expect(resolveKeyAction(key("Backspace"), { ...finder, typing: true })).toBeNull();
		expect(resolveKeyAction(key("Delete"), { zone: "evidence", typing: false })).toBeNull();
	});

	it("dismisses with Escape even while typing", () => {
		expect(resolveKeyAction(key("Escape"), finder)).toEqual({ type: "dismiss" });
		expect(resolveKeyAction(key("Escape"), { ...finder, typing: true })).toEqual({ type: "dismiss" });
	});

	it("maps the command shortcuts", () => {
		expect(resolveKeyAction(key("f", { meta: true }), finder)).toEqual({ type: "focusSearch" });
		expect(resolveKeyAction(key("F", { meta: true }), finder)).toEqual({ type: "focusSearch" });
		expect(resolveKeyAction(key("t", { meta: true }), finder)).toEqual({ type: "newTab" });
		expect(resolveKeyAction(key("w", { meta: true }), finder)).toEqual({ type: "closeTab" });
		expect(resolveKeyAction(key("f", { meta: true }), { ...finder, typing: true })).toEqual({ type: "focusSearch" });
	});

	it("maps control shortcuts for Windows and Linux", () => {
		expect(resolveKeyAction(key("f", { ctrl: true }), finder)).toEqual({ type: "focusSearch" });
	});

	it("switches the view mode with command 1, 2, 3", () => {
		expect(resolveKeyAction(key("1", { meta: true }), finder)).toEqual({ type: "setViewMode", mode: "icons" });
		expect(resolveKeyAction(key("2", { meta: true }), finder)).toEqual({ type: "setViewMode", mode: "list" });
		expect(resolveKeyAction(key("3", { meta: true }), finder)).toEqual({ type: "setViewMode", mode: "columns" });
		expect(resolveKeyAction(key("3", { ctrl: true }), finder)).toEqual({ type: "setViewMode", mode: "columns" });
		expect(resolveKeyAction(key("4", { meta: true }), finder)).toBeNull();
	});

	it("moves sideways with left and right in the icon and column views", () => {
		expect(resolveKeyAction(key("ArrowRight"), { ...finder, viewMode: "icons" })).toEqual({ type: "moveSelectionSideways", delta: 1 });
		expect(resolveKeyAction(key("ArrowLeft"), { ...finder, viewMode: "columns" })).toEqual({ type: "moveSelectionSideways", delta: -1 });
		expect(resolveKeyAction(key("ArrowLeft"), { ...finder, viewMode: "list" })).toEqual({ type: "disclose", direction: "collapse" });
		expect(resolveKeyAction(key("ArrowRight"), { ...finder, viewMode: "icons", typing: true })).toBeNull();
	});

	it("ignores unmapped keys", () => {
		expect(resolveKeyAction(key("x"), finder)).toBeNull();
		expect(resolveKeyAction(key("t"), finder)).toBeNull();
	});
});
