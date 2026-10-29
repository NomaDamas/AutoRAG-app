import { defineTool, type AgentSession, type AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { toToolDeclaration, validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { intentPromptLine, subscribeProfileProgress, withIntentTools } from "../src/main/agents/profile-progress";

function fakeSession(): { readonly session: AgentSession; emit(event: Parameters<AgentSessionEventListener>[0]): void } {
	const listeners = new Set<AgentSessionEventListener>();
	return {
		session: {
			subscribe: (listener: AgentSessionEventListener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as AgentSession,
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("withIntentTools", () => {
	it("puts the required `i` progress field first on the wire, strips it before execute, and still lets calls without `i` validate", async () => {
		const seen: unknown[] = [];
		const sample = defineTool({
			name: "sample",
			label: "Sample",
			description: "Checks a path.",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id, params) => {
				seen.push(params);
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		});
		const answer = defineTool({
			name: "report_result",
			label: "Answer",
			description: "Final answer.",
			parameters: Type.Object({ summary: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
		});

		const wrapped = withIntentTools([sample, answer], { language: "ko", exclude: ["report_result"] });
		const decl = toToolDeclaration(wrapped[0] as never);

		expect(Object.keys((decl.parameters as { properties: Record<string, unknown> }).properties)).toEqual(["i", "path"]);
		expect((decl.parameters as { required: string[] }).required).toEqual(["i", "path"]);
		expect(Object.keys((toToolDeclaration(wrapped[1] as never).parameters as { properties: Record<string, unknown> }).properties)).toEqual(["summary"]);

		// Without `i` (scripted unit tests), prepareArguments supplies "" so validation still passes.
		const prepared = wrapped[0]?.prepareArguments?.({ path: "/docs" });
		const validated = validateToolArguments(wrapped[0] as never, { type: "toolCall", id: "c1", name: "sample", arguments: prepared as never });
		expect(validated).toEqual({ i: "", path: "/docs" });

		await wrapped[0]?.execute("c1", { i: "검색 폴더 확인 중", path: "/docs" } as never, undefined, undefined, undefined as never);
		expect(seen).toEqual([{ path: "/docs" }]);
	});
});

describe("subscribeProfileProgress", () => {
	it("waits until streamed `i` closes its JSON quote, emits once, and ignores duplicate updates", () => {
		const { session, emit } = fakeSession();
		const progress: string[] = [];
		subscribeProfileProgress(session, (text) => progress.push(text));

		emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "ls", arguments: { i: "검색 폴" }, partialJson: '{"i":"검색 폴' }],
			} as never,
			assistantMessageEvent: {} as never,
		});
		expect(progress).toEqual([]);

		emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "ls", arguments: { i: "검색 폴더 위치 확인 중." }, partialJson: '{"i":"검색 폴더 위치 확인 중.","path":"/x' }],
			} as never,
			assistantMessageEvent: {} as never,
		});
		expect(progress).toEqual(["검색 폴더 위치 확인 중"]);

		// Same intent on message_end and tool_execution_start is not repeated.
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "1", name: "ls", arguments: { i: "검색 폴더 위치 확인 중", path: "/x" } }],
			} as never,
		});
		emit({ type: "tool_execution_start", toolCallId: "1", toolName: "ls", args: { i: "검색 폴더 위치 확인 중", path: "/x" } });
		expect(progress).toEqual(["검색 폴더 위치 확인 중"]);
	});

	it("falls back to a short pre-tool assistant note when `i` is absent, and never emits a final answer as progress", () => {
		const { session, emit } = fakeSession();
		const onProgress = vi.fn();
		subscribeProfileProgress(session, onProgress);

		emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "설정 파일을 살펴보는 중입니다." },
					{ type: "toolCall", id: "1", name: "diagnose", arguments: {} },
				],
			} as never,
		});
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "최종 답변입니다." }],
			} as never,
		});

		expect(onProgress.mock.calls).toEqual([["설정 파일을 살펴보는 중입니다"]]);
	});
});

describe("intentPromptLine", () => {
	it("asks for a short plain progress phrase in the reply language on every tool call", () => {
		expect(intentPromptLine("ko")).toContain("Korean");
		expect(intentPromptLine("ja")).toContain("Japanese");
		expect(intentPromptLine("en")).toContain("`i`");
	});
});
