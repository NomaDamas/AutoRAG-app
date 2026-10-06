import { describe, expect, it } from "vitest";
import { ROW_DRAG_THRESHOLD, rowDragPhase } from "../src/renderer/src/state/row-drag";

const viewport = { width: 800, height: 600 };
const start = { x: 100, y: 100 };

describe("rowDragPhase", () => {
	it("keeps a press a press until the pointer travels the threshold", () => {
		expect(rowDragPhase("pending", start, { x: 102, y: 101 }, viewport)).toBe("pending");
		expect(rowDragPhase("pending", start, { x: 100 + ROW_DRAG_THRESHOLD, y: 100 }, viewport)).toBe("inside");
	});

	it("stays an in-app drag anywhere inside the window, edges included", () => {
		expect(rowDragPhase("inside", start, { x: 0, y: 0 }, viewport)).toBe("inside");
		expect(rowDragPhase("inside", start, { x: 799, y: 599 }, viewport)).toBe("inside");
	});

	it("turns native the moment the pointer leaves the window on any side", () => {
		expect(rowDragPhase("inside", start, { x: -1, y: 300 }, viewport)).toBe("native");
		expect(rowDragPhase("inside", start, { x: 400, y: -1 }, viewport)).toBe("native");
		expect(rowDragPhase("inside", start, { x: 800, y: 300 }, viewport)).toBe("native");
		expect(rowDragPhase("inside", start, { x: 400, y: 600 }, viewport)).toBe("native");
	});

	it("goes straight to native when the first move past the threshold is already outside", () => {
		expect(rowDragPhase("pending", start, { x: -50, y: 100 }, viewport)).toBe("native");
	});

	it("stays native once the drag has left, even back over the window", () => {
		expect(rowDragPhase("native", start, { x: 400, y: 300 }, viewport)).toBe("native");
	});
});
