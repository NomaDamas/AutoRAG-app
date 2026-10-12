import { describe, expect, it } from "vitest";
import { IDLE_INDEX_ACTIVITY, type IndexActivityItem, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import { describeIndexActivity } from "../src/renderer/src/state/index-activity";
import { setAppLanguage, t } from "../src/shared/i18n";

function item(overrides: Partial<IndexActivityItem>): IndexActivityItem {
	return { key: "local", kind: "local", id: null, state: "running", phase: null, counts: null, error: null, ...overrides };
}

function snapshot(overrides: Partial<IndexActivitySnapshot>): IndexActivitySnapshot {
	return { ...IDLE_INDEX_ACTIVITY, state: "running", origin: "app", startedAt: "2026-10-10T12:00:00.000Z", ...overrides };
}

describe("describeIndexActivity", () => {
	it("shows nothing when idle", async () => {
		await setAppLanguage("ko");
		expect(describeIndexActivity(IDLE_INDEX_ACTIVITY, t)).toBeNull();
	});

	it("names the running phase and keeps the bar short of 100 while running", async () => {
		await setAppLanguage("ko");
		const view = describeIndexActivity(snapshot({ fraction: 0.999, items: [item({ phase: "minsync" })] }), t);
		expect(view).toMatchObject({ tone: "run", percent: 99, headline: "인덱싱 중", origin: null, detail: "로컬 폴더 · 검색 색인 만드는 중" });
	});

	it("counts items and lists the datasource that is running, with no percent when unknown", async () => {
		await setAppLanguage("ko");
		const view = describeIndexActivity(
			snapshot({
				fraction: null,
				origin: "scheduled",
				items: [item({ state: "done" }), item({ key: "source:slack", kind: "source", id: "slack" }), item({ key: "source:rss", kind: "source", id: "rss", state: "queued" })],
			}),
			t,
		);
		expect(view).toMatchObject({ percent: null, headline: "인덱싱 중 1/3", origin: "자동 새로 고침", detail: "slack 가져오는 중" });
	});

	it("reports done at 100 and failure with the failing item and its error", async () => {
		await setAppLanguage("ko");
		expect(describeIndexActivity(snapshot({ state: "done", fraction: 1, items: [item({ state: "done" })] }), t)).toMatchObject({ tone: "ok", percent: 100, headline: "인덱싱 완료" });
		const failed = describeIndexActivity(
			snapshot({ state: "failed", fraction: 1, error: "no token", items: [item({ key: "source:slack", kind: "source", id: "slack", state: "failed", error: "no token" })] }),
			t,
		);
		expect(failed).toMatchObject({ tone: "error", headline: "인덱싱 실패", detail: "slack — no token" });
	});
});
