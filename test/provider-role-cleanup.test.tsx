// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

// The settings modules capture `window.autorag.settings` at import time, so the bridge must exist first.
vi.hoisted(() => {
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings: {} });
});

const { providerRoleCleanup } = await import("../src/renderer/src/components/settings/roleSupport");

describe("providerRoleCleanup", () => {
	it("removes the required Jev block instead of writing `jev: false`, which the librarian rejects", () => {
		const config = { jev: { backend: "openrouter", model: "typesafe/jev-1.13" } };
		expect(providerRoleCleanup(config, "openrouter")).toEqual([{ path: ["jev"], remove: true }]);
	});

	it("still switches the optional reranker off and removes the answer and splitting models", () => {
		const config = {
			model: { provider: "openrouter", id: "a" },
			queryDecomposition: { model: { provider: "openrouter", id: "b" } },
			rerank: { enabled: true, provider: "openrouter", model: "cohere/rerank-v3.5" },
		};
		expect(providerRoleCleanup(config, "openrouter")).toEqual([
			{ path: ["model"], remove: true },
			{ path: ["queryDecomposition"], remove: true },
			{ path: ["rerank"], value: false },
		]);
	});

	it("leaves a decision model that needs no provider alone", () => {
		expect(providerRoleCleanup({ jev: { backend: "sllm" } }, "openrouter")).toEqual([]);
	});
});
