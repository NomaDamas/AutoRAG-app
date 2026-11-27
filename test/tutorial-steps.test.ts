import { describe, expect, it } from "vitest";
import { anchorSelectors, selectorOf, stepsInPlay, TUTORIALS } from "../src/renderer/src/first-run/tutorial-steps";

describe("the automations tutorial (Figma 672:3637)", () => {
	const steps = TUTORIALS.automations;
	const facts = { aiTab: 7, photo: "/p/IMG_0001.jpg", gray: "/d/gray", result: "/d/gray/IMG_0001.jpg" };

	it("asks the AI, has the person add the rule on its card, then watches it work", () => {
		expect(stepsInPlay(steps, () => true, facts).map((index) => steps[index]?.key)).toEqual(["intro", "send", "asking", "confirm", "rule", "drag", "result"]);
	});

	it("opens on the recommendations, falling back to the page", () => {
		const intro = steps.find((step) => step.key === "intro");
		expect(intro === undefined ? [] : anchorSelectors(intro, facts)).toEqual(["[data-automations-view] [data-automation-recommendations]", "[data-automations-view]"]);
	});

	it("waits for the rule card in its own chat, gives the AI the long wait, and moves on when 추가하기 is clicked", () => {
		const asking = steps.find((step) => step.key === "asking");
		const confirm = steps.find((step) => step.key === "confirm");
		expect(selectorOf(asking?.until, facts)).toBe('[data-ai-tab="7"] [data-interaction="automation"] [data-automation-request]');
		expect(asking?.slow).toBe(true);
		expect(selectorOf(confirm?.tap, facts)).toBe('[data-ai-tab="7"] [data-interaction="automation"] [data-automation-request] [data-action="automation-request-add"]');
	});

	it("splits the window itself when the drag step comes up, with no separate offer", () => {
		const drag = steps.find((step) => step.key === "drag");
		expect(drag?.enter).toBe("arrangePhotoPanes");
		expect(steps.some((step) => step.offer === "arrangePhotoPanes")).toBe(false);
	});
});
