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
import type { AutomationRule, AutomationRun, AutomationsSnapshot } from "../src/shared/automation-contract";
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
	return [...host.querySelectorAll<HTMLElement>(".rule-row")].find((element) => (element.textContent ?? "").includes(title));
}

const section = (): Element | null => host.querySelector(".automation-section");

function menuItem(row: HTMLElement | undefined, name: string): HTMLButtonElement | undefined {
	return [...(row?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find((element) => element.textContent === name);
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
	const snapshot = (rules: readonly AutomationRule[], running = true): AutomationsSnapshot => ({
		ready: true,
		rules,
		daemon: { platform: "darwin", installed: true, running },
		configPath: "/Users/jeffrey/.autorag/automations.json",
		configError: null,
		error: null,
	});

	it("asks for a rule in the aside when it has no rules to report", () => {
		act(() => root.render(<AutomationInspector rule={null} onEdit={noop} onDelete={noop} />));
		expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe("정보 창");
		expect(text()).toContain("규칙을 선택하면\n요약이 여기에 표시됩니다.");
		expect(host.querySelectorAll("button").length).toBe(0);
	});

	it("shows recent activity with nothing picked: the count, the service, failures, and every last run newest first (Figma 611:3601)", () => {
		const ok = rule({ id: "pdf", lastRun: run({ startedAt: Date.now() - 60 * MIN }) });
		const failed = rule({ id: "hwp", run: ["hwp5"], include: ["**/*.hwp"], lastRun: run({ startedAt: Date.now() - 3 * MIN, timedOut: true }) });
		const fresh = rule({ id: "new", lastRun: null });
		const picked: string[] = [];
		act(() => root.render(<AutomationInspector rule={null} state={snapshot([ok, failed, fresh])} onEdit={noop} onDelete={noop} onSelect={(id) => picked.push(id)} />));
		expect(text()).toContain("규칙 3개 · 백그라운드에서 실행 중");
		expect(host.querySelector("[data-automation-failures]")?.textContent).toBe(`실패한 자동화 1개 — ${ruleTitle(failed)}`);
		const runs = [...host.querySelectorAll<HTMLElement>("[data-run-row]")];
		expect(runs.map((row) => row.dataset.runRow)).toEqual(["hwp", "pdf"]);
		expect(runs[0]?.textContent).toContain("시간 초과");
		click(runs[1]);
		expect(picked).toEqual(["pdf"]);
	});

	it("says the service is off and that nothing has run yet", () => {
		act(() => root.render(<AutomationInspector rule={null} state={snapshot([rule({ lastRun: null })], false)} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("규칙 1개 · 꺼짐");
		expect(text()).toContain("아직 실행 기록이 없습니다");
		expect(host.querySelector("[data-automation-failures]")).toBeNull();
	});

	it("shows a picked rule: its name, when it runs, what Dazzi does, its last run, 수정 and 삭제 (Figma 611:4443)", () => {
		const shown = rule({ run: [], agent: { profile: "file-triage", task: "핵심을 3줄로 요약해 줘" } });
		const edits: AutomationRule[] = [];
		const deletes: AutomationRule[] = [];
		act(() => root.render(<AutomationInspector rule={shown} onEdit={(next) => edits.push(next)} onDelete={(next) => deletes.push(next)} />));
		expect(host.querySelector("h2")?.textContent).toBe(ruleTitle(shown));
		expect(text()).toContain(whenText(shown));
		expect(text()).toContain(whatText(shown, { full: true }));
		expect(text()).toContain("읽기만 함");
		expect(host.querySelector("[data-run-row]")?.textContent).toContain("완료");
		click(button("수정"));
		click(button("삭제"));
		expect(edits).toEqual([shown]);
		expect(deletes).toEqual([shown]);
	});

	it("names what went wrong in the last run, and says a rule has not run yet before its first run", () => {
		const failed = rule({ run: ["hwp5", "--to", "pdf"], include: ["**/*.hwp"], lastRun: run({ exitCode: null, error: "spawn hwp5 ENOENT" }) });
		act(() => root.render(<AutomationInspector rule={failed} onEdit={noop} onDelete={noop} />));
		expect(host.querySelector("[data-run-row]")?.textContent).toContain("‘hwp5’ 프로그램을 찾을 수 없음");
		act(() => root.render(<AutomationInspector rule={rule({ lastRun: null })} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain("아직 실행되지 않았습니다");
	});

	it("reads in English", async () => {
		await act(() => setAppLanguage("en"));
		const shown = rule();
		act(() => root.render(<AutomationInspector rule={shown} onEdit={noop} onDelete={noop} />));
		expect(text()).toContain(whenText(shown));
		expect(text()).toContain("What Dazzi does");
		expect(button("Edit")).toBeDefined();
		expect(button("Delete")).toBeDefined();
		expect(text()).not.toMatch(/[가-힣]/);
	});

	it("leaves no Korean behind in Japanese or Chinese", async () => {
		const shown = rule({ run: ["autorag", "refresh"], include: ["**"], exclude: [] });
		for (const language of ["ja", "zh"] as const) {
			await act(() => setAppLanguage(language));
			act(() => root.render(<AutomationInspector rule={null} state={snapshot([shown])} onEdit={noop} onDelete={noop} />));
			expect(text()).not.toMatch(/[가-힣]/);
			act(() => root.render(<AutomationInspector rule={shown} onEdit={noop} onDelete={noop} />));
			expect(text()).not.toMatch(/[가-힣]/);
		}
	});
});

describe("AutomationRulesSection", () => {
	it("renders nothing when the folder has no rules", () => {
		act(() => root.render(<AutomationRulesSection rules={[]} onEdit={noop} onDelete={noop} />));
		expect(text()).toBe("");
	});

	it("lists one card per rule under 자동화, with its last run", () => {
		const first = rule();
		const second = rule({ id: "hwp-to-pdf", paths: ["/Users/jeffrey/Desktop"], include: ["**/*.hwp"], run: ["hwp5", "--to", "pdf"], lastRun: null });
		act(() => root.render(<AutomationRulesSection rules={[first, second]} onEdit={noop} onDelete={noop} />));

		expect(section()?.querySelector(".section-title")?.textContent).toBe("자동화");
		expect(host.querySelectorAll(".rule-row")).toHaveLength(2);
		expect(text()).toContain(ruleTitle(first));
		expect(text()).toContain(lastRunText(first));
		expect(text()).toContain(lastRunText(second));
	});

	it("opens 수정하기 / 삭제하기 from a card's ⋯ button, and each runs once and closes the menu", () => {
		const shown = rule();
		const edits: AutomationRule[] = [];
		const deletes: AutomationRule[] = [];
		act(() => root.render(<AutomationRulesSection rules={[shown]} onEdit={(next) => edits.push(next)} onDelete={(next) => deletes.push(next)} />));

		const row = ruleRow(ruleTitle(shown));
		const more = ariaButton("더보기");
		expect(row?.contains(more ?? null)).toBe(true);
		expect(host.querySelector('[role="menu"]')).toBeNull();

		click(row);
		expect(host.querySelector('[role="menu"]')).toBeNull();
		expect(edits).toEqual([]);

		click(more);
		expect(more?.getAttribute("aria-expanded")).toBe("true");
		expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["수정", "삭제"]);
		click(menuItem(row, "수정"));
		expect(edits).toEqual([shown]);
		expect(host.querySelector('[role="menu"]')).toBeNull();

		click(more);
		click(menuItem(row, "삭제"));
		expect(deletes).toEqual([shown]);
		expect(edits).toEqual([shown]);
	});

	it("closes the ⋯ menu on Escape", () => {
		act(() => root.render(<AutomationRulesSection rules={[rule()]} onEdit={noop} onDelete={noop} />));
		click(ariaButton("더보기"));
		expect(host.querySelector('[role="menu"]')).not.toBeNull();
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(host.querySelector('[role="menu"]')).toBeNull();
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
		expect(section()?.querySelector(".section-title")?.textContent).toBe("Automations");
		click(ariaButton("More"));
		expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Edit", "Delete"]);
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

		expect(section()).not.toBeNull();
		expect(text()).toContain(ruleTitle(parentRule));
		expect(text()).not.toContain(ruleTitle(elsewhere));

		const row = ruleRow(ruleTitle(parentRule));
		click(row?.querySelector('button[aria-label="더보기"]'));
		click(menuItem(row, "수정"));
		expect(edits).toEqual([parentRule]);
	});

	it("shows no section for a folder nothing watches, or when the app passes no rules", () => {
		const elsewhere = rule({ id: "hwp-to-pdf", paths: ["/Users/jeffrey/Desktop"], include: ["**/*.hwp"], run: ["hwp5", "--to", "pdf"] });
		act(() => root.render(inspector(folder("/Users/jeffrey/Downloads"), { rules: [elsewhere], onEdit: noop, onDelete: noop })));
		expect(section()).toBeNull();

		act(() => root.render(inspector(folder("/Users/jeffrey/Downloads"))));
		expect(section()).toBeNull();
	});

	it("keeps the file inspector free of the rules section", () => {
		act(() => root.render(inspector(file("/Users/jeffrey/Downloads/report.pdf"), { rules: [rule()], onEdit: noop, onDelete: noop })));
		expect(text()).toContain("report.pdf");
		expect(section()).toBeNull();
	});

	it("shows the folder in view without a Trash chip and without dashes for what it does not know, and still lists its rules", () => {
		const watching = rule();
		const entry = { ...folder("/Users/jeffrey/Downloads"), mtimeMs: Number.NaN };
		act(() => root.render(inspector(entry, { rules: [watching], onEdit: noop, onDelete: noop }, { folderInView: true })));

		expect(section()).not.toBeNull();
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
