import { describe, expect, it } from "vitest";
import { blockerClip } from "../src/renderer/src/first-run/Tutorials";

describe("the guided tutorial's blocking layer", () => {
	it("covers the whole window when the step asks for nothing on the page", () => {
		expect(blockerClip({ width: 1440, height: 860 }, null)).toBeUndefined();
	});

	it("cuts a hole 4px larger than the target, so only the target takes the click", () => {
		expect(blockerClip({ width: 1440, height: 860 }, { left: 600, top: 300, width: 80, height: 28 })).toBe('path(evenodd, "M0 0H1440V860H0Z M596 296h88v36h-88Z")');
	});
});
