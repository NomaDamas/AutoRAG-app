// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { IndexMapPanel, type IndexMapPanelProps } from "../src/renderer/src/components/settings/index-map/IndexMapPanel";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { setAppLanguage } from "../src/shared/i18n";
import { emptyIndexMapCounts, type IndexMap, type IndexMapState } from "../src/shared/index-map-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let errors: MockInstance<typeof console.error>;

beforeEach(async () => {
	await setAppLanguage("en");
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	errors.mockRestore();
	Reflect.deleteProperty(window, "autorag");
});

const file = (path: string, state: IndexMapState): ScanFile => ({ path, name: path.split("/").at(-1)!, state });
const folder = (path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir => ({ path, name: path.split("/").at(-1)!, files, dirs, sealed: null });
const sealed = (path: string): ScanDir => ({ ...folder(path, []), sealed: { ...emptyIndexMapCounts(), excluded: 2 } });

/** A scope too big to draw file by file, as every real one is: a crowded folder folds into one parcel per state. */
function foldedMap(): IndexMap {
	const states = ["indexed", "stale", "unindexed", "unindexable"] as const;
	const crowded = Array.from({ length: 400 }, (_, index) => file(`/r/Downloads/f${index}.md`, states[index % 4]!));
	return buildIndexMap({ roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/Downloads", crowded)])], truncated: false }, 40);
}

/** One search root with a folder of notes, a folder left out on its own, and a folder inside that one. */
function scopeMap(): IndexMap {
	return buildIndexMap({
		roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/notes", [file("/r/notes/a.md", "indexed"), file("/r/notes/b.md", "unindexed")]), sealed("/r/off"), folder("/r/off-parent", [], [sealed("/r/off-parent/deep")])])],
		truncated: false,
	});
}

function props(overrides: Partial<IndexMapPanelProps> = {}): IndexMapPanelProps {
	return { searchPaths: ["/r"], excludePaths: [], busy: false, onExclude: () => {}, onInclude: () => {}, onRefresh: () => {}, ...overrides };
}

async function open(map: IndexMap, overrides: Partial<IndexMapPanelProps> = {}): Promise<void> {
	Reflect.set(window, "autorag", { fs: { indexMap: async () => map, onIndexRefreshed: () => () => {} } });
	await act(async () => root.render(<IndexMapPanel {...props(overrides)} />));
}

const sector = (path: string): SVGPathElement => {
	const found = host.querySelector<SVGPathElement>(`.index-map-chart path[data-path="${path}"]:not([data-kind="parcel"])`);
	expect(found, path).not.toBeNull();
	return found!;
};
const click = (element: Element): Promise<void> => act(async () => {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const pointer = (element: Element, type: "pointerover" | "pointerout"): Promise<void> => act(async () => {
	element.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null }));
});
const action = (name: "exclude" | "include"): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`[data-action="index-map-${name}"]`);

const reactKeyWarnings = (): string[] =>
	errors.mock.calls.map((call) => call.map(String).join(" ")).filter((text) => /same key|unique "key"|unique key/iu.test(text));

describe("IndexMapPanel", () => {
	it("draws a folded map without React's duplicate-key warning", async () => {
		const map = foldedMap();
		// The premise: several parcels under one folder share its path, which is what a path-only key could not tell apart.
		const parcels = map.nodes.filter((node) => node.kind === "parcel");
		expect(map.folded).toBe(true);
		expect(parcels.length).toBeGreaterThanOrEqual(4);
		expect(new Set(parcels.map((node) => node.path)).size).toBe(1);

		await open(map);

		expect(reactKeyWarnings()).toEqual([]);
		// Every sector drew: none was dropped or merged for sharing a key.
		const drawn = host.querySelectorAll(".index-map-chart path[data-node-id]");
		expect(drawn.length).toBe(map.nodes.length);
		expect(host.querySelectorAll('.index-map-chart path[data-kind="parcel"]').length).toBe(parcels.length);
	});

	it("keeps every parcel when the person drills into the crowded folder", async () => {
		const map = foldedMap();
		await open(map);
		await click(host.querySelector('.index-map-chart path[data-kind="folder"]')!);

		expect(reactKeyWarnings()).toEqual([]);
		expect(host.querySelectorAll('.index-map-chart path[data-kind="parcel"]').length).toBe(map.nodes.filter((node) => node.kind === "parcel").length);
		// The side list shows the same parcels, each once.
		expect(host.querySelectorAll(".index-map-folders > button").length).toBeGreaterThan(1);
	});

	it("offers to leave a folder out once it is picked, and passes its path", async () => {
		const onExclude = vi.fn();
		await open(scopeMap(), { onExclude });
		expect(action("exclude")).toBeNull();

		await click(sector("/r/notes"));

		expect(action("exclude")).not.toBeNull();
		await click(action("exclude")!);
		expect(onExclude).toHaveBeenCalledExactlyOnceWith("/r/notes");
	});

	it("previews what the pointer is over, and returns to the picked folder, with its action, when it leaves the chart", async () => {
		await open(scopeMap());
		await click(sector("/r/notes"));
		const heading = (): string | null | undefined => host.querySelector(".index-map-details h4")?.textContent;
		expect(heading()).toBe("notes");

		await pointer(sector("/r/notes/b.md"), "pointerover");
		expect(heading()).toBe("b.md");

		await pointer(host.querySelector(".index-map-chart")!, "pointerout");
		expect(heading()).toBe("notes");
		expect(action("exclude")).not.toBeNull();
	});

	it("offers to bring back a folder that was left out on its own, and passes its path", async () => {
		const onInclude = vi.fn();
		await open(scopeMap(), { excludePaths: ["/r/off"], onInclude });
		await click(sector("/r/off"));

		expect(action("exclude")).toBeNull();
		await click(action("include")!);
		expect(onInclude).toHaveBeenCalledExactlyOnceWith("/r/off");
	});

	it("offers nothing for a folder that is out only because a folder above it is", async () => {
		await open(scopeMap(), { excludePaths: ["/r/off-parent"] });
		await click(sector("/r/off-parent/deep"));

		expect(host.querySelector(".index-map-details h4")?.textContent).toBe("deep");
		expect(action("exclude")).toBeNull();
		expect(action("include")).toBeNull();
	});

	it("offers nothing for a search root: it is removed from the folder list, not left out of itself", async () => {
		await open(scopeMap());
		await click(sector("/r"));

		expect(action("exclude")).toBeNull();
		expect(action("include")).toBeNull();
	});

	it("does not let a second change start while one is being saved", async () => {
		await open(scopeMap(), { busy: true });
		await click(sector("/r/notes"));

		expect(action("exclude")?.disabled).toBe(true);
	});

	it("asks for a new read when the folders or the exclusions it describes change, and not when the same ones come again", async () => {
		const read = vi.fn(async () => scopeMap());
		Reflect.set(window, "autorag", { fs: { indexMap: read, onIndexRefreshed: () => () => {} } });
		const render = (overrides: Partial<IndexMapPanelProps>): Promise<void> => act(async () => root.render(<IndexMapPanel {...props(overrides)} />));
		await render({});
		expect(read).toHaveBeenCalledTimes(1);

		await render({ searchPaths: ["/r"] });
		expect(read).toHaveBeenCalledTimes(1);

		await render({ excludePaths: ["/r/notes"] });
		expect(read).toHaveBeenCalledTimes(2);

		await render({ excludePaths: ["/r/notes"], searchPaths: ["/r", "/x"] });
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("goes back to the whole scope when the search folders change, and stays put when only exclusions do", async () => {
		await open(scopeMap());
		await click(sector("/r/notes"));
		expect(host.querySelector('[data-action="index-map-parent"]')).not.toBeNull();

		await act(async () => root.render(<IndexMapPanel {...props({ excludePaths: ["/r/other"] })} />));
		expect(host.querySelector('[data-action="index-map-parent"]')).not.toBeNull();

		await act(async () => root.render(<IndexMapPanel {...props({ searchPaths: ["/r", "/x"] })} />));
		expect(host.querySelector('[data-action="index-map-parent"]')).toBeNull();
		expect(host.querySelector(".index-map-details h4")?.textContent).not.toBe("notes");
	});

	it("refreshes the index from the button in the legend row", async () => {
		const onRefresh = vi.fn();
		await open(scopeMap(), { onRefresh });
		await click(host.querySelector<HTMLButtonElement>('[data-action="index-map-refresh"]')!);

		expect(onRefresh).toHaveBeenCalledOnce();
	});
});
