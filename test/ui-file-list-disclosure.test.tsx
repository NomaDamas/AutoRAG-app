// @vitest-environment happy-dom
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "../src/renderer/src/components/FileList";
import type { RowCallbacks } from "../src/renderer/src/components/FileRow";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { DirectoryDataContext } from "../src/renderer/src/hooks/useDirectoryData";
import { OPENNESS_PROPERTY } from "../src/renderer/src/hooks/useDisclosureMotion";
import type { TreeRow } from "../src/renderer/src/state/folder-tree";
import type { GroupSection } from "../src/renderer/src/state/grouping";
import { DEFAULT_LIST_COLUMNS } from "../src/renderer/src/state/list-columns";
import { ROW_HEIGHT } from "../src/renderer/src/state/selection";
import { setAppLanguage } from "../src/shared/i18n";
import { listWithFolder } from "./support/disclosure-rows";

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
let reduced = false;
const sidecar = createEntrySidecar();

function List({ sections, callbacks = CALLBACKS }: { readonly sections: readonly GroupSection<TreeRow>[]; readonly callbacks?: RowCallbacks }): ReactElement {
	return (
		<DirectoryDataContext value={{ store: {} as never, sidecar }}>
			<FileList
				sections={sections}
				listRef={createRef<HTMLDivElement>()}
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
				versionFamilyError={null}
				onRetryVersionFamilies={noop}
				background={BACKGROUND}
				dropBackground={false}
				callbacks={callbacks}
			/>
		</DirectoryDataContext>
	);
}

const showSections = (sections: readonly GroupSection<TreeRow>[], callbacks?: RowCallbacks): void =>
	act(() => root.render(<List sections={sections} {...(callbacks === undefined ? {} : { callbacks })} />));
const show = (rows: readonly TreeRow[], callbacks?: RowCallbacks): void => showSections([{ label: null, rows }], callbacks);
const run = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
const rowEls = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="row"]')];
const rowOf = (path: string): HTMLElement => host.querySelector<HTMLElement>(`[data-path="${path}"]`) as HTMLElement;
const slides = (part: string): string[] => rowEls().filter((el) => el.dataset.slide === part).map((el) => el.dataset.path ?? "");
const grid = (): HTMLElement => host.querySelector<HTMLElement>('[role="treegrid"]') as HTMLElement;
const triangle = (path: string): HTMLElement => rowOf(path).querySelector<HTMLElement>(".row__disclosure") as HTMLElement;

beforeEach(async () => {
	await setAppLanguage("en");
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
	reduced = false;
	vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
	// happy-dom lays nothing out: the scroller is 480px tall.
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

describe("FileList disclosure motion", () => {
	const list = listWithFolder(8);

	it("draws a settled list the way it always was: no marks, no motion variable, stripes by row", () => {
		show(list.expanded);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
		expect(grid().style.paddingTop).toBe("0px");
		// Rows keep their stripe: odd rows are the alternate colour.
		expect(rowEls()[0]?.className).toContain("bg-window");
		expect(rowEls()[1]?.className).toContain("bg-row-alt");
	});

	it("opens a folder: its rows come out from behind it and everything below travels with them", () => {
		show(list.collapsed);
		const below = rowOf("/r/f00002.md");
		show(list.expanded);

		expect(slides("block")).toEqual(list.expanded.slice(2, 10).map((row) => row.entry.path));
		expect(slides("ghost")).toEqual([]);
		// Every other row after the folder row travels as one; the rows above it do not.
		expect(slides("below")).toContain("/r/f00002.md");
		expect(slides("below")).toContain("/r/f00003.md");
		expect(rowOf("/r/f00000.md").dataset.slide).toBeUndefined();
		expect(rowOf("/r/b").dataset.slide).toBeUndefined();

		// Block rows know how far below the folder row they come to rest; the list knows how far everything travels.
		expect(rowOf("/r/b/f00000.md").style.getPropertyValue("--slide-d")).toBe("0px");
		expect(rowOf("/r/b/f00007.md").style.getPropertyValue("--slide-d")).toBe(`${7 * ROW_HEIGHT}px`);
		expect(grid().style.getPropertyValue("--slide-hc")).toBe(`${8 * ROW_HEIGHT}px`);
		// The list is as tall as the closed one while the folder is closed, and grows with the motion.
		expect(grid().style.height).toBe(`calc(${60 * ROW_HEIGHT}px + var(--slide-hc) * var(--slide-q, 1))`);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("0");

		// The row below is the same element before and after: a motion never remounts a row.
		expect(rowOf("/r/f00002.md")).toBe(below);
	});

	it("stripes the rows below the way the settled list will, so the motion's last frame is the settled list", () => {
		const odd = listWithFolder(7);
		const stripe = (path: string): string => (rowOf(path).className.includes("bg-row-alt") ? "alt" : "plain");
		show(odd.collapsed);
		const before = stripe("/r/f00002.md");
		show(odd.expanded);
		const moving = ["/r/f00002.md", "/r/f00003.md", "/r/f00004.md"].map(stripe);
		run(500);
		// Seven rows is odd: the rows below swap stripe when the motion starts, never when it ends.
		expect(["/r/f00002.md", "/r/f00003.md", "/r/f00004.md"].map(stripe)).toEqual(moving);
		expect(moving[0]).not.toBe(before);
		show(odd.collapsed);
		const closing = ["/r/f00002.md", "/r/f00003.md", "/r/f00004.md"].map(stripe);
		run(500);
		expect(["/r/f00002.md", "/r/f00003.md", "/r/f00004.md"].map(stripe)).toEqual(closing);
		expect(closing[0]).toBe(before);
	});

	it("moves nothing once the motion has settled", () => {
		show(list.collapsed);
		show(list.expanded);
		run(80);
		expect(Number(grid().style.getPropertyValue(OPENNESS_PROPERTY))).toBeGreaterThan(0);
		run(400);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
		expect(grid().style.getPropertyValue("--slide-hc")).toBe("");
		expect(grid().style.height).toBe("");
	});

	it("closes a folder: the rows that left are kept for the motion, cannot be reached, and then go", () => {
		show(list.expanded);
		const below = rowOf("/r/f00002.md");
		show(list.collapsed);

		expect(slides("ghost")).toEqual(list.expanded.slice(2, 10).map((row) => row.entry.path));
		expect(slides("block")).toEqual([]);
		for (const path of slides("ghost")) {
			expect(rowOf(path).getAttribute("aria-hidden")).toBe("true");
		}
		expect(rowOf("/r/f00002.md")).toBe(below);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("1");
		// The ghost rows are not part of the list's rows for anything that counts them.
		expect(rowEls().filter((el) => el.getAttribute("aria-hidden") !== "true").map((el) => el.dataset.path)).toEqual(
			list.collapsed.slice(0, 24).map((row) => row.entry.path),
		);

		run(500);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(rowOf("/r/b/f00000.md")).toBeNull();
		expect(rowEls().length).toBe(24);
	});

	it("draws no more rows for a 3,000-row folder than the window and one screenful of it", () => {
		const huge = listWithFolder(3000, 5000, 2);
		show(huge.collapsed);
		const plain = rowEls().length;
		show(huge.expanded);
		const during = rowEls().length;
		// 480px = 20 rows, plus the overscan on each side, plus one screenful of the folder.
		expect(plain).toBeLessThanOrEqual(30);
		expect(during).toBeLessThanOrEqual(plain + Math.ceil(VIEWPORT / ROW_HEIGHT) + 8);
		expect(during).toBeLessThan(60);
		// The 2,992 rows that are not drawn still hold their place in the scroll height.
		const drawn = slides("block").length;
		expect(drawn).toBeLessThan(40);
		expect(grid().style.height).toBe(`calc(${(5000 + 3000 - drawn) * ROW_HEIGHT}px + var(--slide-hc) * var(--slide-q, 1))`);
		run(500);
		expect(rowEls().length).toBeLessThanOrEqual(30);
	});

	it("shows the triangle open or closed, turning over the disclosure motion's time", () => {
		show(list.collapsed);
		expect(rowOf("/r/b").getAttribute("aria-expanded")).toBe("false");
		expect(triangle("/r/b").getAttribute("aria-expanded")).toBe("false");
		expect(triangle("/r/b").className).not.toContain("row__disclosure--open");
		const turn = triangle("/r/b").querySelector("span") as HTMLElement;
		expect(turn.className).not.toContain("rotate-90");
		expect(turn.className).toContain("duration-(--dur-disclosure)");
		expect(turn.className).toContain("ease-(--ease-disclosure)");
		expect(turn.className).toContain("motion-reduce:transition-none");

		show(list.expanded);
		expect(rowOf("/r/b").getAttribute("aria-expanded")).toBe("true");
		expect(triangle("/r/b").className).toContain("row__disclosure--open");
		expect((triangle("/r/b").querySelector("span") as HTMLElement).className).toContain("rotate-90");

		show(list.collapsed);
		expect(triangle("/r/b").getAttribute("aria-expanded")).toBe("false");
		expect((triangle("/r/b").querySelector("span") as HTMLElement).className).not.toContain("rotate-90");
	});

	it("turns the triangle at the click and slides the rows once, when a listing that was still loading arrives", () => {
		show(list.collapsed);
		show(list.waiting);
		// The triangle has turned and nothing else has moved.
		expect(rowOf("/r/b").getAttribute("aria-expanded")).toBe("true");
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		run(400);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);

		show(list.expanded);
		expect(slides("block").length).toBe(8);
		const first = grid().style.getPropertyValue(OPENNESS_PROPERTY);
		expect(first).toBe("0");
		run(500);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		// And it does not start over.
		run(1000);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
	});

	it("leaves the list where the user put it when a folder is opened and closed again mid-motion", () => {
		show(list.collapsed);
		show(list.expanded);
		run(90);
		const reached = Number(grid().style.getPropertyValue(OPENNESS_PROPERTY));
		expect(reached).toBeGreaterThan(0);
		expect(reached).toBeLessThan(1);

		show(list.collapsed);
		// The same rows, now closing, from where they were: no jump to either end.
		expect(slides("ghost").length).toBe(8);
		expect(Number(grid().style.getPropertyValue(OPENNESS_PROPERTY))).toBeCloseTo(reached, 3);

		run(16);
		show(list.expanded);
		expect(slides("block").length).toBe(8);
		run(2000);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(rowEls().length).toBe(24);
		expect(rowOf("/r/b/f00000.md")).not.toBeNull();
		expect(rowOf("/r/f00002.md").dataset.slide).toBeUndefined();
	});

	it("does not animate under prefers-reduced-motion", () => {
		reduced = true;
		show(list.collapsed);
		show(list.expanded);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
		expect(rowOf("/r/b/f00000.md")).not.toBeNull();
		show(list.collapsed);
		expect(rowEls().some((el) => el.dataset.slide !== undefined)).toBe(false);
		expect(rowOf("/r/b/f00000.md")).toBeNull();
	});

	it("keeps answering clicks while the rows move", () => {
		const clicked: string[] = [];
		const callbacks: RowCallbacks = { ...CALLBACKS, onClick: (entry) => clicked.push(entry.path), onToggleFolder: (entry) => clicked.push(`toggle ${entry.path}`) };
		show(list.collapsed, callbacks);
		show(list.expanded, callbacks);
		run(60);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).not.toBe("");
		act(() => rowOf("/r/f00004.md").click());
		act(() => rowOf("/r/b/f00001.md").click());
		act(() => triangle("/r/b").click());
		// Every click went through at once; the motion did not wait to end.
		expect(clicked).toEqual(["/r/f00004.md", "/r/b/f00001.md", "toggle /r/b"]);
		expect(grid().style.getPropertyValue(OPENNESS_PROPERTY)).not.toBe("");
	});

	it("moves a group header that lies below the folder with the rows, and keeps the header above it still", () => {
		const grouped = listWithFolder(8, 60, 1);
		showSections([
			{ label: "Folders", rows: grouped.collapsed.slice(0, 2) },
			{ label: "Files", rows: grouped.collapsed.slice(2) },
		]);
		showSections([
			{ label: "Folders", rows: grouped.expanded.slice(0, 10) },
			{ label: "Files", rows: grouped.expanded.slice(10) },
		]);
		const headers = [...host.querySelectorAll<HTMLElement>(".group-header")];
		expect(headers.map((header) => header.dataset.slide)).toEqual([undefined, "below"]);
		expect(slides("block").length).toBe(8);
		run(500);
		expect([...host.querySelectorAll<HTMLElement>(".group-header")].some((header) => header.dataset.slide !== undefined)).toBe(false);
	});
});
