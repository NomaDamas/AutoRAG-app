import { describe, expect, it } from "vitest";
import { splitTwoFolders } from "../src/renderer/src/first-run/tour";
import { grayCopy } from "../src/renderer/src/first-run/tutorial-steps";
import { allTabs, createWorkspace, paneOf, type Workspace } from "../src/renderer/src/state/workspace";

const paths = (ws: Workspace): string[][] => ws.panes.map((pane) => pane.tabs.map((tab) => tab.path));

describe("splitTwoFolders", () => {
	it("puts the left folder in the existing pane and the right one in a new pane beside it, focused", () => {
		const ws = splitTwoFolders(createWorkspace("/home"), "/home/Downloads", "/home/Practice");
		expect(ws.panes).toHaveLength(2);
		expect(ws.layout.kind).toBe("split");
		const shown = ws.panes.map((pane) => pane.tabs.find((tab) => tab.id === pane.activeId)?.path);
		expect(shown).toEqual(["/home/Downloads", "/home/Practice"]);
		expect(paneOf(ws, ws.focusedPaneId).tabs.find((tab) => tab.id === paneOf(ws, ws.focusedPaneId).activeId)?.path).toBe("/home/Practice");
	});

	it("reuses an existing second pane instead of splitting again", () => {
		const once = splitTwoFolders(createWorkspace("/home"), "/home/Downloads", "/home/Practice");
		const twice = splitTwoFolders(once, "/home/Downloads", "/home/Other");
		expect(twice.panes).toHaveLength(2);
		expect(allTabs(twice).filter((tab) => tab.path === "/home/Downloads")).toHaveLength(1);
		expect(paths(twice).flat()).toContain("/home/Other");
	});
});

describe("grayCopy", () => {
	const before = new Set(["/home/Downloads/흑백/older.jpg"]);

	it("waits while the output folder is empty, missing, or only holds what was there before", () => {
		expect(grayCopy([], before)).toBeNull();
		expect(grayCopy(["/home/Downloads/흑백/older.jpg"], before)).toBeNull();
	});

	it("returns the new picture", () => {
		expect(grayCopy(["/home/Downloads/흑백/older.jpg", "/home/Downloads/흑백/IMG_0001_gray.jpg"], before)).toBe("/home/Downloads/흑백/IMG_0001_gray.jpg");
	});

	it("ignores other kinds of file", () => {
		expect(grayCopy(["/home/Downloads/흑백/notes.txt", "/home/Downloads/흑백/.DS_Store"], before)).toBeNull();
	});

	it("takes paths as the listing spells them, so a symlinked folder still works", () => {
		expect(grayCopy(["/private/var/T/Downloads/흑백/a_gray.jpg"], new Set())).toBe("/private/var/T/Downloads/흑백/a_gray.jpg");
	});
});
