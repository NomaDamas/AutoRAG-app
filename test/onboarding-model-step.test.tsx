// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ModelStep } from "../src/renderer/src/onboarding/steps/Model";
import { setAppLanguage } from "../src/shared/i18n";
import type { OnboardingDraft } from "../src/shared/onboarding-contract";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

// The settings modules capture `window.autorag.settings` at import time, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const settings = {
		providersList: vi.fn(),
		configGet: vi.fn(),
		configPatch: vi.fn(),
		providersTest: vi.fn(),
		providersRemove: vi.fn(),
		providerLogout: vi.fn(),
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
/** The shared config the bridge reads and patches. */
let store: Record<string, unknown>;

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

/** The three helper roles on "auto", so only the answer model decides whether the step opens. */
const HELPERS_AUTO = { queryDecomposition: false, jev: false, rerank: false };

const snapshot = (): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: structuredClone(store) as AutoRagConfigSnapshot["config"] });

function apply(updates: readonly AutoRagConfigUpdate[]): void {
	for (const update of updates) {
		let node = store;
		for (const key of update.path.slice(0, -1)) {
			const next = node[key];
			node[key] = typeof next === "object" && next !== null ? next : {};
			node = node[key] as Record<string, unknown>;
		}
		const last = update.path.at(-1) as string;
		if ("remove" in update && update.remove === true) delete node[last];
		else node[last] = (update as { value: unknown }).value;
	}
}

const byokDraft = (over: Partial<OnboardingDraft> = {}): OnboardingDraft => ({ ...BASE_DRAFT, stepId: "model", plan: "byok", ...over });

async function render(draft: OnboardingDraft): Promise<{ readonly patch: Mock<(value: Partial<OnboardingDraft>) => void> }> {
	const patch = vi.fn<(value: Partial<OnboardingDraft>) => void>();
	await act(async () => {
		root.render(<ModelStep ctx={onboardingCtx({ draft, patch })} />);
	});
	return { patch };
}

const click = async (element: Element | null): Promise<void> => {
	if (element === null) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

const status = (role: string): Element | null => host.querySelector(`[data-role-row="${role}"] .model-role-status`);

async function pick(role: string, id: string): Promise<void> {
	await click(host.querySelector(`[data-role-trigger="${role}"]`));
	await click(document.querySelector(`[data-model-id="${id}"]`));
}

beforeEach(async () => {
	await setAppLanguage("en");
	for (const fn of [...Object.values(bridge.settings), bridge.onboarding.checkModel]) fn.mockReset();
	store = {};
	bridge.onboarding.checkModel.mockResolvedValue({ ok: true, latencyMs: 420 });
	bridge.settings.providersTest.mockResolvedValue({ ok: true });
	bridge.settings.onProviderLoginEvent.mockReturnValue(() => undefined);
	bridge.settings.configGet.mockImplementation(async () => snapshot());
	bridge.settings.configPatch.mockImplementation(async (updates: readonly AutoRagConfigUpdate[]) => {
		apply(updates);
		return snapshot();
	});
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
		await render(byokDraft());
		expect(host.querySelector('[data-provider-row="openai"]')).not.toBeNull();
		expect(host.querySelector('[data-provider-row="dazzi"]')).toBeNull();
		expect(host.querySelector('[data-provider-row="groq"]')).toBeNull();
		expect(host.querySelector("[data-connect-service]")).not.toBeNull();
		for (const role of ["answer", "decomposition", "jev", "rerank"]) expect(host.querySelector(`[data-role-trigger="${role}"]`)).not.toBeNull();
	});

	it("saves the answer model into the shared config and opens the step only once it answered and every role is set", async () => {
		store = { ...HELPERS_AUTO };
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		const { patch } = await render(byokDraft());
		await pick("answer", "openai/b");
		expect(bridge.settings.configPatch).toHaveBeenCalledWith(expect.arrayContaining([{ path: ["model", "provider"], value: "openai" }, { path: ["model", "id"], value: "b" }]));
		expect(bridge.onboarding.checkModel).toHaveBeenCalledWith("answer");
		expect(status("answer")?.classList.contains("ok")).toBe(true);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "b", verified: true } });
	});

	it("keeps the step closed while a helper role has no model yet", async () => {
		store = { model: { provider: "openai", id: "a" }, jev: false, rerank: false };
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		const { patch } = await render(byokDraft());
		expect(patch).not.toHaveBeenCalledWith({ model: expect.objectContaining({ verified: true }) });
		await click(host.querySelector('[data-role-trigger="decomposition"]'));
		await click(document.querySelector("[data-role-auto]"));
		expect(store.queryDecomposition).toBe(false);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "a", verified: true } });
	});

	it("marks a model that did not answer, in its row and in its menu, and keeps the step closed", async () => {
		store = { ...HELPERS_AUTO };
		bridge.onboarding.checkModel.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		const { patch } = await render(byokDraft());
		await pick("answer", "openai/b");
		expect(status("answer")?.classList.contains("failed")).toBe(true);
		expect(host.querySelector('[data-role-trigger="answer"]')?.classList.contains("failed")).toBe(true);
		expect(patch).not.toHaveBeenCalledWith({ model: expect.objectContaining({ verified: true }) });
		await click(host.querySelector('[data-role-trigger="answer"]'));
		expect(document.querySelector('[data-model-id="openai/b"]')?.classList.contains("failed")).toBe(true);
	});

	it("closes an open menu from its own trigger, and turns the trigger's arrow while it is open", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		await render(byokDraft());
		const trigger = host.querySelector('[data-role-trigger="answer"]');
		await click(trigger);
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector(".onb-menu")).not.toBeNull();
		await click(trigger);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector(".onb-menu")).toBeNull();
		await click(host.querySelector("[data-connect-service]"));
		expect(document.querySelector(".onb-menu.connect")).not.toBeNull();
		await click(host.querySelector("[data-connect-service]"));
		expect(document.querySelector(".onb-menu.connect")).toBeNull();
	});

	it("does not open a role's menu while its check runs", async () => {
		store = { ...HELPERS_AUTO };
		bridge.onboarding.checkModel.mockReturnValue(new Promise(() => undefined));
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		await render(byokDraft());
		await pick("answer", "openai/a");
		expect(status("answer")?.classList.contains("checking")).toBe(true);
		expect((host.querySelector('[data-role-trigger="answer"]') as HTMLButtonElement).disabled).toBe(true);
	});

	it("checks the splitting model by a real call, and Jev and the reranker through their provider's connection test", async () => {
		store = { model: { provider: "openrouter", id: "a" } };
		bridge.settings.providersList.mockResolvedValue([provider("openrouter", [model("openrouter", "a"), model("openrouter", "b")])]);
		const { patch } = await render(byokDraft());
		await pick("decomposition", "openrouter/b");
		expect(bridge.onboarding.checkModel).toHaveBeenCalledWith("decomposition");
		await pick("jev", "openrouter/typesafe/jev-1.13");
		await pick("rerank", "openrouter/voyageai/rerank-3-lite");
		expect(bridge.settings.providersTest).toHaveBeenCalledWith("openrouter");
		expect(store.jev).toEqual({ model: "typesafe/jev-1.13", backend: "openrouter" });
		expect(store.rerank).toEqual({ enabled: true, provider: "openrouter", model: "voyageai/rerank-3-lite" });
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openrouter", modelId: "a", verified: true } });
	});

	it("checks what the config already holds, so a returning user is not asked to pick again", async () => {
		store = { model: { provider: "openai", id: "a" }, ...HELPERS_AUTO };
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		const { patch } = await render(byokDraft());
		expect(bridge.settings.configPatch).not.toHaveBeenCalled();
		expect(bridge.onboarding.checkModel).toHaveBeenCalledTimes(1);
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "openai", modelId: "a", verified: true } });
	});

	it("drops a choice the config no longer backs, so the step cannot be passed on a stale draft", async () => {
		bridge.settings.providersList.mockResolvedValue([provider("openai", [model("openai", "a"), model("openai", "b")])]);
		const { patch } = await render(byokDraft({ model: { provider: "openai", modelId: "a", verified: true } }));
		expect(patch).toHaveBeenCalledWith({ model: null });
	});

	it("selects the only model on offer by itself", async () => {
		store = { ...HELPERS_AUTO };
		bridge.settings.providersList.mockResolvedValue([provider("local", [model("local", "only")])]);
		const { patch } = await render(byokDraft());
		expect(bridge.settings.configPatch).toHaveBeenCalledWith(expect.arrayContaining([{ path: ["model", "id"], value: "only" }]));
		expect(patch).toHaveBeenLastCalledWith({ model: { provider: "local", modelId: "only", verified: true } });
	});

	it("opens a searchable connect menu with every provider kind it offers, and no Dazzi sign-in", async () => {
		bridge.settings.providersList.mockResolvedValue([
			provider("anthropic", [], { authConfigured: false, authKinds: ["oauth", "api_key"], subscription: true }),
			provider("openrouter", [], { authConfigured: false }),
		]);
		await render(byokDraft());
		await click(host.querySelector("[data-connect-service]"));
		const menu = document.body.textContent ?? "";
		expect(menu).toContain("Provider anthropic");
		expect(menu).toContain("Provider openrouter");
		expect(menu).toContain("onboarding.model.addCustom");
		expect(menu).not.toContain("Dazzi");
		expect(document.querySelector(".onb-menu-search input")).not.toBeNull();
	});

	it("disconnects a service after asking, freeing the roles that used it", async () => {
		store = { model: { provider: "ollama", id: "a" }, ...HELPERS_AUTO };
		bridge.settings.providersList.mockResolvedValueOnce([provider("ollama", [model("ollama", "a")], { kind: "local", authKinds: [] })]).mockResolvedValue([]);
		await render(byokDraft());
		await click(host.querySelector('[data-provider-row="ollama"] .model-service-remove'));
		await click(document.querySelector(".settings-modal .is-danger"));
		expect(store.model).toBeUndefined();
		expect(bridge.settings.providersRemove).toHaveBeenCalledWith("ollama");
	});

	it("keeps Connect half-strength until the server form is valid, and says which field is wrong", async () => {
		bridge.settings.providersList.mockResolvedValue([]);
		await render(byokDraft());
		await click(host.querySelector("[data-connect-service]"));
		await click([...document.querySelectorAll(".onb-menu-item")].find((item) => item.textContent?.includes("onboarding.model.addCustom")) ?? null);
		const inputs = [...document.querySelectorAll<HTMLInputElement>(".settings-modal input")];
		const connect = document.querySelector<HTMLButtonElement>(".settings-modal .settings-btn-primary");
		const type = async (input: HTMLInputElement | undefined, value: string): Promise<void> => {
			if (input === undefined) throw new Error("no input");
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
		};
		expect(inputs[0]?.value).toBe("");
		expect(connect?.disabled).toBe(true);
		await type(inputs[0], "My server");
		await type(inputs[1], "not a url");
		expect(connect?.disabled).toBe(true);
		expect(document.querySelector(".settings-field-error")?.textContent).toBe("This address isn't valid. Check it and try again.");
		await type(inputs[1], "https://gateway.example.com/v1");
		expect(connect?.disabled).toBe(false);
		expect(document.querySelector(".settings-field-error")).toBeNull();
	});
});
