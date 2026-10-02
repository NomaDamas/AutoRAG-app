import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LIST_COLUMNS,
	LIST_COLUMNS_STORAGE_KEY,
	listGridTemplate,
	loadListColumns,
	resetListColumns,
	saveListColumns,
	setListColumnWidth,
	toggleListColumn,
} from "../src/renderer/src/state/list-columns";

function stubStorage(): Map<string, string> {
	const map = new Map<string, string>();
	const storage: Storage = {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
	};
	vi.stubGlobal("localStorage", storage);
	return map;
}

describe("list columns", () => {
	beforeEach(() => {
		stubStorage();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows date, size, kind and index by default", () => {
		expect(DEFAULT_LIST_COLUMNS.visible).toEqual({
			extension: false,
			date: true,
			size: true,
			kind: true,
			relativePath: false,
			index: true,
		});
		expect(DEFAULT_LIST_COLUMNS.widths).toEqual({});
	});

	it("toggles a column on and off without touching the others", () => {
		const on = toggleListColumn(DEFAULT_LIST_COLUMNS, "extension");
		expect(on.visible.extension).toBe(true);
		expect(on.visible.date).toBe(true);
		expect(toggleListColumn(on, "extension").visible.extension).toBe(false);
	});

	it("resets to the defaults", () => {
		const custom = toggleListColumn(setListColumnWidth(DEFAULT_LIST_COLUMNS, "name", 300), "extension");
		expect(resetListColumns()).toEqual(DEFAULT_LIST_COLUMNS);
		expect(resetListColumns()).not.toBe(DEFAULT_LIST_COLUMNS);
		expect(custom.visible.extension).toBe(true);
	});

	it("renders only the visible columns, name always first", () => {
		expect(listGridTemplate(DEFAULT_LIST_COLUMNS)).toBe("minmax(180px,1fr) 112px 68px 106px 44px");
		const withExtension = toggleListColumn(DEFAULT_LIST_COLUMNS, "extension");
		expect(listGridTemplate(withExtension)).toBe("minmax(180px,1fr) 92px 112px 68px 106px 44px");
		const withoutKind = toggleListColumn(DEFAULT_LIST_COLUMNS, "kind");
		expect(listGridTemplate(withoutKind)).toBe("minmax(180px,1fr) 112px 68px 44px");
	});

	it("uses a stored width for the resizable tracks", () => {
		const sized = setListColumnWidth(setListColumnWidth(DEFAULT_LIST_COLUMNS, "name", 320), "size", 120);
		expect(listGridTemplate(sized)).toBe("minmax(320px,1fr) 112px 120px 106px 44px");
	});

	it("clamps widths to each column's range", () => {
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "name", 40).widths.name).toBe(180);
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "name", 9000).widths.name).toBe(720);
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "size", 10).widths.size).toBe(58);
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "size", 999).widths.size).toBe(280);
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "kind", 1).widths.kind).toBe(62);
		expect(setListColumnWidth(DEFAULT_LIST_COLUMNS, "kind", 999).widths.kind).toBe(260);
	});

	it("round-trips through localStorage", () => {
		const state = toggleListColumn(setListColumnWidth(DEFAULT_LIST_COLUMNS, "kind", 200), "relativePath");
		saveListColumns(state);
		expect(loadListColumns()).toEqual(state);
	});

	it("falls back to the defaults for missing or broken storage", () => {
		expect(loadListColumns()).toEqual(DEFAULT_LIST_COLUMNS);
		globalThis.localStorage.setItem(LIST_COLUMNS_STORAGE_KEY, "{ not json");
		expect(loadListColumns()).toEqual(DEFAULT_LIST_COLUMNS);
	});

	it("merges a partial record over the defaults", () => {
		globalThis.localStorage.setItem(
			LIST_COLUMNS_STORAGE_KEY,
			JSON.stringify({ visible: { extension: true }, widths: { size: 150, junk: "x" } }),
		);
		expect(loadListColumns()).toEqual({
			visible: { ...DEFAULT_LIST_COLUMNS.visible, extension: true },
			widths: { size: 150 },
		});
	});
});
