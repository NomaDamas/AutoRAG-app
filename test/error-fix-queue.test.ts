import { beforeEach, describe, expect, it } from "vitest";
import {
	describeSidebarErrorFixEntries,
	dismissErrorFixStore,
	enqueueErrorFixStore,
	initialErrorFixStore,
	minimizeErrorFixStore,
	openErrorFixStoreById,
	reduceErrorFixStore,
} from "../src/renderer/src/state/error-fix";
import type { ErrorFixResult } from "../src/shared/error-fix-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

const FIXED_A: ErrorFixResult = {
	status: "fixed",
	summary: "첫 번째 검색 폴더를 복구했어요.",
	nextSteps: [],
	actions: [],
	changes: [],
	backupPath: null,
};

const NEEDS_B: ErrorFixResult = {
	status: "needs-user",
	summary: "Slack 토큰을 다시 연결해 주세요.",
	nextSteps: ["Slack 설정에서 로그인하세요."],
	actions: [{ kind: "source", target: "slack", label: "Slack 열기" }],
	changes: [],
	backupPath: null,
};

beforeEach(async () => {
	await setAppLanguage("ko");
});

describe("multi-session ErrorFixStore queue", () => {
	it("enqueues multiple repairs without cancelling or overwriting minimized background sessions", () => {
		let store = enqueueErrorFixStore(initialErrorFixStore, "run-a", "Missing folder /A");
		expect(store.activeId).toBe("run-a");
		expect(store.sessions).toHaveLength(1);

		// Minimize run-a to background, then start run-b for a different error.
		store = minimizeErrorFixStore(store);
		expect(store.activeId).toBeNull();

		store = enqueueErrorFixStore(store, "run-b", "Slack auth expired");
		expect(store.activeId).toBe("run-b");
		expect(store.sessions.map((s) => s.id)).toEqual(["run-a", "run-b"]);
		expect(store.sessions[0]?.run.status).toBe("running");
		expect(store.sessions[1]?.run.status).toBe("running");

		// Minimize run-b too: both run in background and surface as 2 distinct sidebar items.
		store = minimizeErrorFixStore(store);
		store = reduceErrorFixStore(store, { type: "progress", runId: "run-a", text: "폴더 A 복구 중" });
		const entries = describeSidebarErrorFixEntries(store, t);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: "run-a", tone: "run", detail: "폴더 A 복구 중" });
		expect(entries[1]).toMatchObject({ id: "run-b", tone: "queued" });

		// Completing run-a in background does NOT clear run-b, and run-b flips from queued to running on progress.
		store = reduceErrorFixStore(store, { type: "result", runId: "run-a", result: FIXED_A });
		store = reduceErrorFixStore(store, { type: "progress", runId: "run-b", text: "Slack 설정 점검 중" });

		const afterA = describeSidebarErrorFixEntries(store, t);
		expect(afterA).toHaveLength(2);
		expect(afterA.find((e) => e.id === "run-b")).toMatchObject({ tone: "run", detail: "Slack 설정 점검 중" });
		expect(afterA.find((e) => e.id === "run-a")).toMatchObject({ tone: "ok", percent: 100, detail: FIXED_A.summary });

		// Clicking run-a in the sidebar opens ONLY run-a in the dialog; dismissing it clears ONLY run-a while run-b keeps running!
		store = openErrorFixStoreById(store, "run-a");
		expect(store.activeId).toBe("run-a");
		store = dismissErrorFixStore(store);
		expect(store.activeId).toBeNull();
		expect(store.sessions.map((s) => s.id)).toEqual(["run-b"]);

		// Completing run-b in background keeps it visible until reviewed.
		store = reduceErrorFixStore(store, { type: "result", runId: "run-b", result: NEEDS_B });
		expect(describeSidebarErrorFixEntries(store, t)).toEqual([
			expect.objectContaining({ id: "run-b", tone: "error", percent: 100, detail: NEEDS_B.summary }),
		]);
	});

	it("reopens an existing running session instead of duplicating when the exact same error message is triggered again", () => {
		let store = minimizeErrorFixStore(enqueueErrorFixStore(initialErrorFixStore, "run-a", "Missing folder /A"));
		const next = enqueueErrorFixStore(store, "run-dup", "Missing folder /A");
		expect(next.sessions).toHaveLength(1);
		expect(next.activeId).toBe("run-a");
	});
});
