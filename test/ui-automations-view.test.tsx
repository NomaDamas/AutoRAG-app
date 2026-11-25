// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsView, templateTaken, type AutomationsViewProps } from "../src/renderer/src/components/AutomationsView";
import type { AutomationRule, AutomationRun, AutomationsSnapshot } from "../src/shared/automation-contract";
import type { FsLocation } from "../src/shared/fs-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const place = (name: string, path: string, icon: FsLocation["icon"]): FsLocation => ({ name, path, section: "favorites", icon, available: true, scanned: true }) as FsLocation;
const runLogs: Record<string, readonly AutomationRun[]> = {};
/** What each folder holds, by name, for the recommendations' reasons. */
const listings: Record<string, readonly string[]> = {
	"/Users/jeffrey/Desktop": ["스크린샷 2026-11-20 오후 3.12.04.png", "Screenshot 2026-11-21 101010.png", "여행 계획.png", "메모.txt"],
	"/Users/jeffrey/Downloads": ["계약서.pdf", "청구서.PDF", "manual.pdf", "setup.zip"],
};
Reflect.set(globalThis, "autorag", {
	automations: { history: async (id: string): Promise<readonly AutomationRun[]> => runLogs[id] ?? [] },
	fs: {
		locations: async (): Promise<readonly FsLocation[]> => [
			place("Desktop", "/Users/jeffrey/Desktop", "desktop"),
			place("Documents", "/Users/jeffrey/Documents", "documents"),
			place("Downloads", "/Users/jeffrey/Downloads", "downloads"),
		],
		listDir: async (path: string) => ({ path, entries: (listings[path] ?? []).map((name) => ({ name, path: `${path}/${name}`, kind: "file", mtimeMs: 0 })) }),
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

	it("marks the selected row, and draws the on/off switch and the arrow on every row (Figma 641:13493)", () => {
		render(props({ selectedId: "hwp-to-pdf" }));
		expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
		expect(rows().every((row) => row.querySelector('[data-sidebar-switch="automation-rule-on"]') !== null)).toBe(true);
		// Figma 672:3740: every row leads with how its last run went; the last-run words stay on the rule's page.
		expect(rows().every((row) => row.querySelector("[data-run-tone]") !== null)).toBe(true);
		expect(host.querySelector("[data-rule-last-run]")).toBeNull();
	});

	it("heads the page with only 채팅 | 내 자동화, no name on the left, and 채팅 goes back to the chat", async () => {
		await setAppLanguage("en");
		const onShowChat = vi.fn();
		render(props({ onShowChat }));
		expect(host.querySelector("[data-automations-head] strong")).toBeNull();
		expect(text(host.querySelector("[data-automations-head]"))).toBe("ChatMy automations");
		const segment = host.querySelector('[data-agent-segment][role="tablist"]');
		expect(segment?.getAttribute("data-agent-segment")).toBe("automations");
		const sides = [...(segment?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
		expect(sides.map((side) => [side.dataset.side, side.textContent, side.getAttribute("aria-selected")])).toEqual([
			["chat", "Chat", "false"],
			["automations", "My automations", "true"],
		]);
		click(sides[1]);
		expect(onShowChat).not.toHaveBeenCalled();
		click(sides[0]);
		expect(onShowChat).toHaveBeenCalledTimes(1);
	});

	it("names its sections in the interface language, and 새 자동화 hands making a rule to the chat instead of opening a card", async () => {
		await setAppLanguage("en");
		const onTalk = vi.fn();
		render(props({ onTalk }));
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["My Automations", "Suggested"]);
		const open = host.querySelector('[data-action="automation-composer-open"]');
		expect(text(open)).toBe("New automation");
		click(open);
		expect(onTalk).toHaveBeenCalledTimes(1);
		expect(host.querySelector('[data-testid="automation-new"]')).toBeNull();
		// The old 내 자동화 | 전체 기록 segment is gone; 전체 기록 is a link under the list.
		expect(host.querySelector("[data-automation-tabs]")).toBeNull();
		expect(text(host.querySelector('[data-action="automation-all-runs"]'))).toBe("See all runs");
	});

	it("suggests only the recommendations no rule already does", () => {
		const pdfRule = rule("pdf-notes", { run: [], agent: { profile: "file-organizer", task: "요약" }, include: ["**/*.pdf"], events: ["create"] });
		render(props({ state: state([pdfRule, failing]) }));
		expect([...host.querySelectorAll<HTMLElement>("[data-template]")].map((card) => card.dataset.template)).toEqual(["screenshot", "refresh"]);
		const refreshRule = rule("refresh", { run: ["autorag", "refresh"], include: [], events: ["create", "update"] });
		render(props({ state: state([pdfRule, refreshRule]) }));
		expect([...host.querySelectorAll<HTMLElement>("[data-template]")].map((card) => card.dataset.template)).toEqual(["screenshot"]);
	});

	it("draws the soft glow behind each recommendation only while there are no rules", () => {
		render(props({ state: state([]) }));
		const cards = [...host.querySelectorAll<HTMLElement>("[data-template]")];
		expect(cards.length).toBe(3);
		expect(cards.every((card) => card.parentElement?.hasAttribute("data-ai-glow") === true)).toBe(true);
		render(props({ state: state([failing]) }));
		expect(host.querySelector("[data-automation-recommendations] [data-ai-glow]")).toBeNull();
		expect(host.querySelectorAll("[data-template]").length).toBeGreaterThan(0);
	});
});

describe("templateTaken", () => {
	it("counts a rule only when it watches the same files and changes and does the same kind of work", () => {
		const agentPdf = rule("a", { run: [], agent: { profile: "file-triage", task: "t" }, include: ["**/*.pdf"], events: ["create"] });
		expect(templateTaken([agentPdf], "pdf")).toBe(true);
		// The same files, but a program instead of an agent.
		expect(templateTaken([rule("b", { include: ["**/*.pdf"], events: ["create"] })], "pdf")).toBe(false);
		// The same agent, but other changes.
		expect(templateTaken([{ ...agentPdf, events: ["create", "update"] }], "pdf")).toBe(false);
		expect(templateTaken([rule("c", { run: ["autorag", "refresh"], include: [], events: ["update", "create"] })], "refresh")).toBe(true);
		expect(templateTaken([rule("d", { run: ["autorag", "search", "x"], include: [], events: ["create", "update"] })], "refresh")).toBe(false);
		expect(templateTaken([], "screenshot")).toBe(false);
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

describe("AutomationsView background service", () => {
	it("shows no banner or line about the service, off or on: the window turns it on by itself", () => {
		render(props({ state: state([rule("a")], { daemon: { platform: "darwin", installed: false, running: false } }) }));
		expect(host.querySelector("[data-daemon]")).toBeNull();
		render(props());
		expect(host.querySelector("[data-daemon]")).toBeNull();
	});
});

describe("AutomationsView empty and error states", () => {
	it("offers only the recommendations and 채팅으로 만들기 when there are no rules: no 내 자동화 list, no 새 자동화 card", () => {
		const onTalk = vi.fn();
		render(props({ state: state([]), onTalk }));
		expect(rows()).toEqual([]);
		expect([...host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["내 파일에서 찾은 추천 자동화"]);
		expect([...host.querySelectorAll<HTMLElement>("[data-template]")].map((card) => card.dataset.template)).toEqual(["screenshot", "pdf", "refresh"]);
		expect(host.querySelector('[data-testid="automation-new"]')).toBeNull();
		expect(host.querySelector('[data-action="automation-composer-open"]')).toBeNull();
		expect(host.querySelector('[data-action="automation-all-runs"]')).toBeNull();
		expect(text(host.querySelector("[data-automation-recommendations]"))).toContain("원하는 게 없나요?");
		const talk = host.querySelector('[data-action="automation-talk"]');
		expect(text(talk)).toBe("채팅으로 만들기");
		click(talk);
		expect(onTalk).toHaveBeenCalledTimes(1);
	});

	it("says why each recommendation is worth having from the person's own files, and falls back to when it runs (Figma 672:3718)", async () => {
		render(props({ state: state([]) }));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const reason = (id: string): string => text(host.querySelector(`[data-template="${id}"] button[aria-expanded]`)?.lastElementChild?.lastElementChild ?? null);
		expect(reason("pdf")).toBe("다운로드에 PDF가 3개 있어요");
		expect(reason("screenshot")).toBe("데스크탑에 이름 없는 스크린샷이 2개 있어요");
		// Nothing in Documents changed this week and no index run was seen, so the card says when it would run.
		expect(host.querySelector(`[data-template="refresh"] [data-recommendation-reason]`)).toBeNull();
	});

	it("shows nothing but the frame before the first read finishes, instead of a false empty list", () => {
		render(props({ state: { ...state([]), ready: false } }));
		expect(host.querySelector('[data-testid="automation-new"]')).toBeNull();
		expect(host.querySelector("[data-automation-recommendations]")).toBeNull();
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
		// The way back is ‹ 뒤로가기.
		expect(text(host.querySelector('[data-action="automation-back"]'))).toBe("뒤로가기");
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
		expect(runs.map((run) => run.querySelector("[data-run-tone]")?.getAttribute("data-run-tone"))).toEqual(["error", "error", "ok"]);
		expect(text(runs[0])).toContain("파일 1개시간 초과");
		expect(text(runs[1])).toContain("spawn hwp5 ENOENT");
		expect(text(runs[2])).toContain("파일 3개완료");
		Reflect.deleteProperty(runLogs, "pdf");
	});
});

describe("AutomationsView 전체 기록 (Figma 676:646)", () => {
	it("lists every rule's runs newest first under the day they ran, and opens a rule from its run", async () => {
		const today = new Date(NOW).setHours(0, 0, 0, 0);
		runLogs["downloads-pdf-summary"] = [{ startedAt: Math.max(today, NOW - 60_000), durationMs: 1000, eventCount: 1, exitCode: 0, signal: null, timedOut: false }];
		runLogs["hwp-to-pdf"] = [{ startedAt: today - 3_600_000, durationMs: 800, eventCount: 1, exitCode: null, signal: null, timedOut: false, error: "spawn hwp5 ENOENT" }];
		const p = props();
		render(p);
		await settle();
		click(host.querySelector('[data-action="automation-all-runs"]'));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const page = (): HTMLElement | null => host.querySelector("[data-automation-all-runs]");
		expect(rows()).toEqual([]);
		expect(text(page()?.querySelector("h1"))).toBe("전체 기록");
		expect(text(page()?.querySelector('[data-action="automation-back"]'))).toBe("뒤로가기");
		expect([...(page()?.querySelectorAll("h2") ?? [])].map((day) => day.textContent)).toEqual(["오늘", "어제"]);
		const runs = (): Element[] => [...host.querySelectorAll("[data-automation-all-runs] [data-run]")];
		expect(runs().map((run) => text(run))).toEqual([expect.stringContaining("새 PDF → Dazzi에게 맡기기"), expect.stringContaining("hwp5")]);
		// 실패만 보기 is gone: every run shows, with no switch to hide the good ones.
		expect(page()?.querySelector('[role="switch"]')).toBeNull();
		click(runs()[1]);
		expect(p.onEdit).toHaveBeenCalledWith("hwp-to-pdf");
		Reflect.deleteProperty(runLogs, "downloads-pdf-summary");
		Reflect.deleteProperty(runLogs, "hwp-to-pdf");
	});

	it("says there are no runs yet, and ‹ 뒤로가기 returns to the list", async () => {
		render(props({ state: state([never]) }));
		await settle();
		click(host.querySelector('[data-action="automation-all-runs"]'));
		await settle();
		expect(host.querySelector("[data-automation-all-runs] [data-runs-empty]")).not.toBeNull();
		click(host.querySelector('[data-automation-all-runs] [data-action="automation-back"]'));
		expect(host.querySelector("[data-automation-all-runs]")).toBeNull();
		expect(rows().map((row) => row.dataset.ruleId)).toEqual(["screens"]);
	});
});

describe("AutomationsView 추천 자동화 (Figma 672:3718)", () => {
	const card = (id: string): HTMLElement | null => host.querySelector<HTMLElement>(`[data-template="${id}"]`);

	it("opens a recommendation downward to read what it would do, without writing anything", async () => {
		const p = props({ state: state([]) });
		render(p);
		await settle();
		const toggle = card("pdf")?.querySelector<HTMLButtonElement>("[aria-expanded]");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(card("pdf")?.querySelector("dl")).toBeNull();
		expect(text(card("pdf"))).toContain("새 PDF 요약");
		click(toggle);
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		const terms = [...(card("pdf")?.querySelectorAll("dl dt") ?? [])].map((term) => text(term));
		const values = [...(card("pdf")?.querySelectorAll("dl dd") ?? [])].map((value) => text(value));
		expect(terms).toEqual(["언제", "Dazzi가 할 일"]);
		expect(values[0]).toContain("다운로드");
		expect(values[1]).toBe("핵심을 3줄로 요약해서 메모로 남겨 줘");
		// Read-only: no field to type in, and nothing was written.
		expect(card("pdf")?.querySelector("input, textarea")).toBeNull();
		expect(p.onCreate).not.toHaveBeenCalled();
		click(toggle);
		expect(card("pdf")?.querySelector("dl")).toBeNull();
	});

	it("writes the rule at once from 추가하기, in the template's standard folder", async () => {
		const p = props({ state: state([]) });
		render(p);
		await settle();
		const add = (id: string): HTMLButtonElement | null | undefined => card(id)?.querySelector<HTMLButtonElement>('[data-action="automation-template-add"]');
		expect(text(add("pdf"))).toBe("추가하기");
		await act(async () => {
			add("pdf")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(p.onCreate).toHaveBeenCalledWith({
			paths: ["/Users/jeffrey/Downloads"],
			events: ["create"],
			include: ["**/*.pdf"],
			agent: { profile: "file-organizer", task: "핵심을 3줄로 요약해서 메모로 남겨 줘" },
		});
		// The search refresh stays a command, not an agent rule.
		await act(async () => {
			add("refresh")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(p.onCreate).toHaveBeenLastCalledWith({ paths: ["/Users/jeffrey/Documents"], events: ["create", "update"], include: [], run: ["autorag", "refresh"] });
	});
});

describe("AutomationsView a rule's 설정 card", () => {
	const editing = rule("pdf", { run: [], agent: { profile: "file-triage", task: "핵심을 3줄로 요약해 줘" }, paths: ["/Users/jeffrey/Downloads"], include: ["**/*.pdf"], events: ["create"] });
	const save = (): HTMLButtonElement | null => host.querySelector('[data-action="automation-update"]');
	const sentence = (): string => [...(host.querySelector('[data-testid="automation-new-when"]')?.children ?? [])].map((part) => text(part)).join(" ");

	it("reads the 언제 sentence from the rule, with 저장 waiting for a change", async () => {
		render(props({ editing }));
		await settle();
		expect(sentence()).toBe("다운로드 에 PDF 파일 이 새로 생기면");
		expect(save()?.disabled).toBe(true);
	});

	it("changes the folder, the kind, the change and the permission from their chips, and saves them", async () => {
		const onUpdate = vi.fn(async () => true);
		render(props({ editing, onUpdate }));
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
		expect(save()?.disabled).toBe(false);
		await act(async () => {
			save()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(onUpdate).toHaveBeenCalledWith(
			"pdf",
			expect.objectContaining({ paths: ["/Users/jeffrey/Desktop"], events: ["create", "update"], agent: { profile: "file-organizer", task: "핵심을 3줄로 요약해 줘" } }),
		);
	});
});
