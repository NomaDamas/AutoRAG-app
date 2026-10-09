// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { DirectorySnapshot } from "../src/renderer/src/data/directory-store";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { createEntrySidecar, type EntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { type RowPipeline, useRowPipeline } from "../src/renderer/src/hooks/useRowPipeline";
import { kindLabelOf } from "../src/renderer/src/state/entry-values";
import type { SortState } from "../src/renderer/src/state/sort";
import { EMPTY_VERSION_FAMILIES } from "../src/renderer/src/state/version-family";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const STAMP = Date.parse("2026-09-30T00:00:00.000Z");
const NO_KEYS: readonly string[] = [];
const NO_SET: ReadonlySet<string> = new Set();
const NO_CHILDREN = new Map<string, DirectorySnapshot | undefined>();
const NO_PANES: readonly (DirectorySnapshot | undefined)[] = [];

function entry(name: string, osKind: string): FinderEntry {
	return {
		name,
		path: `/d/${name}`,
		kind: "file",
		ext: "txt",
		size: 0,
		mtimeMs: STAMP,
		birthtimeMs: 0,
		osKind,
	};
}

/** Renders the pipeline over one listing and records every result it returns. */
function mount(sidecar: EntrySidecar, listing: DirectorySnapshot, sort: SortState | null) {
	const results: RowPipeline[] = [];
	function Probe(): ReactElement | null {
		results.push(
			useRowPipeline({
				sidecar,
				path: "/d",
				layout: "list",
				searching: false,
				searchScope: "all",
				hits: [],
				listing,
				panePaths: NO_KEYS,
				panes: NO_PANES,
				children: NO_CHILDREN,
				expanded: NO_SET,
				sort,
				grouping: "none",
				showHiddenFiles: false,
				families: EMPTY_VERSION_FAMILIES,
				stackPinned: NO_SET,
				stackSelected: NO_KEYS,
			}),
		);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	act(() => root.render(<Probe />));
	return { results, unmount: () => act(() => root.unmount()) };
}

describe("row pipeline", () => {
	const rows = [entry("a.txt", "Text"), entry("b.txt", "Text")];
	const listing: DirectorySnapshot = { dir: "/d", version: 1, entries: rows, loaded: true, loading: false, error: null };

	it("keeps the sorted rows when icons and OS kinds land under a listing-only order", () => {
		const sidecar = createEntrySidecar();
		const { results, unmount } = mount(sidecar, listing, { key: "name", dir: 1, flipped: false });
		const before = results.at(-1);
		act(() => {
			sidecar.applyEnrichment([{ path: "/d/a.txt", mtimeMs: STAMP, osKind: "Zed Document", iconUrl: "thumb://a" }]);
		});
		const after = results.at(-1);
		expect(after?.stackSections).toBe(before?.stackSections);
		expect(after?.rows[0]).toBe(rows[0]);
		unmount();
	});

	it("re-sorts by the OS kind once it lands when the order reads it", () => {
		const sidecar = createEntrySidecar();
		const { results, unmount } = mount(sidecar, listing, { key: "kind", dir: 1, flipped: false });
		expect(results.at(-1)?.rows.map((row) => row.name)).toEqual(["a.txt", "b.txt"]);
		act(() => {
			sidecar.applyEnrichment([{ path: "/d/a.txt", mtimeMs: STAMP, osKind: "Zed Document", iconUrl: null }]);
		});
		const after = results.at(-1);
		expect(after?.rows.map((row) => row.name)).toEqual(["b.txt", "a.txt"]);
		const second = after?.rows[1];
		expect(second === undefined ? undefined : kindLabelOf(second)).toBe("Zed Document");
		// The listing itself is still the one read from disk.
		const listed = listing.entries[0];
		expect(listed === undefined ? undefined : kindLabelOf(listed)).toBe("Text");
		unmount();
	});
});
