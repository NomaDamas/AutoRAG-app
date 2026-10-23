// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationInspector } from "../src/renderer/src/components/AutomationInspector";
import { AutomationRulesSection } from "../src/renderer/src/components/AutomationRulesSection";
import { Inspector } from "../src/renderer/src/components/Inspector";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { actionShort, lastRunText, ruleTitle, whatText, whenText } from "../src/renderer/src/state/automations";
import { kindLabelOf } from "../src/renderer/src/state/entry-values";
import { NO_CAPABILITIES } from "../src/shared/actions-contract";
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
		run: ["autorag", "search", "Summarize the document"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: run(),
		...overrides,
	};
}

function text(): string {
	return host.textContent ?? "";
}

/** The visible-text button a person clicks; `label` is exactly what it reads. */
function button(label: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((element) => (element.textContent ?? "").trim() === label);
}

/** An icon-only control, named by its aria-label (and tooltip). */
function ariaButton(name: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === name);
}

function click(element: Element | null | undefined): void {
	act(() => element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function press(element: Element | null | undefined, key: string): void {
	act(() => element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

/** Every label/value pair on screen, as a person reads it. */
function facts(): Array<[string, string]> {
	return [...host.querySelectorAll("dt")].map((term) => [term.textContent ?? "", term.parentElement?.querySelector("dd")?.textContent ?? ""]);
}

function value(label: string): string | undefined {
	return facts().find(([term]) => term === label)?.[1];
}

/** The rules section's row for a rule, found by the title it shows. */
function ruleRow(title: string): HTMLElement | undefined {
	return [...host.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => (element.textContent ?? "").includes(title));
}

function inspector(
	entry: FinderEntry,
	automations?: { rules: readonly AutomationRule[]; onEdit: (rule: AutomationRule) => void; onDelete: (rule: AutomationRule) => void },
	extra: { readonly folderInView?: boolean } = {},
): React.ReactElement {
	return (
		<Inspector
			entry={entry}
			entries={[entry]}
			indexStatus={null}
			onToggleIndex={noop}
			onTrash={noop}
			onCopyPath={noop}
			onAskAi={noop}
			actionCapabilities={NO_CAPABILITIES}
			onAction={noop}
			loadOpenWithApplications={async () => []}
			family={null}
			onOpenMember={noop}
			view="info"
			evidence={[]}
			evidenceSelected={0}
			onSelectEvidence={noop}
			onRevealPath={noop}
			onToast={noop}
			imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
			{...(automations === undefined ? {} : { automations })}
			{...extra}
		/>
	);
}

function folder(path: string): FinderEntry {
	return { name: path.split("/").pop() ?? path, path, kind: "folder", ext: "", size: null, mtimeMs: 1_700_000_000_000, birthtimeMs: 0 };
}

function file(path: string): FinderEntry {
	return { name: path.split("/").pop() ?? path, path, kind: "file", ext: "pdf", size: 1024, mtimeMs: 1_700_000_000_000, birthtimeMs: 0 };
}

describe("AutomationInspector", () => {
	it("asks for a rule in the aside and in the empty body", () => {
		act(() => root.render(<AutomationInspector rule={null} onEdit={noop} onDelete={noop} />));
		expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe("정보 창");
		expect(text()).toContain("규칙을 선택하면\n요약이 여기에 표시됩니다.");
		expect(host.querySelectorAll("dl").length).toBe(0);
		expect(host.querySelectorAll("button").length).toBe(0);
	});

	it("summarizes the rule: flow, title, last run, chips and the when/what rows", () => {
		const shown = rule();
		act(() => root.render(<AutomationInspector rule={shown} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("다운로드");
		expect(text()).toContain(actionShort(shown));
		expect(text()).toContain(ruleTitle(shown));
		expect(text()).toContain("3분 전 실행 · 성공");
		expect(button("AI로 편집")).toBeDefined();
		expect(button("삭제")).toBeDefined();
		expect(text()).toContain("요약");
		expect(value("언제")).toBe(whenText(shown));
		expect(value("하는 일")).toBe(whatText(shown));
		expect(value("문제")).toBeUndefined();
	});

	it("names what went wrong when the last run failed", () => {
		const failed = rule({ run: ["hwp5", "--to", "pdf"], include: ["**/*.hwp"], lastRun: run({ exitCode: null, error: "spawn hwp5 ENOENT" }) });
		act(() => root.render(<AutomationInspector rule={failed} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("3분 전 실행 · 실패");
		expect(button("hwp5 실행")).toBeUndefined();
		expect(value("문제")).toBe("‘hwp5’ 프로그램을 찾을 수 없음");
		expect(text()).toContain(ruleTitle(failed));
	});

	it("says a rule has not run yet before its first run", () => {
		const fresh = rule({ lastRun: null });
		act(() => root.render(<AutomationInspector rule={fresh} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("아직 실행되지 않았어요");
		expect(value("문제")).toBeUndefined();
	});

	it("hides the machine rows behind 전체 정보, folds them back, and folds them again when the rule changes", () => {
		const first = rule();
		act(() => root.render(<AutomationInspector rule={first} onEdit={noop} onDelete={noop} />));
		expect(value("감시 폴더")).toBeUndefined();
		expect(value("규칙 ID")).toBeUndefined();

		click(button("전체 정보"));
		expect(button("간략히")).toBeDefined();
		expect(value("감시 폴더")).toBe("/Users/jeffrey/Downloads");
		expect(value("파일 패턴")).toBe("**/*.pdf");
		expect(value("제외")).toBe("없음");
		expect(value("명령")).toBe("autorag search Summarize the document");
		expect(value("규칙 ID")).toBe("downloads-pdf-summary");

		click(button("간략히"));
		expect(value("감시 폴더")).toBeUndefined();
		click(button("전체 정보"));

		const second = rule({
			id: "hwp-to-pdf",
			paths: ["/Users/jeffrey/Desktop", "/Users/jeffrey/Documents"],
			include: ["**/*.hwp", "**/*.hwpx"],
			exclude: ["**/archive/**"],
			run: ["hwp5", "--to", "pdf"],
		});
		act(() => root.render(<AutomationInspector rule={second} onEdit={noop} onDelete={noop} />));
		expect(button("전체 정보")).toBeDefined();
		expect(value("감시 폴더")).toBeUndefined();

		click(button("전체 정보"));
		expect(value("감시 폴더")).toBe("/Users/jeffrey/Desktop\n/Users/jeffrey/Documents");
		expect(value("파일 패턴")).toBe("**/*.hwp, **/*.hwpx");
		expect(value("제외")).toBe("**/archive/**");
	});

	it("shows an AI rule's access in the summary, and its profile instead of an empty command", () => {
		const reader = rule({ run: [], agent: { profile: "file-triage", task: "Summarize each new PDF in three lines" } });
		act(() => root.render(<AutomationInspector rule={reader} onEdit={noop} onDelete={noop} />));
		expect(value("하는 일")).toBe(whatText(reader));
		expect(value("AI 권한")).toBe("읽기만 함");

		click(button("전체 정보"));
		expect(value("명령")).toBeUndefined();
		expect(value("AI 프로필")).toBe("file-triage");

		const writer = rule({ run: [], agent: { profile: "file-organizer", task: "Move each new PDF into a folder" } });
		act(() => root.render(<AutomationInspector rule={writer} onEdit={noop} onDelete={noop} />));
		expect(value("AI 권한")).toBe("파일을 바꿀 수 있음");
	});

	it("does not show AI rows for a rule that runs a command", () => {
		act(() => root.render(<AutomationInspector rule={rule()} onEdit={noop} onDelete={noop} />));
		click(button("전체 정보"));
		expect(value("AI 권한")).toBeUndefined();
		expect(value("AI 프로필")).toBeUndefined();
		expect(value("명령")).toBe("autorag search Summarize the document");
	});

	it("edits and deletes through the chips", () => {
		const shown = rule();
		const edits: AutomationRule[] = [];
		const deletes: AutomationRule[] = [];
		act(() => root.render(<AutomationInspector rule={shown} onEdit={(next) => edits.push(next)} onDelete={(next) => deletes.push(next)} />));
		click(button("AI로 편집"));
		click(button("삭제"));
		expect(edits).toEqual([shown]);
		expect(deletes).toEqual([shown]);
	});

	it("reads in English, and follows the language back to Korean", async () => {
		await act(() => setAppLanguage("en"));
		const shown = rule();
		act(() => root.render(<AutomationInspector rule={shown} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("Downloads");
		expect(text()).toContain("Ran 3 minutes ago · succeeded");
		expect(button("Edit with AI")).toBeDefined();
		expect(button("Delete")).toBeDefined();
		expect(value("When")).toBe(whenText(shown));
		expect(value("Does")).toBe(whatText(shown));
		expect(text()).not.toContain("언제");

		await act(() => setAppLanguage("ko"));
		expect(value("언제")).toBe(whenText(shown));
		expect(button("전체 정보")).toBeDefined();
	});

	it("leaves no Korean behind in Japanese or Chinese", async () => {
		const shown = rule({ run: ["autorag", "refresh"], include: ["**"], exclude: [] });
		for (const language of ["ja", "zh"] as const) {
			await act(() => setAppLanguage(language));
			act(() => root.render(<AutomationInspector rule={shown} onEdit={noop} onDelete={noop} />));
			click(button(language === "ja" ? "すべて表示" : "全部信息"));
			expect(text()).not.toMatch(/[가-힣]/);
			expect(host.querySelectorAll("dt").length).toBeGreaterThan(0);
		}
	});
});

describe("AutomationRulesSection", () => {
	it("renders nothing when the folder has no rules", () => {
		act(() => root.render(<AutomationRulesSection rules={[]} onEdit={noop} onDelete={noop} />));
		expect(text()).toBe("");
	});

	it("lists one row per rule, with the count, its last run, and opens the rule on click or a key", () => {
		const first = rule();
		const second = rule({ id: "hwp-to-pdf", paths: ["/Users/jeffrey/Desktop"], include: ["**/*.hwp"], run: ["hwp5", "--to", "pdf"], lastRun: null });
		const rules = [first, second];
		const edits: AutomationRule[] = [];
		act(() => root.render(<AutomationRulesSection rules={rules} onEdit={(next) => edits.push(next)} onDelete={noop} />));

		expect(text()).toContain("이 폴더의 자동화");
		expect([...host.querySelectorAll("span")].some((element) => element.textContent === "2")).toBe(true);
		expect(text()).toContain(ruleTitle(first));
		expect(text()).toContain(lastRunText(first));
		expect(text()).toContain(lastRunText(second));

		const row = ruleRow(ruleTitle(first));
		expect(row).toBeDefined();
		expect(row?.getAttribute("tabindex")).toBe("0");

		click(row);
		press(row, "Enter");
		press(row, " ");
		expect(edits).toEqual([first, first, first]);
	});

	it("edits or deletes from a row's icon buttons without opening the rule", () => {
		const shown = rule();
		const edits: AutomationRule[] = [];
		const deletes: AutomationRule[] = [];
		act(() => root.render(<AutomationRulesSection rules={[shown]} onEdit={(next) => edits.push(next)} onDelete={(next) => deletes.push(next)} />));

		const row = ruleRow(ruleTitle(shown));
		const edit = ariaButton("AI로 편집");
		const remove = ariaButton("삭제");
		expect(edit).toBeDefined();
		expect(remove).toBeDefined();
		expect(edit?.title).toBe("AI로 편집");
		expect(remove?.title).toBe("삭제");
		expect(row?.contains(edit ?? null)).toBe(true);
		expect(row?.contains(remove ?? null)).toBe(true);

		click(edit);
		expect(edits).toEqual([shown]);
		expect(deletes).toEqual([]);

		click(remove);
		expect(edits).toEqual([shown]);
		expect(deletes).toEqual([shown]);
	});

	it("asks for the rule's menu at the pointer on right click, and does not edit", () => {
		const shown = rule();
		const menus: Array<{ rule: AutomationRule; at: { x: number; y: number } }> = [];
		const edits: AutomationRule[] = [];
		act(() => root.render(<AutomationRulesSection rules={[shown]} onEdit={(next) => edits.push(next)} onDelete={noop} onMenu={(next, at) => menus.push({ rule: next, at })} />));
		const row = ruleRow(ruleTitle(shown));
		const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
		act(() => {
			row?.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		expect(menus).toEqual([{ rule: shown, at: { x: 12, y: 34 } }]);
		expect(edits).toEqual([]);
	});
	it("reads in English", async () => {
		await act(() => setAppLanguage("en"));
		const shown = rule();
		act(() => root.render(<AutomationRulesSection rules={[shown]} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("Automations on this folder");
		expect(ariaButton("Edit with AI")).toBeDefined();
		expect(ariaButton("Delete")).toBeDefined();
	});
});

describe("Inspector's folder automations", () => {
	it("lists the rules that watch the folder, including one watching a parent", () => {
		const parentRule = rule();
		const elsewhere = rule({ id: "hwp-to-pdf", paths: ["/Users/jeffrey/Desktop"], include: ["**/*.hwp"], run: ["hwp5", "--to", "pdf"] });
		const edits: AutomationRule[] = [];
		act(() =>
			root.render(
				inspector(folder("/Users/jeffrey/Downloads/2026"), { rules: [parentRule, elsewhere], onEdit: (next) => edits.push(next), onDelete: noop }),
			),
		);

		expect(text()).toContain("이 폴더의 자동화");
		expect(text()).toContain(ruleTitle(parentRule));
		expect(text()).not.toContain(ruleTitle(elsewhere));

		click(ruleRow(ruleTitle(parentRule)));
		expect(edits).toEqual([parentRule]);
	});

	it("shows no section for a folder nothing watches, or when the app passes no rules", () => {
		const elsewhere = rule({ id: "hwp-to-pdf", paths: ["/Users/jeffrey/Desktop"], include: ["**/*.hwp"], run: ["hwp5", "--to", "pdf"] });
		act(() => root.render(inspector(folder("/Users/jeffrey/Downloads"), { rules: [elsewhere], onEdit: noop, onDelete: noop })));
		expect(text()).not.toContain("이 폴더의 자동화");

		act(() => root.render(inspector(folder("/Users/jeffrey/Downloads"))));
		expect(text()).not.toContain("이 폴더의 자동화");
	});

	it("keeps the file inspector free of the rules section", () => {
		act(() => root.render(inspector(file("/Users/jeffrey/Downloads/report.pdf"), { rules: [rule()], onEdit: noop, onDelete: noop })));
		expect(text()).toContain("report.pdf");
		expect(text()).not.toContain("이 폴더의 자동화");
	});

	it("shows the folder in view without a Trash chip and without dashes for what it does not know, and still lists its rules", () => {
		const watching = rule();
		const entry = { ...folder("/Users/jeffrey/Downloads"), mtimeMs: Number.NaN };
		act(() => root.render(inspector(entry, { rules: [watching], onEdit: noop, onDelete: noop }, { folderInView: true })));

		expect(text()).toContain("이 폴더의 자동화");
		expect(text()).toContain(ruleTitle(watching));
		expect(button("휴지통")).toBeUndefined();
		expect(button("경로 복사")).toBeDefined();
		expect(host.querySelector(".preview-sub")?.textContent).toBe(kindLabelOf(entry));
	});

	it("keeps the Trash chip and the full subtitle for a folder that is selected", () => {
		act(() => root.render(inspector(folder("/Users/jeffrey/Downloads"), { rules: [rule()], onEdit: noop, onDelete: noop })));
		expect(button("휴지통")).toBeDefined();
		expect(host.querySelector(".preview-sub")?.textContent).toContain("·");
	});
});
