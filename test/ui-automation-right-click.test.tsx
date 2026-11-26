// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationDraftCard } from "../src/renderer/src/components/AutomationsView";
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
		expect(host.querySelector('[data-testid="automation-request-event-rightClick"]')).toBeNull();
	});

	it("drops the folder for how many items, and 추가하기 makes a right-click action, not a rule", async () => {
		const onCreate = vi.fn(async () => true);
		const onCreateMagicAction = vi.fn(async (_action: MagicAction) => true);
		await act(async () => {
			root.render(<AutomationDraftCard initial={null} onCreate={onCreate} onCreateMagicAction={onCreateMagicAction} onCancel={() => undefined} />);
		});
		await click('[data-testid="automation-request-event"]');
		await click('[data-testid="automation-request-event-rightClick"]');

		expect(host.querySelector('[data-testid="automation-request-folder"]')).toBeNull();
		expect(host.querySelector('[data-testid="automation-request-rc-count"]')?.textContent).toBe(t("rightClickWhen.count.single"));
		expect(host.querySelector('[data-testid="automation-request-run"]')).not.toBeNull();
		// A new action has no permission chip: it starts read-only.
		expect(host.querySelector('[data-testid="automation-new-mode"]')).toBeNull();

		await click('[data-testid="automation-request-rc-kind"]');
		await click('[data-testid="automation-request-rc-kind-folder"]');
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
