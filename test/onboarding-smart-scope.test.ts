import { describe, expect, it } from "vitest";
import {
	addExclusion,
	etaSaving,
	excludedTotals,
	indexingExclusions,
	initialSmartRun,
	reduceSmartRun,
	setScopeExcluded,
	setScopeMeasure,
	visibleScope,
} from "../src/renderer/src/onboarding/smart-scope";
import type { SmartExclusion, SmartIndexingEvent } from "../src/shared/smart-indexing-contract";

function entry(path: string, overrides: Partial<SmartExclusion> = {}): SmartExclusion {
	return { path, root: "/docs", reason: "r", files: 10, bytes: 1000, excluded: true, ...overrides };
}

const SCOPE: readonly SmartExclusion[] = [
	entry("/docs/Zoom", { files: 4, bytes: 400 }),
	entry("/docs/Telegram", { files: 6, bytes: 600, excluded: false }),
	entry("/desktop/Captures", { root: "/desktop", files: 20, bytes: 2000 }),
];

describe("smart scope", () => {
	it("shows only the proposals under folders that are still selected", () => {
		expect(visibleScope(SCOPE, ["/docs"]).map((item) => item.path)).toEqual(["/docs/Zoom", "/docs/Telegram"]);
		expect(visibleScope(SCOPE, [])).toEqual([]);
		expect(visibleScope(undefined, ["/docs"])).toEqual([]);
	});

	it("totals only what is excluded under selected folders", () => {
		expect(excludedTotals(SCOPE, ["/docs"])).toEqual({ folders: 1, files: 4, bytes: 400 });
		expect(excludedTotals(SCOPE, ["/docs", "/desktop"])).toEqual({ folders: 2, files: 24, bytes: 2400 });
		expect(excludedTotals(undefined, ["/docs"])).toEqual({ folders: 0, files: 0, bytes: 0 });
	});

	it("hands the indexer the excluded folders of selected roots and how many files they hold", () => {
		expect(indexingExclusions(SCOPE, ["/docs"])).toEqual({ excludePaths: ["/docs/Zoom"], excludedFiles: 4 });
		expect(indexingExclusions(SCOPE, [])).toEqual({ excludePaths: [], excludedFiles: 0 });
		expect(indexingExclusions(undefined, ["/docs"])).toEqual({ excludePaths: [], excludedFiles: 0 });
	});

	it("flips one proposal and leaves the others and the input untouched", () => {
		const next = setScopeExcluded(SCOPE, "/docs/Telegram", true);

		expect(next.map((item) => item.excluded)).toEqual([true, true, true]);
		expect(SCOPE[1]?.excluded).toBe(false);
		expect(setScopeExcluded(SCOPE, "/docs/missing", false)).toEqual(SCOPE);
	});

	it("adds a folder the user picked under a selected root, and refuses what cannot be left out", () => {
		const added = addExclusion(SCOPE, "/docs/Drafts", ["/docs"]);
		expect(added.status).toBe("added");
		expect(added.scope.at(-1)).toEqual({ path: "/docs/Drafts", root: "/docs", reason: "", files: 0, bytes: 0, excluded: true });

		expect(addExclusion(SCOPE, "/docs", ["/docs"]).status).toBe("isRoot");
		expect(addExclusion(SCOPE, "/elsewhere/Drafts", ["/docs"]).status).toBe("outside");
		expect(addExclusion(SCOPE, "/docs/Zoom/inner", ["/docs"]).status).toBe("covered");
		expect(addExclusion(SCOPE, "/docs/Zoom", ["/docs"]).status).toBe("covered");
	});

	it("brings a folder that was proposed but kept back in, and lets a wider folder replace the ones inside it", () => {
		const back = addExclusion(SCOPE, "/docs/Telegram", ["/docs"]);
		expect(back.status).toBe("added");
		expect(back.scope.find((item) => item.path === "/docs/Telegram")?.excluded).toBe(true);
		expect(back.scope).toHaveLength(SCOPE.length);

		const wider = addExclusion([entry("/docs/A/x"), entry("/docs/A/y"), entry("/docs/B")], "/docs/A", ["/docs"]);
		expect(wider.scope.map((item) => item.path)).toEqual(["/docs/B", "/docs/A"]);
	});

	it("fills in a measured folder's files and size", () => {
		const next = setScopeMeasure(SCOPE, "/docs/Zoom", 9, 900);

		expect(next.find((item) => item.path === "/docs/Zoom")).toMatchObject({ files: 9, bytes: 900 });
		expect(setScopeMeasure(SCOPE, "/docs/missing", 9, 900)).toBe(SCOPE);
	});

	it("shows what leaving files out saves in time", () => {
		expect(etaSaving(8500, 0, "local")).toEqual({ before: 100, after: 100, percent: 0 });
		expect(etaSaving(8500, 6800, "local")).toEqual({ before: 100, after: 20, percent: 80 });
		expect(etaSaving(0, 0, "local")).toEqual({ before: 1, after: 1, percent: 0 });
		// Keyword-only has a floor, so a small run saves nothing.
		expect(etaSaving(900, 400, "none")).toEqual({ before: 8, after: 8, percent: 0 });
	});
});

describe("smart run state", () => {
	const running = { status: "running", runId: "r1", current: null } as const;
	const event = (value: SmartIndexingEvent): SmartIndexingEvent => value;

	it("starts idle and follows the folder the agent is looking at", () => {
		expect(initialSmartRun).toEqual({ status: "idle" });
		expect(reduceSmartRun(running, event({ type: "exploring", runId: "r1", path: "/docs/Zoom" }))).toEqual({ status: "running", runId: "r1", current: "/docs/Zoom" });
	});

	it("finishes on a result, fails on an error, and returns to idle on a cancel", () => {
		expect(reduceSmartRun(running, event({ type: "result", runId: "r1", exclusions: [] }))).toEqual({ status: "done" });
		expect(reduceSmartRun(running, event({ type: "error", runId: "r1", message: "boom" }))).toEqual({ status: "error", message: "boom" });
		expect(reduceSmartRun(running, event({ type: "cancelled", runId: "r1" }))).toEqual({ status: "idle" });
	});

	it("ignores events of another run, and events when no run is going", () => {
		expect(reduceSmartRun(running, event({ type: "result", runId: "old", exclusions: [] }))).toBe(running);
		expect(reduceSmartRun(initialSmartRun, event({ type: "exploring", runId: "r1", path: "/x" }))).toBe(initialSmartRun);
	});
});
