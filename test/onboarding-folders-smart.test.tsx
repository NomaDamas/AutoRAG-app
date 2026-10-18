// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import { FoldersStep } from "../src/renderer/src/onboarding/steps/Folders";
import type { FolderCandidate, FolderScan } from "../src/shared/onboarding-contract";
import type { SmartExclusion } from "../src/shared/smart-indexing-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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

const DOCS: FolderCandidate = { path: "/docs", name: "Documents", displayPath: "~/Documents", kind: "documents", defaultSelected: true, ocrOff: false };
const SCAN: FolderScan = { path: "/docs", files: 1000, bytes: 2_000_000_000, onlineOnly: 0, done: true, error: null };

function proposal(path: string, overrides: Partial<SmartExclusion> = {}): SmartExclusion {
	return { path, root: "/docs", reason: "Chat app downloads", files: 400, bytes: 500_000_000, excluded: true, ...overrides };
}

function render(overrides: Partial<OnboardingCtx> = {}): OnboardingCtx {
	const ctx = onboardingCtx({ candidates: [DOCS], scans: new Map([["/docs", SCAN]]), ...overrides });
	act(() => root.render(<FoldersStep ctx={ctx} />));
	return ctx;
}

function text(selector: string): string {
	return host.querySelector(selector)?.textContent ?? "";
}

function button(selector: string): HTMLButtonElement {
	const element = host.querySelector<HTMLButtonElement>(selector);
	if (element === null) throw new Error(`no ${selector}`);
	return element;
}

function click(element: HTMLElement): void {
	act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("FoldersStep smart indexing", () => {
	it("offers the analysis before one ran, and starts it from the button", () => {
		const startSmartScan = vi.fn();
		render({ startSmartScan });

		expect(host.querySelectorAll(".si-pill")).toHaveLength(0);
		expect(text(".si-btn.accent")).toContain("onboarding.folders.smart.start");
		click(button(".si-btn.accent"));
		expect(startSmartScan).toHaveBeenCalledTimes(1);
	});

	it("cannot start with no folder selected", () => {
		const startSmartScan = vi.fn();
		render({ startSmartScan, draft: { ...BASE_DRAFT, folders: [{ path: "/docs", selected: false }] } });

		expect(button(".si-btn.accent").disabled).toBe(true);
		click(button(".si-btn.accent"));
		expect(startSmartScan).not.toHaveBeenCalled();
	});

	it("shows what the agent is looking at while it runs, and cancels from the same place", () => {
		const cancelSmartScan = vi.fn();
		render({ cancelSmartScan, smartRun: { status: "running", runId: "r", current: "/docs/Zoom" } });

		expect(text(".si-status")).toContain("onboarding.folders.smart.looking path=/docs/Zoom");
		expect(host.querySelector(".si-btn.accent")).toBeNull();
		click(button(".si-btn"));
		expect(cancelSmartScan).toHaveBeenCalledTimes(1);
	});

	it("lists each proposal under its selected folder, red when left out and blue when kept, and flips one on click", () => {
		const setSmartExcluded = vi.fn();
		render({
			setSmartExcluded,
			draft: { ...BASE_DRAFT, smartScope: [proposal("/docs/Telegram Desktop"), proposal("/docs/Zoom", { excluded: false }), proposal("/other/Cache", { root: "/other" })] },
		});

		const pills = [...host.querySelectorAll<HTMLButtonElement>(".si-pill")];
		expect(pills.map((pill) => pill.className.includes("red"))).toEqual([true, false]);
		expect(pills[0]?.textContent).toContain("Documents /");
		expect(pills[0]?.textContent).toContain("Telegram Desktop");
		click(pills[0] as HTMLButtonElement);
		expect(setSmartExcluded).toHaveBeenLastCalledWith("/docs/Telegram Desktop", false);
		click(pills[1] as HTMLButtonElement);
		expect(setSmartExcluded).toHaveBeenLastCalledWith("/docs/Zoom", true);
	});

	it("takes the left-out files and size off the folder summary, and says what that saves", () => {
		render({ draft: { ...BASE_DRAFT, smartScope: [proposal("/docs/Telegram Desktop"), proposal("/docs/Zoom", { excluded: false })] } });

		expect(text(".summary-main strong")).toContain("files=600");
		expect(text(".summary-main strong")).toContain("size=1.5 GB");
		expect(text(".si-saved")).toContain("folders=1");
		expect(text(".si-saved")).toContain("files=400");
	});

	it("says nothing needs excluding when the analysis found nothing, and shows the failure when it failed", () => {
		render({ draft: { ...BASE_DRAFT, smartScope: [] } });
		expect(text(".si-status")).toContain("onboarding.folders.smart.none");
		expect(host.querySelector(".si-saved")).toBeNull();

		render({ draft: { ...BASE_DRAFT }, smartRun: { status: "error", message: "No API key" } });
		expect(text(".si-status.error")).toContain("onboarding.folders.smart.failed");
		expect(text(".si-status.error")).toContain("No API key");
	});
});
