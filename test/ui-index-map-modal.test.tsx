// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { IndexMapModal } from "../src/renderer/src/components/settings/index-map/IndexMapModal";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { setAppLanguage } from "../src/shared/i18n";
import type { IndexMap, IndexMapState } from "../src/shared/index-map-contract";

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

/** A scope too big to draw file by file, as every real one is: a crowded folder folds into one parcel per state. */
function foldedMap(): IndexMap {
	const states = ["indexed", "stale", "unindexed", "unindexable"] as const;
	const crowded = Array.from({ length: 400 }, (_, index) => file(`/r/Downloads/f${index}.md`, states[index % 4]!));
	return buildIndexMap({ roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/Downloads", crowded)])], truncated: false }, 40);
}

async function open(map: IndexMap): Promise<void> {
	Reflect.set(window, "autorag", { fs: { indexMap: async () => map, onIndexRefreshed: () => () => {} } });
	await act(async () => root.render(<IndexMapModal onClose={() => {}} />));
}

const reactKeyWarnings = (): string[] =>
	errors.mock.calls.map((call) => call.map(String).join(" ")).filter((text) => /same key|unique "key"|unique key/iu.test(text));

describe("IndexMapModal", () => {
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
		const crowded = host.querySelector<SVGPathElement>('.index-map-chart path[data-kind="folder"]');
		expect(crowded).not.toBeNull();
		await act(async () => crowded!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

		expect(reactKeyWarnings()).toEqual([]);
		expect(host.querySelectorAll('.index-map-chart path[data-kind="parcel"]').length).toBe(map.nodes.filter((node) => node.kind === "parcel").length);
		// The side list shows the same parcels, each once.
		expect(host.querySelectorAll(".index-map-folders > button").length).toBeGreaterThan(1);
	});
});
