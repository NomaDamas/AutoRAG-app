import { describe, expect, it } from "vitest";
import type { SetupStatus } from "../src/shared/onboarding-contract";
import { canStartEarly, initialScreen, nextStep, showAiSearchAlone, splitTwoFolders, tourSteps } from "../src/renderer/src/first-run/tour";
import { AI_SEARCH_PATH } from "../src/renderer/src/state/tabs";
import { grayCopy } from "../src/renderer/src/first-run/tutorial-steps";
import { allTabs, createWorkspace, paneOf, type Workspace } from "../src/renderer/src/state/workspace";

const paths = (ws: Workspace): string[][] => ws.panes.map((pane) => pane.tabs.map((tab) => tab.path));

describe("initialScreen", () => {
	const status = (stage: SetupStatus["stage"]): SetupStatus => ({
		stage,
		progress: 0,
		remainingMinutes: null,
		totalFiles: 0,
		processedFiles: 0,
		recentFile: null,
		excludedFolders: 0,
		demo: null,
		error: null,
		startedAt: null,
		finishedAt: null,
	});

	it("asks for the folders before any run, and shows the run once one is under way", () => {
		expect(initialScreen(status("idle"))).toBe("folders");
		expect(initialScreen(status("scanning"))).toBe("setup");
		expect(initialScreen(status("failed"))).toBe("setup");
		expect(initialScreen(status("ready"))).toBe("ready");
	});
});

describe("canStartEarly", () => {
	const base: SetupStatus = {
		stage: "indexing",
		progress: 40,
		remainingMinutes: 3,
		totalFiles: 90,
		processedFiles: 30,
		recentFile: null,
		excludedFolders: 0,
		demo: { question: "What is the deposit?", sourcePath: "/Users/a/Documents/lease.pdf", latencyMs: 40 },
		error: null,
		startedAt: null,
		finishedAt: null,
	};

	it("offers an early start only while the files are still being read and a verified question exists", () => {
		expect(canStartEarly(base)).toBe(true);
		expect(canStartEarly({ ...base, demo: null })).toBe(false);
		expect(canStartEarly(null)).toBe(false);
	});

	it("does not offer it before reading starts, or once the reading is over", () => {
		for (const stage of ["idle", "scanning", "planning", "duplicates", "preparing", "ready", "failed"] as const) expect(canStartEarly({ ...base, stage })).toBe(false);
	});
});

describe("tourSteps", () => {
	it("shows one thing: ask, the answer, and its evidence", () => {
		expect(tourSteps({ demo: true })).toEqual(["ask", "cite", "evidence"]);
		expect(tourSteps({ demo: false })).toEqual([]);
	});

	it("ends after the answer when it carries no citation", () => {
		expect(nextStep(tourSteps({ demo: true }), "cite", { cited: false })).toBeNull();
		expect(nextStep(tourSteps({ demo: true }), "cite", { cited: true })).toBe("evidence");
	});
});

describe("showAiSearchAlone", () => {
	it("turns the folder tab into the AI 에이전트 tab without splitting the window", () => {
		const ws = showAiSearchAlone(createWorkspace("/home"));
		expect(ws.panes).toHaveLength(1);
		expect(paths(ws)).toEqual([[AI_SEARCH_PATH]]);
	});

	it("leaves a window that already shows it as it is", () => {
		const once = showAiSearchAlone(createWorkspace("/home"));
		expect(showAiSearchAlone(once)).toEqual(once);
	});
});

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
