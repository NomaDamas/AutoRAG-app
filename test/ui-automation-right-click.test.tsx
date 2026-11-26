// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDraftCard, AutomationsView, INITIAL_AUTOMATIONS_PLACE, type AutomationsPlace } from "../src/renderer/src/components/AutomationsView";
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
		// No AI | 스크립트 choice: the card always asks the agent.
		expect(host.querySelector('[data-testid="automation-request-run"]')).toBeNull();
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
		// Status dot is removed from the list rows; only the on/off switch represents active state.
		expect(row?.querySelector("[data-run-tone]")).toBeNull();
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
		expect(detail?.querySelector('[data-testid="magic-detail-run"]')).toBeNull();
		expect(detail?.querySelector<HTMLButtonElement>('[data-action="magic-detail-save"]')?.disabled).toBe(true);
		await act(async () => {
			type(detail!.querySelector<HTMLTextAreaElement>('[data-testid="magic-detail-task"]')!, "다섯 줄로 요약해 줘");
		});
		await act(async () => detail!.querySelector<HTMLButtonElement>('[data-action="magic-detail-save"]')?.click());
		expect(onUpdateMagicAction).toHaveBeenCalledTimes(1);
		expect(onUpdateMagicAction.mock.calls[0]![0]).toMatchObject({ id: "pdf-summary", execution: { kind: "agent", prompt: "다섯 줄로 요약해 줘" } });

		await act(async () => detail!.querySelector<HTMLButtonElement>('[data-action="magic-delete"]')?.click());
		// The same dialog as deleting a rule: what stays, and the red 삭제.
		expect(document.body.textContent).toContain(t("automations.confirm.magicMessage"));
		const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === t("automations.confirm.action") && button.closest('[data-magic-action-detail]') === null);
		expect(confirm?.classList.contains("is-danger")).toBe(true);
		await act(async () => confirm?.click());
		expect(onDeleteMagicAction).toHaveBeenCalledWith("pdf-summary");
	});
});

describe("전체 기록 with right-click runs", () => {
	it("names each run by its file, with the automation and how it ended under it, and opens the action's page", async () => {
		const action: MagicAction = {
			id: "minutes",
			label: "세 줄 요약",
			enabled: true,
			selection: "single",
			targetKind: "file",
			extensions: ["txt"],
			execution: { kind: "agent", mode: "read", prompt: "세 줄로 요약해 줘" },
		};
		const run = { startedAt: Date.now() - 60_000, durationMs: 900, eventCount: 3, exitCode: 0, signal: null, timedOut: false, files: ["C:/docs/회의록.txt", "C:/docs/b.txt", "C:/docs/c.txt"] };
		Reflect.set(globalThis, "autorag", {
			...(Reflect.get(globalThis, "autorag") as object),
			magicAction: { history: async () => [run] },
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
				/>,
			);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// Every automation looks alike in the list: no kind glyph, the line under the name says what starts it.
		expect(host.querySelector('[data-magic-action-row="minutes"] [data-kind]')).toBeNull();
		await act(async () => host.querySelector<HTMLElement>('[data-action="automation-all-runs"]')?.click());
		const line = host.querySelector("[data-automation-all-runs] [data-run]");
		expect(line?.querySelector("[data-run-title]")?.textContent).toBe(t("automations.inspector.runFilesMore", { name: "회의록.txt", count: 2 }));
		expect(line?.querySelector("[data-run-caption]")?.textContent).toBe(`세 줄 요약 · ${t("automations.inspector.runDone")}`);
		expect(line?.querySelector("[data-kind]")).toBeNull();
		await act(async () => (line as HTMLElement | null)?.click());
		expect(host.querySelector('[data-magic-action-detail="minutes"]')).not.toBeNull();
		// On the action's page the run reads its time as a clock time and opens its folder.
		expect(host.querySelector('[data-magic-action-detail="minutes"] [data-run]')?.textContent).toContain(t("automations.time.todayAt", { time: "" }).trim());
		expect(host.querySelector('[data-magic-action-detail="minutes"] [data-run] [data-kind]')).toBeNull();
		// Opened from 전체 기록, its path keeps that stop, and the stop leads back there.
		expect(host.querySelector('[data-magic-action-detail="minutes"] [data-action="automation-crumb-all"]')).not.toBeNull();
		await act(async () => host.querySelector<HTMLElement>('[data-action="automation-crumb-all"]')?.click());
		expect(host.querySelector("[data-automation-all-runs]")).not.toBeNull();
		expect(host.querySelector('[data-magic-action-detail="minutes"]')).toBeNull();
	});
});

describe("the 자동화 tab's place", () => {
	it("is found again after the tab was left: 전체 기록, then a right-click action's page", async () => {
		const action: MagicAction = { id: "keep", label: "남는 페이지", enabled: true, selection: "single", targetKind: "file", extensions: [], execution: { kind: "agent", mode: "read", prompt: "x" } };
		Reflect.set(globalThis, "autorag", { ...(Reflect.get(globalThis, "autorag") as object), magicAction: { history: async () => [] } });
		let place: AutomationsPlace = INITIAL_AUTOMATIONS_PLACE;
		const show = async (): Promise<void> => {
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
						place={place}
						onPlaceChange={(next) => {
							place = next;
							void show();
						}}
					/>,
				);
			});
		};
		const leaveAndComeBack = async (): Promise<void> => {
			await act(async () => root.render(<div />));
			await show();
		};
		await show();
		await act(async () => host.querySelector<HTMLElement>('[data-action="automation-all-runs"]')?.click());
		expect(host.querySelector("[data-automation-all-runs]")).not.toBeNull();
		await leaveAndComeBack();
		expect(host.querySelector("[data-automation-all-runs]")).not.toBeNull();

		await act(async () => host.querySelector<HTMLElement>('[data-action="automation-back"]')?.click());
		await act(async () => host.querySelector<HTMLElement>('[data-magic-action-row="keep"]')?.click());
		expect(host.querySelector('[data-magic-action-detail="keep"]')).not.toBeNull();
		await leaveAndComeBack();
		expect(host.querySelector('[data-magic-action-detail="keep"]')).not.toBeNull();
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
