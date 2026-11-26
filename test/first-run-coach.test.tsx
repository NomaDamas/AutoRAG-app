// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoachCard, CoachMarker } from "../src/renderer/src/first-run/coach";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("the coach overlay (Figma 156:591)", () => {
	it("shows the title over the body, a dot per step with the current one marked, and the links at the bottom right", () => {
		act(() =>
			root.render(
				<CoachCard title="내 파일에 물어보세요" body={"첫 줄\n둘째 줄"} index={1} count={4}>
					<button type="button">건너뛰기</button>
				</CoachCard>,
			),
		);
		expect(host.querySelector(".fr-coach-title")?.textContent).toBe("내 파일에 물어보세요");
		expect(host.querySelector(".fr-coach-body")?.textContent).toBe("첫 줄\n둘째 줄");
		const dots = [...host.querySelectorAll<HTMLElement>(".fr-coach-dot")];
		expect(dots.map((dot) => dot.dataset.current ?? "")).toEqual(["", "true", "", ""]);
		expect(host.querySelector(".fr-coach-dots")?.getAttribute("aria-label")).toBe("2 / 4");
		expect(host.querySelector(".fr-coach-links button")?.textContent).toBe("건너뛰기");
	});

	it("rings a small click target and sits on its centre, where a click lands", () => {
		act(() => root.render(<CoachMarker target={{ left: 100, top: 200, width: 32, height: 32 }} spot={null} data={{ "data-target-step": "ask" }} />));
		const marker = host.querySelector<HTMLElement>('.fr-cursor[data-target-step="ask"]');
		expect(marker?.style.left).toBe("116px");
		expect(marker?.style.top).toBe("216px");
		const ring = host.querySelector<HTMLElement>(".fr-cursor-ring");
		expect(ring?.style.width).toBe("52px");
		expect(host.querySelector(".fr-mascot")).not.toBeNull();
	});

	it("points at a wide row with the sunflower alone, and at a spotlight's corner when nothing is to be clicked", () => {
		act(() => root.render(<CoachMarker target={{ left: 180, top: 125, width: 959, height: 24 }} spot={null} data={{}} />));
		expect(host.querySelector(".fr-cursor-ring")).toBeNull();
		expect(host.querySelector(".fr-mascot")).not.toBeNull();
		act(() => root.render(<CoachMarker target={null} spot={{ left: 1150, top: 425, width: 269, height: 102 }} data={{}} />));
		expect(host.querySelector(".fr-cursor-ring")).toBeNull();
		const mascot = host.querySelector<HTMLElement>(".fr-mascot");
		const marker = host.querySelector<HTMLElement>(".fr-cursor");
		// Centred on the corner, 13px in and 9px down (Figma 162:1839).
		expect(Number.parseFloat(marker?.style.left ?? "") + Number.parseFloat(mascot?.style.left ?? "") + 30).toBe(1406);
		expect(Number.parseFloat(marker?.style.top ?? "") + Number.parseFloat(mascot?.style.top ?? "") + 30).toBe(434);
		act(() => root.render(<CoachMarker target={null} spot={null} data={{}} />));
		expect(host.querySelector(".fr-cursor")).toBeNull();
	});
});
