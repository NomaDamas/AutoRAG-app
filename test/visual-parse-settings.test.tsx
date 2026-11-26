// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";

const bridge = vi.hoisted(() => {
	const settings = {
		providersList: vi.fn(),
		embeddingGet: vi.fn(),
		configPatch: vi.fn(),
		configSet: vi.fn(),
		configRemove: vi.fn(),
		configRefresh: vi.fn(),
		onProviderLoginEvent: vi.fn(() => () => undefined),
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings,
		onboarding: {},
		modelDownload: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return settings;
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { AiPage } = await import("../src/renderer/src/components/settings/AiPage");
const { providerRoleCleanup, roleSelectionFor } = await import("../src/renderer/src/components/settings/roleSupport");
const { jevBackendFor, jevModelsFor } = await import("../src/shared/ai-roles");
const {
	visualParseOcrConfigUpdates,
	visualParseOffConfigUpdates,
	visualParseVlmConfigUpdates,
} = await import("../src/shared/model-config");

let host: HTMLDivElement;
let root: Root;

const model = (provider: string, id: string, over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
	provider,
	id,
	name: `Name ${id}`,
	api: "openai-responses",
	available: true,
	baseUrl: null,
	apiKeyEnv: null,
	supportsImage: true,
	...over,
});

const provider = (id: string, name: string, over: Partial<ProviderSummary> = {}): ProviderSummary => ({
	id,
	name,
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: null,
	models: [model(id, "m1")],
	...over,
});

const snapshot = (config: AutoRagConfigSnapshot["config"]): AutoRagConfigSnapshot => ({
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	config,
});

async function render(providers: readonly ProviderSummary[], config: AutoRagConfigSnapshot["config"] = {}): Promise<void> {
	bridge.providersList.mockResolvedValue(providers);
	await act(async () => {
		root.render(<AiPage snapshot={snapshot(config)} onSaved={vi.fn()} />);
	});
}

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.providersList.mockReset();
	bridge.embeddingGet.mockReset();
	bridge.configPatch.mockReset();
	bridge.embeddingGet.mockRejectedValue(new Error("no embedding in this test"));
	host = document.createElement("div");
	host.className = "settings-view";
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("visual parse settings integration (unified Jev decision model)", () => {
	it("exposes vision-capable decision models inside the single Jev role with Jev first as default", () => {
		expect(jevBackendFor("bivia")).toBe("bivia");
		expect(jevModelsFor("bivia").map((m) => m.id)).toEqual(["dec-1"]);
		expect(jevModelsFor("dazzi")[0]?.id).toBe("jev-1.13");
		expect(jevModelsFor("openrouter")[0]?.id).toBe("typesafe/jev-1.13");
		expect(jevModelsFor("openrouter").map((m) => m.id)).toContain("typesafe/jev-1.14");
		expect(jevModelsFor("openai").map((m) => m.id)).toContain("gpt-6-luna");
	});

	it("builds clean leaf updates for VLM, OCR, and Off while preserving sibling visualParse fields", () => {
		const vlmEntry = model("openrouter", "google/gemini-3.5-flash-lite", {
			name: "Gemini 3.5 Flash Lite",
			api: "openai-completions",
		});
		const existing = { visualParse: { enabled: true, threshold: 0.65 } };
		expect(visualParseVlmConfigUpdates(vlmEntry, existing)).toEqual([
			{
				path: ["visualParse"],
				value: {
					enabled: true,
					threshold: 0.65,
					extractor: {
						kind: "vlm",
						model: {
							provider: "openrouter",
							id: "google/gemini-3.5-flash-lite",
							name: "Gemini 3.5 Flash Lite",
							api: "openai-completions",
						},
					},
				},
			},
		]);

		expect(visualParseOcrConfigUpdates(existing)).toEqual([
			{
				path: ["visualParse"],
				value: {
					enabled: true,
					threshold: 0.65,
					extractor: { kind: "ocr" },
				},
			},
		]);

		expect(visualParseOffConfigUpdates()).toEqual([{ path: ["visualParse"], value: false }]);
	});

	it("cleans up visualParse VLM selection when disconnecting its provider", () => {
		const config = {
			jev: { backend: "openrouter", model: "typesafe/jev-1.13" },
			visualParse: {
				enabled: true,
				extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } },
			},
		};
		expect(providerRoleCleanup(config, "openrouter")).toEqual([
			{ path: ["jev"], remove: true },
			{ path: ["visualParse"], value: false },
		]);
	});

	it("renders a single unified Decision model (Jev) row and Advanced visual parsing row with Stage-2 Run now action when enabled", async () => {
		const openrouter = provider("openrouter", "OpenRouter", {
			models: [
				model("openrouter", "google/gemini-3.5-flash-lite", { supportsImage: true }),
				model("openrouter", "text-only/model", { supportsImage: false }),
			],
		});

		await render([openrouter], {});
		expect(host.textContent).toContain("Decision model (Jev)");
		expect(host.textContent).toContain("Advanced visual parsing");
		expect(host.querySelector('[data-action="run-visualParse"]')).toBeNull();

		bridge.configRefresh.mockResolvedValue({ ok: true, written: 3 });
		await render([openrouter], {
			visualParse: {
				enabled: true,
				extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } },
			},
		});
		expect(host.textContent).not.toContain("Visual page gate");
		const runBtn = host.querySelector<HTMLButtonElement>('[data-action="run-visualParse"]');
		expect(runBtn).not.toBeNull();
		await act(async () => {
			runBtn!.click();
		});
		expect(bridge.configRefresh).toHaveBeenCalledWith(["visual", "minsync"]);
		expect(
			roleSelectionFor(
				"visualParse",
				{ visualParse: { enabled: true, extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } } } },
				[openrouter],
			),
		).toEqual({ kind: "model", provider: "openrouter", modelId: "google/gemini-3.5-flash-lite" });
	});
});
