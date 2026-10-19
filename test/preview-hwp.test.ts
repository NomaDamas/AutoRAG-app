import { describe, expect, it } from "vitest";
import { openHwp } from "../src/preview/shared/hwp";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import { buildHwp, initRhwpForNode, svgText } from "./support/hwp-fixture";

const A4 = { width: 793.7, height: 1122.5 };

describe("hwp preview", () => {
	it("sends .hwp and .hwpx to the paged HWP viewer with the whole file", () => {
		expect(viewerForExtension("hwp")).toBe("hwp");
		expect(viewerForExtension("HWPX")).toBe("hwp");
		expect(byteNeed("hwp")).toBe("whole");
		expect(describeExtension("hwp")).toBe("HWP document");
		expect(describeExtension("hwpx")).toBe("HWPX document");
	});

	it.each(["hwp", "hwpx"] as const)("lays out every page of a %s document at its paper size and draws each page's own text", (format) => {
		const pages = openHwp(buildHwp(["첫째 쪽 본문", "둘째 쪽 본문", "셋째 쪽 본문"], format));
		try {
			expect(pages.boxes).toHaveLength(3);
			for (const box of pages.boxes) {
				expect(box.width).toBeCloseTo(A4.width, 0);
				expect(box.height).toBeCloseTo(A4.height, 0);
			}
			expect(pages.boxes.map((_box, index) => svgText(pages.svg(index)))).toEqual(["첫째쪽본문", "둘째쪽본문", "셋째쪽본문"]);
			expect(pages.svg(1)).toMatch(/^<svg\b[^>]*viewBox="0 0 793\.\d+ 1122\.\d+"/);
		} finally {
			pages.close();
		}
	});

	it("turns rhwp's thrown strings into errors the viewer can show", () => {
		initRhwpForNode();
		expect(() => openHwp(new Uint8Array([0x4e, 0x4f, 0x50, 0x45]))).toThrow(Error);
		const pages = openHwp(buildHwp(["한 쪽"]));
		try {
			expect(() => pages.svg(5)).toThrow(Error);
		} finally {
			pages.close();
		}
	});
});
