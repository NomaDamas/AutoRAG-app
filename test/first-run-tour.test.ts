import { describe, expect, it } from "vitest";
import { splitTwoFolders } from "../src/renderer/src/first-run/tour";
import { renamedPhoto } from "../src/renderer/src/first-run/tutorial-steps";
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

describe("renamedPhoto", () => {
	const facts = { downloads: "/home/Downloads", photo: "/home/Practice/IMG_0001.jpg" };
	const before = new Set(["/home/Downloads/old.png", "/home/Downloads/notes.txt"]);

	it("waits while the photo still has the placeholder name or has not arrived", () => {
		expect(renamedPhoto(["/home/Downloads/old.png"], facts, before)).toBeNull();
		expect(renamedPhoto(["/home/Downloads/old.png", "/home/Downloads/IMG_0001.jpg"], facts, before)).toBeNull();
	});

	it("returns the new picture directly in Downloads, ignoring what was already there, other file kinds, and sub-folders", () => {
		const paths = ["/home/Downloads/old.png", "/home/Downloads/IMG_0001.jpg", "/home/Downloads/budget.xlsx", "/home/Downloads/sub/cat.jpg", "/home/Downloads/astronaut-and-flag-on-the-moon.jpg"];
		expect(renamedPhoto(paths, facts, before)).toBe("/home/Downloads/astronaut-and-flag-on-the-moon.jpg");
	});

	it("does not mistake a pane showing another folder for Downloads", () => {
		expect(renamedPhoto(["/home/Practice/astronaut.jpg"], facts, before)).toBeNull();
	});
});
