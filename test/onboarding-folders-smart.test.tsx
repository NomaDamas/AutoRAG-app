// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import { FoldersStep } from "../src/renderer/src/onboarding/steps/Folders";
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
const DRAFT = { ...BASE_DRAFT, folders: [{ path: "/docs", selected: true }, { path: "/dl", selected: false }] };

function proposal(path: string, overrides: Partial<SmartExclusion> = {}): SmartExclusion {
	return { path, root: "/docs", reason: "Chat app downloads", files: 400, bytes: 500_000_000, excluded: true, ...overrides };
}

function renderFolders(overrides: Partial<OnboardingCtx> = {}): OnboardingCtx {
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

	it("cancels the analysis and falls back to choosing by hand", () => {
		const cancelSmartScan = vi.fn();
		renderScan({ cancelSmartScan, smartRun: { status: "running", runId: "r", current: null } });

		click(one(".si-scan-cancel"));
		expect(cancelSmartScan).toHaveBeenCalledTimes(1);
	});

	it("reports a failure with its reason and offers a retry", () => {
		const startSmartScan = vi.fn();
		renderScan({ startSmartScan, smartRun: { status: "error", message: "No model configured" } });

		expect(text(".si-scan-error")).toContain("onboarding.smartScan.failed");
		expect(text(".si-scan-error")).toContain("No model configured");
		click(one(".si-scan-retry"));
		expect(startSmartScan).toHaveBeenCalledTimes(1);
		expect(host.querySelector(".si-roaming-loupe")).toBeNull();
	});

	it("says it is done, with what it proposes, once the analysis finished", () => {
		renderScan({ smartRun: { status: "done" }, draft: { ...DRAFT, smartScope: [proposal("/docs/Zoom"), proposal("/docs/Logs", { excluded: false })] } });

		expect(text("h1")).toContain("onboarding.smartScan.done");
		expect(text(".si-scan-note")).toContain("count=2");
	});
});

describe("FoldersStep as the smart-indexing scope screen", () => {
	it("lays out a policy bar, a blue panel of included folders and a red panel of left-out ones", () => {
		renderFolders();

		expect(text(".si-policy-copy strong")).toContain("onboarding.folders.policy.title");
		expect(host.querySelector(".si-panel.blue")).not.toBeNull();
		expect(host.querySelector(".si-panel.red")).not.toBeNull();
		expect(host.querySelector(".folder-card")).toBeNull();
	});

	it("lists each selected folder as a blue pill with its size and the unselected ones as ghost pills to add", () => {
		const setFolderSelected = vi.fn();
		renderFolders({ setFolderSelected });

		const blue = all(".si-panel.blue .si-pill");
		expect(blue).toHaveLength(1);
		expect(blue[0]?.textContent).toContain("Documents");
		expect(blue[0]?.textContent).toContain("2.0 GB");
		expect(text(".si-panel.blue .si-panel-meta")).toContain("folders=1");
		expect(text(".si-panel.blue .si-panel-meta")).toContain("files=1,000");

		const ghosts = all(".si-panel.blue .si-ghost-pill");
		expect(ghosts.map((ghost) => ghost.textContent)).toEqual(["+ Downloads"]);
		click(ghosts[0] as HTMLElement);
		expect(setFolderSelected).toHaveBeenLastCalledWith("/dl", true);
	});

	it("takes a folder out of the index from its pill's x, and adds one from the dashed button", () => {
		const setFolderSelected = vi.fn();
		const addFolders = vi.fn();
		renderFolders({ setFolderSelected, addFolders });

		click(one(".si-panel.blue .si-pill-x"));
		expect(setFolderSelected).toHaveBeenLastCalledWith("/docs", false);
		click(one(".si-panel.blue .si-add-pill"));
		expect(addFolders).toHaveBeenCalledTimes(1);
	});

	it("restores the suggested selection from the reset button", () => {
		const resetFolders = vi.fn();
		renderFolders({ resetFolders });

		click(one(".si-panel.blue .si-reset"));
		expect(resetFolders).toHaveBeenCalledTimes(1);
	});

	it("lists the left-out sub-folders in red under their parent with the size they save, and puts one back with its x", () => {
		const setSmartExcluded = vi.fn();
		renderFolders({
			setSmartExcluded,
			draft: { ...DRAFT, smartScope: [proposal("/docs/Telegram Desktop"), proposal("/docs/Zoom", { excluded: false }), proposal("/other/Cache", { root: "/other" })] },
		});

		const red = all(".si-panel.red .si-pill");
		expect(red).toHaveLength(1);
		expect(red[0]?.textContent).toContain("Documents /");
		expect(red[0]?.textContent).toContain("Telegram Desktop");
		expect(red[0]?.textContent).toContain("500 MB");
		expect(red[0]?.getAttribute("title")).toContain("Chat app downloads");
		expect(text(".si-panel.red .si-panel-meta")).toContain("count=1");

		click(one(".si-panel.red .si-pill-x"));
		expect(setSmartExcluded).toHaveBeenLastCalledWith("/docs/Telegram Desktop", false);
	});

	it("offers a left-in proposal as a ghost pill to leave out again, and adds a folder of the user's own from the dashed button", () => {
		const setSmartExcluded = vi.fn();
		const addExclusion = vi.fn();
		renderFolders({ setSmartExcluded, addExclusion, draft: { ...DRAFT, smartScope: [proposal("/docs/Zoom", { excluded: false })] } });

		const ghosts = all(".si-panel.red .si-ghost-pill");
		expect(ghosts.map((ghost) => ghost.textContent)).toEqual(["+ Zoom"]);
		click(ghosts[0] as HTMLElement);
		expect(setSmartExcluded).toHaveBeenLastCalledWith("/docs/Zoom", true);
		click(one(".si-panel.red .si-add-pill"));
		expect(addExclusion).toHaveBeenCalledTimes(1);
	});

	it("says what is always left out when nothing was proposed or all were put back", () => {
		renderFolders({ draft: { ...DRAFT, smartScope: [] } });

		expect(text(".si-panel.red .si-panel-foot")).toContain("onboarding.folders.policy.auto");
		expect(host.querySelector(".si-panel.red .si-pill")).toBeNull();
	});

	it("shows the time the left-out files save next to the new estimate", () => {
		renderFolders({
			scans: new Map([["/docs", { ...SCAN, files: 8500 }]]),
			draft: { ...DRAFT, smartScope: [proposal("/docs/Telegram Desktop", { files: 6800 })] },
		});

		expect(text(".si-eta-pill del")).toContain("minutes=100");
		expect(text(".si-eta-pill b")).toContain("minutes=20");
		expect(text(".si-eta-pill em")).toContain("percent=80");
	});

	it("shows the plain estimate when nothing is left out", () => {
		renderFolders({ scans: new Map([["/docs", { ...SCAN, files: 850 }]]) });

		expect(host.querySelector(".si-eta-pill del")).toBeNull();
		expect(text(".si-eta-pill b")).toContain("minutes=10");
	});

	it("goes back to the analysis from the policy bar", () => {
		const rescanSmart = vi.fn();
		renderFolders({ rescanSmart });

		click(one(".si-rescan"));
		expect(rescanSmart).toHaveBeenCalledTimes(1);
	});

	it("explains in plain words how the AI decides: what it looked at, what it keeps, what it leaves out, and that you decide", () => {
		renderFolders();

		click(one(".si-criteria-toggle"));
		const rules = all(".si-criteria li").map((item) => item.textContent ?? "");

		expect(rules.map((rule) => rule.replace(/ .*/u, ""))).toEqual([
			"onboarding.folders.criteria.looked",
			"onboarding.folders.criteria.keep",
			"onboarding.folders.criteria.leave",
			"onboarding.folders.criteria.doubt",
			"onboarding.folders.criteria.you",
		]);
	});

	it("tells the user what the AI could see, and what it could not", () => {
		renderFolders();

		click(one(".si-criteria-toggle"));
		const text = text0(".si-criteria");

		expect(text).toContain("onboarding.folders.criteria.looked");
		// Names, counts and dates only: the UI makes no claim about reading contents.
		expect(text).not.toMatch(/\d+%/u);
	});

	it("keeps the explanation folded until asked", () => {
		renderFolders();

		expect(host.querySelector(".si-criteria")).toBeNull();
		click(one(".si-criteria-toggle"));
		expect(host.querySelector(".si-criteria")).not.toBeNull();
		click(one(".si-criteria-toggle"));
		expect(host.querySelector(".si-criteria")).toBeNull();
	});
});
