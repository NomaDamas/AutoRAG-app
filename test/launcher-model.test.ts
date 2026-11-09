import { describe, expect, it } from "vitest";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	actionsFor,
	buildLauncherRows,
	launcherKeyAction,
	moveSelection,
	rankNameHits,
	selectedPaths,
	type LauncherRow,
} from "../src/renderer/src/state/launcher";

function entry(path: string, kind: "file" | "folder" = "file", mtimeMs = 0): FinderEntry {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return { name, path, kind, ext: kind === "file" && dot > 0 ? name.slice(dot + 1) : "", size: kind === "file" ? 1 : null, mtimeMs, birthtimeMs: 0 };
}

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}) => ({
	key: k,
	code: mods.code,
	metaKey: mods.meta ?? false,
	ctrlKey: mods.ctrl ?? false,
	shiftKey: mods.shift ?? false,
	altKey: mods.alt ?? false,
});

describe("rankNameHits", () => {
	it("puts a name that starts with the query first, then a word start, then anywhere, shorter names first", () => {
		const ranked = rankNameHits(
			[entry("/a/my-report-old.md"), entry("/a/xreport.md"), entry("/a/report-2026.md"), entry("/a/report.md")],
			"Report",
		);
		expect(ranked.map((row) => row.name)).toEqual(["report.md", "report-2026.md", "my-report-old.md", "xreport.md"]);
	});

	it("matches composed Hangul against a decomposed file name", () => {
		const nfd = entry(`/a/${"보안 점검.hwp".normalize("NFD")}`);
		expect(rankNameHits([entry("/a/other.txt"), nfd], "보안").map((row) => row.path)).toEqual([nfd.path, "/a/other.txt"]);
	});
});

describe("buildLauncherRows", () => {
	const recents = [entry("/r/1.md"), entry("/r/2.md")];

	it("shows the recent files for an empty query, and no Ask row", () => {
		const rows = buildLauncherRows({ query: "  ", recents, names: [], content: [] });
		expect(rows.map((row) => (row.kind === "file" ? [row.section, row.entry.path] : [row.kind]))).toEqual([
			["recent", "/r/1.md"],
			["recent", "/r/2.md"],
		]);
	});

	it("lists name matches, then content matches not already listed, then the Ask row", () => {
		const rows = buildLauncherRows({
			query: "refund",
			recents,
			names: [entry("/d/refund.md")],
			content: [
				{ entry: entry("/d/refund.md"), snippet: "dup", line: 1, score: 1 },
				{ entry: entry("/d/policy.pdf"), snippet: "full refund within 7 days", line: 4, score: 0.9 },
			],
		});
		expect(rows.map((row) => (row.kind === "file" ? [row.section, row.entry.path, row.snippet] : [row.kind, row.query]))).toEqual([
			["name", "/d/refund.md", null],
			["content", "/d/policy.pdf", "full refund within 7 days"],
			["ask", "refund"],
		]);
	});

	it("caps each section", () => {
		const names = Array.from({ length: 30 }, (_, index) => entry(`/n/refund-${index}.md`));
		const rows = buildLauncherRows({ query: "refund", recents: [], names, content: [] });
		expect(rows.filter((row) => row.kind === "file")).toHaveLength(8);
	});
});

describe("selection", () => {
	const rows: LauncherRow[] = buildLauncherRows({
		query: "a",
		recents: [],
		names: [entry("/x/a1"), entry("/x/a2"), entry("/x/a3")],
		content: [],
	});

	it("moves and stops at both ends", () => {
		let selection = { anchor: 0, focus: 0 };
		selection = moveSelection(selection, -1, rows.length, false);
		expect(selection).toEqual({ anchor: 0, focus: 0 });
		for (let step = 0; step < 10; step += 1) selection = moveSelection(selection, 1, rows.length, false);
		expect(selection).toEqual({ anchor: 3, focus: 3 });
	});

	it("extends a range with Shift and copies every file in it, never the Ask row", () => {
		let selection = { anchor: 0, focus: 0 };
		selection = moveSelection(selection, 1, rows.length, true);
		selection = moveSelection(selection, 1, rows.length, true);
		selection = moveSelection(selection, 1, rows.length, true);
		expect(selectedPaths(rows, selection)).toEqual(["/x/a1", "/x/a2", "/x/a3"]);
	});
});

describe("launcherKeyAction", () => {
	const idle = { panelOpen: false, textSelected: false };

	it("maps the launcher's keys on macOS", () => {
		expect(launcherKeyAction(key("ArrowDown"), idle, "darwin")).toEqual({ type: "move", delta: 1, extend: false });
		expect(launcherKeyAction(key("ArrowUp", { shift: true }), idle, "darwin")).toEqual({ type: "move", delta: -1, extend: true });
		expect(launcherKeyAction(key("Enter", { code: "Enter" }), idle, "darwin")).toEqual({ type: "run", action: "open" });
		expect(launcherKeyAction(key("Enter", { code: "Enter", meta: true }), idle, "darwin")).toEqual({ type: "run", action: "revealOs" });
		expect(launcherKeyAction(key("Enter", { code: "Enter", meta: true, shift: true }), idle, "darwin")).toEqual({ type: "run", action: "showInApp" });
		expect(launcherKeyAction(key("Enter", { code: "Enter", alt: true }), idle, "darwin")).toEqual({ type: "run", action: "askQuery" });
		expect(launcherKeyAction(key("c", { code: "KeyC", meta: true }), idle, "darwin")).toEqual({ type: "run", action: "copyFile" });
		expect(launcherKeyAction(key("C", { code: "KeyC", meta: true, shift: true }), idle, "darwin")).toEqual({ type: "run", action: "copyPath" });
		expect(launcherKeyAction(key("k", { code: "KeyK", meta: true }), idle, "darwin")).toEqual({ type: "panel" });
		expect(launcherKeyAction(key("Escape", { code: "Escape" }), idle, "darwin")).toEqual({ type: "dismiss" });
	});

	it("uses Ctrl on Windows and leaves the Windows key alone", () => {
		expect(launcherKeyAction(key("c", { code: "KeyC", ctrl: true }), idle, "win32")).toEqual({ type: "run", action: "copyFile" });
		expect(launcherKeyAction(key("c", { code: "KeyC", meta: true }), idle, "win32")).toBeNull();
	});

	it("lets the text field copy its own selected text, and leaves typing alone", () => {
		expect(launcherKeyAction(key("c", { code: "KeyC", meta: true }), { panelOpen: false, textSelected: true }, "darwin")).toBeNull();
		expect(launcherKeyAction(key("a", { code: "KeyA" }), idle, "darwin")).toBeNull();
		expect(launcherKeyAction(key("a", { code: "KeyA", meta: true }), idle, "darwin")).toBeNull();
	});

	it("moves through the action panel while it is open instead of the results", () => {
		expect(launcherKeyAction(key("ArrowDown"), { panelOpen: true, textSelected: false }, "darwin")).toEqual({ type: "panelMove", delta: 1 });
		expect(launcherKeyAction(key("Enter", { code: "Enter" }), { panelOpen: true, textSelected: false }, "darwin")).toEqual({ type: "panelRun" });
	});

	it("gives Space to the query while typing and to the preview while browsing, from an empty query, or with it open", () => {
		const space = key(" ", { code: "Space" });
		expect(launcherKeyAction(space, idle, "darwin")).toBeNull();
		expect(launcherKeyAction(space, { ...idle, browsing: true }, "darwin")).toEqual({ type: "run", action: "preview" });
		expect(launcherKeyAction(space, { ...idle, queryEmpty: true }, "darwin")).toEqual({ type: "run", action: "preview" });
		expect(launcherKeyAction(space, { ...idle, previewOpen: true }, "darwin")).toEqual({ type: "run", action: "preview" });
		expect(launcherKeyAction(space, { panelOpen: true, textSelected: false, browsing: true }, "darwin")).toBeNull();
		expect(launcherKeyAction(key("y", { code: "KeyY", meta: true }), idle, "darwin")).toEqual({ type: "run", action: "preview" });
		expect(launcherKeyAction(key("y", { code: "KeyY", ctrl: true }), idle, "win32")).toEqual({ type: "run", action: "preview" });
	});
});

describe("actionsFor", () => {
	it("offers the file actions for a file and only the question for the Ask row", () => {
		const [file, ask] = buildLauncherRows({ query: "q", recents: [], names: [entry("/d/q.md")], content: [] });
		expect(actionsFor(file).map((action) => action.id)).toEqual(["open", "preview", "revealOs", "showInApp", "copyFile", "copyPath", "askAbout"]);
		expect(actionsFor(ask).map((action) => action.id)).toEqual(["askQuery"]);
		expect(actionsFor(undefined)).toEqual([]);
	});
});
