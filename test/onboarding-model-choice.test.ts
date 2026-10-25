import { describe, expect, it } from "vitest";
import { onlyModel, reconcileModelChoice } from "../src/renderer/src/onboarding/model-choice";
import type { ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";

const model = (provider: string, id: string): ModelCatalogEntry => ({ provider, id, name: id, api: "openai-completions", available: true, baseUrl: null, apiKeyEnv: null });

const provider = (id: string, over: Partial<ProviderSummary> = {}): ProviderSummary => ({
	id,
	name: id,
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: null,
	models: [model(id, "m-1")],
	...over,
});

describe("reconcileModelChoice", () => {
	it("takes the answer model from the config when its provider is connected, still unchecked", () => {
		expect(reconcileModelChoice({ model: { provider: "openai", id: "m-1" } }, [provider("openai")])).toEqual({ provider: "openai", modelId: "m-1", verified: false });
	});

	it("is null when no model is configured or its provider lost its credential", () => {
		expect(reconcileModelChoice({}, [provider("openai")])).toBeNull();
		expect(reconcileModelChoice({ model: { provider: "openai", id: "m-1" } }, [provider("openai", { authConfigured: false })])).toBeNull();
		expect(reconcileModelChoice({ model: { provider: "gone", id: "m-1" } }, [provider("openai")])).toBeNull();
	});

	it("never counts the Dazzi plan as a bring-your-own-key model", () => {
		expect(reconcileModelChoice({ model: { provider: "dazzi", id: "m-1" } }, [provider("dazzi")])).toBeNull();
	});
});

describe("onlyModel", () => {
	it("returns the single model when exactly one is offered, else null", () => {
		const one = { provider: provider("a"), model: model("a", "m-1") };
		const two = { provider: provider("b"), model: model("b", "m-2") };
		expect(onlyModel([one])).toBe(one.model);
		expect(onlyModel([one, two])).toBeNull();
		expect(onlyModel([])).toBeNull();
	});
});
