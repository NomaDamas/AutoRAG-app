import { describe, expect, it } from "vitest";
import {
	describeMarks,
	documentEditMode,
	fromAnchor,
	isDocumentEditEvent,
	isDocumentEditRequest,
	markBounds,
	markShape,
	textProbeRect,
	toAnchor,
	type AnnotationMark,
} from "../src/preview/shared/annotation";

const box = { left: 100, top: 50, width: 400, height: 800 };

describe("anchor geometry", () => {
	it("round-trips a point through a page box, and follows the page when it scrolls or zooms", () => {
		const point = toAnchor({ x: 300, y: 450 }, box);
		expect(point).toEqual({ x: 0.5, y: 0.5 });
		expect(fromAnchor(point, box)).toEqual({ x: 300, y: 450 });
		// Scrolled up 200px and zoomed to 2x: the mark stays on the same spot of the page.
		expect(fromAnchor(point, { left: 100, top: -150, width: 800, height: 1600 })).toEqual({ x: 500, y: 650 });
	});

	it("bounds a stroke whatever direction it was drawn in", () => {
		expect(markBounds([{ x: 0.6, y: 0.4 }, { x: 0.2, y: 0.9 }, { x: 0.3, y: 0.1 }])).toEqual({ left: 0.2, top: 0.1, right: 0.6, bottom: 0.9 });
	});
});

describe("mark shapes", () => {
	it("draws a box from its two corners, an underline level with where it started, and a pen stroke through every point", () => {
		expect(markShape("box", [{ x: 40, y: 30 }, { x: 10, y: 5 }])).toEqual({ kind: "rect", x: 10, y: 5, width: 30, height: 25 });
		expect(markShape("underline", [{ x: 10, y: 20 }, { x: 25, y: 31 }, { x: 90, y: 44 }])).toEqual({ kind: "line", x1: 10, y1: 20, x2: 90, y2: 20 });
		expect(markShape("pen", [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])).toEqual({ kind: "path", d: "M1 2L3 4L5 6" });
	});
});

describe("text probe", () => {
	it("reads the line above an underline, and the marked area itself for a box or pen stroke", () => {
		expect(textProbeRect("underline", { left: 10, top: 100, right: 210, bottom: 100 })).toEqual({ left: 10, top: 76, right: 210, bottom: 102 });
		expect(textProbeRect("box", { left: 10, top: 20, right: 30, bottom: 40 })).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
	});
});

describe("documentEditMode", () => {
	it("edits text formats in place and package formats through a scratch folder; nothing else is offered", () => {
		for (const ext of ["md", "txt", "html", "csv", "json", "py", "MD"]) expect(documentEditMode(ext)).toBe("text");
		for (const ext of ["docx", "pptx", "xlsx", "hwp", "hwpx", "odt"]) expect(documentEditMode(ext)).toBe("package");
		for (const ext of ["pdf", "png", "mp4", "zip", "doc", ""]) expect(documentEditMode(ext)).toBeNull();
	});
});

describe("isDocumentEditRequest", () => {
	const mark: AnnotationMark = { tool: "box", page: 2, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], text: "분기 매출" };

	it("accepts an instruction with marks", () => {
		expect(isDocumentEditRequest({ path: "/a/b.md", instruction: "이 부분을 굵게", marks: [mark] })).toBe(true);
		expect(isDocumentEditRequest({ path: "/a/b.md", instruction: "제목을 바꿔줘", marks: [] })).toBe(true);
	});

	it("refuses an empty instruction, an unknown tool, a stroke off the page box, and an oversized request", () => {
		expect(isDocumentEditRequest({ path: "/a/b.md", instruction: "   ", marks: [mark] })).toBe(false);
		expect(isDocumentEditRequest({ path: "", instruction: "x", marks: [] })).toBe(false);
		expect(isDocumentEditRequest({ path: "/a", instruction: "x", marks: [{ ...mark, tool: "laser" }] })).toBe(false);
		expect(isDocumentEditRequest({ path: "/a", instruction: "x", marks: [{ ...mark, points: [{ x: Number.NaN, y: 0 }] }] })).toBe(false);
		expect(isDocumentEditRequest({ path: "/a", instruction: "x", marks: [{ ...mark, points: [] }] })).toBe(false);
		expect(isDocumentEditRequest({ path: "/a", instruction: "x".repeat(8001), marks: [] })).toBe(false);
		expect(isDocumentEditRequest({ path: "/a", instruction: "x", marks: Array.from({ length: 101 }, () => mark) })).toBe(false);
	});
});

describe("isDocumentEditEvent", () => {
	it("accepts the event kinds the panel follows and refuses the rest", () => {
		expect(isDocumentEditEvent({ type: "progress", runId: "r", text: "읽는 중" })).toBe(true);
		expect(isDocumentEditEvent({ type: "done", runId: "r", path: "/a.md", changed: true, reply: "ok" })).toBe(true);
		expect(isDocumentEditEvent({ type: "done", runId: "r", path: "/a.md", reply: "ok" })).toBe(false);
		expect(isDocumentEditEvent({ type: "nope", runId: "r" })).toBe(false);
	});
});

describe("describeMarks", () => {
	it("lists each mark by page with what it covers and where, so the agent can find it in the file", () => {
		const text = describeMarks([
			{ tool: "underline", page: 3, points: [{ x: 0.1, y: 0.5 }, { x: 0.6, y: 0.5 }], text: "매출 1,234" },
			{ tool: "box", page: null, points: [{ x: 0, y: 0.25 }, { x: 0.5, y: 0.3 }], text: "" },
			{ tool: "pen", page: 1, points: [{ x: 0.9, y: 0.95 }], text: "a".repeat(700) },
		]);
		expect(text).toContain('1. Page 3 — underline under "매출 1,234" (x 10–60%, y 50–50% of the page)');
		expect(text).toContain("2. Document — box (no text under it; see the screenshot) (x 0–50%, y 25–30% of the document)");
		expect(text).toContain(`3. Page 1 — pen stroke over "${"a".repeat(500)}…"`);
	});

	it("says so when there are no marks", () => {
		expect(describeMarks([])).toBe("(no marks; the instruction applies to the whole document)");
	});
});
