import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFollowUpSorter, followUpPrompt, parseFollowUpKind } from "../src/main/follow-up-sorter";
import { heldSteer, releaseHeldSteers, sendHeldSteer, type InspectorChatTab } from "../src/renderer/src/state/inspector-chat";
import { deliverSteers, settleSteers, SORT_TIMEOUT_MS, sortFollowUp, STEER_HOLD_MS, type SteerItem } from "../src/renderer/src/state/steering";

describe("the follow-up sorter", () => {
	const reply = (text: string): AssistantMessage => ({ content: [{ type: "text", text }] }) as unknown as AssistantMessage;
	const resolveModel = async () => ({ model: { provider: "openai" } as Model<Api>, apiKey: "test-key" });

	it("is a correction only when the model says steer; every other reply waits as the next question", () => {
		expect(parseFollowUpKind("STEER")).toBe("steer");
		expect(parseFollowUpKind(" **steer**\n")).toBe("steer");
		expect(parseFollowUpKind("NEXT")).toBe("next");
		expect(parseFollowUpKind("I think this could steer the answer")).toBe("next");
		expect(parseFollowUpKind("")).toBe("next");
	});

	it("gives the model the question in flight and the new message", async () => {
		const seen: Context[] = [];
		const sort = createFollowUpSorter({
			resolveModel,
			complete: async (_model, context) => (seen.push(context), reply("STEER")),
		});
		expect(await sort("지난달 회의록 정리해 줘", "지난주 것만")).toBe("steer");
		expect(seen[0]?.messages[0]?.content).toBe(followUpPrompt("지난달 회의록 정리해 줘", "지난주 것만"));
	});

	it("says next when the model cannot be reached", async () => {
		const sort = createFollowUpSorter({ resolveModel, complete: async () => Promise.reject(new Error("offline")) });
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(await sort("q", "f")).toBe("next");
		vi.restoreAllMocks();
	});
});

describe("sortFollowUp", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	/** The result once it is there, else "waiting". */
	const watch = (promise: Promise<string>) => {
		const seen = { value: "waiting" };
		void promise.then((value) => (seen.value = value));
		return seen;
	};

	it("says next as soon as the sort does, without waiting out the hold", async () => {
		const seen = watch(sortFollowUp(async () => "next"));
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.value).toBe("next");
	});

	it("holds a correction until the hold has passed", async () => {
		const seen = watch(sortFollowUp(async () => "steer"));
		await vi.advanceTimersByTimeAsync(STEER_HOLD_MS - 1);
		expect(seen.value).toBe("waiting");
		await vi.advanceTimersByTimeAsync(1);
		expect(seen.value).toBe("steer");
	});

	it("counts a failed or silent sort as the next question", async () => {
		const failed = watch(sortFollowUp(() => Promise.reject(new Error("no model"))));
		const silent = watch(sortFollowUp(() => new Promise(() => undefined)));
		await vi.advanceTimersByTimeAsync(0);
		expect(failed.value).toBe("next");
		await vi.advanceTimersByTimeAsync(SORT_TIMEOUT_MS);
		expect(silent.value).toBe("next");
	});
});

describe("held corrections", () => {
	const held: SteerItem = { id: "h", text: "지난주 것만", timing: "before-quick", status: "held" };
	const tab = (): InspectorChatTab => ({
		mode: "chat",
		seenAt: 0,
		dismissed: [],
		queued: ["먼저 기다리던 질문"],
		chat: { chatId: "c", updatedAt: 0, turns: [{ question: "q", attachments: [], quick: null, deep: null, quickDraft: "", deepDraft: "", deepElapsed: null, startedAt: 0, progress: "", error: null, stopped: false, steers: [held], revisions: [] }] },
	});

	it("are neither delivered nor dropped by the run's own events: they were never sent", () => {
		expect(deliverSteers([held])).toEqual([held]);
		expect(settleSteers([held])).toEqual([held]);
	});

	it("wait as the next question when the run ends, and are forgotten when it is stopped", () => {
		const requeued = releaseHeldSteers(tab(), true);
		expect(requeued.queued).toEqual(["먼저 기다리던 질문", "지난주 것만"]);
		expect(requeued.chat?.turns[0]?.steers).toEqual([]);
		expect(releaseHeldSteers(tab(), false).queued).toEqual(["먼저 기다리던 질문"]);
	});

	it("go out as a waiting correction", () => {
		const chat = tab().chat;
		if (chat === null) throw new Error("no chat");
		const sent = sendHeldSteer(chat, "h");
		expect(sent.turns[0]?.steers[0]?.status).toBe("pending");
		expect(heldSteer({ ...tab(), chat: sent }, "h")).toBeUndefined();
	});
});
