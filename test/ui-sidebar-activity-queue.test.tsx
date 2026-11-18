// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarActivityQueue } from "../src/renderer/src/components/SidebarActivityQueue";
import { clearBackgroundTasksForTests, enqueueBackgroundTask } from "../src/renderer/src/hooks/useBackgroundTasks";
import { dismissErrorFixDialog, resetErrorFixStoreForTests, startErrorFix } from "../src/renderer/src/hooks/useErrorFix";
import { resetIndexActivityForTests } from "../src/renderer/src/hooks/useIndexActivity";
import { resetIndexProblemForTests } from "../src/renderer/src/hooks/useIndexProblem";
import { resetModelDownloadForTests } from "../src/renderer/src/state/model-download";
import type { ErrorFixEvent } from "../src/shared/error-fix-contract";
import { setAppLanguage } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import { NO_INDEX_PROBLEM, type IndexProblem } from "../src/shared/index-problem-contract";
import type { ModelDownloadStatus } from "../src/shared/model-download-contract";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let pushActivity: (snapshot: IndexActivitySnapshot) => void = () => undefined;
let pushProblem: (problem: IndexProblem) => void = () => undefined;
let pushErrorFix: (event: ErrorFixEvent) => void = () => undefined;
let pushModel: (status: ModelDownloadStatus) => void = () => undefined;

const IDLE_MODEL: ModelDownloadStatus = {
	state: "absent",
	bytesDone: 0,
	bytesTotal: 1_200_000_000,
	file: null,
	error: null,
};

beforeEach(async () => {
	await setAppLanguage("ko");
	clearBackgroundTasksForTests();
	resetErrorFixStoreForTests();
	resetIndexActivityForTests();
	resetIndexProblemForTests();
	resetModelDownloadForTests();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);

	Reflect.set(window, "autorag", {
		indexActivity: {
			get: vi.fn().mockResolvedValue(IDLE_INDEX_ACTIVITY),
			onChange: (listener: (snapshot: IndexActivitySnapshot) => void) => {
				pushActivity = listener;
				return () => undefined;
			},
		},
		indexProblem: {
			get: vi.fn().mockResolvedValue(NO_INDEX_PROBLEM),
			retry: vi.fn().mockResolvedValue(undefined),
			dismiss: vi.fn().mockResolvedValue(undefined),
			onChange: (listener: (problem: IndexProblem) => void) => {
				pushProblem = listener;
				return () => undefined;
			},
		},
		errorFix: {
			start: vi.fn(() => Promise.withResolvers<void>().promise),
			cancel: vi.fn().mockResolvedValue(undefined),
			onEvent: (listener: (event: ErrorFixEvent) => void) => {
				pushErrorFix = listener;
				return () => undefined;
			},
		},
		modelDownload: {
			get: vi.fn().mockResolvedValue(IDLE_MODEL),
			start: vi.fn().mockResolvedValue(IDLE_MODEL),
			cancel: vi.fn().mockResolvedValue(IDLE_MODEL),
			onChange: (listener: (status: ModelDownloadStatus) => void) => {
				pushModel = listener;
				return () => undefined;
			},
		},
	});
});

afterEach(async () => {
	act(() => {
		clearBackgroundTasksForTests();
		resetErrorFixStoreForTests();
		resetIndexActivityForTests();
		resetIndexProblemForTests();
		resetModelDownloadForTests();
		root.unmount();
	});
	host.remove();
	Reflect.deleteProperty(window, "autorag");
	vi.clearAllMocks();
});

async function renderQueue(props: { onOpenIndexing?: () => void; onOpenAiSettings?: () => void } = {}): Promise<void> {
	await act(async () => {
		root.render(
			<SidebarActivityQueue
				onOpenIndexing={props.onOpenIndexing ?? vi.fn()}
				onOpenAiSettings={props.onOpenAiSettings ?? vi.fn()}
			/>,
		);
	});
}

describe("SidebarActivityQueue (+N collapsed & hover-expandable stack)", () => {
	it("renders nothing when all background producers are idle", async () => {
		await renderQueue();
		expect(host.querySelector(".sidebar__activity")).toBeNull();
	});

	it("renders a single card without +N badge when only one task is active", async () => {
		await renderQueue();
		act(() => {
			pushActivity({
				state: "running",
				origin: "app",
				startedAt: "2026-11-02T00:00:00.000Z",
				finishedAt: null,
				fraction: 0.45,
				progress: null,
				error: null,
				items: [{ key: "local", kind: "local", id: null, state: "running", phase: "minsync", counts: null, error: null }],
			});
		});

		const cards = host.querySelectorAll(".sidebar__activity");
		expect(cards).toHaveLength(1);
		expect(cards[0]?.textContent).toContain("45%");
		expect(host.querySelector('[data-testid="sidebar-activity-badge"]')).toBeNull();
	});

	it("shows 1 primary card with +N badge when multiple indexing/error-fix/file tasks are queued, and expands on hover to show all without overwriting", async () => {
		const onOpenIndexing = vi.fn();
		const onOpenAiSettings = vi.fn();
		const onReopenReduce = vi.fn();
		await renderQueue({ onOpenIndexing, onOpenAiSettings });

		// 1) Queue local refresh + slack sync + kakao sync (3 items in indexActivity)
		act(() => {
			pushActivity({
				state: "running",
				origin: "app",
				startedAt: "2026-11-02T00:00:00.000Z",
				finishedAt: null,
				fraction: 0.6 / 3,
				progress: null,
				error: null,
				items: [
					{ key: "local", kind: "local", id: null, state: "running", phase: "minsync", counts: null, error: null },
					{ key: "source:slack", kind: "source", id: "slack", state: "queued", phase: null, counts: null, error: null },
					{ key: "source:kakao", kind: "source", id: "kakao", state: "queued", phase: null, counts: null, error: null },
				],
			});
			// 2) Start two AI error fixes in background
			startErrorFix("Missing folder /OldDocs");
			dismissErrorFixDialog();
			startErrorFix("Slack token expired");
			dismissErrorFixDialog();
			// 3) Enqueue a background file size reduction
			void enqueueBackgroundTask({
				id: "reduce-video",
				kind: "reduce-size",
				headline: "용량 줄이는 중 · demo.mp4",
				doneHeadline: "완료",
				failedHeadline: "실패",
				detail: "보통",
				onSelect: onReopenReduce,
				run: () => Promise.withResolvers<void>().promise,
			});
			// 4) Start model download in background
			pushModel({ ...IDLE_MODEL, state: "downloading", bytesDone: 300_000_000, bytesTotal: 1_200_000_000, file: "model.onnx" });
		});

		// Total items = 3 (indexing: local, slack, kakao) + 2 (error-fix) + 1 (reduce-size) + 1 (model-download) = 7 items -> primary + "+6"!
		expect(host.querySelectorAll(".sidebar__activity")).toHaveLength(1);
		const badge = host.querySelector('[data-testid="sidebar-activity-badge"]');
		expect(badge?.textContent).toBe("+6");
		expect(host.querySelector('[data-testid="sidebar-activity-popover"]')).toBeNull();

		// Hovering over the queue container expands the stack upward and reveals all 7 items!
		const container = host.querySelector<HTMLElement>('[data-testid="sidebar-activity-queue"]');
		expect(container).not.toBeNull();
		act(() => {
			container?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});

		const popover = host.querySelector('[data-testid="sidebar-activity-popover"]');
		expect(popover).not.toBeNull();
		const expandedCards = host.querySelectorAll<HTMLButtonElement>(".sidebar__activity");
		expect(expandedCards).toHaveLength(7);

		const allText = host.textContent ?? "";
		expect(allText).toContain("로컬 폴더");
		expect(allText).toContain("slack");
		expect(allText).toContain("kakao");
		expect(allText).toContain("demo.mp4");
		expect(allText).toContain("이 컴퓨터용 모델");
		// Verbose sub-descriptions stay in tooltips instead of crowding the narrow sidebar cards.
		expect(allText).not.toContain("검색 색인 만드는 중");
		expect(allText).not.toContain("진행 및 대기열");
		const localCard = [...expandedCards].find((card) => card.textContent?.includes("로컬 폴더"));
		expect(localCard?.getAttribute("title")).toContain("검색 색인 만드는 중");

		// Clicking individual cards routes to their respective owners.
		const modelCard = [...expandedCards].find((card) => card.textContent?.includes("이 컴퓨터용 모델"));
		act(() => modelCard?.click());
		expect(onOpenAiSettings).toHaveBeenCalledTimes(1);

		const reduceCard = [...expandedCards].find((card) => card.textContent?.includes("demo.mp4"));
		act(() => reduceCard?.click());
		expect(onReopenReduce).toHaveBeenCalledTimes(1);

		const slackCard = [...expandedCards].find((card) => card.textContent?.includes("slack"));
		act(() => slackCard?.click());
		expect(onOpenIndexing).toHaveBeenCalledTimes(1);

		// Leaving hover collapses back to single card + "+6" badge.
		act(() => {
			container?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
		});
		expect(host.querySelector('[data-testid="sidebar-activity-popover"]')).toBeNull();
		expect(host.querySelectorAll(".sidebar__activity")).toHaveLength(1);
	});

	it("keeps a persistent indexProblem alongside an unrelated datasource sync instead of overwriting either", async () => {
		await renderQueue();
		act(() => {
			pushProblem({
				failure: { reason: "embedder-offline", folders: [], code: null },
				skipped: 0,
				at: "2026-11-02T00:00:00.000Z",
				retrying: false,
			});
			pushActivity({
				state: "running",
				origin: "app",
				startedAt: "2026-11-02T00:01:00.000Z",
				finishedAt: null,
				fraction: null,
				progress: null,
				error: null,
				items: [{ key: "source:slack", kind: "source", id: "slack", state: "running", phase: null, counts: null, error: null }],
			});
		});

		expect(host.querySelector('[data-testid="sidebar-activity-badge"]')?.textContent).toBe("+1");
		const container = host.querySelector<HTMLElement>('[data-testid="sidebar-activity-queue"]');
		act(() => {
			container?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		});
		expect(host.querySelectorAll(".sidebar__activity")).toHaveLength(2);
		expect(host.textContent).toContain("slack");
		expect(host.textContent).toContain("연결 기다리는 중");
	});
});
