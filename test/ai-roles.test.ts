import { describe, expect, it } from "vitest";
import {
	jevBackendFor,
	jevModelsFor,
	rerankModelsFor,
	shouldAdoptManagedRoles,
	managedRoleUpdates,
} from "../src/shared/ai-roles";

describe("jev and rerank roles", () => {
	it("maps the AutoRAG provider to the autorag Jev backend alongside the existing ones", () => {
		expect(jevBackendFor("autorag")).toBe("autorag");
		expect(jevBackendFor("openrouter")).toBe("openrouter");
		expect(jevBackendFor("vercel-ai-gateway")).toBe("vercel");
		expect(jevBackendFor("typesafe")).toBe("typesafe");
		expect(jevBackendFor("anthropic")).toBeUndefined();
	});

	it("offers the plan's Jev model and its rerankers only for the AutoRAG provider", () => {
		expect(jevModelsFor("autorag").map((model) => model.id)).toEqual(["jev-1.13"]);
		expect(rerankModelsFor("autorag").map((model) => model.id)).toEqual(["qwen/qwen3-reranker-8b", "nvidia/llama-nemotron-rerank-vl-1b-v2:free"]);
		expect(rerankModelsFor("openrouter").length).toBeGreaterThan(0);
		expect(rerankModelsFor("anthropic")).toEqual([]);
	});
});

describe("managed Jev and rerank defaults", () => {
	it("adopts each role when it is unset or already points at AutoRAG, and never overrides another provider", () => {
		expect(shouldAdoptManagedRoles({})).toEqual({ jev: true, rerank: true });
		expect(shouldAdoptManagedRoles({ jev: { backend: "autorag", model: "jev-1.13" }, rerank: { provider: "autorag" } })).toEqual({ jev: true, rerank: true });
		expect(shouldAdoptManagedRoles({ jev: { backend: "openrouter", model: "typesafe/jev-1.13" }, rerank: { provider: "openrouter", model: "voyageai/rerank-3" } })).toEqual({ jev: false, rerank: false });
	});

	it("respects an explicit off and a malformed value as the user's choice", () => {
		expect(shouldAdoptManagedRoles({ jev: false, rerank: false })).toEqual({ jev: false, rerank: false });
		expect(shouldAdoptManagedRoles({ jev: "x", rerank: 3 })).toEqual({ jev: false, rerank: false });
	});

	it("treats the librarian's untouched OpenRouter defaults as unset, but a deliberate choice as the user's", () => {
		// What `writeDefaultConfig` writes on a fresh machine.
		const fresh = {
			jev: { backend: "openrouter" },
			rerank: { provider: "openrouter", model: "voyageai/rerank-3-lite", apiKeyEnv: "OPENROUTER_API_KEY", topN: 25 },
		};
		expect(shouldAdoptManagedRoles(fresh)).toEqual({ jev: true, rerank: true });
		expect(shouldAdoptManagedRoles({ jev: { backend: "openrouter", model: "typesafe/jev-latest" }, rerank: { ...fresh.rerank, model: "voyageai/rerank-3" } })).toEqual({ jev: false, rerank: false });
		expect(shouldAdoptManagedRoles({ jev: { backend: "typesafe" }, rerank: { ...fresh.rerank, topN: 10 } })).toEqual({ jev: false, rerank: false });
		expect(shouldAdoptManagedRoles({ jev: {}, rerank: undefined })).toEqual({ jev: true, rerank: true });
	});

	it("writes only the roles it may adopt, using the server's first models", () => {
		const jevModels = [{ id: "jev-1.13" }];
		const rerankModels = [{ id: "qwen/qwen3-reranker-8b" }, { id: "nvidia/llama-nemotron-rerank-vl-1b-v2:free" }];

		expect(managedRoleUpdates({ jev: true, rerank: true }, jevModels, rerankModels)).toEqual({
			jev: { backend: "autorag", model: "jev-1.13" },
			rerank: { enabled: true, provider: "autorag", model: "qwen/qwen3-reranker-8b" },
		});
		expect(managedRoleUpdates({ jev: false, rerank: true }, jevModels, rerankModels)).toEqual({ rerank: { enabled: true, provider: "autorag", model: "qwen/qwen3-reranker-8b" } });
		expect(managedRoleUpdates({ jev: true, rerank: true }, [], [])).toEqual({});
	});
});
