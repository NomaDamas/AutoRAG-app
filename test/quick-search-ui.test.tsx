// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickSearch } from "../src/renderer/src/launcher/QuickSearch";
import type { ContentSearchResult } from "../src/shared/content-search-contract";
import type { FsEntry } from "../src/shared/fs-contract";
import { setAppLanguage } from "../src/shared/i18n";
import type { QuickSearchBridge } from "../src/shared/quick-search-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function fsEntry(path: string): FsEntry {
	const name = path.split("/").pop() ?? path;
	return { name, path, kind: "file", ext: name.split(".").pop() ?? "", size: 1, mtimeMs: 1, flags: 0 };
}

interface Calls {
	opened: string[];
	copied: string[][];
	paths: string[][];
	asked: string[];
	attached: string[][];
	hidden: string[];
	revealed: string[];
}

function fakeBridge(calls: Calls): QuickSearchBridge {
	return {
		platform: "darwin",
		language: "en",
		onLanguage: () => () => {},
		onShown: () => () => {},
		hide: (mode) => calls.hidden.push(mode),
		revealInApp: async (path) => {
			calls.revealed.push(path);
		},
		ask: async (query) => {
			calls.asked.push(query);
		},
		attach: async (paths) => {
			calls.attached.push([...paths]);
		},
		startDrag: () => {},
		searchNames: async (query) => (query === "report" ? [fsEntry("/d/report.md"), fsEntry("/d/report-2.md")].map((entry) => ({ entry, location: "d" })) : []),
		searchContent: async (query): Promise<ContentSearchResult> => ({
			state: "ok",
			hits: query === "report" ? [{ entry: fsEntry("/d/q3.pdf"), snippet: "the quarterly report", line: 3, score: 1 }] : [],
		}),
		recents: async () => [fsEntry("/r/recent.md")],
		icons: async () => [],
		open: async (path) => {
			calls.opened.push(path);
		},
		reveal: async () => {},
		copyFiles: async (paths) => {
			calls.copied.push([...paths]);
		},
		copyPaths: async (paths) => {
			calls.paths.push([...paths]);
		},
	};
}

let host: HTMLDivElement;
let root: Root;
let calls: Calls;

beforeEach(async () => {
	await setAppLanguage("en");
	vi.useFakeTimers({ shouldAdvanceTime: true });
	calls = { opened: [], copied: [], paths: [], asked: [], attached: [], hidden: [], revealed: [] };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<QuickSearch bridge={fakeBridge(calls)} />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const input = (): HTMLInputElement => host.querySelector("input") as HTMLInputElement;
const names = (): string[] => [...host.querySelectorAll(".qs__row[role=option] .qs__name")].map((node) => node.textContent ?? "");

async function type(text: string): Promise<void> {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input(), text);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(400);
	});
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
	await act(async () => {
		input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
	});
}

describe("quick search launcher page", () => {
	it("shows the recent files before anything is typed", () => {
		expect(names()).toEqual(["recent.md"]);
	});

	it("lists name matches, then content matches, then the Ask row; Enter opens the first and hands off", async () => {
		await type("report");
		expect(names()).toEqual(["report.md", "report-2.md", "q3.pdf", "Ask Dazzi: \u201creport\u201d"]);
		expect(host.textContent).toContain("the quarterly report");

		await press("Enter", { code: "Enter" });
		expect(calls.opened).toEqual(["/d/report.md"]);
		expect(calls.hidden).toEqual(["handoff"]);
	});

	it("copies a Shift-extended range as files and its paths with ⇧⌘C, without closing", async () => {
		await type("report");
		await press("ArrowDown", { shiftKey: true });
		await press("c", { code: "KeyC", metaKey: true });
		await press("C", { code: "KeyC", metaKey: true, shiftKey: true });

		expect(calls.copied).toEqual([["/d/report.md", "/d/report-2.md"]]);
		expect(calls.paths).toEqual([["/d/report.md", "/d/report-2.md"]]);
		expect(calls.hidden).toEqual([]);
	});

	it("asks Dazzi with the typed question from the Ask row or ⌥Enter anywhere", async () => {
		await type("report");
		await press("Enter", { code: "Enter", altKey: true });
		for (let step = 0; step < 3; step += 1) await press("ArrowDown");
		await press("Enter", { code: "Enter" });

		expect(calls.asked).toEqual(["report", "report"]);
	});

	it("runs an action from the ⌘K panel with the arrows and Enter", async () => {
		await type("report");
		await press("k", { code: "KeyK", metaKey: true });
		expect(host.querySelector(".qs__panel")).not.toBeNull();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("Enter", { code: "Enter" });

		expect(calls.revealed).toEqual(["/d/report.md"]);
		expect(host.querySelector(".qs__panel")).toBeNull();
	});

	it("selects a row with a click and opens it with a double-click", async () => {
		await type("report");
		const row = host.querySelectorAll(".qs__row[role=option]")[1] as HTMLElement;
		await act(async () => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(row.getAttribute("aria-selected")).toBe("true");
		expect(calls.opened).toEqual(["/d/report-2.md"]);
	});

	it("Escape clears the query first, then hides and gives the foreground back", async () => {
		await type("report");
		await press("Escape", { code: "Escape" });
		expect(input().value).toBe("");
		expect(calls.hidden).toEqual([]);
		await press("Escape", { code: "Escape" });
		expect(calls.hidden).toEqual(["restore"]);
	});
});
