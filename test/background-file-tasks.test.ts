import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelBackgroundTask,
	clearBackgroundTasksForTests,
	enqueueBackgroundTask,
	getBackgroundTasksSnapshot,
	updateBackgroundTaskProgress,
} from "../src/renderer/src/hooks/useBackgroundTasks";

beforeEach(() => {
	vi.useFakeTimers();
	clearBackgroundTasksForTests();
});

afterEach(() => {
	clearBackgroundTasksForTests();
	vi.useRealTimers();
});

describe("background file task queue", () => {
	it("queues multiple background tasks in FIFO order, streams progress on the running task, and lingers briefly on completion", async () => {
		const gate1 = Promise.withResolvers<void>();
		const gate2 = Promise.withResolvers<void>();
		const started: string[] = [];

		const p1 = enqueueBackgroundTask({
			id: "reduce-1",
			kind: "reduce-size",
			headline: "용량 줄이는 중 · a.mp4",
			doneHeadline: "용량 줄이기 완료 · a.mp4",
			failedHeadline: "용량 줄이기 실패 · a.mp4",
			detail: "보통 · 원본 대체",
			run: () => {
				started.push("reduce-1");
				return gate1.promise;
			},
		});

		const p2 = enqueueBackgroundTask({
			id: "convert-2",
			kind: "convert-rename",
			headline: "변환 중 · b.webp",
			doneHeadline: "변환 완료 · b.webp",
			failedHeadline: "변환 실패 · b.webp",
			detail: "PNG → WEBP",
			run: () => {
				started.push("convert-2");
				return gate2.promise;
			},
		});

		expect(started).toEqual(["reduce-1"]);
		expect(getBackgroundTasksSnapshot().map((item) => `${item.id}:${item.state}:${item.percent}`)).toEqual([
			"reduce-1:running:null",
			"convert-2:queued:0",
		]);

		updateBackgroundTaskProgress("reduce-1", 64);
		expect(getBackgroundTasksSnapshot()[0]?.percent).toBe(64);

		gate1.resolve();
		await p1;
		await Promise.resolve();

		expect(started).toEqual(["reduce-1", "convert-2"]);
		expect(getBackgroundTasksSnapshot().map((item) => `${item.id}:${item.state}`)).toEqual([
			"reduce-1:done",
			"convert-2:running",
		]);

		// Done lingers 4s then clears while convert-2 continues running.
		vi.advanceTimersByTime(4_100);
		expect(getBackgroundTasksSnapshot().map((item) => `${item.id}:${item.state}`)).toEqual(["convert-2:running"]);

		gate2.resolve();
		await p2;
		vi.advanceTimersByTime(4_100);
		expect(getBackgroundTasksSnapshot()).toEqual([]);
	});

	it("cancels a queued task immediately without disturbing the currently running task", async () => {
		const gate1 = Promise.withResolvers<void>();
		const onCancel2 = vi.fn();

		const p1 = enqueueBackgroundTask({
			id: "t1",
			kind: "reduce-size",
			headline: "a.mp4",
			doneHeadline: "done",
			failedHeadline: "fail",
			detail: null,
			run: () => gate1.promise,
		});
		const p2 = enqueueBackgroundTask({
			id: "t2",
			kind: "reduce-size",
			headline: "b.mp4",
			doneHeadline: "done",
			failedHeadline: "fail",
			detail: null,
			onCancel: onCancel2,
			run: async () => undefined,
		});

		cancelBackgroundTask("t2");
		await expect(p2).rejects.toThrow(/cancelled/i);
		expect(onCancel2).not.toHaveBeenCalled();
		expect(getBackgroundTasksSnapshot().map((item) => item.id)).toEqual(["t1"]);

		gate1.resolve();
		await p1;
	});
});
