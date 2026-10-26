// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexingScreen } from "../src/renderer/src/onboarding/IndexingScreen";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import type { IndexFailure } from "../src/shared/index-failure";
import type { IndexingStatus } from "../src/shared/onboarding-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

const PAUSE = "onboarding.indexing.pause";

const status = (patch: Partial<IndexingStatus>): IndexingStatus => ({
	state: "running",
	phase: null,
	progress: 0,
	remainingMinutes: null,
	totalFiles: 100,
	processedFiles: 0,
	recentFile: null,
	recentFolder: null,
	failure: null,
	skipped: 0,
	sources: [],
	startedAt: "2026-10-24T05:00:00.000Z",
	finishedAt: null,
	error: null,
	...patch,
});

let stops = 0;
const stopped = (failure: IndexFailure, progress = 0): IndexingStatus => {
	stops += 1;
	return status({ state: "failed", failure, progress, error: "raw error", finishedAt: `2026-10-24T05:00:0${stops}.000Z` });
};
const failure = (reason: IndexFailure["reason"], folders: readonly string[] = []): IndexFailure => ({ reason, folders, code: null });

function render(overrides: Partial<OnboardingCtx>): OnboardingCtx {
	const ctx = onboardingCtx({ draft: { ...BASE_DRAFT, stepId: "indexing" }, ...overrides });
	act(() => root.render(<IndexingScreen ctx={ctx} />));
	return ctx;
}

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>(".ix-cta, .ix-links button")];
const cta = (): HTMLButtonElement => {
	const element = host.querySelector<HTMLButtonElement>(".ix-cta");
	if (element === null) throw new Error("no button");
	return element;
};
const click = (element: HTMLElement): void => {
	act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const line = (): string => host.querySelector(".ix-sub")?.textContent ?? "";

describe("the first-index pause screen", () => {
	it("shows one button and the other ways on as links, and never the running screen's estimates", () => {
		render({ indexStatus: stopped(failure("embedder-config")) });
		expect(host.querySelector(".ix.paused")).not.toBeNull();
		expect(buttons().map((button) => button.textContent?.replace("↵", "").trim())).toEqual([
			`${PAUSE}.exit.changeEmbedding`,
			`${PAUSE}.exit.retry`,
		]);
		expect(host.querySelectorAll(".ix-cta")).toHaveLength(1);
		// #283: a stopped run has no ETA, no phase strip, no locked gate.
		expect(host.textContent).not.toContain("metaEstimating");
		expect(host.querySelector(".ix-phases, .ix-meta, .ix-gate")).toBeNull();
		// Nothing of the raw error reaches the screen.
		expect(host.textContent).not.toContain("raw error");
	});

	it("opens the embedding choice from the button of a refused embedder", () => {
		const changeEmbedding = vi.fn();
		render({ indexStatus: stopped(failure("embedder-config")), changeEmbedding });
		click(cta());
		expect(changeEmbedding).toHaveBeenCalledOnce();
	});

	it("offers no way to open Dazzi early from any kind of stop: the Finder is already open beside it", () => {
		for (const reason of ["embedder-config", "embedder-offline", "model-download", "disk-full", "folder-unreadable", "unknown"] as const) {
			render({ indexStatus: stopped(failure(reason, reason === "folder-unreadable" ? ["/Volumes/Work/Projects"] : [])) });
			expect(buttons().some((button) => button.textContent?.includes("exit.openAnyway")), reason).toBe(false);
			expect(host.textContent, reason).not.toContain("onboarding.indexing.startInBackground");
		}
	});

	it("leaves exactly the unreadable folders out when asked", () => {
		const excludeFolders = vi.fn();
		render({ indexStatus: stopped(failure("folder-unreadable", ["/Volumes/Work/Projects"])), excludeFolders });
		const exclude = buttons().find((button) => button.textContent?.includes("exit.exclude"));
		click(exclude as HTMLElement);
		expect(excludeFolders).toHaveBeenCalledWith(["/Volumes/Work/Projects"]);
	});

	it("presses the button on Enter, wherever focus is", () => {
		const startIndexing = vi.fn();
		render({ indexStatus: stopped(failure("unknown")), startIndexing });
		(document.activeElement as HTMLElement | null)?.blur();
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(startIndexing).toHaveBeenCalledOnce();
	});

	it("shows how far the run got, and no bar when nothing was read yet", () => {
		render({ indexStatus: stopped(failure("unknown"), 64) });
		expect(host.querySelector(".ix-bar")?.getAttribute("aria-valuenow")).toBe("64");
		render({ indexStatus: stopped(failure("embedder-config"), 0) });
		expect(host.querySelector(".ix-bar")).toBeNull();
	});

	it("keeps the pause up while a retry connects, then shows the run once it reads", () => {
		const startIndexing = vi.fn();
		const base = { startIndexing };
		render({ ...base, indexStatus: stopped(failure("unknown")) });
		click(cta());
		expect(startIndexing).toHaveBeenCalledOnce();
		render({ ...base, indexStatus: status({ state: "running", phase: null }) });
		expect(host.querySelector(".ix.paused")).not.toBeNull();
		expect(line()).toBe(`${PAUSE}.line.retrying`);
		render({ ...base, indexStatus: status({ state: "running", phase: "parsed", progress: 3 }) });
		expect(host.querySelector(".ix.paused")).toBeNull();
		expect(host.querySelector(".ix-phases")).not.toBeNull();
	});

	it("moves the button off 'retry' after a retry from here stops again, and says so", () => {
		const startIndexing = vi.fn();
		const base = { startIndexing };
		render({ ...base, indexStatus: stopped(failure("unknown")) });
		expect(cta().textContent).toContain("exit.retry");
		click(cta());
		render({ ...base, indexStatus: status({ state: "running" }) });
		render({ ...base, indexStatus: stopped(failure("unknown")) });
		expect(cta().textContent).toContain("exit.changeEmbedding");
		expect(line()).toBe(`${PAUSE}.line.again`);
		expect(host.querySelector(".ix-sub.again")).not.toBeNull();
	});

	it("does not count a different reason as the same thing stopping again", () => {
		const startIndexing = vi.fn();
		const base = { startIndexing };
		render({ ...base, indexStatus: stopped(failure("unknown")) });
		click(cta());
		render({ ...base, indexStatus: status({ state: "running" }) });
		render({ ...base, indexStatus: stopped(failure("disk-full")) });
		expect(cta().textContent).toContain("exit.resumeDisk");
		expect(line()).toBe(`${PAUSE}.disk.line`);
	});

	it("retries an offline embedder by itself and counts down on the reason line", () => {
		const startIndexing = vi.fn();
		render({ indexStatus: stopped(failure("embedder-offline")), startIndexing });
		expect(line()).toBe(`${PAUSE}.line.countdown seconds=8`);
		act(() => vi.advanceTimersByTime(3000));
		expect(line()).toBe(`${PAUSE}.line.countdown seconds=5`);
		expect(startIndexing).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(5000));
		expect(startIndexing).toHaveBeenCalledOnce();
	});

	it("stops retrying by itself after six tries and hands the choice back", () => {
		const startIndexing = vi.fn();
		const base = { startIndexing };
		for (let attempt = 0; attempt < 6; attempt += 1) {
			render({ ...base, indexStatus: stopped(failure("embedder-offline")) });
			act(() => vi.advanceTimersByTime(8000));
			render({ ...base, indexStatus: status({ state: "running" }) });
		}
		expect(startIndexing).toHaveBeenCalledTimes(6);
		render({ ...base, indexStatus: stopped(failure("embedder-offline")) });
		expect(line()).toBe(`${PAUSE}.line.exhausted`);
		act(() => vi.advanceTimersByTime(60_000));
		expect(startIndexing).toHaveBeenCalledTimes(6);
		expect(cta().textContent).toContain("exit.changeEmbedding");
	});

	it("never retries by itself for a refused embedder or a full disk", () => {
		const startIndexing = vi.fn();
		render({ indexStatus: stopped(failure("embedder-config")), startIndexing });
		act(() => vi.advanceTimersByTime(60_000));
		render({ indexStatus: stopped(failure("disk-full")), startIndexing });
		act(() => vi.advanceTimersByTime(60_000));
		expect(startIndexing).not.toHaveBeenCalled();
	});

	it("looks at an unreadable folder again every 3 seconds", () => {
		const startIndexing = vi.fn();
		render({ indexStatus: stopped(failure("folder-unreadable", ["/Volumes/Work/Projects"])), startIndexing });
		act(() => vi.advanceTimersByTime(3000));
		expect(startIndexing).toHaveBeenCalledOnce();
	});
});

describe("a first index that finished with files left out", () => {
	it("says how many files were skipped, and counts only what was read", () => {
		render({ indexStatus: status({ state: "success", progress: 100, totalFiles: 120, skipped: 22, finishedAt: "2026-10-24T05:40:00.000Z" }) });
		expect(host.querySelector(".ix-skippill")?.textContent).toContain("onboarding.indexing.skipped count=22");
		expect(host.textContent).toContain("onboarding.indexing.metaFiles count=98");
		expect(host.textContent).toContain("onboarding.indexing.gateOkDetailPartial");
	});

	it("shows no skipped line when nothing was skipped", () => {
		render({ indexStatus: status({ state: "success", progress: 100, totalFiles: 120, skipped: 0, finishedAt: "2026-10-24T05:40:00.000Z" }) });
		expect(host.querySelector(".ix-skippill")).toBeNull();
	});
});

describe("the first-index screen has no way to open Dazzi", () => {
	const OPEN_KEYS = ["onboarding.indexing.open", "onboarding.indexing.startInBackground", "onboarding.indexing.gateLocked"];

	it("shows no open, background-start, or locked button while the index runs", () => {
		render({ indexStatus: status({ state: "running", phase: "parsed", progress: 12 }) });
		expect(host.querySelector(".ix-open-btn, .ix-bg-start")).toBeNull();
		for (const key of OPEN_KEYS) expect(host.textContent, key).not.toContain(key);
		expect(host.querySelector(".ix-phases")).not.toBeNull();
	});

	it("shows no open button once the index is done, only the result", () => {
		render({ indexStatus: status({ state: "success", progress: 100, totalFiles: 120, skipped: 0, finishedAt: "2026-10-24T05:40:00.000Z" }) });
		expect(host.querySelector(".ix-open-btn, .ix-bg-start")).toBeNull();
		expect(host.querySelector(".ix-gate button")).toBeNull();
		expect(host.textContent).toContain("onboarding.indexing.gateOkTitle");
		for (const key of OPEN_KEYS) expect(host.textContent, key).not.toContain(key);
	});
});
