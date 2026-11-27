import { describe, expect, it } from "vitest";
import { anchorSelectors, nextStep, selectorOf, stepsInPlay, TUTORIALS } from "../src/renderer/src/first-run/tutorial-steps";

describe("the automations tutorial adds a right-click recommendation and runs it (Figma 672:3637)", () => {
	const steps = TUTORIALS.automations;
	const facts = { sample: "/home/Dazzi 체험/연습 파일/주간 보고 예시.txt" };
	const step = (key: string) => steps.find((candidate) => candidate.key === key);

	it("introduces automations, has the person add 문서 세 줄 요약, run it from a file's menu, and ends on 새 자동화", () => {
		// The result step only follows a click on the menu item.
		expect(stepsInPlay(steps, () => true, facts).map((index) => steps[index]?.key)).toEqual(["intro", "add", "made", "sample", "pick", "result", "chat"]);
	});

	it("opens on the recommendations with a plain 다음, no offer to accept", () => {
		const intro = step("intro");
		expect(intro === undefined ? [] : anchorSelectors(intro, facts)).toEqual(["[data-automations-view] [data-automation-recommendations]", "[data-automations-view]"]);
		expect(intro?.offer).toBeUndefined();
	});

	it("moves on from the recommendation when its 추가하기 is clicked, and is passed over when it is already added", () => {
		const add = step("add");
		expect(selectorOf(add?.tap, facts)).toBe('[data-automations-view] [data-template="summary"] [data-action="automation-template-add"]');
		const index = steps.findIndex((candidate) => candidate.key === "add");
		const present = (selector: string): boolean => !selector.includes('data-template="summary"');
		expect(nextStep(steps, index - 1, false, present, facts)).toBe(index + 1);
	});

	it("finds the automation the person added by its id, in the list and in the practice file's menu", () => {
		const added = { ...facts, action: "summary-3" };
		expect(step("made")?.enter).toBe("showNewRightClick");
		expect(selectorOf(step("made")?.waitFor, added)).toBe('[data-automations-view] [data-magic-action-row="summary-3"]');
		const sample = step("sample");
		expect(sample?.enter).toBe("openSample");
		expect(sample?.hint).toBe("rightClick");
		expect(selectorOf(sample?.until, added)).toBe('.menu[role="menu"] [data-magic-action-id="summary-3"]');
		expect(selectorOf(step("pick")?.tap, added)).toBe('.menu[role="menu"] [data-magic-action-id="summary-3"]');
		// Until it is known, nothing matches: another action's item is never taken for it.
		expect(selectorOf(sample?.until, facts)).toBe("[data-magic-action-id]:not([data-magic-action-id])");
	});

	it("goes back to the automations page for its last step, which points at 새 자동화", () => {
		const chat = step("chat");
		expect(chat?.enter).toBe("backToAutomations");
		expect(chat === undefined ? [] : anchorSelectors(chat, facts)).toEqual(['[data-automations-view] [data-action="automation-composer-open"]']);
		expect(nextStep(steps, steps.length - 1, false, () => true, facts)).toBeNull();
	});
});
