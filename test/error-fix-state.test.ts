import { beforeEach, describe, expect, it } from "vitest";
import {
	actionLabel,
	beginErrorFixSession,
	describeSidebarErrorFix,
	dismissErrorFixSession,
	initialErrorFixRun,
	initialErrorFixSession,
	minimizeErrorFixSession,
	openErrorFixSession,
	reduceErrorFixRun,
	reduceErrorFixSession,
	startErrorFixRun,
} from "../src/renderer/src/state/error-fix";
import type { ErrorFixResult } from "../src/shared/error-fix-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

const RESULT: ErrorFixResult = { status: "fixed", summary: "ok", nextSteps: [], actions: [], changes: [], backupPath: null };

beforeEach(async () => {
	await setAppLanguage("ko");
});

describe("reduceErrorFixRun", () => {
	const running = startErrorFixRun("r1");

	it("starts idle and begins a run with no live progress phrase yet", () => {
		expect(initialErrorFixRun).toEqual({ status: "idle" });
		expect(running).toEqual({ status: "running", runId: "r1", progress: null });
	});

	it("replaces the live progress phrase as the agent announces each tool call's intent", () => {
		let state = reduceErrorFixRun(running, { type: "progress", runId: "r1", text: "검색 폴더 위치 확인 중" });
		expect(state).toEqual({ status: "running", runId: "r1", progress: "검색 폴더 위치 확인 중" });

		state = reduceErrorFixRun(state, { type: "progress", runId: "r1", text: "이동된 폴더로 설정 복구 중" });
		expect(state).toEqual({ status: "running", runId: "r1", progress: "이동된 폴더로 설정 복구 중" });
	});

	it("ends cleanly with the result, failed message, or stopped state", () => {
		expect(reduceErrorFixRun(running, { type: "result", runId: "r1", result: RESULT })).toEqual({ status: "done", result: RESULT });
		expect(reduceErrorFixRun(running, { type: "error", runId: "r1", message: "No API key found for dazzi", changes: [], backupPath: null })).toEqual({
			status: "failed",
			message: "No API key found for dazzi",
		});
		expect(reduceErrorFixRun(running, { type: "cancelled", runId: "r1", changes: [], backupPath: null })).toEqual({ status: "stopped" });
	});

	it("ignores events of another run and anything after the end", () => {
		expect(reduceErrorFixRun(running, { type: "progress", runId: "other", text: "x" })).toBe(running);
		expect(reduceErrorFixRun(running, { type: "result", runId: "other", result: RESULT })).toBe(running);
		const done = reduceErrorFixRun(running, { type: "result", runId: "r1", result: RESULT });
		expect(reduceErrorFixRun(done, { type: "progress", runId: "r1", text: "late" })).toBe(done);
		expect(reduceErrorFixRun(done, { type: "error", runId: "r1", message: "late", changes: [], backupPath: null })).toBe(done);
		expect(reduceErrorFixRun(initialErrorFixRun, { type: "result", runId: "r1", result: RESULT })).toBe(initialErrorFixRun);
	});
});

describe("actionLabel", () => {
	it("uses the agent's own label or names the button after its destination when blank", () => {
		expect(actionLabel({ kind: "settings", target: "scope", label: "검색 폴더 다시 고르기" }, t)).toBe("검색 폴더 다시 고르기");
		expect(actionLabel({ kind: "settings", target: "scope", label: "" }, t)).toBe(t("appError.fix.openSettings", { page: t("settingsCore.nav.scope") }));
		expect(actionLabel({ kind: "source", target: "kakao", label: "" }, t)).toBe(t("appError.fix.openSource", { name: "kakao" }));
	});
});

describe("background ErrorFixSession & sidebar indicator", () => {
	it("keeps the run alive in the background when minimized, shows sidebar progress, and reopens the modal on click", () => {
		let session = beginErrorFixSession("r1", "Search root missing");
		expect(session.dialogOpen).toBe(true);
		expect(session.run).toEqual({ status: "running", runId: "r1", progress: null });

		// Minimizing hides the dialog WITHOUT stopping the run.
		session = minimizeErrorFixSession(session);
		expect(session.dialogOpen).toBe(false);
		expect(session.run.status).toBe("running");
		expect(describeSidebarErrorFix(session, t)).toEqual({
			tone: "run",
			percent: null,
			headline: t("appError.fix.sidebar.running"),
			detail: t("appError.fix.running"),
		});

		// Live progress updates keep arriving while minimized.
		session = reduceErrorFixSession(session, { type: "progress", runId: "r1", text: "검색 폴더 위치 확인 중" });
		expect(describeSidebarErrorFix(session, t)).toEqual({
			tone: "run",
			percent: null,
			headline: t("appError.fix.sidebar.running"),
			detail: "검색 폴더 위치 확인 중",
		});

		// Completion while minimized stays visible in the sidebar until opened or dismissed.
		session = reduceErrorFixSession(session, {
			type: "result",
			runId: "r1",
			result: { ...RESULT, summary: "문서 폴더 경로를 바로잡았어요." },
		});
		expect(session.dialogOpen).toBe(false);
		expect(describeSidebarErrorFix(session, t)).toEqual({
			tone: "ok",
			percent: 100,
			headline: t("appError.fix.status.fixed"),
			detail: "문서 폴더 경로를 바로잡았어요.",
		});

		// Clicking the sidebar block reopens the finished dialog; dismissing after finish clears the session.
		session = openErrorFixSession(session);
		expect(session.dialogOpen).toBe(true);
		session = dismissErrorFixSession(session);
		expect(session).toBe(initialErrorFixSession);
		expect(describeSidebarErrorFix(session, t)).toBeNull();
	});

	it("surfaces needs-user and failed runs in error tone in the sidebar when minimized", () => {
		const minNeedsUser = reduceErrorFixSession(minimizeErrorFixSession(beginErrorFixSession("r2", "err")), {
			type: "result",
			runId: "r2",
			result: { status: "needs-user", summary: "새 폴더를 골라 주세요.", nextSteps: [], actions: [], changes: [], backupPath: null },
		});
		expect(describeSidebarErrorFix(minNeedsUser, t)).toEqual({
			tone: "error",
			percent: 100,
			headline: t("appError.fix.status.needsUser"),
			detail: "새 폴더를 골라 주세요.",
		});

		const minFailed = reduceErrorFixSession(minimizeErrorFixSession(beginErrorFixSession("r3", "err")), {
			type: "error",
			runId: "r3",
			message: "network down",
			changes: [],
			backupPath: null,
		});
		expect(describeSidebarErrorFix(minFailed, t)?.tone).toBe("error");
	});
});
