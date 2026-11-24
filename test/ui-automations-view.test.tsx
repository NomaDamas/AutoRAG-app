// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsView, type AutomationsViewProps } from "../src/renderer/src/components/AutomationsView";
import type { AutomationRule, AutomationRun, AutomationsSnapshot } from "../src/shared/automation-contract";
import type { FsLocation } from "../src/shared/fs-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const place = (name: string, path: string, icon: FsLocation["icon"]): FsLocation => ({ name, path, section: "favorites", icon, available: true, scanned: true }) as FsLocation;
const runLogs: Record<string, readonly AutomationRun[]> = {};
Reflect.set(globalThis, "autorag", {
	automations: { history: async (id: string): Promise<readonly AutomationRun[]> => runLogs[id] ?? [] },
	fs: {
		locations: async (): Promise<readonly FsLocation[]> => [
			place("Desktop", "/Users/jeffrey/Desktop", "desktop"),
			place("Documents", "/Users/jeffrey/Documents", "documents"),
			place("Downloads", "/Users/jeffrey/Downloads", "downloads"),
		],
	},
});

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

const NOW = Date.now();

function rule(id: string, overrides: Partial<AutomationRule> = {}): AutomationRule {
	return {
		id,
		paths: ["/Users/jeffrey/Downloads"],
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "search", "요약해줘"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: { startedAt: NOW - 3 * 60_000, durationMs: 1000, eventCount: 1, exitCode: 0, signal: null, timedOut: false },
		...overrides,
	};
}

const failing = rule("hwp-to-pdf", {
	include: ["**/*.hwp"],
	run: ["hwp5", "--to", "pdf"],
	lastRun: { startedAt: NOW - 19 * 3_600_000, durationMs: 800, eventCount: 1, exitCode: null, signal: null, timedOut: false, error: "spawn hwp5 ENOENT" },
});
const never = rule("screens", { paths: ["/Users/jeffrey/Desktop"], include: ["Screen Shot*.png"], lastRun: null });

function state(rules: readonly AutomationRule[], overrides: Partial<AutomationsSnapshot> = {}): AutomationsSnapshot {
	return {
		ready: true,
		rules,
		daemon: { platform: "darwin", installed: true, running: true },
		configPath: "/Users/jeffrey/.autorag/automations.json",
		configError: null,
		error: null,
		...overrides,
	};
}

function props(overrides: Partial<AutomationsViewProps> = {}): AutomationsViewProps {
	return {
		state: state([rule("downloads-pdf-summary"), failing, never]),
		daemonBusy: false,
		selectedId: null,
		onSelect: vi.fn(),
		onEdit: vi.fn(),
		onAdd: vi.fn(),
		onCreate: vi.fn(async () => true),
		onPreview: vi.fn(),
		onAskDelete: vi.fn(),
		onSetDaemon: vi.fn(),
		onContextMenu: vi.fn(),
		onOpenFolder: vi.fn(),
		...overrides,
	};
}

function render(p: AutomationsViewProps): void {
	act(() => root.render(<AutomationsView {...p} />));
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function type(element: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	setter?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

const click = (element: Element | null | undefined): void => {
	act(() => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="row"][data-rule-id]')];
const text = (element: Element | null | undefined): string => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("AutomationsView list", () => {
	it("lists every rule under 내 자동화 as its name over when it runs", () => {
		render(props());
		expect(rows().map((row) => row.dataset.ruleId)).toEqual(["downloads-pdf-summary", "hwp-to-pdf", "screens"]);
		const first = rows()[0];
		expect(text(first)).toContain("새 PDF → Dazzi에게 맡기기");
		expect(text(first)).toContain("다운로드에 PDF 파일이 새로 생기면");
		expect(text(rows()[2])).toContain("데스크탑");
	});

	it("marks the selected row and tells a failed rule apart from a good one and one that never ran", () => {
		render(props({ selectedId: "hwp-to-pdf" }));
		expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
		const tones = rows().map((row) => row.querySelector("[data-run-tone]")?.getAttribute("data-run-tone"));
		expect(tones).toEqual(["ok", "fail", "never"]);
	});

	it("names its sections in the interface language, with the 새 자동화 card folded into one line while there are rules", async () => {
		await setAppLanguage("en");
		render(props());
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["My Automations", "Suggested Automations"]);
		expect(text(host.querySelector('[data-action="automation-composer-open"]'))).toBe("New automation");
		expect([...host.querySelectorAll('[data-automation-tabs] [role="tab"]')].map((tab) => tab.textContent)).toEqual(["Automations", "All runs"]);
	});

	it("says how each rule's last run went, beside its name (Figma 621:4556)", () => {
		render(props());
		expect(rows().map((row) => text(row.querySelector("[data-rule-last-run]")))).toEqual(["3분 전 · 성공", "19시간 전 · 실패", "아직 실행되지 않음"]);
	});

	it("counts its rules in a wording that reads right for one and for many", async () => {
		await setAppLanguage("en");
		const footerText = (rules: readonly AutomationRule[]): string => {
			render(props({ state: state(rules) }));
			return host.querySelector("[data-daemon]")?.textContent ?? "";
		};
		expect(footerText([rule("a")])).toContain("Rules: 1");
		expect(footerText([rule("a"), rule("b"), rule("c")])).toContain("Rules: 3");
	});
});

describe("AutomationsView interaction", () => {
	it("opens a rule's page on click, and opens the menu on right click", () => {
		const p = props();
		render(p);
		act(() => rows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(p.onSelect).toHaveBeenCalledWith("hwp-to-pdf");
		expect(p.onEdit).toHaveBeenCalledWith("hwp-to-pdf");
		act(() => rows()[0]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 50 })));
		expect(p.onContextMenu).toHaveBeenCalledWith("downloads-pdf-summary", { x: 40, y: 50 });
	});

	it("opens the menu with no rule on the empty space below the rows", () => {
		const p = props();
		render(p);
		act(() => host.querySelector('[data-rules-body]')?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 8 })));
		expect(p.onContextMenu).toHaveBeenCalledWith(null, { x: 9, y: 8 });
	});

	it("keeps the selected row in view", () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
		render(props({ selectedId: "screens" }));
		expect(scrollIntoView).toHaveBeenCalled();
		Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	});
});

describe("AutomationsView background service line", () => {
	const bar = (): HTMLElement | null => host.querySelector("[data-daemon]");

	it("says rules are running and counts them, and offers to turn the service off", () => {
		const p = props();
		render(p);
		expect(text(bar())).toContain("백그라운드에서 실행 중");
		expect(text(bar())).toContain("규칙 3개");
		act(() => bar()?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(p.onSetDaemon).toHaveBeenCalledWith(false);
	});

	it("says nothing runs when the service is off, and offers to turn it on", () => {
		const p = props({ state: state([rule("a")], { daemon: { platform: "darwin", installed: false, running: false } }) });
		render(p);
		expect(text(bar())).toContain("꺼짐 · 규칙이 실행되지 않습니다");
		expect(bar()?.querySelector("button")?.textContent).toBe("켜기");
		act(() => bar()?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(p.onSetDaemon).toHaveBeenCalledWith(true);
	});

	it("turns a registered but stopped service on again instead of calling it off", () => {
		render(props({ state: state([rule("a")], { daemon: { platform: "darwin", installed: true, running: false } }) }));
		expect(text(bar())).toContain("꺼짐");
	});

	it("disables the switch while it is being changed", () => {
		render(props({ daemonBusy: true }));
		const button = bar()?.querySelector("button");
		expect(button?.disabled).toBe(true);
		expect(button?.textContent).toBe("처리 중…");
	});

	it("does not claim either state while the daemon is unknown", () => {
		render(props({ state: state([rule("a")], { daemon: null }) }));
		expect(text(bar())).toContain("백그라운드 실행 상태를 확인할 수 없습니다");
		expect(bar()?.querySelector("button")).toBeNull();
	});

	it("shows no service line at all for a user with no rules file, where there is nothing to run", () => {
		render(props({ state: state([], { daemon: null }) }));
		expect(bar()).toBeNull();
		expect(host.querySelector('[data-testid="automation-new"]')).not.toBeNull();
	});
});

describe("AutomationsView empty and error states", () => {
	it("offers the 새 자동화 card and 추천 자동화 but no 내 자동화 list when there are no rules", () => {
		render(props({ state: state([]) }));
		expect(rows()).toEqual([]);
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["새 자동화", "추천 자동화"]);
	});

	it("shows nothing but the frame before the first read finishes, instead of a false empty list", () => {
		render(props({ state: { ...state([]), ready: false } }));
		expect(host.querySelector('[data-testid="automation-new"]')).toBeNull();
	});

	it("says when the rules file cannot be read and shows the reason, not an empty list", () => {
		render(props({ state: state([], { configError: "Unknown field \"note\" in automations[1]" }) }));
		expect(text(host)).toContain("규칙 파일을 읽을 수 없습니다");
		expect(text(host)).toContain("Unknown field \"note\" in automations[1]");
		expect(text(host)).not.toContain("아직 자동화가 없습니다");
	});

	it("shows a read failure beside the rules it kept", () => {
		render(props({ state: state([rule("a")], { error: "자동화 상태를 확인하지 못했습니다: boom" }) }));
		expect(rows()).toHaveLength(1);
		// The reason stays behind 자세히 보기; the card says what happened and offers 다시 확인 and AI로 해결하기.
		expect(text(host)).toContain("자동화 상태를 확인하지 못했습니다");
		expect(text(host)).not.toContain("boom");
		expect(text(host)).toContain("AI로 해결하기");
		const details = [...host.querySelectorAll("button")].find((button) => button.textContent === "자세히 보기");
		click(details);
		expect(text(host)).toContain("자동화 상태를 확인하지 못했습니다: boom");
	});

	it("reads the status again from the failure card's 다시 확인", () => {
		const onRetryStatus = vi.fn();
		render(props({ state: state([rule("a")], { error: "자동화 상태를 확인하지 못했습니다: boom" }), onRetryStatus }));
		const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "다시 확인");
		click(retry);
		expect(onRetryStatus).toHaveBeenCalledTimes(1);
	});
});

describe("AutomationsView a rule's own page (Figma 621:4882)", () => {
	const page = (): HTMLElement | null => host.querySelector("[data-automation-detail]");
	const titleInput = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>('[data-testid="automation-title-input"]');
	const editing = rule("pdf", { run: [], agent: { profile: "file-organizer", task: "메모로 남겨 줘" }, paths: ["/Users/jeffrey/Desktop"], include: ["**/*.pdf"], events: ["create", "update"] });

	it("shows the rule in place of the list: back, its name with a pencil, 설정 and 실행 기록", async () => {
		const onCancelEdit = vi.fn();
		render(props({ editing, onCancelEdit }));
		await settle();
		expect(page()?.dataset.automationDetail).toBe("pdf");
		expect(rows()).toEqual([]);
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["설정", "실행 기록 (1)"]);
		const name = host.querySelector('[data-action="automation-rename"]');
		expect(name?.getAttribute("title")).toBe("이름 바꾸기");
		expect(name?.querySelector("svg")).not.toBeNull();
		click(host.querySelector('[data-action="automation-back"]'));
		expect(onCancelEdit).toHaveBeenCalledTimes(1);
	});

	it("renames from the title: a click makes it a field, Enter keeps the new name, Escape keeps the old one", async () => {
		const onRename = vi.fn(async () => undefined);
		render(props({ editing, onRename }));
		await settle();
		click(host.querySelector('[data-action="automation-rename"]'));
		expect(titleInput()?.placeholder).toBe("바뀐 PDF → AI가 처리하기");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(titleInput(), "PDF 3줄 요약");
			titleInput()?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => titleInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onRename).toHaveBeenCalledWith("pdf", "PDF 3줄 요약");
		expect(titleInput()).toBeNull();
		click(host.querySelector('[data-action="automation-rename"]'));
		act(() => titleInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(onRename).toHaveBeenCalledTimes(1);
	});

	it("lets the rule's page be changed at once, with 삭제 beside 저장, and saves with the rule's id", async () => {
		const onUpdate = vi.fn(async () => true);
		const p = props({ editing, onUpdate });
		render(p);
		await settle();
		const task = (): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>('[data-testid="automation-new-task"]');
		const save = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[data-action="automation-update"]');
		expect(task()?.value).toBe("메모로 남겨 줘");
		// No 수정 step: the fields are open, 저장 waits for a change, and 취소 is not there yet.
		expect(task()?.readOnly).toBe(false);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="automation-new-folder"]')?.disabled).toBe(false);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="automation-new-mode"]')?.disabled).toBe(false);
		expect(host.querySelector('[data-action="automation-edit"]')).toBeNull();
		expect(host.querySelector('[data-action="automation-cancel-edit"]')).toBeNull();
		expect(save()?.textContent).toBe("저장");
		expect(save()?.disabled).toBe(true);
		click(host.querySelector('[data-action="automation-delete"]'));
		expect(p.onAskDelete).toHaveBeenCalledWith("pdf");
		act(() => type(task() as HTMLTextAreaElement, "메모로 남겨 줘!"));
		expect(host.querySelector('[data-action="automation-cancel-edit"]')?.textContent).toBe("취소");
		expect(save()?.disabled).toBe(false);
		await act(async () => {
			save()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(onUpdate).toHaveBeenCalledWith("pdf", { paths: ["/Users/jeffrey/Desktop"], events: ["create", "update"], include: ["**/*.pdf"], agent: { profile: "file-organizer", task: "메모로 남겨 줘!" } });
		// Saved: nothing differs any more.
		expect(host.querySelector('[data-action="automation-cancel-edit"]')).toBeNull();
		expect(save()?.disabled).toBe(true);
	});

	it("puts the rule back on 취소 and stays on its page", async () => {
		const onCancelEdit = vi.fn();
		render(props({ editing, onCancelEdit }));
		await settle();
		const task = (): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>('[data-testid="automation-new-task"]');
		act(() => type(task() as HTMLTextAreaElement, "다른 일"));
		expect(task()?.value).toBe("다른 일");
		click(host.querySelector('[data-action="automation-cancel-edit"]'));
		expect(task()?.value).toBe("메모로 남겨 줘");
		expect(host.querySelector('[data-action="automation-cancel-edit"]')).toBeNull();
		expect(onCancelEdit).not.toHaveBeenCalled();
		expect(page()?.dataset.automationDetail).toBe("pdf");
	});

	it("keeps files and changes the chips cannot say", async () => {
		const odd = rule("odd", { run: [], agent: { profile: "file-triage", task: "t" }, include: ["**/*.hwp"], events: ["create", "update", "delete"] });
		const onUpdate = vi.fn(async () => true);
		render(props({ editing: odd, onUpdate }));
		await settle();
		act(() => type(host.querySelector<HTMLTextAreaElement>('[data-testid="automation-new-task"]') as HTMLTextAreaElement, "t2"));
		await act(async () => {
			host.querySelector('[data-action="automation-update"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(onUpdate).toHaveBeenCalledWith("odd", expect.objectContaining({ include: ["**/*.hwp"], events: ["create", "update", "delete"] }));
	});

	it("lists the rule's runs from its log, newest first, with the error a failed run left", async () => {
		runLogs.pdf = [
			{ startedAt: NOW - 60_000, durationMs: 120_000, eventCount: 1, exitCode: null, signal: null, timedOut: true },
			{ startedAt: NOW - 2 * 3_600_000, durationMs: 900, eventCount: 2, exitCode: null, signal: null, timedOut: false, error: "spawn hwp5 ENOENT" },
			{ startedAt: NOW - 26 * 3_600_000, durationMs: 900, eventCount: 3, exitCode: 0, signal: null, timedOut: false },
		];
		render(props({ editing }));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["설정", "실행 기록 (3)"]);
		const runs = [...host.querySelectorAll("[data-run]")];
		expect(runs.map((run) => run.querySelector("[data-run-tone]")?.getAttribute("data-run-tone"))).toEqual(["fail", "fail", "ok"]);
		expect(text(runs[0])).toContain("파일 1개시간 초과");
		expect(text(runs[1])).toContain("spawn hwp5 ENOENT");
		expect(text(runs[2])).toContain("파일 3개완료");
		Reflect.deleteProperty(runLogs, "pdf");
	});
});

describe("AutomationsView 전체 기록 (Figma 621:5262)", () => {
	it("lists every rule's runs newest first, keeps only failures on 실패만 보기, and opens a rule from its run", async () => {
		runLogs["downloads-pdf-summary"] = [{ startedAt: NOW - 3 * 60_000, durationMs: 1000, eventCount: 1, exitCode: 0, signal: null, timedOut: false }];
		runLogs["hwp-to-pdf"] = [{ startedAt: NOW - 19 * 3_600_000, durationMs: 800, eventCount: 1, exitCode: null, signal: null, timedOut: false, error: "spawn hwp5 ENOENT" }];
		const p = props();
		render(p);
		await settle();
		click(host.querySelector('[data-tab="all"]'));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const runs = (): Element[] => [...host.querySelectorAll("[data-automation-all-runs] [data-run]")];
		expect(runs().map((run) => text(run))).toEqual([expect.stringContaining("새 PDF → Dazzi에게 맡기기"), expect.stringContaining("hwp5")]);
		expect(text(host.querySelector("[data-automation-all-runs]"))).toContain("2회 실행");
		click(host.querySelector('[data-switch-id="automation-fail-only"]') ?? host.querySelector('[data-automation-all-runs] [role="switch"]'));
		expect(runs()).toHaveLength(1);
		click(runs()[0]);
		expect(p.onEdit).toHaveBeenCalledWith("hwp-to-pdf");
		Reflect.deleteProperty(runLogs, "downloads-pdf-summary");
		Reflect.deleteProperty(runLogs, "hwp-to-pdf");
	});
});

describe("AutomationsView 새 자동화 card", () => {
	const create = (): HTMLButtonElement | null => host.querySelector('[data-action="automation-create"]');
	const task = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>('[data-testid="automation-new-task"]')!;
	const sentence = (): string => [...(host.querySelector('[data-testid="automation-new-when"]')?.children ?? [])].map((part) => text(part)).join(" ");
	const openCard = (): void => click(host.querySelector('[data-action="automation-composer-open"]'));

	it("reads the 언제 sentence with the first standard folder, and creates a read-only agent rule from it", async () => {
		const p = props();
		render(p);
		await settle();
		openCard();
		await settle();
		expect(sentence()).toBe("다운로드 에 PDF 파일 이 새로 생기면");
		expect(create()?.disabled).toBe(true);
		act(() => type(task(), "핵심을 3줄로 요약해 줘"));
		expect(create()?.disabled).toBe(false);
		await act(async () => {
			create()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(p.onCreate).toHaveBeenCalledWith({
			paths: ["/Users/jeffrey/Downloads"],
			events: ["create"],
			include: ["**/*.pdf"],
			agent: { profile: "file-triage", task: "핵심을 3줄로 요약해 줘" },
		});
		await settle();
		// Made: the card folds back into its line, and the new rule is in 내 자동화.
		expect(host.querySelector('[data-testid="automation-new"]')).toBeNull();
		expect(host.querySelector('[data-action="automation-composer-open"]')).not.toBeNull();
	});

	it("changes the folder, the kind, the change and the permission from their chips", async () => {
		const p = props();
		render(p);
		await settle();
		openCard();
		await settle();
		click(host.querySelector('[data-testid="automation-new-folder"]'));
		click(host.querySelector('[data-testid="automation-new-folder-/Users/jeffrey/Desktop"]'));
		click(host.querySelector('[data-testid="automation-new-kind"]'));
		click(host.querySelector('[data-testid="automation-new-kind-image"]'));
		click(host.querySelector('[data-testid="automation-new-event"]'));
		click(host.querySelector('[data-testid="automation-new-event-createUpdate"]'));
		click(host.querySelector('[data-testid="automation-new-mode"]'));
		click(host.querySelector('[data-testid="automation-new-mode-write"]'));
		expect(sentence()).toBe("데스크탑 에 이미지 파일 이 생기거나 바뀌면");
		act(() => type(task(), "이름을 정리해 줘"));
		await act(async () => {
			create()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(p.onCreate).toHaveBeenCalledWith(expect.objectContaining({ paths: ["/Users/jeffrey/Desktop"], events: ["create", "update"], agent: { profile: "file-organizer", task: "이름을 정리해 줘" } }));
	});

	it("fills the card from a 추천 자동화 row, and keeps the search refresh a command until its words are changed", async () => {
		const p = props();
		render(p);
		await settle();
		click(host.querySelector('[data-template="refresh"]'));
		// The card opens with the row; its folder waits for the OS's folders to load.
		await settle();
		expect(task().value).toBe("검색에 바로 반영해 줘");
		// The 읽기 / 파일 수정 허용 chip shows on this card too.
		expect(host.querySelector('[data-testid="automation-new-mode"]')).not.toBeNull();
		await act(async () => {
			create()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(p.onCreate).toHaveBeenCalledWith({ paths: ["/Users/jeffrey/Documents"], events: ["create", "update"], include: [], run: ["autorag", "refresh"] });
	});
});
