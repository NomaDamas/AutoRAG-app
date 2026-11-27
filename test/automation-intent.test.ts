import { describe, expect, it } from "vitest";
import { automationRequestKind, isAutomationRequest } from "../src/renderer/src/state/automation-intent";

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
		"자동화 만들고싶음",
		"나만의 자동화 하나 만들래",
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
		"우클릭으로 파일 변환하는 자동화 만들어줘",
		"우클릭 메뉴가 안 떠",
		"what is an automation",
		"find the automation report",
		"",
	])("leaves %s to the agent", (text) => {
		expect(isAutomationRequest(text)).toBe(false);
	});

	it.each([
		"우클릭 자동화 만들고싶음",
		"우클릭 메뉴에 항목 추가하고 싶어",
		"오른쪽 클릭 버튼 만들어줘",
		"매직 액션 하나 만들어 주세요",
		"右クリックメニューに項目を追加して",
		"マジックアクションを作って",
		"帮我添加一个右键菜单项",
		"create a right-click automation",
		"I want to add a context menu item",
		"make a magic action please",
	])("treats %s as a request for a right-click automation", (text) => {
		expect(automationRequestKind(text)).toBe("rightClick");
	});

	it("keeps a plain automation request a folder rule", () => {
		expect(automationRequestKind("자동화 만들고싶음")).toBe("rule");
		expect(automationRequestKind("create an automation")).toBe("rule");
	});
});
