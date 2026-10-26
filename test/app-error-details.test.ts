import { describe, expect, it } from "vitest";
import { splitErrorDetails } from "../src/renderer/src/state/app-error";

describe("splitErrorDetails: what the person reads and what only a developer needs", () => {
	it("keeps a short plain sentence as it is, with nothing to expand", () => {
		expect(splitErrorDetails("The folder does not exist.")).toEqual({ summary: "The folder does not exist.", details: null });
	});

	it("moves the JSON body and the status of a provider error into the details", () => {
		const raw = 'dazzi API error (401): {"message":"Invalid or revoked API key.","type":"invalid_request_error","code":"invalid_api_key"}';

		const split = splitErrorDetails(raw);

		expect(split.details).toBe(raw);
		expect(split.summary).not.toContain("{");
		expect(split.summary).not.toContain("invalid_request_error");
	});

	it("moves a stack trace out of the sight, keeping the first line as the summary", () => {
		const raw = "TypeError: x is not a function\n    at run (/app/out/main/index.js:10:5)\n    at async main (/app/out/main/index.js:20:3)";

		const split = splitErrorDetails(raw);

		expect(split.summary).toBe("TypeError: x is not a function");
		expect(split.details).toBe(raw);
	});

	it("hides internal setup instructions (command lines, config paths) that mean nothing to the person", () => {
		const raw = "ConfigError: No model configured. Sign in and pick one with `autorag tui` (`/login`, then `/model`), or set \"model\": { \"provider\": ... } in the AutoRAG config (`autorag models list` shows the ids). The local Codex runtime fallback is unavailable: Codex config not found at /Users/me/.codex/config.toml";
		const split = splitErrorDetails(raw);

		expect(split.details).toBe(raw);
		expect(split.summary).not.toContain("autorag tui");
		expect(split.summary).not.toContain(".codex");
	});

	it("leaves no summary when nothing readable is left but a status code: the plain-words title already says it", () => {
		expect(splitErrorDetails('401: {"message":"Incorrect API key provided."}').summary).toBe("");
		expect(splitErrorDetails('dazzi API error (429): {"message":"x"}').summary).toBe("");
		expect(splitErrorDetails('dazzi API error (429): {"message":"x"}').details).not.toBeNull();
	});

	it("hides a very long message behind the details instead of filling the box", () => {
		const raw = `Something failed. ${"x".repeat(400)}`;

		const split = splitErrorDetails(raw);

		expect(split.details).toBe(raw);
		expect(split.summary.length).toBeLessThanOrEqual(140);
	});

	it("leaves a folder path in a short message: the person needs to see which folder", () => {
		const raw = "Error: AutoRAG search root does not exist: /Users/me/Documents-old";

		expect(splitErrorDetails(raw)).toEqual({ summary: raw, details: null });
	});

	it("never returns an empty summary", () => {
		expect(splitErrorDetails("").summary).toBe("");
		expect(splitErrorDetails('{"a":1}').summary).not.toBe("");
	});
});
