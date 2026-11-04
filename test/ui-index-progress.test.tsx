// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexActivityCard } from "../src/renderer/src/components/settings/IndexActivityCard";
import { describeIndexActivity } from "../src/renderer/src/state/index-activity";
import { collectSidebarActivities } from "../src/renderer/src/state/sidebar-activity-queue";
import { NO_INDEX_PROBLEM } from "../src/shared/index-problem-contract";
import { setAppLanguage, t } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import { computeIndexProgress, type IndexProgressInput } from "../src/shared/index-progress";
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
		expect(entry?.percent).toBe(61);
		expect(entry?.title).toContain(`임베딩 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`);
		expect(entry?.title).toContain("용량 4.0 GB / 17 GB (23%)");
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
		expect(entry?.percent).toBe(61);
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
