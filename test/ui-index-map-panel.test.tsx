// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { IndexMapPanel, type IndexMapPanelProps, type MapScope } from "../src/renderer/src/components/settings/index-map/IndexMapPanel";
import { resetIndexActivityForTests } from "../src/renderer/src/hooks/useIndexActivity";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
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
	resetIndexActivityForTests();
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
	return { searchPaths: ["/r"], excludePaths: [], busy: false, onExclude: () => {}, onInclude: () => {}, ...overrides };
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
const row = (path: string): HTMLElement => {
	const found = host.querySelector<HTMLElement>(`.index-map-row[data-path="${path}"]`);
	expect(found, path).not.toBeNull();
	return found!;
};
const rowAction = (path: string, name: "exclude" | "include"): HTMLButtonElement | null => row(path).querySelector<HTMLButtonElement>(`[data-action="index-map-${name}"]`);
const crumbs = (): string[] => [...host.querySelectorAll(".index-map-crumbs > *:not(svg)")].map((crumb) => crumb.textContent ?? "");

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
		expect(host.querySelectorAll(".index-map-folders > .index-map-row").length).toBeGreaterThan(1);
	});

	it("puts 제외 at the right of every row that can be left out, and passes its path", async () => {
		const onExclude = vi.fn();
		await open(scopeMap(), { onExclude });

		expect(rowAction("/r/notes", "exclude")).not.toBeNull();
		expect(rowAction("/r/top.md", "exclude")).not.toBeNull();
		await click(rowAction("/r/notes", "exclude")!);
		expect(onExclude).toHaveBeenCalledExactlyOnceWith("/r/notes");
	});

	it("dims everything but the row pointed at, in the chart and the list, also while the pointer is on its 제외", async () => {
		await open(scopeMap());
		const lit = (): string[] => [...host.querySelectorAll('.index-map-chart path[data-node-id]:not([data-dimmed="true"])')].map((path) => path.getAttribute("data-path") ?? "");
		expect(host.querySelectorAll('[data-dimmed="true"]')).toHaveLength(0);

		await pointer(rowAction("/r/notes", "exclude")!, "pointerover");

		expect(new Set(lit())).toEqual(new Set(["/r/notes", "/r/notes/a.md", "/r/notes/b.md"]));
		expect(row("/r/notes").dataset.dimmed).toBeUndefined();
		expect(row("/r/notes").dataset.hovered).toBe("true");
		expect(row("/r/top.md").dataset.dimmed).toBe("true");

		await pointer(host.querySelector(".index-map-folders")!, "pointerout");
		expect(host.querySelectorAll('[data-dimmed="true"]')).toHaveLength(0);
	});

	it("dims the same way when a sector is pointed at", async () => {
		await open(scopeMap());
		await pointer(sector("/r/top.md"), "pointerover");

		expect(sector("/r/top.md").dataset.dimmed).toBeUndefined();
		expect(sector("/r/notes").dataset.dimmed).toBe("true");
		expect(row("/r/notes").dataset.dimmed).toBe("true");
	});

	it("offers to bring back a folder that was left out on its own, and passes its path", async () => {
		const onInclude = vi.fn();
		await open(scopeMap(), { excludePaths: ["/r/off"], onInclude });

		expect(rowAction("/r/off", "exclude")).toBeNull();
		expect(row("/r/off").querySelector(".index-map-row-badge")).not.toBeNull();
		await click(rowAction("/r/off", "include")!);
		expect(onInclude).toHaveBeenCalledExactlyOnceWith("/r/off");
	});

	it("does not open a folder that is left out, so nothing under it can be changed on its own; it can be brought back whole", async () => {
		await open(scopeMap(), { excludePaths: ["/r/off-parent"] });
		await click(row("/r/off-parent").querySelector(".index-map-row-main")!);

		expect(crumbs()).toEqual(["All"]);
		expect(host.querySelector('.index-map-row[data-path="/r/off-parent/deep"]')).toBeNull();
		expect(rowAction("/r/off-parent", "include")).not.toBeNull();
	});

	it("offers nothing for a search root: it is removed from the folder list, not left out of itself", async () => {
		await open(buildIndexMap({ roots: [folder("/r", [file("/r/a.md", "indexed")]), folder("/x", [file("/x/b.md", "unindexed")])], truncated: false }), { searchPaths: ["/r", "/x"] });

		expect(rowAction("/r", "exclude")).toBeNull();
		expect(rowAction("/x", "exclude")).toBeNull();
		expect(rowAction("/r", "include")).toBeNull();
	});

	it("does not let a second change start while one is being saved", async () => {
		await open(scopeMap(), { busy: true });

		expect(rowAction("/r/notes", "exclude")?.disabled).toBe(true);
	});

	it("goes into a folder from its row or its sector, and back to any part of the path from the breadcrumbs", async () => {
		await open(buildIndexMap({ roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/a", [file("/r/a/x.md", "indexed")], [folder("/r/a/b", [file("/r/a/b/c.md", "unindexed")])])])], truncated: false }));
		expect(crumbs()).toEqual(["All"]);

		await click(row("/r/a").querySelector(".index-map-row-main")!);
		await click(row("/r/a/b").querySelector(".index-map-row-main")!);
		expect(crumbs()).toEqual(["All", "a", "b"]);
		expect(row("/r/a/b/c.md")).not.toBeNull();

		await click(host.querySelector('.index-map-crumb[data-crumb="/r/a"]')!);
		expect(crumbs()).toEqual(["All", "a"]);
		expect(row("/r/a/b")).not.toBeNull();

		await click(host.querySelector('.index-map-crumb[data-crumb=""]')!);
		expect(crumbs()).toEqual(["All"]);

		await click(sector("/r/a/b"));
		expect(crumbs()).toEqual(["All", "a", "b"]);
		expect(host.querySelector(".index-map-crumb.is-current")?.getAttribute("aria-current")).toBe("location");
	});

	it("tells the folder list above it each search folder's progress and which one is in view, and follows its pick", async () => {
		let seen: MapScope | null = null;
		const header = (scope: MapScope): null => {
			seen = scope;
			return null;
		};
		await open(buildIndexMap({ roots: [folder("/r", [file("/r/a.md", "indexed"), file("/r/b.md", "unindexed")]), folder("/x", [file("/x/c.md", "indexed")])], truncated: false }), { searchPaths: ["/r", "/x"], header });

		expect(seen!.counts("/r")).toEqual({ indexed: 1, targets: 2 });
		expect(seen!.totals).toEqual({ indexed: 2, targets: 3 });
		expect(seen!.selected).toBeNull();

		await act(async () => seen!.select("/x"));
		expect(seen!.selected).toBe("/x");
		expect(crumbs()).toEqual(["All", "x"]);
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
		expect(crumbs()).toEqual(["All", "notes"]);

		await act(async () => root.render(<IndexMapPanel {...props({ excludePaths: ["/r/other"] })} />));
		expect(crumbs()).toEqual(["All", "notes"]);

		await act(async () => root.render(<IndexMapPanel {...props({ searchPaths: ["/r", "/x"] })} />));
		expect(crumbs()).toEqual(["All"]);
	});

	describe("while the local folders are being indexed", () => {
		const RUNNING: IndexActivitySnapshot = {
			...IDLE_INDEX_ACTIVITY,
			state: "running",
			origin: "app",
			items: [{ key: "local", kind: "local", id: null, state: "running", phase: "minsync", counts: null, error: null }],
		};
		const withStates = (states: Readonly<Record<string, IndexMapState>>): IndexMap => buildIndexMap({
			roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/notes", [file("/r/notes/a.md", states["/r/notes/a.md"] ?? "unindexed"), file("/r/notes/b.md", "unindexed")]), folder("/r/other", [file("/r/other/c.md", "unindexed")])])],
			truncated: false,
		});

		/** The index is running from the first moment; the map is read twice, as it is when a run starts. */
		async function openRunning(first: IndexMap, second: IndexMap): Promise<void> {
			let reads = 0;
			Reflect.set(window, "autorag", {
				fs: { indexMap: async () => (reads++ === 0 ? first : second), onIndexRefreshed: () => () => {} },
				indexActivity: { get: async () => RUNNING, onChange: () => () => {} },
			});
			await act(async () => root.render(<IndexMapPanel {...props()} />));
			await act(async () => {});
		}

		it("rings the place the index just moved to, flags the folders that hold it, and says what the ring means", async () => {
			await openRunning(withStates({}), withStates({ "/r/notes/a.md": "stale" }));

			const ringed = [...host.querySelectorAll('.index-map-chart path[data-progress="true"]')].map((path) => path.getAttribute("data-path"));
			expect(ringed).toEqual(["/r/notes/a.md"]);
			// The mark is a separate arc on the outer edge, so the sector keeps its own colour and stays the one thing to click.
			const arcs = [...host.querySelectorAll(".index-map-chart .index-map-edge")];
			expect(arcs.map((arc) => arc.getAttribute("data-path"))).toEqual(["/r/notes/a.md"]);
			expect(arcs[0]?.getAttribute("aria-hidden")).toBe("true");
			expect(arcs[0]?.getAttribute("d")).toMatch(/^M[\d.,-]+ A/u);
			expect(host.querySelector('.index-map-chart path[data-path="/r/notes/a.md"][data-kind="file"]')?.getAttribute("data-state")).toBe("unindexed");
			expect(host.querySelector('.index-map-legend li[data-state="progress"]')).not.toBeNull();
			// The list names the folder it happened in; one it did not touch stays plain.
			const rows = [...host.querySelectorAll<HTMLElement>(".index-map-folders > .index-map-row")];
			expect(rows.find((row) => row.textContent?.includes("notes"))?.hasAttribute("data-progress")).toBe(true);
			expect(rows.find((row) => row.textContent?.includes("other"))?.hasAttribute("data-progress")).toBe(false);
		});

		it("rings nothing when the second read finds the index where it was", async () => {
			await openRunning(withStates({}), withStates({}));

			expect(host.querySelectorAll('.index-map-chart path[data-progress="true"]')).toHaveLength(0);
			expect(host.querySelectorAll(".index-map-edge")).toHaveLength(0);
			// A legend entry for a mark that is not on screen would explain nothing: it is there only while a ring is.
			expect(host.querySelector('.index-map-legend li[data-state="progress"]')).toBeNull();
		});
	});

	it("shows only the four colours, and no ring, when nothing is indexing", async () => {
		await open(scopeMap());

		expect(host.querySelectorAll(".index-map-legend li")).toHaveLength(4);
		expect(host.querySelector('.index-map-legend li[data-state="progress"]')).toBeNull();
		expect(host.querySelectorAll("[data-progress]")).toHaveLength(0);
	});
});
