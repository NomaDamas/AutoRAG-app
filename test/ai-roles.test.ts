import { describe, expect, it } from "vitest";
import {
	jevBackendFor,
	jevModelsFor,
	rerankModelsFor,
	shouldAdoptManagedDecomposition,
	shouldAdoptManagedRoles,
	managedRoleUpdates,
	providerConnectRoute,
	withoutAutorag,
} from "../src/shared/ai-roles";

describe("AutoRAG connect and disconnect routing", () => {
	it("sends the AutoRAG plan to the account service and every other provider to the Pi flow", () => {
		expect(providerConnectRoute("dazzi")).toBe("account");
		expect(providerConnectRoute("openrouter")).toBe("provider");
		expect(providerConnectRoute("anthropic")).toBe("provider");
	});

	it("keeps AutoRAG out of the Pi connect lists", () => {
		const rows = [{ id: "openrouter" }, { id: "dazzi" }, { id: "anthropic" }];
		expect(withoutAutorag(rows).map((row) => row.id)).toEqual(["openrouter", "anthropic"]);
	});
});
describe("jev and rerank roles", () => {
	it("maps the AutoRAG provider to the dazzi Jev backend alongside the existing ones", () => {
		expect(jevBackendFor("dazzi")).toBe("dazzi");
		expect(jevBackendFor("openrouter")).toBe("openrouter");
		expect(jevBackendFor("vercel-ai-gateway")).toBe("vercel");
		expect(jevBackendFor("typesafe")).toBe("typesafe");
		expect(jevBackendFor("anthropic")).toBeUndefined();
	});

	it("offers the plan's Jev model and its rerankers only for the AutoRAG provider", () => {
		expect(jevModelsFor("dazzi").map((model) => model.id)).toEqual(["jev-1.13"]);
		expect(rerankModelsFor("dazzi").map((model) => model.id)).toEqual(["qwen/qwen3-reranker-8b"]);
		expect(rerankModelsFor("openrouter").length).toBeGreaterThan(0);
		expect(rerankModelsFor("anthropic")).toEqual([]);
	});
});

describe("managed Jev and rerank defaults", () => {
	it("adopts each role when it is unset or already points at AutoRAG, and never overrides another provider", () => {
		expect(shouldAdoptManagedRoles({})).toEqual({ jev: true, rerank: true });
		expect(shouldAdoptManagedRoles({ jev: { backend: "dazzi", model: "jev-1.13" }, rerank: { provider: "dazzi" } })).toEqual({ jev: true, rerank: true });
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

	it("keeps an AutoRAG block the user switched off or tuned, and only refreshes a bare one", () => {
		expect(shouldAdoptManagedRoles({ jev: { backend: "dazzi", enabled: false }, rerank: { provider: "dazzi", enabled: false } })).toEqual({ jev: false, rerank: false });
		expect(shouldAdoptManagedRoles({ jev: { backend: "dazzi", confidenceThreshold: 0.8 }, rerank: { provider: "dazzi", topN: 10 } })).toEqual({ jev: false, rerank: false });
		expect(shouldAdoptManagedRoles({ jev: { backend: "dazzi", model: "jev-1.13" }, rerank: { provider: "dazzi", enabled: true, model: "x" } })).toEqual({ jev: true, rerank: true });
		expect(shouldAdoptManagedRoles({ jev: { backend: "dazzi" }, rerank: { provider: "dazzi" } })).toEqual({ jev: true, rerank: true });
	});

	it("keeps the model an AutoRAG block already names when it still exists on the server", () => {
		const jevModels = [{ id: "jev-1.13" }, { id: "jev-2" }];
		const rerankModels = [{ id: "r-a" }, { id: "r-b" }];

		expect(managedRoleUpdates({ jev: true, rerank: true }, jevModels, rerankModels, { jev: { backend: "dazzi", model: "jev-2" }, rerank: { provider: "dazzi", model: "r-b" } })).toEqual({
			jev: { backend: "dazzi", model: "jev-2" },
			rerank: { enabled: true, provider: "dazzi", model: "r-b" },
		});
		// A model the server no longer lists falls back to its first one.
		expect(managedRoleUpdates({ jev: true, rerank: true }, jevModels, rerankModels, { jev: { backend: "dazzi", model: "gone" }, rerank: { provider: "dazzi", model: "gone" } })).toEqual({
			jev: { backend: "dazzi", model: "jev-1.13" },
			rerank: { enabled: true, provider: "dazzi", model: "r-a" },
		});
	});

	it("adopts a decomposition model only when it is absent, already AutoRAG, or the librarian's untouched default", () => {
		const untouched = { model: { provider: "openrouter", id: "qwen/qwen3.7-flash" } };
		expect(shouldAdoptManagedDecomposition(undefined)).toBe(true);
		expect(shouldAdoptManagedDecomposition({})).toBe(true);
		expect(shouldAdoptManagedDecomposition(untouched)).toBe(true);
		expect(shouldAdoptManagedDecomposition({ model: { provider: "dazzi", id: "x" } })).toBe(true);
		// A deliberate OpenRouter pick, an explicit "same as the answer model" (false), or anything malformed is the user's.
		expect(shouldAdoptManagedDecomposition({ model: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" } })).toBe(false);
		expect(shouldAdoptManagedDecomposition(false)).toBe(false);
		expect(shouldAdoptManagedDecomposition("x")).toBe(false);
		expect(shouldAdoptManagedDecomposition({ model: { provider: "anthropic", id: "y" } })).toBe(false);
	});
	it("writes only the roles it may adopt, using the server's first models", () => {
		const jevModels = [{ id: "jev-1.13" }];
		const rerankModels = [{ id: "qwen/qwen3-reranker-8b" }];

		expect(managedRoleUpdates({ jev: true, rerank: true }, jevModels, rerankModels)).toEqual({
			jev: { backend: "dazzi", model: "jev-1.13" },
			rerank: { enabled: true, provider: "dazzi", model: "qwen/qwen3-reranker-8b" },
		});
		expect(managedRoleUpdates({ jev: false, rerank: true }, jevModels, rerankModels)).toEqual({ rerank: { enabled: true, provider: "dazzi", model: "qwen/qwen3-reranker-8b" } });
		expect(managedRoleUpdates({ jev: true, rerank: true }, [], [])).toEqual({});
	});
});
