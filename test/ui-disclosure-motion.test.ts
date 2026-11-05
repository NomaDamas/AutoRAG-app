import { describe, expect, it } from "vitest";
import {
	cubicBezier,
	DEFAULT_DISCLOSURE_EASE,
	detectDisclosureChange,
	disclosureView,
	drawnBlockRows,
	motionDuration,
	opennessAt,
	parseCubicBezier,
	parseDuration,
	sameShape,
	startDisclosure,
	type DisclosureMotion,
} from "../src/renderer/src/state/disclosure-motion";
import { buildFolderTree, type TreeRow } from "../src/renderer/src/state/folder-tree";
import { GROUP_HEADER_HEIGHT, type GroupSection } from "../src/renderer/src/state/grouping";
import { ROW_HEIGHT } from "../src/renderer/src/state/selection";
import { LIST_OVERSCAN } from "../src/renderer/src/state/virtual";
import type { StackRow } from "../src/renderer/src/state/version-family";
import { entry, files, listWithFolder, row } from "./support/disclosure-rows";

const TOP: readonly StackRow[] = [row("/r/a.md"), row("/r/b", "folder"), row("/r/c.md"), row("/r/d", "folder"), row("/r/e.md")];

function tree(
	expanded: readonly string[],
	listings: Readonly<Record<string, readonly StackRow[]>>,
	top: readonly StackRow[] = TOP,
): TreeRow[] {
	return buildFolderTree(top, { expanded: new Set(expanded), childrenOf: (path) => listings[path] });
}

const B_KIDS: readonly StackRow[] = [row("/r/b/x.md"), row("/r/b/y", "folder"), row("/r/b/z.md")];
const LISTINGS = { "/r/b": B_KIDS, "/r/b/y": [row("/r/b/y/1.md"), row("/r/b/y/2.md")] };
const paths = (rows: readonly TreeRow[]): string[] => rows.map((candidate) => candidate.entry.path);

describe("detectDisclosureChange", () => {
	it("reads a folder opening as one block entering after it", () => {
		const closed = tree([], LISTINGS);
		const open = tree(["/r/b"], LISTINGS);
		const change = detectDisclosureChange(closed, open);
		expect(change?.kind).toBe("expand");
		expect(change?.parent).toBe("/r/b");
		expect(change?.parentIndex).toBe(1);
		expect(paths(change?.block ?? [])).toEqual(["/r/b/x.md", "/r/b/y", "/r/b/z.md"]);
	});

	it("reads a folder closing as the same block leaving", () => {
		const change = detectDisclosureChange(tree(["/r/b"], LISTINGS), tree([], LISTINGS));
		expect(change?.kind).toBe("collapse");
		expect(change?.parent).toBe("/r/b");
		expect(change?.parentIndex).toBe(1);
		expect(change?.block.length).toBe(3);
	});

	it("takes the open subfolders of a block along, because the block is the folder's whole run", () => {
		const closed = tree([], LISTINGS);
		const open = tree(["/r/b", "/r/b/y"], LISTINGS);
		expect(detectDisclosureChange(closed, open)?.block.length).toBe(5);
		expect(detectDisclosureChange(open, closed)?.block.length).toBe(5);
	});

	it("animates a nested folder the same way as a top-level one", () => {
		const outer = tree(["/r/b"], LISTINGS);
		const inner = tree(["/r/b", "/r/b/y"], LISTINGS);
		const change = detectDisclosureChange(outer, inner);
		expect(change?.parent).toBe("/r/b/y");
		expect(change?.parentIndex).toBe(3);
		expect(paths(change?.block ?? [])).toEqual(["/r/b/y/1.md", "/r/b/y/2.md"]);
	});

	it("counts the rows of a folder that was already open and whose listing arrives late", () => {
		const waiting = tree(["/r/b"], {});
		expect(waiting.find((candidate) => candidate.entry.path === "/r/b")?.disclosure).toBe("expanded");
		const change = detectDisclosureChange(waiting, tree(["/r/b"], LISTINGS));
		expect(change?.kind).toBe("expand");
		expect(change?.block.length).toBe(3);
	});

	it("sees nothing in the click that opens a folder whose listing is still loading", () => {
		expect(detectDisclosureChange(tree([], {}), tree(["/r/b"], {}))).toBeNull();
		expect(detectDisclosureChange(tree(["/r/b"], {}), tree([], {}))).toBeNull();
	});

	it("ignores a refresh that changed no rows", () => {
		const before = tree(["/r/b"], LISTINGS);
		const after = tree(["/r/b"], LISTINGS);
		expect(after).not.toBe(before);
		expect(detectDisclosureChange(before, after)).toBeNull();
		expect(sameShape(before, after)).toBe(true);
	});

	it("ignores a file that appears or disappears inside a folder that is already open", () => {
		const open = tree(["/r/b"], LISTINGS);
		const grown = tree(["/r/b"], { ...LISTINGS, "/r/b": [row("/r/b/w.md"), ...B_KIDS] });
		expect(detectDisclosureChange(open, grown)).toBeNull();
		expect(detectDisclosureChange(grown, open)).toBeNull();
		const trimmed = tree(["/r/b"], { ...LISTINGS, "/r/b": B_KIDS.slice(0, 2) });
		expect(detectDisclosureChange(open, trimmed)).toBeNull();
	});

	it("ignores a folder that is emptied while it stays open", () => {
		expect(detectDisclosureChange(tree(["/r/b"], LISTINGS), tree(["/r/b"], { "/r/b": [] }))).toBeNull();
	});

	it("ignores rows that come and go at the top level", () => {
		const base = tree([], LISTINGS);
		const grown = tree([], LISTINGS, [...TOP, row("/r/f.md")]);
		const middle = tree([], LISTINGS, [TOP[0] as StackRow, row("/r/ab.md"), ...TOP.slice(1)]);
		expect(detectDisclosureChange(base, grown)).toBeNull();
		expect(detectDisclosureChange(grown, base)).toBeNull();
		expect(detectDisclosureChange(base, middle)).toBeNull();
	});

	it("ignores two folders that open at once and a whole listing that is swapped", () => {
		const closed = tree([], LISTINGS, [row("/r/b", "folder"), row("/r/d", "folder")]);
		const both = tree(["/r/b", "/r/d"], { ...LISTINGS, "/r/d": [row("/r/d/1.md")] }, [row("/r/b", "folder"), row("/r/d", "folder")]);
		expect(detectDisclosureChange(closed, both)).toBeNull();
		expect(detectDisclosureChange(tree([], LISTINGS), tree([], LISTINGS, [row("/other/x.md")]))).toBeNull();
		expect(detectDisclosureChange([], tree(["/r/b"], LISTINGS))).toBeNull();
	});

	it("ignores a reorder, even when the number of rows changes with it", () => {
		const open = tree(["/r/b"], LISTINGS);
		const reordered = [...open].reverse();
		expect(detectDisclosureChange(open, reordered)).toBeNull();
		expect(detectDisclosureChange(open, reordered.slice(1))).toBeNull();
	});

	it("ignores a new sibling that appears right after an open folder with no rows", () => {
		const waiting = tree(["/r/b"], {});
		const index = waiting.findIndex((candidate) => candidate.entry.path === "/r/b");
		const sibling: TreeRow = { ...(waiting[0] as TreeRow), entry: entry("/r/b-copy.md") };
		const grown = [...waiting.slice(0, index + 1), sibling, ...waiting.slice(index + 1)];
		expect(sibling.depth).toBe(0);
		expect(detectDisclosureChange(waiting, grown)).toBeNull();
		expect(detectDisclosureChange(grown, waiting)).toBeNull();
	});

	it("ignores rows that appear under a folder that is still closed", () => {
		const closed = tree([], LISTINGS);
		const kid: TreeRow = { ...(tree(["/r/b"], LISTINGS)[2] as TreeRow) };
		const index = closed.findIndex((candidate) => candidate.entry.path === "/r/b");
		const grown = [...closed.slice(0, index + 1), kid, ...closed.slice(index + 1)];
		expect(grown[index]?.disclosure).toBe("collapsed");
		expect(detectDisclosureChange(closed, grown)).toBeNull();
	});

	it("ignores a disclosure that comes with another change in the list", () => {
		const closed = tree([], LISTINGS);
		const open = tree(["/r/b"], LISTINGS);
		expect(detectDisclosureChange(closed, open)).not.toBeNull();
		const renamed = [...open.slice(0, -1), { ...(open.at(-1) as TreeRow), entry: entry("/r/e-renamed.md") }];
		expect(detectDisclosureChange(closed, renamed)).toBeNull();
		expect(detectDisclosureChange(renamed, closed)).toBeNull();
	});

	it("only counts a block that follows a folder row", () => {
		const closed = tree([], LISTINGS);
		const deeper: TreeRow[] = [...closed];
		const inserted: TreeRow = { ...(tree(["/r/b"], LISTINGS)[2] as TreeRow) };
		// Rows deeper than the file `a.md` they follow are not a folder's block.
		deeper.splice(1, 0, inserted);
		expect(detectDisclosureChange(closed, deeper)).toBeNull();
	});
});

const bigList = listWithFolder;

describe("drawnBlockRows", () => {
	it("draws the rows that fit between the folder row and the bottom of the window, and no more", () => {
		expect(drawnBlockRows({ count: 5000, parentBottom: 48, reach: 48 + 10 * ROW_HEIGHT })).toBe(10);
		expect(drawnBlockRows({ count: 5000, parentBottom: 48, reach: 48 + 10 * ROW_HEIGHT - 1 })).toBe(10);
		expect(drawnBlockRows({ count: 5000, parentBottom: 48, reach: 48 + 10 * ROW_HEIGHT + 1 })).toBe(11);
	});

	it("draws a short block whole", () => {
		expect(drawnBlockRows({ count: 3, parentBottom: 48, reach: 4800 })).toBe(3);
	});

	it("draws nothing when the block starts below the window", () => {
		expect(drawnBlockRows({ count: 40, parentBottom: 960, reach: 480 })).toBe(0);
	});
});

describe("startDisclosure", () => {
	const scroll = { offset: 0, viewport: 480 };
	const call = (input: Partial<Parameters<typeof startDisclosure>[0]> & { change: NonNullable<ReturnType<typeof detectDisclosureChange>> }) =>
		startDisclosure({
			sections: [],
			scroll,
			overscan: LIST_OVERSCAN,
			id: 1,
			current: null,
			currentOpenness: 1,
			...input,
		});

	it("opens a folder from closed and closes it from open", () => {
		const { collapsed, expanded } = bigList(10);
		const expand = detectDisclosureChange(collapsed, expanded);
		const collapse = detectDisclosureChange(expanded, collapsed);
		expect(expand).not.toBeNull();
		expect(collapse).not.toBeNull();
		const opening = call({ change: expand as NonNullable<typeof expand>, sections: [{ label: null, rows: expanded }] });
		const closing = call({ change: collapse as NonNullable<typeof collapse>, sections: [{ label: null, rows: collapsed }] });
		expect(opening).toMatchObject({ kind: "expand", from: 0, to: 1, drawn: 10, parent: "/r/b" });
		expect(closing).toMatchObject({ kind: "collapse", from: 1, to: 0, drawn: 10, parent: "/r/b" });
	});

	it("draws only the screenful of a huge block", () => {
		const { collapsed, expanded } = bigList(5000);
		const change = detectDisclosureChange(collapsed, expanded);
		const motion = call({ change: change as NonNullable<typeof change>, sections: [{ label: null, rows: expanded }] });
		// parent bottom 48, reach 480 + 4 rows of overscan
		expect(motion?.drawn).toBe(Math.ceil((480 + LIST_OVERSCAN * ROW_HEIGHT - 48) / ROW_HEIGHT));
		expect(motion?.block.length).toBe(5000);
	});

	it("starts nothing when the folder row is scrolled away or its block lies below the window", () => {
		const { collapsed, expanded } = bigList(10);
		const change = detectDisclosureChange(collapsed, expanded) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const sections = [{ label: null, rows: expanded }];
		expect(call({ change, sections, scroll: { offset: 24 * 40, viewport: 480 } })).toBeNull();
		expect(call({ change, sections, scroll: { offset: 0, viewport: 24 } , overscan: 0 })).toBeNull();
	});

	it("continues from where the same folder's motion is when the user turns it around", () => {
		const { collapsed, expanded } = bigList(10);
		const expand = detectDisclosureChange(collapsed, expanded) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const collapse = detectDisclosureChange(expanded, collapsed) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const running = call({ change: expand, sections: [{ label: null, rows: expanded }] }) as DisclosureMotion;
		const reversed = call({ change: collapse, sections: [{ label: null, rows: collapsed }], current: running, currentOpenness: 0.37, id: 2 });
		expect(reversed).toMatchObject({ kind: "collapse", from: 0.37, to: 0 });
		const again = call({ change: expand, sections: [{ label: null, rows: expanded }], current: reversed, currentOpenness: 0.12, id: 3 });
		expect(again).toMatchObject({ kind: "expand", from: 0.12, to: 1 });
	});

	it("starts another folder's motion from its own end, not from the running one", () => {
		const { collapsed, expanded } = bigList(10);
		const expand = detectDisclosureChange(collapsed, expanded) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const other = { ...(call({ change: expand, sections: [{ label: null, rows: expanded }] }) as DisclosureMotion), parent: "/r/zzz" };
		const next = call({ change: expand, sections: [{ label: null, rows: expanded }], current: other, currentOpenness: 0.6 });
		expect(next?.from).toBe(0);
	});

	it("keeps a reversal inside 0..1 whatever the sampled openness was", () => {
		const { collapsed, expanded } = bigList(10);
		const expand = detectDisclosureChange(collapsed, expanded) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const collapse = detectDisclosureChange(expanded, collapsed) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const running = call({ change: expand, sections: [{ label: null, rows: expanded }] }) as DisclosureMotion;
		const sections = [{ label: null, rows: collapsed }];
		expect(call({ change: collapse, sections, current: running, currentOpenness: 1.4 })?.from).toBe(1);
		expect(call({ change: collapse, sections, current: running, currentOpenness: Number.NaN })?.from).toBe(0);
	});
});

function motionFor(kind: "expand" | "collapse", size: number, scroll = { offset: 0, viewport: 480 }, top = 60) {
	const list = bigList(size, top);
	const change = (kind === "expand" ? detectDisclosureChange(list.collapsed, list.expanded) : detectDisclosureChange(list.expanded, list.collapsed)) as NonNullable<
		ReturnType<typeof detectDisclosureChange>
	>;
	const settled = kind === "expand" ? list.expanded : list.collapsed;
	const sections: GroupSection<TreeRow>[] = [{ label: null, rows: settled }];
	const motion = startDisclosure({ change, sections, scroll, overscan: LIST_OVERSCAN, id: 1, current: null, currentOpenness: 1 }) as DisclosureMotion;
	return { motion, sections, list };
}

describe("disclosureView", () => {
	const scroll = { offset: 0, viewport: 480 };

	it("windows the list without the block and hangs the drawn block under the folder row", () => {
		const { motion, sections } = motionFor("expand", 10);
		const view = disclosureView(sections, motion, scroll, LIST_OVERSCAN);
		expect(view).not.toBeNull();
		// 60 top-level rows, the block is not part of the layout.
		expect(view?.layout.total).toBe(60 * ROW_HEIGHT);
		expect(view?.base[0]?.rows.length).toBe(60);
		expect(view?.parentIndex).toBe(1);
		expect(view?.parentItem).toBe(1);
		expect(view?.drawn.length).toBe(10);
		expect(view?.count).toBe(10);
		expect(view?.travel).toBe(10 * ROW_HEIGHT);
		expect(view?.hidden).toBe(0);
	});

	it("never builds more rows than the window and one screenful of the block, however big the block is", () => {
		const { motion, sections } = motionFor("expand", 5000, scroll, 5000);
		const view = disclosureView(sections, motion, scroll, LIST_OVERSCAN);
		const windowRows = (view?.window.end ?? 0) - (view?.window.start ?? 0);
		const drawn = view?.drawn.length ?? 0;
		expect(drawn).toBeLessThanOrEqual(Math.ceil((480 + LIST_OVERSCAN * ROW_HEIGHT) / ROW_HEIGHT));
		expect(windowRows).toBeLessThanOrEqual(Math.ceil(480 / ROW_HEIGHT) + 2 * LIST_OVERSCAN + 1);
		expect(windowRows + drawn).toBeLessThan(60);
		expect(view?.count).toBe(5000);
		// The rows the block has beyond what is drawn still count toward the scroll height.
		expect(view?.hidden).toBe((5000 - drawn) * ROW_HEIGHT);
		// Hung back under the folder row, the drawn and the hidden rows add up to the open list's height.
		expect((view?.layout.total ?? 0) + (view?.travel ?? 0) + (view?.hidden ?? 0)).toBe((5000 + 5000) * ROW_HEIGHT);
	});

	it("keeps the rows of a closing block for the motion, drawn from the block that left", () => {
		const { motion, sections, list } = motionFor("collapse", 10);
		const view = disclosureView(sections, motion, scroll, LIST_OVERSCAN);
		expect(view?.base).toBe(sections);
		expect(view?.drawn.map((candidate) => candidate.entry.path)).toEqual(list.expanded.slice(2, 12).map((candidate) => candidate.entry.path));
		expect(view?.layout.total).toBe(list.collapsed.length * ROW_HEIGHT);
	});

	it("counts group headers in the layout and still finds the folder row", () => {
		const { motion, list } = motionFor("expand", 10);
		const grouped: GroupSection<TreeRow>[] = [
			{ label: "Folders", rows: list.expanded.slice(0, 12) },
			{ label: "Files", rows: list.expanded.slice(12) },
		];
		const view = disclosureView(grouped, motion, scroll, LIST_OVERSCAN);
		expect(view?.layout.total).toBe(2 * GROUP_HEADER_HEIGHT + 60 * ROW_HEIGHT);
		expect(view?.layout.items[view.parentItem]).toMatchObject({ kind: "rows", section: 0, start: 1 });
		expect(view?.base[0]?.rows.length).toBe(2);
		expect(view?.base[1]?.rows.length).toBe(list.expanded.length - 12);
	});

	it("gives way to the plain list when the folder row is no longer in the window", () => {
		const { motion, sections } = motionFor("expand", 10);
		expect(disclosureView(sections, motion, { offset: 24 * 40, viewport: 480 }, LIST_OVERSCAN)).toBeNull();
	});

	it("gives way to the plain list when the rows no longer match the motion", () => {
		const { motion, list } = motionFor("expand", 10);
		const wrongParent: GroupSection<TreeRow>[] = [{ label: null, rows: list.expanded.slice(0, 1).concat(list.expanded.slice(2)) }];
		expect(disclosureView(wrongParent, motion, scroll, LIST_OVERSCAN)).toBeNull();
		expect(disclosureView([{ label: null, rows: list.collapsed }], motion, scroll, LIST_OVERSCAN)).toBeNull();
		expect(disclosureView([], motion, scroll, LIST_OVERSCAN)).toBeNull();
	});

	it("gives way to the plain list when the row where the folder was is another row now", () => {
		const { motion, list } = motionFor("collapse", 10);
		const shifted: GroupSection<TreeRow>[] = [{ label: null, rows: [list.collapsed[1] as TreeRow, ...list.collapsed.slice(0, 1), ...list.collapsed.slice(2)] }];
		expect(disclosureView(shifted, motion, scroll, LIST_OVERSCAN)).toBeNull();
	});

	it("also draws the rows a closing folder's shrinking list pulls into view, so no gap opens at the top", () => {
		// 30 rows with the folder at row 20 and 8 rows under it: the open list scrolls 192px further than the closed one.
		const list = bigList(8, 30, 20);
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: list.collapsed }];
		const change = detectDisclosureChange(list.expanded, list.collapsed) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const openMax = list.expanded.length * ROW_HEIGHT - 480;
		const settledMax = list.collapsed.length * ROW_HEIGHT - 480;
		expect(openMax - settledMax).toBe(8 * ROW_HEIGHT);
		const closing: DisclosureMotion = { id: 1, kind: "collapse", parent: "/r/b", parentIndex: change.parentIndex, block: change.block, drawn: 8, from: 1, to: 0 };
		const view = disclosureView(sections, closing, { offset: openMax, viewport: 480 }, LIST_OVERSCAN);
		// Where the browser leaves the scroller once the block is gone, plus the overscan: rows 6 and up, not 14 and up.
		expect(view?.window.start).toBe(Math.floor(settledMax / ROW_HEIGHT) - LIST_OVERSCAN);
		expect(view?.window.start).toBeLessThan(Math.floor(openMax / ROW_HEIGHT) - LIST_OVERSCAN);
		expect(view?.window.end).toBe(list.collapsed.length);
	});

	it("does not widen the window for an opening folder, whose list only grows", () => {
		const list = bigList(8, 30, 20);
		const sections: GroupSection<TreeRow>[] = [{ label: null, rows: list.expanded }];
		const change = detectDisclosureChange(list.collapsed, list.expanded) as NonNullable<ReturnType<typeof detectDisclosureChange>>;
		const opening: DisclosureMotion = { id: 1, kind: "expand", parent: "/r/b", parentIndex: change.parentIndex, block: change.block, drawn: 8, from: 0, to: 1 };
		const offset = 20 * ROW_HEIGHT - 48;
		const view = disclosureView(sections, opening, { offset, viewport: 480 }, LIST_OVERSCAN);
		expect(view?.window.start).toBe(Math.floor(offset / ROW_HEIGHT) - LIST_OVERSCAN);
	});
});

describe("timing", () => {
	it("reads CSS durations", () => {
		expect(parseDuration("220ms")).toBe(220);
		expect(parseDuration(" 0.22s ")).toBeCloseTo(220);
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("fast")).toBeNull();
	});

	it("reads cubic-bezier timing functions and nothing else", () => {
		expect(parseCubicBezier("cubic-bezier(0.2, 0.8, 0.2, 1)")).toEqual([0.2, 0.8, 0.2, 1]);
		expect(parseCubicBezier(" cubic-bezier(0,0,.58,1) ")).toEqual([0, 0, 0.58, 1]);
		expect(parseCubicBezier("ease-out")).toBeNull();
		expect(parseCubicBezier("cubic-bezier(2, 0, 0, 1)")).toBeNull();
		expect(parseCubicBezier("cubic-bezier(a, 0, 0, 1)")).toBeNull();
	});

	it("eases out: fast at the start, settled at the end, never backwards", () => {
		const ease = cubicBezier(...DEFAULT_DISCLOSURE_EASE);
		expect(ease(0)).toBe(0);
		expect(ease(1)).toBe(1);
		expect(ease(0.5)).toBeGreaterThan(0.5);
		expect(ease(0.1)).toBeGreaterThan(0.1);
		let last = 0;
		for (let step = 1; step <= 100; step += 1) {
			const value = ease(step / 100);
			expect(value).toBeGreaterThanOrEqual(last);
			last = value;
		}
	});

	it("follows the curve the CSS timing function describes", () => {
		// Brute force: walk the Bezier's parameter finely and read y where x passes `time`.
		const reference = (x1: number, y1: number, x2: number, y2: number, time: number): number => {
			const at = (a: number, b: number, u: number): number => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
			let best = { distance: Number.POSITIVE_INFINITY, y: 0 };
			for (let step = 0; step <= 20_000; step += 1) {
				const u = step / 20_000;
				const distance = Math.abs(at(x1, x2, u) - time);
				if (distance < best.distance) best = { distance, y: at(y1, y2, u) };
			}
			return best.y;
		};
		const curves: readonly (readonly [number, number, number, number])[] = [DEFAULT_DISCLOSURE_EASE, [0, 0, 0.58, 1], [0.42, 0, 1, 1], [0, 0, 1, 1]];
		for (const [x1, y1, x2, y2] of curves) {
			const ease = cubicBezier(x1, y1, x2, y2);
			for (const time of [0.05, 0.2, 0.5, 0.8, 0.95]) {
				expect(ease(time)).toBeCloseTo(reference(x1, y1, x2, y2, time), 3);
			}
		}
	});

	it("moves openness from where a motion starts to where it ends", () => {
		const ease = (time: number): number => time;
		expect(opennessAt({ from: 0, to: 1 }, 0, 200, ease)).toBe(0);
		expect(opennessAt({ from: 0, to: 1 }, 50, 200, ease)).toBeCloseTo(0.25);
		expect(opennessAt({ from: 0, to: 1 }, 400, 200, ease)).toBe(1);
		expect(opennessAt({ from: 1, to: 0 }, 100, 200, ease)).toBeCloseTo(0.5);
		expect(opennessAt({ from: 0.4, to: 0 }, 100, 200, ease)).toBeCloseTo(0.2);
		expect(opennessAt({ from: 0, to: 1 }, 10, 0, ease)).toBe(1);
	});

	it("gives a reversal only the rest of the way to go", () => {
		expect(motionDuration(220, 0, 1)).toBe(220);
		expect(motionDuration(220, 1, 0)).toBe(220);
		expect(motionDuration(220, 0.5, 1)).toBe(110);
		expect(motionDuration(220, 1, 1)).toBe(0);
	});
});
