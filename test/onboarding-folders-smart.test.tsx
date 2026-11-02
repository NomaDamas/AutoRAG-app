// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import { FoldersStep } from "../src/renderer/src/onboarding/steps/Folders";
import { SmartScopeStep } from "../src/renderer/src/onboarding/steps/SmartScope";
import { SmartScanStep } from "../src/renderer/src/onboarding/steps/SmartScan";
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
const DOWNLOADS: FolderCandidate = { path: "/dl", name: "Downloads", displayPath: "~/Downloads", kind: "downloads", defaultSelected: false, ocrOff: false };
const SCAN: FolderScan = { path: "/docs", files: 1000, bytes: 2_000_000_000, onlineOnly: 0, done: true, error: null };
const DRAFT = { ...BASE_DRAFT, folders: [{ path: "/docs", selected: true }, { path: "/dl", selected: false }], smartScopeRoots: ["/docs", "/dl"] };

function proposal(path: string, overrides: Partial<SmartExclusion> = {}): SmartExclusion {
	return { path, root: "/docs", reason: "Chat app downloads", files: 400, bytes: 500_000_000, excluded: true, ...overrides };
}

function renderFolders(overrides: Partial<OnboardingCtx> = {}): OnboardingCtx {
	const ctx = onboardingCtx({ candidates: [DOCS, DOWNLOADS], draft: DRAFT, scans: new Map([["/docs", SCAN]]), ...overrides });
	act(() => root.render(<SmartScopeStep ctx={ctx} />));
	return ctx;
}

function renderPicker(overrides: Partial<OnboardingCtx> = {}): OnboardingCtx {
	const ctx = onboardingCtx({ candidates: [DOCS, DOWNLOADS], draft: DRAFT, scans: new Map([["/docs", SCAN]]), ...overrides });
	act(() => root.render(<FoldersStep ctx={ctx} />));
	return ctx;
}

function renderScan(overrides: Partial<OnboardingCtx> = {}): OnboardingCtx {
	const ctx = onboardingCtx({ candidates: [DOCS, DOWNLOADS], draft: DRAFT, ...overrides });
	act(() => root.render(<SmartScanStep ctx={ctx} />));
	return ctx;
}

function text0(selector: string): string {
	return host.querySelector(selector)?.textContent ?? "";
}

function text(selector: string): string {
	return host.querySelector(selector)?.textContent ?? "";
}

function all(selector: string): HTMLElement[] {
	return [...host.querySelectorAll<HTMLElement>(selector)];
}

function one(selector: string): HTMLElement {
	const element = host.querySelector<HTMLElement>(selector);
	if (element === null) throw new Error(`no ${selector}`);
	return element;
}

function click(element: HTMLElement): void {
	act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("SmartScanStep", () => {
	it("says the agent is looking and shows the folder it is in", () => {
		renderScan({ smartRun: { status: "running", runId: "r", current: "/docs/Zoom" } });

		expect(text("h1")).toContain("onboarding.smartScan.title");
		expect(text(".si-scan-path")).toContain("/docs/Zoom");
		expect(host.querySelector(".si-folder-art")).not.toBeNull();
		expect(host.querySelector(".si-roaming-loupe")).not.toBeNull();
	});

	it("renders the agent's live progress phrase with the text shimmer effect", () => {
		renderScan({ smartRun: { status: "running", runId: "r", current: "/docs/Zoom", progress: "다운로드 하위 폴더 살펴보는 중" } });

		const shimmer = host.querySelector(".si-scan-path .shimmer");
		expect(shimmer?.textContent).toBe("다운로드 하위 폴더 살펴보는 중");
	});

	it("stops the analysis and goes back to choosing folders", () => {
		const cancelSmartScan = vi.fn();
		const setStep = vi.fn();
		renderScan({ cancelSmartScan, setStep, smartRun: { status: "running", runId: "r", current: null } });

		click(one(".si-scan-cancel"));
		expect(cancelSmartScan).toHaveBeenCalledTimes(1);
		expect(setStep).toHaveBeenCalledWith("folders");
	});

	it("offers a retry, the way back and a way on when the analysis fails", () => {
		const startSmartScan = vi.fn();
		const setStep = vi.fn();
		renderScan({ startSmartScan, setStep, smartRun: { status: "error", message: "No model configured" } });

		expect(text("h1")).toContain("onboarding.smartScan.failedTitle");
		expect(one(".si-scan-retry").title).toBe("No model configured");
		click(one(".si-scan-retry"));
		expect(startSmartScan).toHaveBeenCalledTimes(1);
		expect(host.querySelector(".si-roaming-loupe")).toBeNull();
		click(one(".si-scan-back"));
		expect(setStep).toHaveBeenLastCalledWith("folders");
		click(one(".si-scan-manual"));
		expect(setStep).toHaveBeenLastCalledWith("smartScope");
	});

	it("shows only the finished title once the analysis is done", () => {
		renderScan({ smartRun: { status: "done" }, draft: { ...DRAFT, smartScope: [proposal("/docs/Zoom")] } });

		expect(text("h1")).toContain("onboarding.smartScan.done");
		expect(host.querySelector(".si-roaming-loupe")).toBeNull();
		expect(host.querySelector("button")).toBeNull();
	});
});

describe("SmartScopeStep, the smart-indexing scope screen", () => {
	const drag = (from: Element, to: Element): void => {
		act(() => {
			from.dispatchEvent(new Event("dragstart", { bubbles: true }));
		});
		act(() => {
			to.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
			to.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
		});
	};
	const pathOf = (path: string): HTMLElement => one(`.si-pill[data-path="${path}"]`);
	const flush = async (): Promise<void> => {
		await act(async () => {
			await Promise.resolve();
		});
	};

	it("lists the selected folders on the left and what is left out on the right, grouped by folder", () => {
		renderFolders({ draft: { ...DRAFT, smartScope: [proposal("/docs/Telegram"), proposal("/docs/Zoom", { excluded: false }), proposal("/other/Cache", { root: "/other" })] } });

		expect(all(".si-panel.blue .si-pill").map((pill) => pill.dataset.path)).toEqual(["/docs"]);
		expect(text(".si-panel.blue .si-panel-meta")).toContain("count=1");
		// Unselected folders the AI looked through stay on the right; a kept proposal and another root's do not show.
		expect(all(".si-panel.red .si-pill").map((pill) => pill.dataset.path)).toEqual(["/dl", "/docs/Telegram"]);
		expect(text(".si-summary")).toContain("onboarding.smartScope.summary.eta");
	});

	it("drags a selected folder out and back, selecting it accordingly", () => {
		const setFolderSelected = vi.fn();
		renderFolders({ setFolderSelected });

		drag(pathOf("/docs"), one(".si-panel.red"));
		expect(setFolderSelected).toHaveBeenLastCalledWith("/docs", false);
		drag(pathOf("/dl"), one(".si-panel.blue"));
		expect(setFolderSelected).toHaveBeenLastCalledWith("/dl", true);
	});

	it("drags a left-out folder back in, and ignores a drop on the side it came from", () => {
		const setSmartExcluded = vi.fn();
		renderFolders({ setSmartExcluded, draft: { ...DRAFT, smartScope: [proposal("/docs/Zoom")] } });

		drag(pathOf("/docs/Zoom"), one(".si-panel.red"));
		expect(setSmartExcluded).not.toHaveBeenCalled();
		drag(pathOf("/docs/Zoom"), one(".si-panel.blue"));
		expect(setSmartExcluded).toHaveBeenCalledWith("/docs/Zoom", false);
	});

	it("opens a folder with sub-folders under a breadcrumb, excludes one by dragging, and goes back from the crumb", async () => {
		const excludeFolder = vi.fn();
		const measureFolders = vi.fn();
		const listSubfolders = vi.fn(async (path: string) => (path === "/docs" ? [{ path: "/docs/2024", name: "2024" }] : []));
		renderFolders({ excludeFolder, measureFolders, listSubfolders });
		await flush();

		click(pathOf("/docs"));
		await flush();
		expect(text(".si-crumb-here")).toBe("Documents");
		expect(measureFolders).toHaveBeenCalledWith(["/docs/2024"]);
		// Nothing inside it, so it offers no way further in.
		expect(pathOf("/docs/2024").querySelector(".si-pill-open")).toBeNull();

		drag(pathOf("/docs/2024"), one(".si-panel.red"));
		expect(excludeFolder).toHaveBeenCalledWith("/docs/2024");

		click(one(".si-crumb"));
		await flush();
		expect(host.querySelector(".si-crumb-here")).toBeNull();
		expect(pathOf("/docs")).toBeTruthy();
	});

	it("explains the AI criteria in a tooltip beside the lead", () => {
		renderFolders();

		expect(text(".si-criteria-toggle")).toContain("onboarding.smartScope.criteria.label");
		expect(one(".si-criteria").getAttribute("role")).toBe("tooltip");
		expect(text(".si-criteria")).toContain("onboarding.smartScope.criteria.includeBody");
		expect(text(".si-criteria")).toContain("onboarding.smartScope.criteria.excludeBody");
	});
});

describe("FoldersStep, where the folders to look through are chosen", () => {
	it("lists every suggested folder as a card with a checkbox, the selected ones marked", () => {
		renderPicker();

		const cards = all(".folder-card:not(.add)");
		expect(cards.map((card) => card.querySelector(".folder-name")?.textContent)).toEqual(["Documents", "Downloads"]);
		expect(cards.map((card) => card.className.includes("selected"))).toEqual([true, false]);
		expect(cards[0]?.querySelector(".folder-path")?.textContent).toBe("~/Documents");
	});

	it("shows each folder's file count, size and time while its scan runs and when it is done", () => {
		renderPicker({ scans: new Map([["/docs", SCAN]]) });

		const stats = all(".folder-card:not(.add) .folder-stats").map((item) => item.textContent ?? "");
		expect(stats[0]).toContain("files=1,000");
		expect(stats[0]).toContain("size=2.0 GB");
		// /dl has no scan yet.
		expect(stats[1]).toContain("onboarding.folders.scanning");
	});

	it("selects and unselects a folder from its card", () => {
		const setFolderSelected = vi.fn();
		renderPicker({ setFolderSelected });

		const cards = all(".folder-card:not(.add)");
		click(cards[1] as HTMLElement);
		expect(setFolderSelected).toHaveBeenLastCalledWith("/dl", true);
		click(cards[0] as HTMLElement);
		expect(setFolderSelected).toHaveBeenLastCalledWith("/docs", false);
	});

	it("selects or clears every folder from the select-all checkbox", () => {
		const toggleAllFolders = vi.fn();
		renderPicker({ toggleAllFolders });

		click(one(".folder-head input[type=checkbox]"));
		expect(toggleAllFolders).toHaveBeenCalledTimes(1);
	});

	it("adds a folder from the dashed card", () => {
		const addFolders = vi.fn();
		renderPicker({ addFolders });

		click(one(".folder-card.add"));
		expect(addFolders).toHaveBeenCalledTimes(1);
	});

	it("does not show the smart-indexing panels: those come after the scan", () => {
		renderPicker();

		expect(host.querySelector(".si-dual-panels")).toBeNull();
		expect(host.querySelector(".si-policy-bar")).toBeNull();
	});
});

