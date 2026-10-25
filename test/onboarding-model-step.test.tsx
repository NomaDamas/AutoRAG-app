// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ModelStep } from "../src/renderer/src/onboarding/steps/Model";
import { setAppLanguage } from "../src/shared/i18n";
import type { OnboardingDraft } from "../src/shared/onboarding-contract";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

// The settings modules capture `window.autorag.settings` at import time, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const settings = {
		providersList: vi.fn(),
		configGet: vi.fn(),
		configPatch: vi.fn(),
		onProviderLoginEvent: vi.fn(() => () => undefined),
		providerLoginStart: vi.fn(),
		credentialsSet: vi.fn(),
	};
	const onboarding = { checkModel: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings, onboarding, account: { signIn: vi.fn(), signOut: vi.fn() }, fs: { openUrl: vi.fn() } });
	return { settings, onboarding };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const model = (provider: string, id: string): ModelCatalogEntry => ({ provider, id, name: `Name ${id}`, api: "openai-responses", available: true, baseUrl: null, apiKeyEnv: "OPENAI_API_KEY" });

const provider = (id: string, models: readonly ModelCatalogEntry[], over: Partial<ProviderSummary> = {}): ProviderSummary => ({
	id,
	name: `Provider ${id}`,
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: "OPENAI_API_KEY",
	models,
	...over,
});

const config = (body: AutoRagConfigSnapshot["config"] = {}): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: body });

const byokDraft = (over: Partial<OnboardingDraft> = {}): OnboardingDraft => ({ ...BASE_DRAFT, stepId: "model", plan: "byok", ...over });

interface Rendered {
	readonly patch: Mock<(value: Partial<OnboardingDraft>) => void>;
	readonly toast: Mock<(message: string) => void>;
}

async function render(draft: OnboardingDraft): Promise<Rendered> {
	const patch = vi.fn<(value: Partial<OnboardingDraft>) => void>();
	const toast = vi.fn<(message: string) => void>();
	await act(async () => {
		root.render(<ModelStep ctx={onboardingCtx({ draft, patch, toast })} />);
	});
	return { patch, toast };
}

const click = async (element: Element | null): Promise<void> => {
	if (element === null) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

beforeEach(async () => {
	await setAppLanguage("en");
	for (const fn of [...Object.values(bridge.settings), bridge.onboarding.checkModel]) fn.mockReset();
	bridge.onboarding.checkModel.mockResolvedValue({ ok: true, latencyMs: 420 });
	bridge.settings.onProviderLoginEvent.mockReturnValue(() => undefined);
	bridge.settings.configPatch.mockImplementation(async () => config());
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("ModelStep", () => {
	it("lists the providers Settings knows as connected, never the Dazzi plan, and offers to connect more", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")]), provider("dazzi", [model("dazzi", "z")]), provider("groq", [model("groq", "g")], { authConfigured: false })]);
		bridge.settings.configGet.mockResolvedValue(config());
		await render(byokDraft());
		expect(host.querySelector('[data-provider-row="openai"]')).not.toBeNull();
		expect(host.querySelector('[data-provider-row="dazzi"]')).toBeNull();
		expect(host.querySelector('[data-provider-row="groq"]')).toBeNull();
		expect(host.querySelector("[data-connect-service]")).not.toBeNull();
	});

	it("saves the picked model into the shared config, where Settings reads it, and marks the choice ready", async () => {
		const pick = model("openai", "b");
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), pick])]);
		bridge.settings.configGet.mockResolvedValue(config());
		const { patch } = await render(byokDraft());
		await click(host.querySelector("[data-model-trigger]"));
		await click(host.querySelector('[data-model-id="openai/b"]'));
		expect(bridge.settings.configPatch).toHaveBeenCalledWith(
			expect.arrayContaining([
				{ path: ["model", "provider"], value: "openai" },
				{ path: ["model", "id"], value: "b" },
			]),
		);
		// Saved first, and only ready once that very model has answered a real call.
		expect(patch).toHaveBeenNthCalledWith(1, { model: { provider: "openai", modelId: "b", verified: false } });
		expect(bridge.onboarding.checkModel).toHaveBeenCalledTimes(1);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "b", verified: true } });
	});

	it("keeps the step closed when the chosen model does not answer, and says why", async () => {
		bridge.onboarding.checkModel.mockResolvedValue({ ok: false, error: "401 invalid api key" });
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		bridge.settings.configGet.mockResolvedValue(config());
		const { patch } = await render(byokDraft());
		await click(host.querySelector("[data-model-trigger]"));
		await click(host.querySelector('[data-model-id="openai/b"]'));
		expect(patch).not.toHaveBeenCalledWith({ model: expect.objectContaining({ verified: true }) });
		expect(host.textContent).toContain("401 invalid api key");
		expect(host.querySelector("[data-model-retry]")).not.toBeNull();
	});

	it("lets the user run the check again after a failure, and opens the step once it passes", async () => {
		bridge.onboarding.checkModel.mockResolvedValueOnce({ ok: false, error: "timeout" }).mockResolvedValueOnce({ ok: true, latencyMs: 90 });
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		bridge.settings.configGet.mockResolvedValue(config());
		const { patch } = await render(byokDraft());
		await click(host.querySelector("[data-model-trigger]"));
		await click(host.querySelector('[data-model-id="openai/b"]'));
		await click(host.querySelector("[data-model-retry]"));
		expect(bridge.onboarding.checkModel).toHaveBeenCalledTimes(2);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "b", verified: true } });
		expect(host.querySelector("[data-model-retry]")).toBeNull();
	});

	it("adopts the answer model already in the config, so a returning user is not asked again", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		bridge.settings.configGet.mockResolvedValue(config({ model: { provider: "openai", id: "a" } }));
		const { patch } = await render(byokDraft());
		expect(bridge.settings.configPatch).not.toHaveBeenCalled();
		// What the config already holds still has to answer before the step opens.
		expect(patch).toHaveBeenNthCalledWith(1, { model: { provider: "openai", modelId: "a", verified: false } });
		expect(bridge.onboarding.checkModel).toHaveBeenCalledTimes(1);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "a", verified: true } });
	});

	it("drops a choice the config no longer backs, so the step cannot be passed on a stale draft", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		bridge.settings.configGet.mockResolvedValue(config());
		const { patch } = await render(byokDraft({ model: { provider: "openai", modelId: "a", verified: true } }));
		expect(patch).toHaveBeenCalledWith({ model: null });
	});

	it("does not re-check a resumed draft whose verified model the config still backs", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		bridge.settings.configGet.mockResolvedValue(config({ model: { provider: "openai", id: "a" } }));
		const { patch } = await render(byokDraft({ model: { provider: "openai", modelId: "a", verified: true } }));
		expect(patch).not.toHaveBeenCalled();
		expect(bridge.onboarding.checkModel).not.toHaveBeenCalled();
	});

	it("selects the only model on offer by itself", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("local", [model("local", "only")])]);
		bridge.settings.configGet.mockResolvedValue(config());
		const { patch } = await render(byokDraft());
		expect(bridge.settings.configPatch).toHaveBeenCalledWith(expect.arrayContaining([{ path: ["model", "id"], value: "only" }]));
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "local", modelId: "only", verified: true } });
	});

	it("opens the same connect menu as Settings, with every provider kind it offers", async () => {
		bridge.settings.providersList.mockResolvedValue([
			provider("anthropic", [], { authConfigured: false, authKinds: ["oauth", "api_key"], subscription: true }),
			provider("openrouter", [], { authConfigured: false }),
			provider("ollama", [], { authConfigured: false, kind: "local", authKinds: [] }),
		]);
		bridge.settings.configGet.mockResolvedValue(config());
		await render(byokDraft());
		await click(host.querySelector("[data-connect-service]"));
		const menu = document.body.textContent ?? "";
		expect(menu).toContain("Provider anthropic");
		expect(menu).toContain("Provider openrouter");
		expect(menu).toContain("Provider ollama");
		// The Dazzi plan sign-in belongs to the account step, not to bring-your-own-key.
		expect(menu).not.toContain("Dazzi");
	});
});
