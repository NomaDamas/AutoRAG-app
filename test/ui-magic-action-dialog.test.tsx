// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MagicActionDialog } from "../src/renderer/src/components/MagicActionDialog";
import { SidebarMagicActionActivity } from "../src/renderer/src/components/SidebarMagicActionActivity";
import {
	resetMagicActionStoreForTests,
	startMagicActionRun,
} from "../src/renderer/src/hooks/useMagicAction";
import { setAppLanguage } from "../src/shared/i18n";
import type { MagicActionEvent } from "../src/shared/magic-actions-contract";

const bridge = vi.hoisted(() => {
	const listeners = new Set<(event: MagicActionEvent) => void>();
	const magicAction = {
		start: vi.fn(),
		cancel: vi.fn(),
		onEvent: (fn: (event: MagicActionEvent) => void) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		magicAction,
	});
	return {
		magicAction,
		emit: (event: MagicActionEvent) => {
			for (const fn of listeners) fn(event);
		},
		clear: () => listeners.clear(),
	};
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

function settle(): Promise<void> {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

beforeEach(async () => {
	await setAppLanguage("ko");
	resetMagicActionStoreForTests();
	bridge.clear();
	bridge.magicAction.start.mockReset().mockResolvedValue(undefined);
	bridge.magicAction.cancel.mockReset().mockResolvedValue(undefined);

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	resetMagicActionStoreForTests();
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

describe("MagicActionDialog & SidebarMagicActionActivity", () => {
	it("streams live progress & draft, minimizes to sidebar while running, and reopens with final Markdown output", async () => {
		await act(async () => {
			root.render(
				<div>
					<SidebarMagicActionActivity />
					<MagicActionDialog />
				</div>,
			);
		});

		await act(async () => {
			startMagicActionRun(
				{
					id: "pdf-summary",
					label: "PDF 3줄 요약",
					enabled: true,
					selection: "single",
					targetKind: "file",
					extensions: ["pdf"],
					execution: { kind: "agent", mode: "read", prompt: "요약해줘" },
				},
				["/Users/me/Documents/report.pdf"],
			);
		});
		await settle();

		expect(bridge.magicAction.start).toHaveBeenCalledTimes(1);
		const runId = bridge.magicAction.start.mock.calls[0]?.[0] as string;
		expect(host.querySelector('[data-testid="magic-action-dialog"]')).not.toBeNull();
		expect(host.textContent).toContain("report.pdf");

		// Emit progress phrase (`i`) and streamed draft
		await act(async () => {
			bridge.emit({ type: "progress", runId, text: "PDF 문서를 읽는 중" });
			bridge.emit({ type: "draft", runId, text: "1. 핵심 요약 초안" });
		});
		await settle();
		expect(host.querySelector('[data-testid="magic-action-progress"]')?.textContent).toContain("PDF 문서를 읽는 중");
		expect(host.querySelector('[data-testid="magic-action-output"]')?.textContent).toContain("핵심 요약 초안");

		// Minimize to background: dialog hides, sidebar block remains active
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="minimize-magic-action"]')?.click();
		});
		await settle();
		expect(host.querySelector('[data-testid="magic-action-dialog"]')).toBeNull();
		const sidebarBlock = host.querySelector<HTMLButtonElement>(".sidebar__magic-action");
		expect(sidebarBlock).not.toBeNull();
		expect(sidebarBlock?.textContent).toContain("PDF 3줄 요약");

		// Complete in background: sidebar block shows completed state; clicking reopens dialog with final output
		await act(async () => {
			bridge.emit({
				type: "done",
				runId,
				result: {
					actionId: "pdf-summary",
					actionLabel: "PDF 3줄 요약",
					executionKind: "agent",
					paths: ["/Users/me/Documents/report.pdf"],
					output: "**최종 3줄 요약**\n- 항목 A\n- 항목 B",
					durationMs: 420,
				},
			});
		});
		await settle();
		expect(host.querySelector<HTMLButtonElement>(".sidebar__magic-action")?.getAttribute("data-tone")).toBe("ok");

		await act(async () => {
			host.querySelector<HTMLButtonElement>(".sidebar__magic-action")?.click();
		});
		await settle();
		expect(host.querySelector('[data-testid="magic-action-dialog"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="magic-action-output"]')?.textContent).toContain("최종 3줄 요약");

		// Close clears finished session
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="close-magic-action"]')?.click();
		});
		await settle();
		expect(host.querySelector('[data-testid="magic-action-dialog"]')).toBeNull();
		expect(host.querySelector(".sidebar__magic-action")).toBeNull();
	});
});
