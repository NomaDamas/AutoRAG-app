import { beforeEach, describe, expect, it } from "vitest";
import { describeAppError } from "../src/renderer/src/state/app-error";
import { setAppLanguage, t } from "../src/shared/i18n";

beforeEach(async () => {
	await setAppLanguage("ko");
});

const ids = (message: string): string[] => describeAppError(message, null, t).actions.map((action) => action.id);

describe("describeAppError", () => {
	it("offers the AI fix, and only that, for an error that is about the app's own setup", () => {
		const view = describeAppError("Search root /Users/me/Docs does not exist", null, t);

		expect(view.kind).toBe("other");
		expect(view.actions).toEqual([{ id: "fix", label: t("appError.fixAction"), primary: true }]);
		expect(view.title).toBe(t("appError.other.title"));
	});

	it("sends a missing model to the model settings and never offers the AI fix, since the AI is what is down", () => {
		const view = describeAppError("No API key found for dazzi", null, t);

		expect(view.kind).toBe("model-missing");
		expect(view.actions).toEqual([{ id: "open-ai", label: t("appError.openModelSettings"), primary: true }]);
	});

	it("tells a rejected key or login to check the model settings and the subscription, with a button to each", () => {
		const view = describeAppError("401 Incorrect API key provided", null, t);

		expect(view.kind).toBe("model-credentials");
		expect(view.title).toContain("모델");
		expect(view.hint).toContain("구독");
		expect(view.actions).toEqual([
			{ id: "open-ai", label: t("appError.openModelSettings"), primary: true },
			{ id: "open-plan", label: t("aiSearch.openPlan"), primary: false },
		]);
	});

	it("puts the subscription first when the plan or credits ran out", () => {
		const view = describeAppError("402 Payment Required", null, t);

		expect(view.kind).toBe("model-subscription");
		expect(view.title).toContain("구독");
		expect(view.actions.map((action) => [action.id, action.primary])).toEqual([
			["open-plan", true],
			["open-ai", false],
		]);
	});

	it("sends a model that no longer exists to pick another one", () => {
		expect(ids("Unknown configured model: dazzi/old")).toEqual(["open-ai"]);
	});

	it("says to wait for a rate limit and to check the connection for a network failure, with the model settings as the way out", () => {
		const limited = describeAppError("429 Too Many Requests", null, t);
		const offline = describeAppError("fetch failed", null, t);

		expect(limited.kind).toBe("rate-limit");
		expect(offline.kind).toBe("network");
		expect(limited.actions).toEqual([{ id: "open-ai", label: t("appError.openModelSettings"), primary: false }]);
		expect(offline.actions).toEqual([{ id: "open-ai", label: t("appError.openModelSettings"), primary: false }]);
		expect(limited.hint).not.toBe(offline.hint);
	});

	it("trusts the main process's own hint that the plan is the problem, whatever the message says", () => {
		const view = describeAppError("이번 주 Dazzi 크레딧을 모두 사용했습니다.", "open-plan", t);

		expect(view.kind).toBe("model-subscription");
		expect(view.title).toBeNull();
		expect(view.hint).toBeNull();
		expect(view.actions).toEqual([{ id: "open-plan", label: t("aiSearch.openPlan"), primary: true }]);
	});

	it("explains a conversation that no longer fits the model and offers a new chat or a narrower question, never the AI fix", () => {
		const view = describeAppError("400 context_length_exceeded: This model's maximum context length is 1048576 tokens.", "new-chat", t);

		expect(view.kind).toBe("context-overflow");
		expect(view.title).toBe(t("appError.contextOverflow.title"));
		expect(view.hint).toBe(t("appError.contextOverflow.hint"));
		expect(view.actions).toEqual([
			{ id: "new-chat", label: t("aiSearch.newChat"), primary: true },
			{ id: "rephrase", label: t("appError.askNarrower"), primary: false },
		]);
	});

	it("speaks the interface language", async () => {
		await setAppLanguage("en");

		const view = describeAppError("402 Payment Required", null, t);

		expect(view.title).toMatch(/subscription/iu);
		expect(view.actions[0]?.label).toBe("Open Subscription & Usage");
	});
});
