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
	previews: string[];
}

/** The preview panel's side of the bridge: what the page asked it, plus its own close and arrow keys. */
const panel = { closed: () => {}, navigate: (_delta: 1 | -1) => {} };

function fakeBridge(calls: Calls, material: QuickSearchBridge["material"] = "glass"): QuickSearchBridge {
	return {
		platform: "darwin",
		material,
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
		preview: {
			show: async (target) => {
				calls.previews.push(`show ${target.path}`);
			},
			hide: async () => {
				calls.previews.push("hide");
			},
			prefetch: () => {},
			onClosed: (listener) => {
				panel.closed = listener;
				return () => {};
			},
			onNavigate: (listener) => {
				panel.navigate = listener;
				return () => {};
			},
			onOpenEdit: () => () => {},
		},
	};
}

let host: HTMLDivElement;
let root: Root;
let calls: Calls;

beforeEach(async () => {
	await setAppLanguage("en");
	vi.useFakeTimers({ shouldAdvanceTime: true });
	calls = { opened: [], copied: [], paths: [], asked: [], attached: [], hidden: [], revealed: [], previews: [] };
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
		expect(names()).toEqual(["report.md", "report-2.md", "q3.pdf", "Ask AI: \u201creport\u201d"]);
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

	it("Space previews the focused row once the person browses, follows the arrows, and Escape closes it before the launcher", async () => {
		await type("report");
		// Right after typing, Space belongs to the query.
		await press(" ", { code: "Space" });
		expect(calls.previews).toEqual([]);

		await press("ArrowDown");
		await press(" ", { code: "Space" });
		expect(calls.previews).toEqual(["show /d/report-2.md"]);

		await press("ArrowDown");
		expect(calls.previews).toEqual(["show /d/report-2.md", "show /d/q3.pdf"]);
		// The panel's own ↑ steps the launcher's selection, and the preview follows it.
		await act(async () => panel.navigate(-1));
		expect(calls.previews.at(-1)).toBe("show /d/report-2.md");
		// The Ask row has nothing to preview: reaching it closes the panel.
		await press("ArrowDown");
		await press("ArrowDown");
		expect(calls.previews.at(-1)).toBe("hide");

		await press("ArrowUp");
		await press(" ", { code: "Space" });
		await press("Escape", { code: "Escape" });
		expect(calls.previews.slice(-2)).toEqual(["show /d/q3.pdf", "hide"]);
		expect(input().value).toBe("report");
		expect(calls.hidden).toEqual([]);
	});

	it("previews from the empty query and with ⌘Y while typing, and stops following once the panel closed itself", async () => {
		await press(" ", { code: "Space" });
		expect(calls.previews).toEqual(["show /r/recent.md"]);
		await act(async () => panel.closed());

		await type("report");
		await press("y", { code: "KeyY", metaKey: true });
		expect(calls.previews.at(-1)).toBe("show /d/report.md");
		await act(async () => panel.closed());
		await press("ArrowDown");
		expect(calls.previews.at(-1)).toBe("show /d/report.md");
	});

	describe("liquid glass layout", () => {
		it("marks the surface with the material main attached, so the sheet knows how much of the glass to draw itself", async () => {
			expect(host.querySelector(".qs")?.getAttribute("data-material")).toBe("glass");
			await act(async () => root.render(<QuickSearch bridge={fakeBridge(calls, "solid")} />));
			expect(host.querySelector(".qs")?.getAttribute("data-material")).toBe("solid");
		});

		it("shows the Ask AI hint beside the field only once something is typed, and ⌥↩ chip clicks ask", async () => {
			expect(host.querySelector(".qs__ask-hint")).toBeNull();
			await type("report");
			const hint = host.querySelector(".qs__ask-hint") as HTMLButtonElement;
			expect(hint.textContent).toContain("Ask AI");
			expect(hint.querySelector(".qs__key")?.textContent).toBe("⌥↩");
			await act(async () => hint.click());
			expect(calls.asked).toEqual(["report"]);
		});

		it("right-aligns the folder a file lives in on every row, one line per name", async () => {
			expect([...host.querySelectorAll(".qs__row[role=option] .qs__trail")].map((node) => node.textContent)).toEqual(["r"]);
			await type("report");
			expect([...host.querySelectorAll(".qs__row[role=option] .qs__trail")].map((node) => node.textContent)).toEqual(["d", "d", "d"]);
			expect(host.querySelector(".qs__where")).toBeNull();
		});

		it("draws the row icons at 26px, a thumbnail included, never at the picture's own size", async () => {
			const icons = fakeBridge(calls);
			await act(async () => root.render(<QuickSearch bridge={{ ...icons, icons: async (targets) => targets.map((target) => ({ path: target.path, iconUrl: "autorag-thumb://x" }) as never) }} />));
			await type("report");
			const tiles = [...host.querySelectorAll(".qs__row[role=option] .tile")];
			expect(tiles.length).toBeGreaterThan(0);
			for (const tile of tiles) expect(tile.className).toContain("size-[26px]");
		});

		it("puts the actions in a round button at the footer's left and the primary action in a capsule at its right", async () => {
			await type("report");
			const capsule = host.querySelector(".qs__pill") as HTMLElement;
			expect(capsule.textContent).toContain("Open");
			expect(capsule.querySelector(".qs__key")?.textContent).toBe("↩");
			expect(capsule.textContent).toContain("Actions");
			expect(capsule.textContent).toContain("⌘K");
			expect(capsule.textContent).not.toContain("Preview");
			expect(capsule.textContent).not.toContain("Copy");

			const round = host.querySelector(".qs__menu-btn") as HTMLButtonElement;
			expect(round.getAttribute("aria-label")).toBe("Actions");
			await act(async () => round.click());
			expect(host.querySelector(".qs__panel")).not.toBeNull();
		});

		it("names the Ask row's action in the capsule when the Ask row is focused", async () => {
			await type("report");
			for (let step = 0; step < 3; step += 1) await press("ArrowDown");
			expect((host.querySelector(".qs__pill") as HTMLElement).textContent).toContain("Ask AI");
		});

		it("runs the capsule's primary half as a click", async () => {
			await type("report");
			await act(async () => (host.querySelector(".qs__pill-primary") as HTMLButtonElement).click());
			expect(calls.opened).toEqual(["/d/report.md"]);
		});

		it("keeps the focused file's full path in the footer, where the notice also lands", async () => {
			await type("report");
			expect(host.querySelector(".qs__foot-spacer")?.textContent).toBe("/d");
		});
	});
});
