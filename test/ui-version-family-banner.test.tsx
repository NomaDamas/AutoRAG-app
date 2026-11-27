// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionFamilyBanner } from "../src/renderer/src/components/VersionFamilyBanner";
import { clearBackgroundTasksForTests, getBackgroundTasksSnapshot as getBackgroundTasks } from "../src/renderer/src/hooks/useBackgroundTasks";
import { setAppLanguage } from "../src/shared/i18n";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	setAppLanguage("ko");
	clearBackgroundTasksForTests();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("the duplicate-check notice over a Finder list", () => {
	it("says what happened in the app's language and keeps the tool's English behind 자세히 보기", () => {
		act(() =>
			root.render(
				<VersionFamilyBanner error={{ code: "scan-failed", message: "dupey scan failed for C:\\Users\\me\\Downloads: dupey timed out.", installCommand: null }} onRetry={vi.fn()} />,
			),
		);
		expect(host.querySelector("strong")?.textContent).toBe("중복 파일 검사를 끝내지 못했습니다");
		expect(host.querySelector(".notice-card__copy")?.textContent).toContain("잠시 뒤 다시 확인해 주세요");
		// The raw message is not the title; it waits behind the details toggle.
		expect(host.querySelector("strong")?.textContent).not.toContain("dupey scan failed");
	});

	it("while 다시 확인 runs, steps back to one line and lists the scan in the sidebar's activity", async () => {
		let finish: (ok: boolean) => void = () => undefined;
		const onRetry = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
		act(() => root.render(<VersionFamilyBanner error={{ code: "scan-failed", message: "dupey timed out.", installCommand: null }} onRetry={onRetry} />));
		// The last button in the actions row; 자세히 보기 comes first.
		const button = (): HTMLButtonElement | null => [...host.querySelectorAll<HTMLButtonElement>(".notice-card__actions button")].at(-1) ?? null;
		expect(button()?.textContent).toBe("다시 확인");
		await act(async () => {
			button()?.click();
			await Promise.resolve();
		});
		// The one-line notice: no title-and-button card, no second press.
		expect(host.querySelector("[data-version-recheck]")?.textContent).toContain("왼쪽 아래");
		expect(host.querySelector(".notice-card__actions")).toBeNull();
		expect(getBackgroundTasks().some((task) => task.headline === "중복 파일 다시 확인 중" && task.state === "running")).toBe(true);
		expect(onRetry).toHaveBeenCalledTimes(1);
		await act(async () => {
			finish(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		// It failed again: the full card is back, and the sidebar task ends as failed.
		expect(button()?.textContent).toBe("다시 확인");
		expect(getBackgroundTasks().some((task) => task.headline === "중복 파일 다시 확인 중" && task.state === "failed")).toBe(true);
	});

	it("is cut by the pane under 400px instead of wrapping into a tall column", () => {
		act(() => root.render(<VersionFamilyBanner error={{ code: "dupey-missing", message: "dupey CLI is required", installCommand: "brew install dupey" }} onRetry={vi.fn()} />));
		const clip = host.querySelector<HTMLElement>("[data-notice-clip]");
		expect(clip?.className).toContain("overflow-hidden");
		expect(clip?.querySelector<HTMLElement>(".notice-card")?.style.minWidth).toBe("400px");
		expect(host.querySelector("strong")?.textContent).toBe("중복 파일 검사 도구가 없습니다");
		expect(host.querySelector("code")?.textContent).toBe("brew install dupey");
	});
});
