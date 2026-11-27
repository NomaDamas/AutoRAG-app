import { describe, expect, it } from "vitest";
import { placeBubble } from "../src/renderer/src/first-run/tour";

describe("placeBubble right-middle (the card that waits while the answer is written)", () => {
	const viewport = { width: 1440, height: 860 };
	const size = { width: 360, height: 140 };

	it("sits at the window's right middle, 28px in, whatever it frames", () => {
		const big = { left: 180, top: 100, width: 960, height: 600 };
		expect(placeBubble(big, viewport, size, "right-middle")).toEqual({ left: 1440 - 360 - 28, top: (860 - 140) / 2, side: "center" });
		expect(placeBubble(null, viewport, size, "right-middle")).toEqual({ left: 1052, top: 360, side: "center" });
	});

	it("stays inside a window too small for it", () => {
		const place = placeBubble(null, { width: 300, height: 100 }, size, "right-middle");
		expect(place.left).toBe(14);
		expect(place.top).toBe(14);
	});
});
