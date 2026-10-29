// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolesStep } from "../src/renderer/src/onboarding/steps/Roles";
import { setAppLanguage } from "../src/shared/i18n";
import type { AutoRagConfigSnapshot, ProviderSummary } from "../src/shared/settings-contract";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

// The settings modules capture `window.autorag.settings` at import time, so the bridge must exist first.
const settings = vi.hoisted(() => {
	const bridge = { providersList: vi.fn(), configGet: vi.fn(), configPatch: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings: bridge });
	return bridge;
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const provider = (id: string, over: Partial<ProviderSummary> = {}): ProviderSummary => ({
	id,
	name: `Provider ${id}`,
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: null,
	models: [],
	...over,
});

const config = (body: AutoRagConfigSnapshot["config"] = {}): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: body });

async function render(): Promise<void> {
	await act(async () => {
		root.render(<RolesStep ctx={onboardingCtx({ draft: { ...BASE_DRAFT, stepId: "roles", plan: "byok" } })} />);
	});
}

const click = async (element: Element | null): Promise<void> => {
	if (element === null) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

const trigger = (role: "rerank" | "jev"): Element | null => host.querySelector(`[data-role-trigger="${role}"]`);

beforeEach(async () => {
	await setAppLanguage("en");
	for (const fn of Object.values(settings)) fn.mockReset();
	settings.configPatch.mockImplementation(async () => config());
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("RolesStep", () => {
	it("offers the reranker and Jev models the connected providers serve, and only those", async () => {
		settings.providersList.mockResolvedValue([provider("openrouter"), provider("anthropic")]);
		settings.configGet.mockResolvedValue(config());
		await render();
		await click(trigger("rerank"));
		expect(host.querySelector('[data-provider-trigger="openrouter"]')).not.toBeNull();
		expect(host.querySelector('[data-provider-trigger="anthropic"]')).toBeNull();
		await click(host.querySelector('[data-provider-trigger="openrouter"]'));
		expect(host.querySelector('[data-model-id="openrouter/cohere/rerank-v3.5"]')).not.toBeNull();
	});

	it("saves the picked reranker into the shared config, where Settings reads it", async () => {
		settings.providersList.mockResolvedValue([provider("openrouter")]);
		settings.configGet.mockResolvedValue(config());
		await render();
		await click(trigger("rerank"));
		await click(host.querySelector('[data-provider-trigger="openrouter"]'));
		await click(host.querySelector('[data-model-id="openrouter/cohere/rerank-v3.5"]'));
		expect(settings.configPatch).toHaveBeenCalledWith([{ path: ["rerank"], value: { enabled: true, provider: "openrouter", model: "cohere/rerank-v3.5" } }]);
	});

	it("saves the picked Jev model with the backend its provider serves", async () => {
		settings.providersList.mockResolvedValue([provider("openrouter")]);
		settings.configGet.mockResolvedValue(config());
		await render();
		await click(trigger("jev"));
		await click(host.querySelector('[data-provider-trigger="openrouter"]'));
		await click(host.querySelector('[data-model-id="openrouter/typesafe/jev-1.13"]'));
		expect(settings.configPatch).toHaveBeenCalledWith([{ path: ["jev"], value: { model: "typesafe/jev-1.13", backend: "openrouter" } }]);
	});

	it("turns a role off when asked", async () => {
		settings.providersList.mockResolvedValue([provider("openrouter")]);
		settings.configGet.mockResolvedValue(config({ rerank: { enabled: true, provider: "openrouter", model: "cohere/rerank-v3.5" } }));
		await render();
		await click(trigger("rerank"));
		const off = [...host.querySelectorAll(".settings-menu-item")].find((item) => item.textContent?.trim() === "Disabled");
		await click(off ?? null);
		expect(settings.configPatch).toHaveBeenCalledWith([{ path: ["rerank"], value: false }]);
	});

	it("says so, instead of showing an empty menu, when the connected services serve a role not at all", async () => {
		settings.providersList.mockResolvedValue([provider("anthropic")]);
		settings.configGet.mockResolvedValue(config());
		await render();
		expect(host.querySelector('[data-role-unavailable="rerank"]')).not.toBeNull();
		expect(host.querySelector('[data-role-unavailable="jev"]')).not.toBeNull();
		expect(trigger("rerank")?.hasAttribute("disabled")).toBe(true);
	});
});
