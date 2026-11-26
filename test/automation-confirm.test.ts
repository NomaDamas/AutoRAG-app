import { describe, expect, it, vi } from "vitest";
import { confirmAutomationSaves, draftOf, mergeDraft, wrapSave } from "../src/main/automation-confirm";
import { runAutomationToolOnNode } from "../src/main/automation-runtime";
import { createAutomationVerificationTracker, type AutomationSandboxTestResult } from "../src/main/automation-sandbox";
import { createInteractionHub } from "../src/main/interaction-hub";
import type { RunInteraction } from "../src/main/host-ui";
import type { InteractionAnswer, InteractionRequest } from "../src/shared/interaction-contract";

const body = {
	paths: ["C:/Users/me/Downloads"],
	include: ["**/*.pdf"],
	exclude: ["흑백/**"],
	appendFiles: true,
	agent: { profile: "file-triage", task: "요약해 줘", retrieval: { searchAll: true } },
};

function runAnswering(answer: InteractionAnswer): { run: RunInteraction; asked: unknown[] } {
	const asked: unknown[] = [];
	return {
		asked,
		run: {
			open: async (request) => {
				asked.push(request);
				return answer;
			},
		},
	};
}

describe("automation saves wait for the person", () => {
	it("spells out the librarian's defaults in the card's rule", () => {
		expect(draftOf({ paths: ["/a"], run: ["autorag", "refresh"] })).toEqual({ paths: ["/a"], events: ["create", "update", "delete"], include: [], run: ["autorag", "refresh"] });
	});

	it("keeps what the card does not show when it merges the person's changes", () => {
		const merged = mergeDraft(body, { paths: ["C:/Users/me/Desktop"], events: ["create"], include: [], agent: { profile: "file-triage", task: "세 줄로" } });
		expect(merged).toEqual({
			paths: ["C:/Users/me/Desktop"],
			events: ["create"],
			include: [],
			exclude: ["흑백/**"],
			appendFiles: true,
			agent: { profile: "file-triage", task: "세 줄로", retrieval: { searchAll: true } },
		});
	});

	it("shows a save filled in and writes the rule the person added", async () => {
		const execute = vi.fn(async () => "saved");
		const added = { paths: ["C:/Users/me/Downloads"], events: ["create"] as const, include: ["**/*.pdf"], agent: { profile: "file-triage", task: "세 줄로 요약" } };
		const { run, asked } = runAnswering({ kind: "automation", rule: added });
		const result = await wrapSave(execute, () => run)("call-1", { action: "save", id: "pdf-summary", automation: body });
		expect(result).toBe("saved");
		expect(asked).toEqual([{ kind: "automation", ruleId: "pdf-summary", rule: draftOf(body) }]);
		expect(execute).toHaveBeenCalledWith("call-1", { action: "save", id: "pdf-summary", automation: mergeDraft(body, added) });
	});

	it("saves nothing and tells the agent so when the person cancels", async () => {
		const execute = vi.fn(async () => "saved");
		const { run } = runAnswering({ kind: "cancel" });
		const result = (await wrapSave(execute, () => run)("call-1", { action: "save", id: "pdf-summary", automation: body })) as { content: { text: string }[] };
		expect(execute).not.toHaveBeenCalled();
		expect(result.content[0]?.text).toMatch(/did not add this automation/);
	});

	it("leaves every other action, and a save with nobody to ask, untouched", async () => {
		const execute = vi.fn(async () => "done");
		const { run, asked } = runAnswering({ kind: "cancel" });
		await wrapSave(execute, () => run)("c", { action: "list" });
		await wrapSave(execute, () => undefined)("c", { action: "save", id: "x", automation: body });
		expect(asked).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("patches the agent's manage_automations tool, and fails loudly without one", () => {
		const tool = { name: "manage_automations", execute: async () => "x" };
		const before = tool.execute;
		confirmAutomationSaves({ tools: [tool] }, () => undefined);
		expect(tool.execute).not.toBe(before);
		expect(() => confirmAutomationSaves({ tools: [] }, () => undefined)).toThrow(/manage_automations/);
	});

	it("takes only an answer that fits an automation request through the hub", async () => {
		const requests: InteractionRequest[] = [];
		const hub = createInteractionHub({ emitRequest: (request) => requests.push(request), emitClosed: () => undefined, newId: () => "r1" });
		const answered = hub.open("run-1", { kind: "automation", ruleId: "x", rule: draftOf(body) });
		expect(hub.answer("r1", { kind: "approval", choice: "allow-once" })).toBe(false);
		expect(hub.answer("r1", { kind: "automation", rule: { paths: ["/a"], events: ["create"], include: [] } })).toBe(false);
		expect(hub.answer("r1", { kind: "automation", rule: { paths: ["/a"], events: ["create"], include: [], run: ["a"], agent: { profile: "p", task: "t" } } })).toBe(false);
		const rule = { paths: ["/a"], events: ["create" as const], include: [], agent: { profile: "p", task: "t" } };
		expect(hub.answer("r1", { kind: "automation", rule })).toBe(true);
		await expect(answered).resolves.toEqual({ kind: "automation", rule });
	});

	it("validates right-click automation (magic-action) confirmation answers through the hub", async () => {
		const requests: InteractionRequest[] = [];
		const hub = createInteractionHub({ emitRequest: (request) => requests.push(request), emitClosed: () => undefined, newId: () => "m1" });
		const sampleAction = {
			id: "pdf-summary",
			label: "PDF 요약",
			enabled: true,
			selection: "single" as const,
			targetKind: "file" as const,
			extensions: ["pdf"],
			execution: { kind: "agent" as const, mode: "read" as const, prompt: "요약해 줘", useSkills: true, useMcp: true },
		};
		const answered = hub.open("run-1", { kind: "magic-action", action: sampleAction, isUpdate: false });
		expect(hub.answer("m1", { kind: "approval", choice: "allow-once" })).toBe(false);
		expect(hub.answer("m1", { kind: "magic-action", action: { ...sampleAction, label: "" } })).toBe(false);
		const edited = { ...sampleAction, selection: "any" as const };
		expect(hub.answer("m1", { kind: "magic-action", action: edited })).toBe(true);
		await expect(answered).resolves.toEqual({ kind: "magic-action", action: edited });
	});

	describe("verify-first, user-confirm-second ordering with runAutomationToolOnNode", () => {
		const sandboxPass: AutomationSandboxTestResult = {
			ok: true,
			executionKind: "agent",
			exitCode: 0,
			timedOut: false,
			durationMs: 42,
			output: "ok",
			stdout: "ok",
			stderr: "",
			matchedFiles: ["sample.pdf"],
			retriggerWarnings: [],
			diff: { created: [], modified: [], deleted: [], unchanged: ["sample.pdf"] },
		};
		const sandboxFail: AutomationSandboxTestResult = {
			...sandboxPass,
			ok: false,
			exitCode: 1,
			error: "command failed in sandbox",
		};

		it("never pops the confirmation card when sandbox verification fails", async () => {
			const events: string[] = [];
			const rawExecute = vi.fn(async () => {
				events.push("persist");
				return { content: [{ type: "text", text: "saved" }], details: { action: "save" } };
			});
			const agent = { tools: [{ name: "manage_automations", execute: rawExecute }] };
			const run: RunInteraction = {
				open: vi.fn(async () => {
					events.push("confirm");
					return { kind: "cancel" as const };
				}),
			};
			// Wrap confirmAutomationSaves FIRST (inner), runAutomationToolOnNode SECOND (outer) — matching search-service.ts.
			confirmAutomationSaves(agent, () => run);
			runAutomationToolOnNode(agent, () => process.execPath, {
				tracker: createAutomationVerificationTracker(),
				verifyRule: async () => {
					events.push("verify");
					return sandboxFail;
				},
			});

			const res = (await agent.tools[0]!.execute("c1", { action: "save", id: "broken-rule", automation: body })) as {
				content: { text: string }[];
				details: { saved?: boolean; verified?: boolean };
			};
			expect(events).toEqual(["verify"]);
			expect(run.open).not.toHaveBeenCalled();
			expect(rawExecute).not.toHaveBeenCalled();
			expect(res.details.saved).toBe(false);
			expect(res.details.verified).toBe(false);
		});

		it("runs sandbox verification first, pops confirmation second, and skips persist when the user cancels", async () => {
			const events: string[] = [];
			const rawExecute = vi.fn(async () => {
				events.push("persist");
				return { content: [{ type: "text", text: "saved" }], details: { action: "save" } };
			});
			const agent = { tools: [{ name: "manage_automations", execute: rawExecute }] };
			const run: RunInteraction = {
				open: vi.fn(async () => {
					events.push("confirm");
					return { kind: "cancel" as const };
				}),
			};
			confirmAutomationSaves(agent, () => run);
			runAutomationToolOnNode(agent, () => process.execPath, {
				tracker: createAutomationVerificationTracker(),
				verifyRule: async () => {
					events.push("verify");
					return sandboxPass;
				},
			});

			const res = (await agent.tools[0]!.execute("c2", { action: "save", id: "ok-rule", automation: body })) as {
				content: { text: string }[];
				details: { saved?: boolean; cancelledByUser?: boolean };
			};
			expect(events).toEqual(["verify", "confirm"]);
			expect(rawExecute).not.toHaveBeenCalled();
			expect(res.details.saved).toBe(false);
			expect(res.details.cancelledByUser).toBe(true);
			expect(res.content[0]?.text).toMatch(/did not add this automation/);
		});

		it("runs verify -> confirm -> persist in order and writes the user's edited rule on approve", async () => {
			const events: string[] = [];
			const rawExecute = vi.fn(async (_id: string, params: unknown) => {
				events.push("persist");
				return { content: [{ type: "text", text: "saved" }], details: { action: "save", params } };
			});
			const agent = { tools: [{ name: "manage_automations", execute: rawExecute }] };
			const edited = {
				paths: ["C:/Users/me/Downloads"],
				events: ["create" as const],
				include: ["**/*.pdf"],
				agent: { profile: "file-triage", task: "핵심 3줄 요약" },
			};
			const run: RunInteraction = {
				open: vi.fn(async () => {
					events.push("confirm");
					return { kind: "automation" as const, rule: edited };
				}),
			};
			confirmAutomationSaves(agent, () => run);
			runAutomationToolOnNode(agent, () => process.execPath, {
				tracker: createAutomationVerificationTracker(),
				verifyRule: async () => {
					events.push("verify");
					return sandboxPass;
				},
			});

			const res = (await agent.tools[0]!.execute("c3", { action: "save", id: "ok-rule", automation: body })) as {
				content: { text: string }[];
			};
			expect(events).toEqual(["verify", "confirm", "persist"]);
			expect(rawExecute).toHaveBeenCalledWith("c3", {
				action: "save",
				id: "ok-rule",
				automation: mergeDraft(body, edited),
			});
			expect(res.content[0]?.text).toContain("Verified in temporary sandbox");
		});
	});
});
