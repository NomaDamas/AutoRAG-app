// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StalledWarning } from "../src/renderer/src/components/StalledWarning";
import { IndexActivityCard } from "../src/renderer/src/components/settings/IndexActivityCard";
import { describeIndexActivity } from "../src/renderer/src/state/index-activity";
import { collectSidebarActivities } from "../src/renderer/src/state/sidebar-activity-queue";
import { NO_INDEX_PROBLEM } from "../src/shared/index-problem-contract";
import { setAppLanguage, t } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import { computeIndexProgress, EMPTY_RATE_HISTORY, STALL_AFTER_MS, type IndexProgressInput } from "../src/shared/index-progress";
import type { IndexProgressSnapshot } from "../src/shared/index-progress-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(globalThis, "autorag", {
	indexProblem: { get: async () => NO_INDEX_PROBLEM, onChange: (): (() => void) => () => undefined, retry: async () => undefined, dismiss: async () => undefined },
});

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

function activity(progress: IndexProgressSnapshot): IndexActivitySnapshot {
	return {
		...IDLE_INDEX_ACTIVITY,
		state: "running",
		origin: "app",
		startedAt: new Date(T0).toISOString(),
		items: [{ key: "local", kind: "local", id: null, state: "running", phase: "minsync", counts: null, error: null }],
		fraction: progress.indeterminate ? null : progress.fraction,
		progress,
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

describe("Settings > Indexing and the sidebar read the same snapshot", () => {
	it("prints the stage lines under the bar in Settings", async () => {
		const snapshot = activity(computeIndexProgress(realCase()).snapshot);
		await act(async () => {
			root.render(<IndexActivityCard snapshot={snapshot} />);
			await Promise.resolve();
		});
		const detail = host.querySelector('[data-testid="index-progress-detail"]')?.textContent ?? "";
		expect(detail).toContain("탐색파싱임베딩마무리");
		expect(detail).toContain(`임베딩 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`);
		expect(detail).toContain("용량 4.0 GB / 17 GB (23%)");
		expect(host.querySelector('[aria-current="step"]')?.textContent).toBe("임베딩");
	});

	it("gives the sidebar the same percent as Settings and the same counts in its tooltip", () => {
		const snapshot = activity(computeIndexProgress(realCase()).snapshot);
		const view = describeIndexActivity(snapshot, t);
		const [entry] = collectSidebarActivities({
			indexActivity: snapshot,
			indexProblem: NO_INDEX_PROBLEM,
			errorFix: { sessions: [], activeId: null },
			backgroundTasks: [],
			modelDownload: { state: "absent", bytesDone: 0, bytesTotal: 0, file: null, error: null },
			t,
			onOpenIndexing: () => undefined,
			onOpenErrorFix: () => undefined,
		});
		expect(entry?.percent).toBe(view?.percent);
		expect(entry?.percent).toBe(28);
		expect(entry?.title).toContain(`임베딩 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`);
		expect(entry?.title).toContain("용량 4.0 GB / 17 GB (23%)");
	});

	it("marks the stage the run is on as the one current step while MinSync's stage also works alongside parsing", async () => {
		const snapshot = activity(
			computeIndexProgress(realCase({ phase: "parsed", parsed: { scanned: 87, written: 87, deleted: 0, skipped: 0 }, sourceTotal: 120, minsync: { synced: 25, total: 83 }, journal: null, embedBytesTotal: null })).snapshot,
		);
		await act(async () => {
			root.render(<IndexActivityCard snapshot={snapshot} />);
			await Promise.resolve();
		});
		const stages = [...host.querySelectorAll(".settings-activity-stages li")].map((item) => [item.textContent, item.getAttribute("data-state")]);
		expect(stages).toEqual([
			["탐색", "done"],
			["파싱", "running"],
			["임베딩", "running"],
			["마무리", "pending"],
		]);
		expect(host.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
		expect(host.querySelector('[aria-current="step"]')?.textContent).toBe("파싱");
	});

	it("calls MinSync's step the same thing in Settings and the sidebar when nothing is embedded", async () => {
		const snapshot = activity(computeIndexProgress(realCase({ embedding: false })).snapshot);
		await act(async () => {
			root.render(<IndexActivityCard snapshot={snapshot} />);
			await Promise.resolve();
		});
		const detail = host.querySelector('[data-testid="index-progress-detail"]')?.textContent ?? "";
		const counts = `키워드 색인 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`;
		expect(detail).toContain("탐색파싱키워드 색인마무리");
		expect(detail).toContain(counts);
		expect(host.querySelector('[aria-current="step"]')?.textContent).toBe("키워드 색인");
		const [entry] = collectSidebarActivities({
			indexActivity: snapshot,
			indexProblem: NO_INDEX_PROBLEM,
			errorFix: { sessions: [], activeId: null },
			backgroundTasks: [],
			modelDownload: { state: "absent", bytesDone: 0, bytesTotal: 0, file: null, error: null },
			t,
			onOpenIndexing: () => undefined,
			onOpenErrorFix: () => undefined,
		});
		expect(entry?.title).toContain(counts);
		// A measured stage, so a number, not the indeterminate bar the final tidy-up gets.
		expect(entry?.percent).toBe(28);
		expect(`${detail}${entry?.title ?? ""}`).not.toContain("임베딩");
	});

	it("shows an indeterminate bar in both while the final stage runs", () => {
		const snapshot = activity(computeIndexProgress(realCase({ phase: "jikji" })).snapshot);
		expect(snapshot.fraction).toBeNull();
		const [entry] = collectSidebarActivities({
			indexActivity: snapshot,
			indexProblem: NO_INDEX_PROBLEM,
			errorFix: { sessions: [], activeId: null },
			backgroundTasks: [],
			modelDownload: { state: "absent", bytesDone: 0, bytesTotal: 0, file: null, error: null },
			t,
			onOpenIndexing: () => undefined,
			onOpenErrorFix: () => undefined,
		});
		expect(entry?.percent).toBeNull();
		expect(describeIndexActivity(snapshot, t)?.percent).toBeNull();
	});
});

describe("the stalled warning", () => {
	const alerts = (): string[] => [...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent ?? "");
	const line = (): string => host.querySelector('[data-testid="stalled"]')?.textContent ?? "";
	function show(warning: string | null, warningKind: "alive" | "silent" | null): void {
		act(() => root.render(<StalledWarning view={{ warning, warningKind }} testId="stalled" />));
	}

	it("announces the warning once and does not read the growing minute count out again", () => {
		show("11분째 끝난 파일이 없어요.", "alive");
		expect(alerts()).toEqual(["11분째 끝난 파일이 없어요."]);
		expect(host.querySelector('[data-testid="stalled"]')?.getAttribute("aria-hidden")).toBe("true");
		// A minute later the visible line says 12; the live region keeps its words, so nothing is announced.
		show("12분째 끝난 파일이 없어요.", "alive");
		show("13분째 끝난 파일이 없어요.", "alive");
		expect(line()).toBe("13분째 끝난 파일이 없어요.");
		expect(alerts()).toEqual(["11분째 끝난 파일이 없어요."]);
	});

	it("reaches Settings > Indexing as the same single alert", async () => {
		const quiet = { committed: 500, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null };
		const start = computeIndexProgress(realCase({ now: T0, heartbeatAt: T0, journal: quiet }), EMPTY_RATE_HISTORY);
		const later = T0 + STALL_AFTER_MS + 60_000;
		const stalled = computeIndexProgress(realCase({ now: later, heartbeatAt: later - 5_000, journal: quiet }), start.history).snapshot;
		vi.useFakeTimers({ now: later });
		try {
			await act(async () => {
				root.render(<IndexActivityCard snapshot={activity(stalled)} />);
				await Promise.resolve();
			});
		} finally {
			vi.useRealTimers();
		}
		expect(host.querySelector('[data-testid="index-progress-stalled"]')?.getAttribute("aria-hidden")).toBe("true");
		expect(alerts()).toHaveLength(1);
		expect(alerts()[0]).toContain("11분째 끝난 파일이 없어요");
	});

	it("announces again when the situation changes, and not at all once the warning is gone", () => {
		show("11분째 끝난 파일이 없어요. 작업 신호는 계속 들어오고 있어요.", "alive");
		show("14분째 끝난 파일이 없고 작업 신호도 끊겼어요.", "silent");
		expect(alerts()).toEqual(["14분째 끝난 파일이 없고 작업 신호도 끊겼어요."]);
		show(null, null);
		expect(alerts()).toEqual([]);
		expect(line()).toBe("");
		// A warning that comes back later is a new one.
		show("10분째 끝난 파일이 없어요.", "alive");
		expect(alerts()).toEqual(["10분째 끝난 파일이 없어요."]);
	});
});
