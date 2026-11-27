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
		// Centred just outside the corner, 4px right and 6px up, so it does not sit on the box's words.
		expect(Number.parseFloat(marker?.style.left ?? "") + Number.parseFloat(mascot?.style.left ?? "") + 30).toBe(1423);
		expect(Number.parseFloat(marker?.style.top ?? "") + Number.parseFloat(mascot?.style.top ?? "") + 30).toBe(419);
		act(() => root.render(<CoachMarker target={null} spot={null} data={{}} />));
		expect(host.querySelector(".fr-cursor")).toBeNull();
	});

	const mascotCentre = (): { x: number; y: number } => {
		const mascot = host.querySelector<HTMLElement>(".fr-mascot");
		const marker = host.querySelector<HTMLElement>(".fr-cursor");
		return {
			x: Number.parseFloat(marker?.style.left ?? "") + Number.parseFloat(mascot?.style.left ?? "") + 30,
			y: Number.parseFloat(marker?.style.top ?? "") + Number.parseFloat(mascot?.style.top ?? "") + 30,
		};
	};

	it("moves to the spotlight's other corner when the first one is cut by the window's edge", () => {
		// The evidence panel at the window's right edge: its top-right corner would put half the sunflower off screen.
		act(() => root.render(<CoachMarker target={null} spot={{ left: 1140, top: 120, width: 300, height: 600 }} data={{}} bounds={{ width: 1440, height: 860 }} />));
		expect(mascotCentre()).toEqual({ x: 1136, y: 114 });
	});

	it("moves to the spotlight's other corner rather than cover the coach card", () => {
		// A wide composer with the card beside its right end (the tour's first step).
		const spot = { left: 400, top: 380, width: 620, height: 48 };
		const card = { left: 990, top: 330, width: 320, height: 150 };
		act(() => root.render(<CoachMarker target={null} spot={spot} data={{}} bounds={{ width: 1440, height: 860 }} avoid={card} />));
		expect(mascotCentre()).toEqual({ x: 396, y: 374 });
	});

	it("puts the sunflower left of the ring when the right side is off the window", () => {
		act(() => root.render(<CoachMarker target={{ left: 1400, top: 800, width: 30, height: 30 }} spot={null} data={{}} bounds={{ width: 1440, height: 860 }} />));
		// Ring diameter 50 around (1415, 815): left of it is 1415 - 25 - 8.
		expect(mascotCentre()).toEqual({ x: 1382, y: 815 });
	});
});
