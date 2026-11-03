// @vitest-environment happy-dom
import { act, useLayoutEffect, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENNESS_PROPERTY, useDisclosureMotion } from "../src/renderer/src/hooks/useDisclosureMotion";
import type { DisclosureMotion } from "../src/renderer/src/state/disclosure-motion";
import type { TreeRow } from "../src/renderer/src/state/folder-tree";
import type { GroupSection } from "../src/renderer/src/state/grouping";
import { LIST_OVERSCAN } from "../src/renderer/src/state/virtual";
import { listWithFolder } from "./support/disclosure-rows";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SCROLL = { offset: 0, viewport: 480 };

let host: HTMLDivElement;
let root: Root;
/** The motion of every commit, in order. */
let seen: (DisclosureMotion | null)[];
let reduced = false;

function Probe({ rows, scroll = SCROLL }: { readonly rows: readonly TreeRow[]; readonly scroll?: typeof SCROLL }): ReactElement {
	const target = useRef<HTMLDivElement | null>(null);
	const sections: readonly GroupSection<TreeRow>[] = [{ label: null, rows }];
	const motion = useDisclosureMotion({ rows, sections, scroll, overscan: LIST_OVERSCAN, target });
	// Only what React committed: a render that React throws away to apply a state update made during it is not seen.
	useLayoutEffect(() => {
		seen.push(motion);
	});
	return <div data-target ref={target} />;
}

const last = (): DisclosureMotion | null => seen.at(-1) ?? null;
const target = (): HTMLElement => host.querySelector("[data-target]") as HTMLElement;
const openness = (): number => Number(target().style.getPropertyValue(OPENNESS_PROPERTY));
const show = (rows: readonly TreeRow[], scroll = SCROLL): void => act(() => root.render(<Probe rows={rows} scroll={scroll} />));
const run = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
	reduced = false;
	vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
	seen = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("useDisclosureMotion", () => {
	const list = listWithFolder(8);

	it("starts nothing for the rows it is first given", () => {
		show(list.collapsed);
		expect(last()).toBeNull();
		expect(target().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
	});

	it("starts the motion in the render that brings the rows, so no frame shows the settled list first", () => {
		show(list.collapsed);
		const rendersBefore = seen.length;
		show(list.expanded);
		// Every render that carried the new rows already had the motion.
		expect(seen.slice(rendersBefore).every((motion) => motion?.kind === "expand")).toBe(true);
		expect(last()).toMatchObject({ kind: "expand", parent: "/r/b", from: 0, to: 1, drawn: 8 });
		// The layout effect has put the first frame on the element before anything is painted.
		expect(openness()).toBe(0);
	});

	it("opens a folder from 0 to 1 and then lets the rows settle", () => {
		show(list.collapsed);
		show(list.expanded);
		run(16);
		expect(openness()).toBeGreaterThan(0);
		run(60);
		const mid = openness();
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		run(60);
		expect(openness()).toBeGreaterThanOrEqual(mid);
		run(300);
		expect(last()).toBeNull();
		expect(target().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
	});

	it("closes a folder from 1 to 0", () => {
		show(list.expanded);
		show(list.collapsed);
		expect(last()).toMatchObject({ kind: "collapse", from: 1, to: 0 });
		expect(openness()).toBe(1);
		run(80);
		expect(openness()).toBeLessThan(1);
		expect(openness()).toBeGreaterThan(0);
		run(300);
		expect(last()).toBeNull();
	});

	it("runs for the --dur-disclosure token, not a number of its own", () => {
		const style = getComputedStyle(document.documentElement);
		vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
			() => ({ ...style, getPropertyValue: (name: string) => (name === "--dur-disclosure" ? "1000ms" : "") }) as CSSStyleDeclaration,
		);
		show(list.collapsed);
		show(list.expanded);
		run(600);
		expect(last()).not.toBeNull();
		run(600);
		expect(last()).toBeNull();
	});

	it("turns a folder around from where it is, not from the end", () => {
		show(list.collapsed);
		show(list.expanded);
		run(80);
		const reached = openness();
		expect(reached).toBeGreaterThan(0.2);
		expect(reached).toBeLessThan(1);
		show(list.collapsed);
		expect(last()).toMatchObject({ kind: "collapse", to: 0 });
		expect(last()?.from).toBeCloseTo(reached, 3);
		expect(openness()).toBeCloseTo(reached, 3);
		run(16);
		expect(openness()).toBeLessThan(reached);
		// The way back is only as long as what is left of it.
		run(300);
		expect(last()).toBeNull();
		show(list.expanded);
		expect(last()).toMatchObject({ kind: "expand", from: 0 });
	});

	it("lets a second folder replace the running motion", () => {
		const other = listWithFolder(8, 60, 5);
		show(list.collapsed);
		show(list.expanded);
		run(60);
		const first = last();
		show(other.collapsed);
		expect(last()).toBeNull();
		show(other.expanded);
		expect(last()?.id).not.toBe(first?.id);
		expect(last()).toMatchObject({ kind: "expand", from: 0, parent: "/r/b", parentIndex: 5 });
		run(400);
		expect(last()).toBeNull();
	});

	it("ends the motion when the rows change in any way that is not a disclosure", () => {
		show(list.collapsed);
		show(list.expanded);
		run(40);
		expect(last()).not.toBeNull();
		show([...list.expanded].reverse());
		expect(last()).toBeNull();
		expect(target().style.getPropertyValue(OPENNESS_PROPERTY)).toBe("");
	});

	it("keeps the motion through a refresh that left the rows as they were", () => {
		show(list.collapsed);
		show(list.expanded);
		const motion = last();
		run(40);
		show(list.expanded.map((candidate) => ({ ...candidate })));
		expect(last()).toBe(motion);
		run(300);
		expect(last()).toBeNull();
	});

	it("starts no motion for the click on a folder whose listing is still loading, and one when its rows arrive", () => {
		show(list.collapsed);
		show(list.waiting);
		expect(last()).toBeNull();
		run(500);
		show(list.expanded);
		expect(last()).toMatchObject({ kind: "expand", from: 0 });
		run(400);
		expect(last()).toBeNull();
		// Nothing moves a second time.
		run(1000);
		const ids = seen.flatMap((motion) => (motion === null ? [] : [motion.id]));
		expect(new Set(ids).size).toBe(1);
	});

	it("starts nothing when the folder row is scrolled away", () => {
		show(list.collapsed, { offset: 24 * 50, viewport: 480 });
		show(list.expanded, { offset: 24 * 50, viewport: 480 });
		expect(last()).toBeNull();
	});

	it("starts no motion under prefers-reduced-motion, and follows the setting live", () => {
		reduced = true;
		show(list.collapsed);
		show(list.expanded);
		expect(last()).toBeNull();
		expect(seen.every((motion) => motion === null)).toBe(true);
		show(list.collapsed);
		expect(last()).toBeNull();
		reduced = false;
		show(list.expanded);
		expect(last()).toMatchObject({ kind: "expand" });
	});

	it("settles on its own when the window gets no animation frames", () => {
		vi.stubGlobal("requestAnimationFrame", () => 1);
		show(list.collapsed);
		show(list.expanded);
		expect(last()).not.toBeNull();
		run(220);
		expect(last()).not.toBeNull();
		run(400);
		expect(last()).toBeNull();
	});

	it("drops its frames when it unmounts mid-motion", () => {
		show(list.collapsed);
		show(list.expanded);
		run(40);
		const paint = vi.spyOn(target().style, "setProperty");
		act(() => root.unmount());
		paint.mockClear();
		run(1000);
		// No timer is left to paint or settle after the list is gone.
		expect(paint).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		root = createRoot(host);
	});
});
