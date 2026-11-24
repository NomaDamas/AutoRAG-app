// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { IndexProblemBanner } from "../src/renderer/src/components/IndexProblemBanner";
import type { IndexFailure } from "../src/shared/index-failure";
import { NO_INDEX_PROBLEM, type IndexProblem } from "../src/shared/index-problem-contract";
import { setAppLanguage } from "../src/shared/i18n";

// The banner subscribes to the preload bridge, which a browser-only run does not have; the stub is armed per test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const retry = vi.fn(async (): Promise<void> => undefined);
const dismiss = vi.fn(async (): Promise<void> => undefined);
let problem: IndexProblem = NO_INDEX_PROBLEM;

Reflect.set(globalThis, "autorag", {
	indexProblem: {
		get: async (): Promise<IndexProblem> => problem,
		onChange: (): (() => void) => () => undefined,
		retry,
		dismiss,
	},
});

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	problem = NO_INDEX_PROBLEM;
	retry.mockClear();
	dismiss.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function failed(reason: IndexFailure["reason"]): IndexProblem {
	return { failure: { reason, folders: [], code: null }, skipped: 0, at: "2026-10-24T05:00:00.000Z", retrying: false };
}

/** Render the banner over one problem and let the bridge's first answer land. */
async function render(next: IndexProblem): Promise<Mock> {
	problem = next;
	const onFixEmbedding = vi.fn();
	act(() => root.render(<IndexProblemBanner onFixEmbedding={onFixEmbedding} />));
	await act(async () => {
		await Promise.resolve();
	});
	return onFixEmbedding;
}

const banner = (): HTMLElement | null => host.querySelector<HTMLElement>('[role="alert"]');
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="alert"] button')];
/** The accent action; 나중에 and the × both dismiss. */
const primary = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[role="alert"] button.bg-accent');
const dismissButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[role="alert"] button[aria-label]');

describe("IndexProblemBanner", () => {
	it("shows nothing while the index works", async () => {
		await render(NO_INDEX_PROBLEM);
		expect(banner()).toBeNull();
	});

	it("warns, not errs, for a refused embedder, says keyword search still works, and offers 다시 시도 beside 설정 열기 (Figma 430:8644)", async () => {
		const onFixEmbedding = await render(failed("embedder-config"));
		expect(banner()?.getAttribute("data-tone")).toBe("warning");
		expect(banner()?.textContent).toContain("의미 검색을 사용할 수 없습니다");
		expect(banner()?.textContent).toContain("문서 이해 모델 설정을 확인해 주세요. 키워드 검색은 계속 사용할 수 있습니다.");
		expect(buttons().map((button) => button.textContent)).toEqual(["", "다시 시도", "설정 열기"]);
		act(() => primary()?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onFixEmbedding).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
		const again = buttons().find((button) => button.textContent === "다시 시도");
		act(() => again?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it("keeps 나중에 and the error tone for a problem that stops search", async () => {
		await render(failed("disk-full"));
		expect(banner()?.getAttribute("data-tone")).toBe("error");
		expect(buttons().map((button) => button.textContent)).toContain("나중에");
	});

	it("shows one line and one button while the embedder is unreachable, and that button retries", async () => {
		const onFixEmbedding = await render(failed("embedder-offline"));
		expect(banner()?.textContent).toBeTruthy();
		expect(buttons()).toHaveLength(3);
		expect(primary()).not.toBeNull();
		act(() => primary()?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(retry).toHaveBeenCalledTimes(1);
		expect(onFixEmbedding).not.toHaveBeenCalled();
	});

	it("leaves the run in flight alone: no banner while a retry from a surface runs", async () => {
		await render({ ...failed("disk-full"), retrying: true });
		expect(banner()).toBeNull();
	});

	it("goes away with the dismiss button", async () => {
		await render(failed("unknown"));
		act(() => dismissButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(dismiss).toHaveBeenCalledTimes(1);
		expect(banner()).toBeNull();
	});
});
