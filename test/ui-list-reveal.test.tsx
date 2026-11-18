// @vitest-environment happy-dom
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "../src/renderer/src/components/FileList";
import type { RowCallbacks } from "../src/renderer/src/components/FileRow";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { DirectoryDataContext } from "../src/renderer/src/hooks/useDirectoryData";
import { revealListRow, revealTarget, type ScrollRequest } from "../src/renderer/src/hooks/list-reveal";
import { buildFolderTree, type TreeRow } from "../src/renderer/src/state/folder-tree";
import { GROUP_HEADER_HEIGHT, type GroupSection } from "../src/renderer/src/state/grouping";
import { DEFAULT_LIST_COLUMNS } from "../src/renderer/src/state/list-columns";
import { moveSelection, ROW_HEIGHT, SCROLL_LEAD, type ScrollIntent, type SelectionState } from "../src/renderer/src/state/selection";
import { setAppLanguage } from "../src/shared/i18n";
import { files, listWithFolder } from "./support/disclosure-rows";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const VIEWPORT = 480;
const noop = (): void => undefined;
const CALLBACKS: RowCallbacks = {
	onClick: noop,
	onOpen: noop,
	onContextMenu: noop,
	onToggleIndex: noop,
	onPointerDown: noop,
	onDragOver: noop,
	onDrop: noop,
	dropTargetPath: null,
	onToggleStack: noop,
	onToggleFolder: noop,
	onRenameChange: noop,
	onRenameCommit: noop,
	onRenameCancel: noop,
	onVisible: noop,
};
const BACKGROUND = { onDragOver: noop, onDrop: noop, onDragLeave: noop, onContextMenu: noop };

let host: HTMLDivElement;
let root: Root;
const listRef = createRef<HTMLDivElement>();
const sidecar = createEntrySidecar();

function List({ sections, banner = false }: { readonly sections: readonly GroupSection<TreeRow>[]; readonly banner?: boolean }): ReactElement {
	return (
		<DirectoryDataContext value={{ store: {} as never, sidecar }}>
			<FileList
				sections={sections}
				listRef={listRef}
				searching={false}
				emptyText="empty"
				selectedKeys={[]}
				focusedZone
				flashPath={null}
				renamePath={null}
				renameDraft=""
				listPath="/r"
				columns={DEFAULT_LIST_COLUMNS}
				minWidth={null}
				versionFamilyError={banner ? { code: "dupey-missing", message: "dupey is missing", installCommand: null } : null}
				onRetryVersionFamilies={noop}
				background={BACKGROUND}
				dropBackground={false}
				callbacks={CALLBACKS}
			/>
		</DirectoryDataContext>
	);
}

/** The error banner above the rows is this tall in the test's pretend layout. */
const BANNER = 56;

/**
 * Shows the sections. happy-dom lays nothing out, so the layout a browser would give is faked: the scroller starts at
 * the top of the page and the rows container sits below the banner (if any), moving up as the scroller scrolls.
 */
function showSections(sections: readonly GroupSection<TreeRow>[], banner = false): void {
	act(() => root.render(<List sections={sections} banner={banner} />));
	const scroller = list();
	vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
	vi.spyOn(grid(), "getBoundingClientRect").mockImplementation(() => ({ top: (banner ? BANNER : 0) - scroller.scrollTop }) as DOMRect);
}
/** `count` plain file rows under `dir` (no folder among them), as the list shows them. */
const treeRows = (count: number, dir = "/r"): TreeRow[] => buildFolderTree(files(dir, count), { expanded: new Set(), childrenOf: () => undefined });
const list = (): HTMLDivElement => listRef.current as HTMLDivElement;
const run = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const grid = (): HTMLElement => host.querySelector<HTMLElement>('[role="treegrid"]') as HTMLElement;

/** Presses ↓ on the focused index the way the controller does: move the focus, then reveal it. */
function press(sections: readonly GroupSection<TreeRow>[], from: number, intent: ScrollIntent = "step"): number {
	const keys = sections.flatMap((section) => section.rows.map((candidate) => candidate.entry.path));
	const focus: SelectionState = { keys: [keys[from] ?? ""], anchor: null, focus: keys[from] ?? "" };
	const next = moveSelection(keys, focus, 1).focus ?? "";
	const index = keys.indexOf(next);
	revealListRow(list(), { sections, index, intent });
	return index;
}

beforeEach(async () => {
	await setAppLanguage("en");
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
	vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
	// happy-dom lays nothing out: the scroller is 480px tall and starts at the top.
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	await setAppLanguage("ko");
});

describe("revealListRow: ↑/↓ in the list view", () => {
	it("does not scroll while the focused row stays in the viewport", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections);
		list().scrollTop = 240;
		// Rows 10..29 are fully visible at scrollTop 240.
		for (let from = 10; from < 29; from += 1) {
			press(sections, from);
			expect(list().scrollTop).toBe(240);
		}
	});

	it("scrolls by exactly the overflow at the bottom edge, one row per press, then keeps still on the way back", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections);
		const seen: number[] = [];
		for (let from = 0; from < 40; from += 1) {
			press(sections, from);
			seen.push(list().scrollTop);
		}
		// 20 rows fit: the first 19 presses (focus 1..19) leave the list at 0, the 20th (focus 20) scrolls by one row.
		expect(seen.slice(0, 19).every((value) => value === 0)).toBe(true);
		expect(seen[19]).toBe(ROW_HEIGHT);
		expect(seen[20]).toBe(2 * ROW_HEIGHT);
		const last = seen[39] ?? 0;
		// The row the focus ended on sits on the bottom edge.
		expect(40 * ROW_HEIGHT + ROW_HEIGHT - last).toBe(VIEWPORT);

		// ↑ back up: rows 21..40 are on screen at `last`, so nothing moves until the focus crosses the top edge.
		for (let index = 39; index >= 21; index -= 1) {
			revealListRow(list(), { sections, index, intent: "step" });
			expect(list().scrollTop).toBe(last);
		}
		revealListRow(list(), { sections, index: 20, intent: "step" });
		expect(list().scrollTop).toBe(20 * ROW_HEIGHT);
		revealListRow(list(), { sections, index: 19, intent: "step" });
		expect(list().scrollTop).toBe(19 * ROW_HEIGHT);
	});

	it("counts the group headers above a row, and does not hide a row behind one", () => {
		const sections: GroupSection<TreeRow>[] = [
			{ label: "A", rows: treeRows(10, "/a") },
			{ label: "B", rows: treeRows(30, "/b") },
		];
		showSections(sections);
		// Row 10 is the first row of "B": 40 (A header) + 10 rows + 40 (B header) = 320; its bottom is 344.
		expect(press(sections, 9)).toBe(10);
		expect(list().scrollTop).toBe(0);
		// Rows below the second header sit at 2 * 40 + index * 24: row 15 ends at 464, row 16 at 488 (> 480).
		const bottomOf = (index: number): number => 2 * GROUP_HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT;
		let focus = 10;
		while (bottomOf(focus + 1) <= VIEWPORT) {
			press(sections, focus);
			expect(list().scrollTop).toBe(0);
			focus += 1;
		}
		// The next row is past the edge by exactly what sticks out: its bottom ends on the viewport's bottom edge.
		press(sections, focus);
		expect(list().scrollTop).toBe(bottomOf(focus + 1) - VIEWPORT);
		expect(bottomOf(focus + 1) - list().scrollTop).toBe(VIEWPORT);
		// ↑ onto the first row of "B": the row (not the header above it) is what lands on the top edge.
		list().scrollTop = 330;
		revealListRow(list(), { sections, index: 10, intent: "step" });
		expect(list().scrollTop).toBe(GROUP_HEADER_HEIGHT * 2 + 10 * ROW_HEIGHT);
	});

	it("measures from the rows, not the scroller, when a banner sits above them", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections, true);
		const scroller = list();
		// Scrolled to the top, the viewport shows (480 - 56) / 24 = 17.67 rows: row 17 is cut at the bottom, so
		// it is the first that scrolls, and by the 8px it sticks out.
		for (let from = 0; from < 16; from += 1) {
			press(sections, from);
			expect(scroller.scrollTop).toBe(0);
		}
		press(sections, 16);
		expect(scroller.scrollTop).toBe(BANNER + 17 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});

	it("takes a row that is not mounted from the layout", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(5000) }];
		showSections(sections);
		expect(host.querySelector('[data-path="/r/f04000.md"]')).toBeNull();
		revealListRow(list(), { sections, index: 4000, intent: "step" });
		expect(list().scrollTop).toBe(4000 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});
});

describe("revealListRow: a reveal", () => {
	const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(200) }];

	it("keeps context above a row that is entirely off screen", () => {
		showSections(sections);
		revealListRow(list(), { sections, index: 120, intent: "reveal" });
		expect(list().scrollTop).toBe(120 * ROW_HEIGHT - SCROLL_LEAD);
	});

	it("leaves a row that is already visible alone, and only nudges one that is cut off", () => {
		showSections(sections);
		list().scrollTop = 100;
		revealListRow(list(), { sections, index: 10, intent: "reveal" });
		expect(list().scrollTop).toBe(100);
		list().scrollTop = 100;
		revealListRow(list(), { sections, index: 24, intent: "reveal" });
		expect(list().scrollTop).toBe(24 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});

	it("stops at the settled end of the list", () => {
		showSections(sections);
		revealListRow(list(), { sections, index: 199, intent: "reveal" });
		expect(list().scrollTop).toBe(200 * ROW_HEIGHT - VIEWPORT);
	});
});

describe("revealListRow while a folder opens or closes", () => {
	const lists = listWithFolder(8);
	const open = (): void => showSections([{ label: null, rows: lists.expanded }]);

	it("does not scroll on the motion itself", () => {
		showSections([{ label: null, rows: lists.collapsed }]);
		list().scrollTop = 120;
		open();
		run(300);
		expect(list().scrollTop).toBe(120);
	});

	it("waits for the motion to settle and then scrolls to where the row rests", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: lists.expanded }];
		showSections([{ label: null, rows: lists.collapsed }]);
		open();
		expect(grid().style.getPropertyValue("--slide-q")).not.toBe("");

		revealListRow(list(), { sections, index: 40, intent: "step" });
		// The rows are still moving and the scroller is not as tall as it will be: nothing is written yet.
		expect(list().scrollTop).toBe(0);
		run(100);
		expect(list().scrollTop).toBe(0);

		run(300);
		expect(grid().style.getPropertyValue("--slide-q")).toBe("");
		// The openness is cleared in React's commit that ends the motion, which may come after the motion's last
		// frame (seungwonme/AutoRAG-app#25); the scroll waiting on it lands on the next frame.
		run(16);
		// Row 40 of the settled (open) list, with the 8 rows the folder added counted.
		expect(list().scrollTop).toBe(40 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});

	it("waits for a closing folder too, and uses the closed list's end", () => {
		const closed: GroupSection<TreeRow>[] = [{ label: null, rows: lists.collapsed }];
		open();
		run(400);
		showSections(closed);
		expect(grid().style.getPropertyValue("--slide-q")).not.toBe("");

		revealListRow(list(), { sections: closed, index: 59, intent: "step" });
		expect(list().scrollTop).toBe(0);
		run(400);
		run(16);
		// The last row of the closed list ends on the viewport's bottom edge: the list's settled end.
		expect(list().scrollTop).toBe(60 * ROW_HEIGHT - VIEWPORT);
	});

	it("is cancelled by the function it returns", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: lists.expanded }];
		showSections([{ label: null, rows: lists.collapsed }]);
		open();
		revealListRow(list(), { sections, index: 40, intent: "step" })();
		run(400);
		expect(list().scrollTop).toBe(0);
	});

	it("does not wait when no motion runs", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: lists.expanded }];
		showSections(sections);
		revealListRow(list(), { sections, index: 40, intent: "step" });
		expect(list().scrollTop).toBe(40 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});
});

describe("revealTarget", () => {
	const request = (path: string, intent: ScrollIntent = "step"): ScrollRequest => ({ path, intent });

	it("scrolls an icon tile and a column row to the nearest edge, as before", () => {
		const scrollIntoView = vi.fn();
		vi.stubGlobal("CSS", { escape: (value: string) => value });
		for (const className of ["icon-tile", "column-row"]) {
			scrollIntoView.mockClear();
			const element = document.createElement("div");
			element.className = className;
			element.dataset.path = "/r/a.md";
			element.scrollIntoView = scrollIntoView;
			host.replaceChildren(element);
			for (const layout of ["icons", "columns"] as const) {
				const done = revealTarget({ layout, list: host, request: request("/r/a.md", "reveal"), rows: null });
				expect(done).not.toBeNull();
				expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
			}
		}
	});

	it("keeps the request while an icon tile or column row is not rendered yet", () => {
		vi.stubGlobal("CSS", { escape: (value: string) => value });
		expect(revealTarget({ layout: "icons", list: host, request: request("/r/missing.md"), rows: null })).toBeNull();
		expect(revealTarget({ layout: "columns", list: null, request: request("/r/missing.md"), rows: null })).toBeNull();
	});

	it("never moves the list's scrollTop for the icon and column views", () => {
		vi.stubGlobal("CSS", { escape: (value: string) => value });
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections);
		list().scrollTop = 77;
		for (const layout of ["icons", "columns"] as const) {
			revealTarget({ layout, list: list(), request: request("/r/f00050.md"), rows: { sections, orderedKeys: [] } });
		}
		expect(list().scrollTop).toBe(77);
	});

	it("keeps the request in the list while the rows are not the target's folder, or do not hold it", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections);
		const orderedKeys = sections.flatMap((section) => section.rows.map((candidate) => candidate.entry.path));
		expect(revealTarget({ layout: "list", list: list(), request: request("/r/f00050.md"), rows: null })).toBeNull();
		expect(revealTarget({ layout: "list", list: list(), request: request("/elsewhere/x.md"), rows: { sections, orderedKeys } })).toBeNull();
		expect(list().scrollTop).toBe(0);
	});

	it("scrolls the list to the row once the rows hold it", () => {
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: treeRows(100) }];
		showSections(sections);
		const orderedKeys = sections.flatMap((section) => section.rows.map((candidate) => candidate.entry.path));
		const done = revealTarget({ layout: "list", list: list(), request: request("/r/f00050.md"), rows: { sections, orderedKeys } });
		expect(done).not.toBeNull();
		expect(list().scrollTop).toBe(50 * ROW_HEIGHT + ROW_HEIGHT - VIEWPORT);
	});
});
