// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsView, type AutomationsViewProps } from "../src/renderer/src/components/AutomationsView";
import type { AutomationRule, AutomationsSnapshot } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="row"][data-rule-id]')];
const text = (element: Element | null | undefined): string => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("AutomationsView list", () => {
	it("lists every rule as a row: what it does, the watched folder, when it last ran", () => {
		render(props());
		expect(rows().map((row) => row.dataset.ruleId)).toEqual(["downloads-pdf-summary", "hwp-to-pdf", "screens"]);
		const first = rows()[0];
		expect(text(first)).toContain("새 PDF → Dazzi에게 맡기기");
		expect(text(first)).toContain("다운로드");
		expect(text(first)).toContain("3분 전");
		expect(text(rows()[2])).toContain("데스크탑");
		expect(text(rows()[2])).toContain("—");
	});

	it("marks the selected row and tells a failed rule apart from a good one and one that never ran", () => {
		render(props({ selectedId: "hwp-to-pdf" }));
		expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
		const tones = rows().map((row) => row.querySelector("[data-run-tone]")?.getAttribute("data-run-tone"));
		expect(tones).toEqual(["ok", "fail", "never"]);
	});

	it("names its columns in the interface language", async () => {
		await setAppLanguage("en");
		render(props());
		const header = host.querySelector('[role="rowgroup"][data-columns]');
		expect([...(header?.querySelectorAll("span") ?? [])].map((cell) => cell.textContent)).toEqual(["Name", "Watched folder", "Last run", "Status"]);
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
	it("selects on click, edits on double click, and opens the menu on right click", () => {
		const p = props();
		render(p);
		act(() => rows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(p.onSelect).toHaveBeenCalledWith("hwp-to-pdf");
		act(() => rows()[1]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
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
		expect(text(bar())).toContain("백그라운드 실행 상태를 확인할 수 없어요");
		expect(bar()?.querySelector("button")).toBeNull();
	});

	it("shows no service line at all for a user with no rules file, where there is nothing to run", () => {
		render(props({ state: state([], { daemon: null }) }));
		expect(bar()).toBeNull();
		expect(text(host)).toContain("아직 자동화가 없어요");
	});
});

describe("AutomationsView empty and error states", () => {
	it("invites adding the first rule through AI Search when there are none", () => {
		const p = props({ state: state([]) });
		render(p);
		expect(rows()).toEqual([]);
		expect(text(host)).toContain("아직 자동화가 없어요");
		act(() => [...host.querySelectorAll("button")].find((b) => text(b) === "AI 검색에서 규칙 추가")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(p.onAdd).toHaveBeenCalledTimes(1);
	});

	it("shows nothing but the frame before the first read finishes, instead of a false empty list", () => {
		render(props({ state: { ...state([]), ready: false } }));
		expect(text(host)).not.toContain("아직 자동화가 없어요");
	});

	it("says when the rules file cannot be read and shows the reason, not an empty list", () => {
		render(props({ state: state([], { configError: "Unknown field \"note\" in automations[1]" }) }));
		expect(text(host)).toContain("규칙 파일을 읽을 수 없어요");
		expect(text(host)).toContain("Unknown field \"note\" in automations[1]");
		expect(text(host)).not.toContain("아직 자동화가 없어요");
	});

	it("shows a read failure beside the rules it kept", () => {
		render(props({ state: state([rule("a")], { error: "자동화 상태를 확인하지 못했습니다: boom" }) }));
		expect(rows()).toHaveLength(1);
		expect(text(host)).toContain("자동화 상태를 확인하지 못했습니다: boom");
	});
});
