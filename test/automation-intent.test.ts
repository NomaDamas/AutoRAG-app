import { describe, expect, it } from "vitest";
import { isAutomationRequest } from "../src/renderer/src/state/automation-intent";

describe("isAutomationRequest", () => {
	it.each([
		"자동화 만들기",
		"자동화 만들어줘",
		"자동화만들고싶어",
		"자동화 만들고 싶어요",
		"자동화를 좀 만들어 주세요",
		"새 자동화 하나 추가해줘",
		"새 자동화",
		"자동화하고 싶어",
		"自動化を作って",
		"新しい自動化を追加したい",
		"创建自动化",
		"我想新建一个自动化",
		"create an automation",
		"I want to make a new automation",
		"Can you set up an automation for me please?",
		"New automation",
	])("treats %s as a request for the 새 자동화 card", (text) => {
		expect(isAutomationRequest(text)).toBe(true);
	});

	it.each([
		"다운로드에 PDF가 들어오면 요약하는 자동화 만들어줘",
		"자동화가 뭐야?",
		"자동화 기록 보여줘",
		"업무 자동화 관련 문서 찾아줘",
		"what is an automation",
		"find the automation report",
		"",
	])("leaves %s to the agent", (text) => {
		expect(isAutomationRequest(text)).toBe(false);
	});
});
