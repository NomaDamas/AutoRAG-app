import { beforeEach, describe, expect, it } from "vitest";
import { describeIndexProgress, formatAgo, formatDuration, progressTranslate } from "../src/renderer/src/state/index-progress";
import { setAppLanguage, t } from "../src/shared/i18n";
import { computeIndexProgress, EMPTY_RATE_HISTORY, STALL_AFTER_MS, type IndexProgressInput } from "../src/shared/index-progress";

const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const MIN = 60_000;
const tr = progressTranslate(t);

function input(overrides: Partial<IndexProgressInput> = {}): IndexProgressInput {
	return {
		state: "running",
		phase: "minsync",
		sourceTotal: 29_595,
		parsed: { scanned: 29_595, written: 29_595, deleted: 0, skipped: 0 },
		minsync: { total: 29_595 },
		journal: { committed: 12_950, deleted: 0, failed: 0, bytesDone: 4_255_000_000, lastFile: "report.pdf", modifiedAt: T0 },
		embedBytesTotal: 18_500_000_000,
		heartbeatAt: T0,
		now: T0,
		...overrides,
	};
}

beforeEach(async () => {
	await setAppLanguage("ko");
});

describe("describeIndexProgress", () => {
	it("words the 0.1.7 case with its real counts, bytes and a calculating estimate", () => {
		const { snapshot } = computeIndexProgress(input());
		const view = describeIndexProgress(snapshot, T0, tr);
		expect(view.stageName).toBe("임베딩");
		expect(view.countLine).toBe(`임베딩 ${(12_950).toLocaleString()} / ${(29_595).toLocaleString()}개 파일 (44%)`);
		expect(view.bytesLine).toBe("용량 4.0 GB / 17 GB (23%)");
		expect(view.etaLine).toBe("임베딩 남은 시간 계산 중");
		expect(view.activityLine).toBe("마지막 완료 방금 · report.pdf · 활동 신호 방금");
		expect(view.stages.map((stage) => [stage.label, stage.state])).toEqual([
			["탐색", "done"],
			["파싱", "done"],
			["임베딩", "running"],
			["마무리", "pending"],
		]);
	});

	it("gives the remaining time once the rate is known, and names the stage it is about", () => {
		const first = computeIndexProgress(input({ journal: { committed: 0, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null } }));
		const second = computeIndexProgress(
			input({ now: T0 + 2 * MIN, journal: { committed: 100, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: T0 + 2 * MIN }, embedBytesTotal: null }),
			first.history,
		);
		const view = describeIndexProgress(second.snapshot, T0 + 2 * MIN, tr);
		// 100 files in 2 minutes, 29,495 left: about 590 minutes.
		expect(view.etaLine).toBe("임베딩 약 9시간 50분 남음");
	});

	it("counts skipped and failed files apart", () => {
		const { snapshot } = computeIndexProgress(input({ journal: { committed: 90, deleted: 0, failed: 10, bytesDone: null, lastFile: null, modifiedAt: null }, embedBytesTotal: null }));
		const view = describeIndexProgress(snapshot, T0, tr);
		expect(view.extraLine).toBe("실패 10개");
		expect(view.bytesLine).toBeNull();
		const parse = computeIndexProgress(input({ phase: "parsed", minsync: null, journal: null, sourceTotal: 400, parsed: { scanned: 100, written: 70, deleted: 0, skipped: 20 } }));
		expect(describeIndexProgress(parse.snapshot, T0, tr).extraLine).toBe("건너뜀 20개");
	});

	it("has no percent and no estimate for the stages that cannot be counted", () => {
		const discover = describeIndexProgress(computeIndexProgress(input({ phase: "parsed", sourceTotal: null, parsed: null, minsync: null, journal: null })).snapshot, T0, tr);
		expect(discover).toMatchObject({ stageName: "탐색", stagePercent: null, countLine: "파일을 찾는 중", etaLine: null });
		const finalize = describeIndexProgress(computeIndexProgress(input({ phase: "jikji" })).snapshot, T0, tr);
		expect(finalize).toMatchObject({ stageName: "마무리", stagePercent: null, countLine: "검색 인덱스를 마무리하는 중", etaLine: null });
	});

	it("warns that the run may be stalled, and says whether the work signal is still arriving", () => {
		const stalled = (heartbeatAt: number) => {
			const start = computeIndexProgress(input({ now: T0, heartbeatAt: T0, journal: { committed: 500, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null } }), EMPTY_RATE_HISTORY);
			const now = T0 + STALL_AFTER_MS + MIN;
			const later = computeIndexProgress(input({ now, heartbeatAt, journal: { committed: 500, deleted: 0, failed: 0, bytesDone: null, lastFile: null, modifiedAt: null } }), start.history);
			return describeIndexProgress(later.snapshot, now, tr).warning;
		};
		expect(stalled(T0 + STALL_AFTER_MS + MIN - 5_000)).toContain("작업 신호는 계속 들어오고 있어서");
		expect(stalled(T0)).toContain("작업 신호도 끊겼어요");
		expect(stalled(T0)).toContain("11분째");
	});
});

describe("formatDuration and formatAgo", () => {
	it("rounds to the unit that fits the span", () => {
		expect(formatDuration(1, tr)).toBe("1분");
		expect(formatDuration(59, tr)).toBe("59분");
		expect(formatDuration(60, tr)).toBe("1시간");
		expect(formatDuration(125, tr)).toBe("2시간 5분");
		expect(formatDuration(47 * 60 + 40, tr)).toBe("47시간 40분");
		expect(formatDuration(3 * 1440, tr)).toBe("3일");
	});

	it("says how long ago, from just now to hours", () => {
		const at = (offset: number) => formatAgo(new Date(T0 - offset).toISOString(), T0, tr);
		expect(at(2_000)).toBe("방금");
		expect(at(30_000)).toBe("30초 전");
		expect(at(5 * MIN)).toBe("5분 전");
		expect(at(3 * 60 * MIN)).toBe("3시간 전");
	});
});
