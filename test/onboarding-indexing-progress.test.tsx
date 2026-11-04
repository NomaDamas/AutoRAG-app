// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import type { Translate } from "../src/renderer/src/onboarding/flow";
import { IndexingScreen } from "../src/renderer/src/onboarding/IndexingScreen";
import { setAppLanguage, t } from "../src/shared/i18n";
import { computeIndexProgress, EMPTY_RATE_HISTORY, STALL_AFTER_MS, type IndexProgressInput } from "../src/shared/index-progress";
import type { IndexProgressSnapshot } from "../src/shared/index-progress-contract";
import type { IndexingStatus } from "../src/shared/onboarding-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const T0 = Date.parse("2026-10-20T09:00:00.000Z");

/** The 0.1.7 case: 12,950 of 29,595 files embedded while the screen said "95%, under a minute". */
function realCase(overrides: Partial<IndexProgressInput> = {}): IndexProgressInput {
	return {
		state: "running",
		phase: "minsync",
		sourceTotal: 29_595,
		parsed: { scanned: 29_595, written: 29_595, deleted: 0, skipped: 0 },
		minsync: { total: 29_595 },
		journal: { committed: 12_950, deleted: 0, failed: 0, bytesDone: 4_255_000_000, lastFile: "report.pdf", modifiedAt: Date.now() },
		embedBytesTotal: 18_500_000_000,
		heartbeatAt: Date.now(),
		now: Date.now(),
		...overrides,
	};
}

function status(progress: IndexProgressSnapshot): IndexingStatus {
	return {
		state: "running",
		phase: "minsync",
		progress: progress.fraction * 100,
		remainingMinutes: progress.etaMinutes,
		totalFiles: 29_595,
		processedFiles: 29_595,
		recentFile: null,
		recentFolder: null,
		failure: null,
		skipped: 0,
		detail: progress,
		sources: [],
		startedAt: new Date(T0).toISOString(),
		finishedAt: null,
		error: null,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const text = (): string => host.textContent ?? "";

describe("the first-run indexing screen", () => {
	function barFill(): HTMLElement {
		const fill = host.querySelector<HTMLElement>(".ix-bar > span");
		if (fill === null) throw new Error("the bar has no fill");
		return fill;
	}

	function renderScreen(next: IndexingStatus): void {
		const ctx: OnboardingCtx = onboardingCtx({ draft: { ...BASE_DRAFT, stepId: "indexing" }, indexStatus: next, t: t as unknown as Translate });
		act(() => root.render(<IndexingScreen ctx={ctx} />));
	}

	it("shows the journal's counts and bytes instead of 95% and under a minute", () => {
		renderScreen(status(computeIndexProgress(realCase()).snapshot));
		const detail = host.querySelector('[data-testid="ix-detail"]')?.textContent ?? "";
		expect(detail).toContain(`임베딩 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`);
		expect(detail).toContain("용량 4.0 GB / 17 GB (23%)");
		expect(detail).toContain("마지막 완료");
		expect(detail).toContain("report.pdf");
		expect(host.querySelector(".ix-meta")?.textContent).toContain("61%");
		expect(host.querySelector(".ix-meta")?.textContent).toContain("임베딩 남은 시간 계산 중");
		expect(text()).not.toContain("95%");
		expect(text()).not.toContain("1분 미만");
		expect(host.querySelector(".ix-bar")?.classList.contains("waiting")).toBe(false);
		// The read stage's 40% plus 44% of the embedding stage's 50%.
		expect(Number.parseFloat(barFill().style.width)).toBeCloseTo(61.88, 1);
	});

	it("steps discover, parse, embed, finalize on the strip", () => {
		renderScreen(status(computeIndexProgress(realCase()).snapshot));
		const phases = [...host.querySelectorAll(".ix-phase")].map((el) => [el.textContent, el.classList.contains("done"), el.classList.contains("active")]);
		expect(phases).toEqual([
			["탐색", true, false],
			["파싱", true, false],
			["임베딩", false, true],
			["마무리", false, false],
		]);
	});

	it("draws a stage it cannot measure as working rather than as a percent", () => {
		renderScreen(status(computeIndexProgress(realCase({ phase: "jikji" })).snapshot));
		expect(host.querySelector(".ix-bar")?.classList.contains("waiting")).toBe(true);
		expect(host.querySelector(".ix-bar")?.hasAttribute("aria-valuenow")).toBe(false);
		// The stylesheet fills the working bar; an inline width would only be beaten by `!important`.
		expect(barFill().style.width).toBe("");
		expect(host.querySelector(".ix-meta b")?.textContent).toBe("마무리");
		expect(text()).not.toMatch(/9\d%/);
	});

	it("warns that the run may be stalled after ten quiet minutes", () => {
		const start = computeIndexProgress(realCase({ now: T0, heartbeatAt: T0, journal: { committed: 500, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null } }), EMPTY_RATE_HISTORY);
		const later = computeIndexProgress(
			realCase({ now: T0 + STALL_AFTER_MS + 60_000, heartbeatAt: T0 + STALL_AFTER_MS + 55_000, journal: { committed: 500, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null } }),
			start.history,
		);
		expect(later.snapshot.pulse.stalled).toBe(true);
		vi.useFakeTimers({ now: T0 + STALL_AFTER_MS + 60_000 });
		renderScreen(status(later.snapshot));
		vi.useRealTimers();
		expect(host.querySelector('[data-testid="ix-stalled"]')?.textContent).toContain("11분째 끝난 파일이 없어요");
		expect(host.querySelector('[data-testid="ix-stalled"]')?.getAttribute("role")).toBe("alert");
	});
});

