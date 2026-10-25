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
/** The one labelled action; the dismiss is the icon button that carries an `aria-label` instead. */
const primary = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[role="alert"] button:not([aria-label])');
const dismissButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[role="alert"] button[aria-label]');

describe("IndexProblemBanner", () => {
	it("shows nothing while the index works", async () => {
		await render(NO_INDEX_PROBLEM);
		expect(banner()).toBeNull();
	});

	it("shows one line and one button for a refused embedder, and that button opens the embedding choice", async () => {
		const onFixEmbedding = await render(failed("embedder-config"));
		expect(banner()?.textContent).toContain("의미 검색을 쓸 수 없어요");
		expect(buttons()).toHaveLength(2);
		expect(primary()).not.toBeNull();
		act(() => primary()?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onFixEmbedding).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	it("shows one line and one button while the embedder is unreachable, and that button retries", async () => {
		const onFixEmbedding = await render(failed("embedder-offline"));
		expect(banner()?.textContent).toBeTruthy();
		expect(buttons()).toHaveLength(2);
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
