import { describe, expect, it } from "vitest";
import { collapseOrder, fitPathBar } from "../src/renderer/src/state/path-fit";

// Macintosh HD › Users › jeffrey › Downloads › quicklook-preview-reference
const LABELS = [70, 34, 44, 60, 160];
const FIXED = 150;
const NATURAL = FIXED + LABELS.reduce((total, label) => total + label, 0); // 518
const MIN_LABEL = 32;

const fit = (available: number) => fitPathBar({ available, fixed: FIXED, labels: LABELS, minLabel: MIN_LABEL });
const modes = (available: number) => fit(available).segments.map((segment) => segment.mode);

describe("collapseOrder", () => {
	it("gives up the middle first, then the root, the parent, and the last segment", () => {
		expect(collapseOrder(5)).toEqual([1, 2, 0, 3, 4]);
		expect(collapseOrder(3)).toEqual([0, 1, 2]);
		expect(collapseOrder(2)).toEqual([0, 1]);
		expect(collapseOrder(1)).toEqual([0]);
		expect(collapseOrder(0)).toEqual([]);
	});
});

describe("fitPathBar", () => {
	it("shows every label when the trail fits exactly", () => {
		expect(fit(NATURAL)).toEqual({ segments: LABELS.map(() => ({ mode: "full" })), overflow: false });
	});

	it("clips the first segment in order by exactly the missing width", () => {
		// "jeffrey"-like middle labels are short; "Users" (34) can only lose 2px.
		expect(fit(NATURAL - 2).segments[1]).toEqual({ mode: "clip", width: 32 });
		expect(modes(NATURAL - 2)).toEqual(["full", "clip", "full", "full", "full"]);
	});

	it("drops a segment to its icon once less than minLabel would remain", () => {
		// Users cannot shed 3px and keep 32, so it goes icon and jeffrey stays full.
		expect(modes(NATURAL - 3)).toEqual(["full", "icon", "full", "full", "full"]);
	});

	it("collapses the middle before narrowing the root", () => {
		// Users (34) and jeffrey (44) gone → root clips by the remaining 10px.
		expect(fit(NATURAL - 88).segments).toEqual([
			{ mode: "clip", width: 60 },
			{ mode: "icon" },
			{ mode: "icon" },
			{ mode: "full" },
			{ mode: "full" },
		]);
	});

	it("collapses the root before the parent, and the parent before the last segment", () => {
		expect(modes(NATURAL - 34 - 44 - 70 - 1)).toEqual(["icon", "icon", "icon", "clip", "full"]);
		expect(modes(NATURAL - 34 - 44 - 70 - 60 - 1)).toEqual(["icon", "icon", "icon", "icon", "clip"]);
	});

	it("floors clip widths so the trail never exceeds the bar", () => {
		const result = fit(NATURAL - 88 - 10.4);
		expect(result.segments[0]).toEqual({ mode: "clip", width: 49 });
	});

	it("reports overflow only when the icon-only trail is still too wide", () => {
		expect(fit(FIXED)).toEqual({ segments: LABELS.map(() => ({ mode: "icon" })), overflow: false });
		expect(fit(FIXED - 1).overflow).toBe(true);
	});
});
