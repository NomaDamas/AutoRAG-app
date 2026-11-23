import { describe, expect, it } from "vitest";
import { createCustomizerPrompter } from "../src/main/agents/customizer-prompter";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";

function setup() {
	const events: AppCustomizerEvent[] = [];
	const prompter = createCustomizerPrompter({ send: (event) => events.push(event) });
	const scope = prompter.forRun({ runId: "run-1", sessionId: "sess-1" });
	return { events, prompter, scope };
}
const promptOf = (events: readonly AppCustomizerEvent[]) => events.find((event) => event.type === "prompt");

describe("customizer prompter", () => {
	it("hands a secret from the panel to the tool and never to the event stream", async () => {
		const { events, prompter, scope } = setup();
		const pending = scope.askSecret({ title: "API key for Anthropic", detail: "Stored encrypted." });
		const prompt = promptOf(events);
		expect(prompt?.type === "prompt" && prompt.prompt.kind).toBe("secret");
		const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
		expect(prompter.answer(id, { kind: "secret", value: "sk-ant-api03-supersecretvalue0123456789" })).toBe(true);
		expect(await pending).toEqual({ kind: "secret", value: "sk-ant-api03-supersecretvalue0123456789" });
		expect(JSON.stringify(events)).not.toContain("supersecretvalue");
		expect(events.at(-1)).toMatchObject({ type: "prompt-closed", promptId: id });
	});

	it("rejects an answer of the wrong kind and keeps waiting for a valid one", async () => {
		const { events, prompter, scope } = setup();
		const pending = scope.askSecret({ title: "t", detail: "d" });
		const id = (promptOf(events) as Extract<AppCustomizerEvent, { type: "prompt" }>).prompt.id;
		expect(prompter.answer(id, { kind: "confirm", confirmed: true })).toBe(false);
		expect(prompter.answer(id, { kind: "secret", value: "   " })).toBe(false);
		expect(prompter.answer(id, { kind: "secret", value: "real-value-123456" })).toBe(true);
		expect((await pending).kind).toBe("secret");
	});

	it("answers cancelled when the person cancels, and a late answer is ignored", async () => {
		const { events, prompter, scope } = setup();
		const pending = scope.askConfirm({ title: "Run?", lines: ["claude --version"] });
		const id = (promptOf(events) as Extract<AppCustomizerEvent, { type: "prompt" }>).prompt.id;
		expect(prompter.answer(id, { kind: "cancelled" })).toBe(true);
		expect(await pending).toEqual({ kind: "cancelled" });
		expect(prompter.answer(id, { kind: "confirm", confirmed: true })).toBe(false);
	});

	it("closes every open prompt of a run when the run is stopped", async () => {
		const { events, prompter, scope } = setup();
		const pending = scope.askConfirm({ title: "Run?", lines: [] });
		prompter.closeRun("run-1");
		expect(await pending).toEqual({ kind: "cancelled" });
		expect(events.filter((event) => event.type === "prompt-closed")).toHaveLength(1);
	});

	it("never accepts an answer for another run's prompt id", async () => {
		const { prompter, scope } = setup();
		const pending = scope.askConfirm({ title: "t", lines: [] });
		expect(prompter.answer("not-a-real-id", { kind: "confirm", confirmed: true })).toBe(false);
		prompter.closeRun("run-1");
		await pending;
	});

	it("times out an unanswered prompt as cancelled", async () => {
		const events: AppCustomizerEvent[] = [];
		const prompter = createCustomizerPrompter({ send: (event) => events.push(event), timeoutMs: 20 });
		const result = await prompter.forRun({ runId: "r", sessionId: "s" }).askConfirm({ title: "t", lines: [] });
		expect(result).toEqual({ kind: "cancelled" });
	});
});
