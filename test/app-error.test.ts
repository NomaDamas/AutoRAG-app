import { describe, expect, it } from "vitest";
import { canFixWithAi, classifyAppError, isModelProblem, type AppErrorKind } from "../src/shared/app-error";

/** Wordings taken from what pi, the librarian and the OpenAI/Anthropic SDKs really throw, not invented ones. */
const CASES: readonly (readonly [string, AppErrorKind])[] = [
	["No model configured. Provide --model-provider and --model-id on the command line, or set the \"model\" key in the config file.", "model-missing"],
	["No model configured. Sign in and pick one with `autorag tui` (`/login`, then `/model`)", "model-missing"],
	["No API key found for dazzi", "model-missing"],
	["No API key found for provider openrouter.", "model-missing"],

	["401 Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.", "model-credentials"],
	["Authentication failed for opencode-go", "model-credentials"],
	["HTTP 401: invalid x-api-key", "model-credentials"],
	["403 Forbidden", "model-credentials"],
	["Error: 401 status code (no body)", "model-credentials"],
	["Your token has expired. Please sign in again.", "model-credentials"],

	["402 Payment Required", "model-subscription"],
	["429 You exceeded your current quota, please check your plan and billing details. insufficient_quota", "model-subscription"],
	["You have reached your usage limit for this plan.", "model-subscription"],
	["Your credit balance is too low to access the API.", "model-subscription"],
	["403 Your plan does not include this model", "model-subscription"],
	["usage_limit_exceeded", "model-subscription"],

	["Unknown configured model: dazzi/deepseek/old-model. Run `autorag models list`.", "model-not-found"],
	["Model \"gpt-x\" not found for provider \"openai\"", "model-not-found"],
	["404 The model `claude-old` does not exist or you do not have access to it.", "model-not-found"],

	["429 Too Many Requests", "rate-limit"],
	["Rate limit reached; retry in 20s", "rate-limit"],
	["529 Overloaded", "rate-limit"],

	["fetch failed", "network"],
	["getaddrinfo ENOTFOUND api.dazziapp.com", "network"],
	["connect ECONNREFUSED 127.0.0.1:11434", "network"],
	["Request timed out.", "network"],
	["read ECONNRESET", "network"],

	["Search root /Users/me/Docs does not exist", "other"],
	["ENOENT: no such file or directory, open '/Users/me/report-401.pdf'", "other"],
	["Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", "other"],
	["The AI ended without reporting which folders to exclude.", "other"],
	["Config error: minSync.embedder.dimension must be a positive integer", "other"],
	["", "other"],
];

describe("classifyAppError", () => {
	it.each(CASES)("reads %j as %s", (message, kind) => {
		expect(classifyAppError(message)).toBe(kind);
	});

	it("puts a spent plan ahead of the rate limit it is reported with, since waiting never helps it", () => {
		expect(classifyAppError("429 rate limit: weekly usage limit reached for your plan")).toBe("model-subscription");
	});

	it("does not mistake a number in a path or a file name for an HTTP status", () => {
		expect(classifyAppError("Cannot read /Users/me/Invoices/402/scan.pdf")).toBe("other");
		expect(classifyAppError("Cannot parse report-429.docx")).toBe("other");
		expect(classifyAppError("ENOENT: no such file or directory, open '/Users/me/Billing/subscription.pdf'")).toBe("other");
		expect(classifyAppError("Cannot open C:\\Users\\me\\Unauthorized\\plan.xlsx")).toBe("other");
	});
});

describe("what each kind allows", () => {
	it("is a model problem only when the model itself cannot be used, which no AI run can repair", () => {
		expect(isModelProblem("model-missing")).toBe(true);
		expect(isModelProblem("model-credentials")).toBe(true);
		expect(isModelProblem("model-subscription")).toBe(true);
		expect(isModelProblem("model-not-found")).toBe(true);
		expect(isModelProblem("rate-limit")).toBe(false);
		expect(isModelProblem("network")).toBe(false);
		expect(isModelProblem("other")).toBe(false);
	});

	it("offers the AI fix only for errors that are not about reaching or paying for the model", () => {
		expect(canFixWithAi("other")).toBe(true);
		for (const kind of ["model-missing", "model-credentials", "model-subscription", "model-not-found", "rate-limit", "network"] as const) {
			expect(canFixWithAi(kind)).toBe(false);
		}
	});
});
