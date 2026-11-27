import { describe, expect, it } from "vitest";
import { anchorSelectors, selectorOf, stepsInPlay, TUTORIALS } from "../src/renderer/src/first-run/tutorial-steps";
import { automationRequestKind } from "../src/renderer/src/state/automation-intent";
import { APP_LANGUAGES } from "../src/shared/language-contract";
import { setAppLanguage, t } from "../src/shared/i18n/core";

describe("the automations tutorial makes a right-click automation (Figma 672:3637)", () => {
	const steps = TUTORIALS.automations;
	const facts = { aiTab: 7, sample: "/home/Dazzi 체험/연습 파일/주간 보고 예시.txt" };
	const step = (key: string) => steps.find((candidate) => candidate.key === key);

	it("asks the chat, has the person fill in and add the card, then runs the new item from a file's menu", () => {
		// The result step only follows a click on the menu item, as the right-click tutorial's did.
		expect(stepsInPlay(steps, () => true, facts).map((index) => steps[index]?.key)).toEqual(["intro", "send", "card", "made", "sample", "pick", "result"]);
	});

	it("opens on the recommendations, falling back to the page", () => {
		const intro = step("intro");
		expect(intro === undefined ? [] : anchorSelectors(intro, facts)).toEqual(["[data-automations-view] [data-automation-recommendations]", "[data-automations-view]"]);
		expect(intro?.offer).toBe("askForRightClick");
	});

	it("moves on from the card when 추가하기 is clicked in the tutorial's own chat", () => {
		expect(selectorOf(step("card")?.tap, facts)).toBe('[data-ai-tab="7"] [data-automation-request] [data-action="automation-request-add"]');
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

	it("sends, in every language, words the chat answers with the card already on 우클릭하면", async () => {
		for (const language of APP_LANGUAGES) {
			await setAppLanguage(language);
			expect(automationRequestKind(t("tutorials.automations.askText")), language).toBe("rightClick");
		}
		await setAppLanguage("ko");
	});
});
