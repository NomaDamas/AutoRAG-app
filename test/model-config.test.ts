import { describe, expect, it } from "vitest";
import { isAllowedAgentApi, modelConfigUpdates } from "../src/shared/model-config";
import type { ModelCatalogEntry } from "../src/shared/settings-contract";

const entry = (over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
	provider: "openai",
	id: "m-1",
	name: "Model One",
	api: "openai-responses",
	available: true,
	baseUrl: null,
	apiKeyEnv: "OPENAI_API_KEY",
	...over,
});

describe("modelConfigUpdates", () => {
	it("writes every leaf of the answer model and removes the ones the entry does not carry", () => {
		expect(modelConfigUpdates(entry())).toEqual([
			{ path: ["model", "provider"], value: "openai" },
			{ path: ["model", "id"], value: "m-1" },
			{ path: ["model", "name"], value: "Model One" },
			{ path: ["model", "api"], value: "openai-responses" },
			{ path: ["model", "baseUrl"], remove: true },
			{ path: ["model", "apiKeyEnv"], value: "OPENAI_API_KEY" },
		]);
	});

	it("keeps a server's base URL and drops a protocol the config does not accept", () => {
		const updates = modelConfigUpdates(entry({ provider: "ollama", api: "google-generative-ai", baseUrl: " http://127.0.0.1:11434/v1 ", apiKeyEnv: null, name: "  " }));
		expect(updates).toContainEqual({ path: ["model", "baseUrl"], value: "http://127.0.0.1:11434/v1" });
		expect(updates).toContainEqual({ path: ["model", "api"], remove: true });
		expect(updates).toContainEqual({ path: ["model", "name"], remove: true });
		expect(updates).toContainEqual({ path: ["model", "apiKeyEnv"], remove: true });
	});
});

describe("isAllowedAgentApi", () => {
	it("accepts the wire protocols the config knows and nothing else", () => {
		expect(isAllowedAgentApi("anthropic-messages")).toBe(true);
		expect(isAllowedAgentApi("google-generative-ai")).toBe(false);
		expect(isAllowedAgentApi("")).toBe(false);
	});
});
