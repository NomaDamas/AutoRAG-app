import { describe, expect, it, vi } from "vitest";
import { confirmAutomationSaves, draftOf, mergeDraft, wrapSave } from "../src/main/automation-confirm";
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
});
