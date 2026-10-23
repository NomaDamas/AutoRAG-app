// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationQuickLook } from "../src/renderer/src/components/AutomationQuickLook";
import { ruleTitle, triggerText, whatText } from "../src/renderer/src/state/automations";
import type { AutomationRule, AutomationRun } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const MIN = 60_000;
const noop = (): void => {};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return { startedAt: Date.now() - 3 * MIN, durationMs: 21_000, eventCount: 1, exitCode: 0, signal: null, timedOut: false, ...overrides };
}

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
	return {
		id: "downloads-pdf-summary",
		paths: ["/Users/jeffrey/Downloads"],
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "search", "이 문서를 세 줄로 요약해서 같은 폴더에 저장해줘"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: run(),
		...overrides,
	};
}

/** Press the mouse on an element, the way a person does. */
function pressDown(element: Element | null | undefined): void {
	act(() => element?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
}

function click(element: Element | null | undefined): void {
	act(() => element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function labelledButton(name: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === name);
}

function textButton(label: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((element) => (element.textContent ?? "").trim() === label);
}

/** Every label/value pair on screen, as a person reads it. */
function value(label: string): string | undefined {
	const term = [...host.querySelectorAll("dt")].find((element) => element.textContent === label);
	return term?.nextElementSibling?.textContent ?? undefined;
}

describe("AutomationQuickLook", () => {
	it("shows the rule's trigger, whole instruction and folders under the panel's own name", () => {
		const shown = rule({ run: ["autorag", "search", "이 문서를 세 줄로 요약해서 같은 폴더에 저장해줘"] });
		act(() => root.render(<AutomationQuickLook rule={shown} onClose={noop} onEdit={noop} />));

		expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(ruleTitle(shown));
		expect(host.textContent).toContain(ruleTitle(shown));
		expect(value("언제")).toBe(triggerText(shown));
		expect(value("하는 일")).toBe(whatText(shown, { full: true }));
		expect(value("하는 일")).toBe("“이 문서를 세 줄로 요약해서 같은 폴더에 저장해줘”");
		expect(value("대상 폴더")).toBe("다운로드");
		expect(host.textContent).toContain("3분 전 실행 · 성공");
		expect(textButton("AI 검색에서 편집")).toBeDefined();
		expect(labelledButton("닫기")).toBeDefined();
	});

	it("keeps the folder's own row for a rule with several folders", () => {
		const shown = rule({ paths: ["/Users/jeffrey/Downloads", "/Users/jeffrey/Documents"] });
		act(() => root.render(<AutomationQuickLook rule={shown} onClose={noop} onEdit={noop} />));
		expect(value("대상 폴더")).toBe("다운로드, 문서");
		expect(value("언제")).not.toContain("다운로드");
	});

	it("closes from the toolbar button and from a press on the scrim", () => {
		const closes: number[] = [];
		act(() => root.render(<AutomationQuickLook rule={rule()} onClose={() => closes.push(1)} onEdit={noop} />));
		click(labelledButton("닫기"));
		pressDown(host.querySelector('[role="presentation"]'));
		expect(closes).toEqual([1, 1]);
	});

	it("survives a press inside the panel: only the scrim itself closes it", () => {
		const closes: number[] = [];
		act(() => root.render(<AutomationQuickLook rule={rule()} onClose={() => closes.push(1)} onEdit={noop} />));
		pressDown(host.querySelector('[role="dialog"]'));
		pressDown(host.querySelector("dl"));
		pressDown(labelledButton("닫기"));
		expect(closes).toEqual([]);
		pressDown(host.querySelector('[role="presentation"]'));
		expect(closes).toEqual([1]);
	});

	it("edits the rule from the toolbar pill", () => {
		const shown = rule();
		const edits: AutomationRule[] = [];
		act(() => root.render(<AutomationQuickLook rule={shown} onClose={noop} onEdit={(next) => edits.push(next)} />));
		click(textButton("AI 검색에서 편집"));
		expect(edits).toEqual([shown]);
	});

	it("reports a failed run with its reason, and a rule that never ran without one", () => {
		const failed = rule({ run: ["hwp5", "--to", "pdf"], include: ["**/*.hwp"], lastRun: run({ exitCode: null, error: "spawn hwp5 ENOENT" }) });
		act(() => root.render(<AutomationQuickLook rule={failed} onClose={noop} onEdit={noop} />));
		expect(host.textContent).toContain("3분 전 실행 · ‘hwp5’ 프로그램을 찾을 수 없음");

		act(() => root.render(<AutomationQuickLook rule={rule({ lastRun: null })} onClose={noop} onEdit={noop} />));
		expect(host.textContent).toContain("아직 실행되지 않았어요");
	});

	it("reads in English", async () => {
		await act(() => setAppLanguage("en"));
		const shown = rule({ run: ["autorag", "refresh"], include: ["**"] });
		act(() => root.render(<AutomationQuickLook rule={shown} onClose={noop} onEdit={noop} />));
		expect(value("When")).toBe(triggerText(shown));
		expect(value("Does")).toBe(whatText(shown, { full: true }));
		expect(value("Folders")).toBe("Downloads");
		expect(textButton("Edit in AI Search")).toBeDefined();
		expect(host.textContent).toContain("Ran 3 minutes ago · succeeded");
		expect(host.textContent).not.toContain("언제");
	});

	it("leaves no Korean behind in Japanese or Chinese", async () => {
		const shown = rule({ run: ["autorag", "refresh"], include: ["**"] });
		for (const language of ["ja", "zh"] as const) {
			await act(() => setAppLanguage(language));
			act(() => root.render(<AutomationQuickLook rule={shown} onClose={noop} onEdit={noop} />));
			expect(host.textContent).not.toMatch(/[가-힣]/);
			expect([...host.querySelectorAll("dt")].length).toBe(3);
		}
	});
});
