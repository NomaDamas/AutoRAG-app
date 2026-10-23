import { afterEach, describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { formatModified } from "../src/renderer/src/state/format";
import { inspectorEntryFor } from "../src/renderer/src/state/inspector-target";
import { AI_SEARCH_PATH, AUTOMATIONS_PATH, SETTINGS_PATH } from "../src/renderer/src/state/tabs";
import { RECENTS_PATH, tagPath } from "../src/shared/fs-contract";
import type { AutomationRule } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n";

afterEach(async () => {
	await setAppLanguage("ko");
});

function rule(paths: readonly string[]): AutomationRule {
	return {
		id: "downloads-pdf-summary",
		paths,
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "search", "Summarize the document"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: null,
	};
}

function entry(path: string, kind: FinderEntry["kind"] = "file"): FinderEntry {
	return { name: path.split("/").pop() ?? path, path, kind, ext: "", size: kind === "file" ? 1 : null, mtimeMs: 1, birthtimeMs: 0 };
}

const DOWNLOADS = "/Users/jeffrey/Downloads";

function target(overrides: Partial<Parameters<typeof inspectorEntryFor>[0]> = {}): FinderEntry | null {
	return inspectorEntryFor({
		focused: null,
		selectedCount: 0,
		searching: false,
		path: DOWNLOADS,
		rules: [rule([DOWNLOADS])],
		...overrides,
	});
}

describe("inspectorEntryFor", () => {
	it("keeps the row the person selected", () => {
		const row = entry(`${DOWNLOADS}/report.pdf`);
		expect(target({ focused: row, selectedCount: 1 })).toBe(row);
	});

	it("shows the folder in view when nothing is selected and a rule watches it", () => {
		const shown = target();
		expect(shown).toMatchObject({ kind: "folder", path: DOWNLOADS, name: "Downloads" });
	});

	it("also shows a folder inside a watched one, as the rules section already does for a selected folder", () => {
		expect(target({ path: `${DOWNLOADS}/2026`, rules: [rule([DOWNLOADS])] })).toMatchObject({ kind: "folder", path: `${DOWNLOADS}/2026`, name: "2026" });
	});

	it("stays empty for a folder no rule watches", () => {
		expect(target({ rules: [rule(["/Users/jeffrey/Desktop"])] })).toBeNull();
		expect(target({ rules: [] })).toBeNull();
	});

	it("leaves a multi-selection to the inspector's own summary", () => {
		expect(target({ selectedCount: 3 })).toBeNull();
	});

	it("stays empty where there is no folder: the app's own tabs, Recents, and tags", () => {
		for (const path of ["", SETTINGS_PATH, AI_SEARCH_PATH, AUTOMATIONS_PATH, RECENTS_PATH, tagPath("Research")]) {
			expect(target({ path, rules: [rule([DOWNLOADS, path])] }), path || "(empty)").toBeNull();
		}
	});

	it("treats a path that merely starts with a watched name as a different folder", () => {
		expect(target({ path: `${DOWNLOADS}-old` })).toBeNull();
	});

	it("stays empty while a search is showing, since the rows are results and not this folder's contents", () => {
		expect(target({ searching: true })).toBeNull();
	});

	it("names a drive root by its path rather than an empty name", () => {
		expect(target({ path: "/", rules: [rule(["/"])] })).toMatchObject({ kind: "folder", path: "/", name: "/" });
	});

	it("gives the folder no size and no time it does not know, so the inspector prints dashes, not 1970", () => {
		const shown = target();
		expect(shown?.size).toBeNull();
		expect(Number.isNaN(shown?.mtimeMs)).toBe(true);
		expect(formatModified(shown?.mtimeMs ?? 0)).toBe("—");
	});
});
