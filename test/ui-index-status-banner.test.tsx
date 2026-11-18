// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexStatusBanner } from "../src/renderer/src/components/settings/IndexStatusBanner";
import { setAppLanguage } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import type { IndexProblem } from "../src/shared/index-problem-contract";
import type { ScheduledRunPause } from "../src/shared/settings-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const retry = vi.fn(async (): Promise<void> => undefined);
let problem: IndexProblem = { failure: null, skipped: 0, at: null, retrying: false };

Reflect.set(globalThis, "autorag", {
	indexProblem: { get: async (): Promise<IndexProblem> => problem, onChange: (): (() => void) => () => undefined, retry, dismiss: async () => undefined },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	retry.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const RAW = "http://127.0.0.1:49158 fetch failed";
const activity = (state: IndexActivitySnapshot["state"]): IndexActivitySnapshot => ({
	state,
	origin: "app",
	startedAt: "2026-10-24T05:00:00.000Z",
	finishedAt: state === "running" ? null : "2026-10-24T05:00:05.000Z",
	items: [{ key: "local", kind: "local", id: null, state: state === "failed" ? "failed" : state === "done" ? "done" : "running", phase: state === "running" ? "parsed" : null, counts: null, error: state === "failed" ? RAW : null }],
	fraction: state === "running" ? 0.3 : 1,
	progress: null,
	error: state === "failed" ? RAW : null,
});

const NONE: IndexProblem = { failure: null, skipped: 0, at: null, retrying: false };

async function render(
	snapshot: IndexActivitySnapshot,
	next: IndexProblem,
	extra: { readonly totals?: { readonly indexed: number; readonly targets: number } | null; readonly paused?: ScheduledRunPause | null; readonly lastRunAt?: string | null } = {},
): Promise<void> {
	problem = next;
	act(() => root.render(<IndexStatusBanner snapshot={snapshot} totals={extra.totals ?? null} paused={extra.paused ?? null} lastRunAt={extra.lastRunAt ?? null} />));
	await act(async () => {
		await Promise.resolve();
	});
}

const offline: IndexProblem = { failure: { reason: "embedder-offline", folders: [], code: null }, skipped: 0, at: "2026-10-24T05:00:05.000Z", retrying: false };

describe("진행 상황 banner with a problem the last run left behind", () => {
	it("shows the problem instead of the failed run's own echo, so the raw error never reaches Settings", async () => {
		await render(activity("failed"), offline);
		expect(host.textContent).toContain("인덱싱 멈춤");
		expect(host.textContent).not.toContain("fetch failed");
		expect(host.textContent).toContain("지금 다시 시도");
	});

	it("shows the problem when nothing has run for a while, in the stopped tone", async () => {
		await render(IDLE_INDEX_ACTIVITY, offline);
		expect(host.textContent).toContain("인덱싱 멈춤");
		expect(host.querySelector('[data-tone="stop"]')).not.toBeNull();
	});

	it("keeps showing the run while one is in flight, whatever is recorded", async () => {
		await render(activity("running"), offline);
		expect(host.textContent).not.toContain("인덱싱 멈춤");
		expect(host.querySelector('[data-tone="run"]')).not.toBeNull();
		expect(host.querySelector(".index-status-title")?.textContent).toBe("문서 읽는 중");
	});

	it("retries from the card's button", async () => {
		await render(IDLE_INDEX_ACTIVITY, offline);
		const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "지금 다시 시도");
		act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(retry).toHaveBeenCalledTimes(1);
	});
});

describe("진행 상황 banner (Figma 596:18346, 601:4495, 601:4870)", () => {
	it("says indexing is done, how long ago, and counts every file read", async () => {
		await render(IDLE_INDEX_ACTIVITY, NONE, { totals: { indexed: 1326, targets: 1326 }, lastRunAt: new Date().toISOString() });
		expect(host.querySelector(".index-status-title")?.textContent).toBe("인덱싱 완료");
		expect(host.querySelector(".index-status-note")?.textContent).toBe("방금 전");
		expect(host.querySelector(".index-status-count")?.textContent).toBe("1,326/1,326개");
		expect(host.querySelector('[data-tone="ok"]')).not.toBeNull();
	});

	it("says it stopped in red, and why, when the schedule held it back on battery", async () => {
		await render(IDLE_INDEX_ACTIVITY, NONE, { totals: { indexed: 450, targets: 1326 }, paused: { reason: "battery", at: new Date().toISOString() } });
		expect(host.querySelector(".index-status-title")?.textContent).toBe("인덱싱 중지됨");
		expect(host.querySelector(".index-status-note")?.textContent).toBe("전원을 연결하면 이어서 진행합니다.");
		expect(host.querySelector(".index-status-count")?.textContent).toBe("450/1,326개");
		expect(host.querySelector('[data-tone="stop"]')).not.toBeNull();
	});

	it("shows no stage strip, only the title, the note and the count", async () => {
		await render(activity("running"), NONE, { totals: { indexed: 450, targets: 1326 } });
		expect(host.textContent).not.toContain("탐색파싱");
		expect(host.querySelectorAll(".index-status > *")).toHaveLength(2);
	});
});
