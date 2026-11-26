// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDraftCard, AutomationsView } from "../src/renderer/src/components/AutomationsView";
import type { MagicAction } from "../src/shared/context-menu-contract";
import type { FsLocation } from "../src/shared/fs-contract";
import { setAppLanguage } from "../src/shared/i18n";
import { t } from "../src/shared/i18n/core";
import { autoMagicLabel, newMagicActionId, rightClickKindOf, rightClickTarget } from "../src/renderer/src/state/right-click-trigger";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const place = (name: string, path: string, icon: FsLocation["icon"]): FsLocation => ({ name, path, section: "favorites", icon, available: true, scanned: true }) as FsLocation;
Reflect.set(globalThis, "autorag", {
	fs: { locations: async (): Promise<readonly FsLocation[]> => [place("Downloads", "/Users/jeffrey/Downloads", "downloads")] },
});

beforeAll(async () => {
	await setAppLanguage("ko");
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const click = async (selector: string): Promise<void> => {
	await act(async () => {
		host.querySelector<HTMLElement>(selector)?.click();
	});
};

function type(element: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
	setter?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the 새 자동화 card's 우클릭하면 trigger", () => {
	it("is offered only where a right-click action can be made", async () => {
		await act(async () => {
			root.render(<AutomationDraftCard initial={null} onCreate={async () => true} onCancel={() => undefined} />);
		});
		await click('[data-testid="automation-request-event"]');
		expect(document.querySelector('[data-testid="automation-request-event-rightClick"]')).toBeNull();
	});

	it("drops the folder for how many items, and 추가하기 makes a right-click action, not a rule", async () => {
		const onCreate = vi.fn(async () => true);
		const onCreateMagicAction = vi.fn(async (_action: MagicAction) => true);
		await act(async () => {
			root.render(<AutomationDraftCard initial={null} onCreate={onCreate} onCreateMagicAction={onCreateMagicAction} onCancel={() => undefined} />);
		});
		await click('[data-testid="automation-request-event"]');
		await act(async () => document.querySelector<HTMLElement>('[data-testid="automation-request-event-rightClick"]')?.click());

		expect(host.querySelector('[data-testid="automation-request-folder"]')).toBeNull();
		expect(host.querySelector('[data-testid="automation-request-rc-count"]')?.textContent).toBe(t("rightClickWhen.count.single"));
		expect(host.querySelector('[data-testid="automation-request-run"]')).not.toBeNull();
		// A new action has no permission chip: it starts read-only.
		expect(host.querySelector('[data-testid="automation-new-mode"]')).toBeNull();

		await click('[data-testid="automation-request-rc-kind"]');
		await act(async () => document.querySelector<HTMLElement>('[data-testid="automation-request-rc-kind-folder"]')?.click());
		await act(async () => {
			type(host.querySelector<HTMLTextAreaElement>('[data-testid="automation-request-task"]')!, "폴더 안 파일 개수를 세어 줘");
		});
		await click('[data-action="automation-request-add"]');

		expect(onCreate).not.toHaveBeenCalled();
		expect(onCreateMagicAction).toHaveBeenCalledTimes(1);
		expect(onCreateMagicAction.mock.calls[0]![0]).toMatchObject({
			label: "폴더 안 파일 개수를 세어 줘",
			selection: "single",
			targetKind: "folder",
			extensions: [],
			execution: { kind: "agent", mode: "read", prompt: "폴더 안 파일 개수를 세어 줘" },
		});
	});
});

describe("the 자동화 tab's right-click rows", () => {
	const action: MagicAction = {
		id: "pdf-summary",
		label: "세 줄 요약",
		enabled: true,
		selection: "single",
		targetKind: "file",
		extensions: ["pdf"],
		execution: { kind: "agent", mode: "read", prompt: "세 줄로 요약해 줘" },
	};

	it("lists the actions under 내 자동화 with their last run's dot and the click glyph, and opens one a step in, as a rule's page", async () => {
		const onToggleMagicAction = vi.fn();
		const onUpdateMagicAction = vi.fn(async (_next: MagicAction) => true);
		const onDeleteMagicAction = vi.fn(async (_id: string) => undefined);
		const run = { startedAt: Date.now() - 60_000, durationMs: 1200, eventCount: 1, exitCode: 0, signal: null, timedOut: false };
		Reflect.set(globalThis, "autorag", {
			...(Reflect.get(globalThis, "autorag") as object),
			magicAction: { history: async (id: string) => (id === "pdf-summary" ? [run] : []) },
		});
		await act(async () => {
			root.render(
				<AutomationsView
					state={{ ready: true, rules: [], daemon: null, configPath: "", configError: null, error: null }}
					daemonBusy={false}
					selectedId={null}
					onSelect={vi.fn()}
					onEdit={vi.fn()}
					onAdd={vi.fn()}
					onCreate={vi.fn(async () => true)}
					onPreview={vi.fn()}
					onAskDelete={vi.fn()}
					onSetDaemon={vi.fn()}
					onContextMenu={vi.fn()}
					onOpenFolder={vi.fn()}
					magicActions={[action]}
					onToggleMagicAction={onToggleMagicAction}
					onUpdateMagicAction={onUpdateMagicAction}
					onDeleteMagicAction={onDeleteMagicAction}
				/>,
			);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const row = host.querySelector<HTMLElement>('[data-magic-action-row="pdf-summary"]');
		expect(row?.textContent).toContain("세 줄 요약");
		expect(row?.textContent).toContain("PDF 파일 하나를 우클릭하면");
		expect(row?.querySelector('[data-run-tone="ok"]')).not.toBeNull();
		expect(host.querySelector("[data-automation-hero]")).toBeNull();
		await act(async () => host.querySelector<HTMLElement>('[data-sidebar-switch="magic-action-on:pdf-summary"]')?.click());
		expect(onToggleMagicAction).toHaveBeenCalledWith("pdf-summary");

		// › opens the action's own page here: its name, 설정 card, 실행 기록, and 삭제.
		await act(async () => row?.click());
		const detail = host.querySelector('[data-magic-action-detail="pdf-summary"]');
		expect(detail).not.toBeNull();
		expect(detail?.textContent).toContain(t("automations.detail.history"));
		expect(detail?.querySelectorAll("[data-run]")).toHaveLength(1);
		expect(detail?.querySelector('[data-testid="magic-detail-mode"]')).not.toBeNull();
		expect(detail?.querySelector<HTMLButtonElement>('[data-action="magic-detail-save"]')?.disabled).toBe(true);
		await act(async () => {
			type(detail!.querySelector<HTMLTextAreaElement>('[data-testid="magic-detail-task"]')!, "다섯 줄로 요약해 줘");
		});
		await act(async () => detail!.querySelector<HTMLButtonElement>('[data-action="magic-detail-save"]')?.click());
		expect(onUpdateMagicAction).toHaveBeenCalledTimes(1);
		expect(onUpdateMagicAction.mock.calls[0]![0]).toMatchObject({ id: "pdf-summary", execution: { kind: "agent", prompt: "다섯 줄로 요약해 줘" } });

		await act(async () => detail!.querySelector<HTMLButtonElement>('[data-action="magic-delete"]')?.click());
		const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("automations.detail.delete") && button.closest('[data-magic-action-detail]') === null);
		await act(async () => confirm?.click());
		expect(onDeleteMagicAction).toHaveBeenCalledWith("pdf-summary");
	});
});

describe("right-click trigger helpers", () => {
	it("maps the chip to a target and back", () => {
		expect(rightClickTarget("pdf", null)).toEqual({ targetKind: "file", extensions: ["pdf"] });
		expect(rightClickTarget("both", null)).toEqual({ targetKind: "any", extensions: [] });
		expect(rightClickTarget("pdf", ["hwp"])).toEqual({ targetKind: "file", extensions: ["hwp"] });
		expect(rightClickKindOf("file", ["pdf"])).toEqual({ kind: "pdf", custom: null });
		expect(rightClickKindOf("folder", [])).toEqual({ kind: "folder", custom: null });
		expect(rightClickKindOf("file", ["pdf", "md"])).toEqual({ kind: "all", custom: ["pdf", "md"] });
	});

	it("names an action from its first line and never reuses an id", () => {
		expect(autoMagicLabel("\n  세 줄로 요약해 줘\n표도 만들어 줘")).toBe("세 줄로 요약해 줘");
		expect([...autoMagicLabel("가".repeat(40))]).toHaveLength(30);
		expect(newMagicActionId("요약", [])).toBe("요약");
		expect(newMagicActionId("요약", ["요약", "요약-2"])).toBe("요약-3");
	});
});
