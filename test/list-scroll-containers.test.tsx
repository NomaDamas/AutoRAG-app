// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HEADER_VIEWPORT_CLASS, LIST_SCROLLER_CLASS, followScrollLeft } from "../src/renderer/src/components/list-scroll";

const tokens = (className: string): string[] => className.split(/\s+/);

describe("file list scroll containers", () => {
	it("has one sideways scroller, the list: the header viewport only follows it", () => {
		expect(tokens(LIST_SCROLLER_CLASS)).toContain("overflow-auto");
		expect(tokens(HEADER_VIEWPORT_CLASS)).toContain("overflow-x-hidden");
		expect(tokens(HEADER_VIEWPORT_CLASS)).not.toContain("overflow-x-auto");
		expect(tokens(HEADER_VIEWPORT_CLASS)).not.toContain("overflow-auto");
	});
});

describe("followScrollLeft", () => {
	function pair(): { list: HTMLElement; header: HTMLElement } {
		const list = document.createElement("div");
		const header = document.createElement("div");
		return { list, header };
	}

	it("moves the header to the list's horizontal scroll position on every scroll", () => {
		const { list, header } = pair();
		const stop = followScrollLeft(list, header);
		list.scrollLeft = 120;
		list.dispatchEvent(new Event("scroll"));
		expect(header.scrollLeft).toBe(120);
		list.scrollLeft = 0;
		list.dispatchEvent(new Event("scroll"));
		expect(header.scrollLeft).toBe(0);
		stop();
	});

	it("starts aligned and stops following after cleanup", () => {
		const { list, header } = pair();
		list.scrollLeft = 40;
		const stop = followScrollLeft(list, header);
		expect(header.scrollLeft).toBe(40);
		stop();
		list.scrollLeft = 90;
		list.dispatchEvent(new Event("scroll"));
		expect(header.scrollLeft).toBe(40);
	});
});
