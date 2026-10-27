import { beforeEach, describe, expect, it } from "vitest";
import { describeFixStep, initialErrorFixRun, reduceErrorFixRun, startErrorFixRun } from "../src/renderer/src/state/error-fix";
import type { ErrorFixEvent, ErrorFixResult } from "../src/shared/error-fix-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

const RESULT: ErrorFixResult = { status: "fixed", summary: "ok", nextSteps: [], actions: [], changes: [], backupPath: null };

beforeEach(async () => {
	await setAppLanguage("ko");
});

describe("reduceErrorFixRun", () => {
	const running = startErrorFixRun("r1");
	const step = (runId: string, tool: "diagnose" | "ls", detail: string | null = null): ErrorFixEvent => ({ type: "step", runId, step: { tool, detail } });

	it("starts idle and begins a run with no steps", () => {
		expect(initialErrorFixRun).toEqual({ status: "idle" });
		expect(running).toEqual({ status: "running", runId: "r1", steps: [] });
	});

	it("lists what the agent does, in order, keeping a repeated step: checking again after a change is the point", () => {
		let state = reduceErrorFixRun(running, step("r1", "diagnose"));
		state = reduceErrorFixRun(state, step("r1", "ls", "/Users/me/Docs"));
		state = reduceErrorFixRun(state, step("r1", "diagnose"));

		expect(state).toMatchObject({ status: "running", steps: [{ tool: "diagnose" }, { tool: "ls", detail: "/Users/me/Docs" }, { tool: "diagnose" }] });
	});

	it("ends with the result, keeping the steps that led to it", () => {
		const state = reduceErrorFixRun(reduceErrorFixRun(running, step("r1", "diagnose")), { type: "result", runId: "r1", result: RESULT });

		expect(state).toEqual({ status: "done", result: RESULT, steps: [{ tool: "diagnose", detail: null }] });
	});

	it("ends with the message on an error and with 'stopped' on a cancel", () => {
		const change = { path: "searchPaths", before: null, after: "[\"/x\"]" };
		expect(reduceErrorFixRun(running, { type: "error", runId: "r1", message: "No API key found for dazzi", changes: [], backupPath: null })).toEqual({ status: "failed", message: "No API key found for dazzi", steps: [], changes: [], commands: [], backupPath: null });
		expect(reduceErrorFixRun(running, { type: "cancelled", runId: "r1", changes: [change], backupPath: "/c.bak" })).toEqual({ status: "stopped", steps: [], changes: [change], backupPath: "/c.bak", commands: [] });
	});

	it("ignores events of another run and anything after the end", () => {
		expect(reduceErrorFixRun(running, step("other", "diagnose"))).toBe(running);
		expect(reduceErrorFixRun(running, { type: "result", runId: "other", result: RESULT })).toBe(running);
		const done = reduceErrorFixRun(running, { type: "result", runId: "r1", result: RESULT });
		expect(reduceErrorFixRun(done, step("r1", "diagnose"))).toBe(done);
		expect(reduceErrorFixRun(done, { type: "error", runId: "r1", message: "late", changes: [], backupPath: null })).toBe(done);
		expect(reduceErrorFixRun(initialErrorFixRun, { type: "result", runId: "r1", result: RESULT })).toBe(initialErrorFixRun);
	});

	it("keeps only the latest steps of a very long run", () => {
		let state = running;
		for (let index = 0; index < 60; index += 1) state = reduceErrorFixRun(state, step("r1", "ls", `/p/${index}`));

		expect(state.status === "running" ? state.steps : []).toHaveLength(30);
		expect(state.status === "running" ? state.steps.at(-1)?.detail : null).toBe("/p/59");
	});
});

describe("describeFixStep", () => {
	it("words each tool in the interface language and shows the path or key it works on as it is", () => {
		expect(describeFixStep({ tool: "diagnose", detail: null }, t)).toBe(t("appError.fix.steps.diagnose"));
		for (const [tool, key] of [["read", "read"], ["ls", "ls"], ["find", "find"], ["grep", "grep"], ["edit", "edit"], ["write", "write"], ["bash", "bash"]] as const) {
			expect(describeFixStep({ tool, detail: "/Users/me/Docs" }, t), tool).toBe(`${t(`appError.fix.steps.${key}`)}: /Users/me/Docs`);
		}
		expect(describeFixStep({ tool: "bash", detail: "chmod u+r a.txt" }, t)).toBe(`${t("appError.fix.steps.bash")}: chmod u+r a.txt`);
		expect(describeFixStep({ tool: "refresh_index", detail: null }, t)).toBe(t("appError.fix.steps.refreshIndex"));
	});
});
