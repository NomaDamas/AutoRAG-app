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
const { visualGateBackendFor, visualGateModelsFor } = await import("../src/shared/ai-roles");
const {
	visualParseGateAutoConfigUpdates,
	visualParseGateConfigUpdates,
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

describe("visual parse settings integration", () => {
	it("exposes vision-capable decision models for Bivia, OpenRouter, Dazzi, OpenAI, TypeSafe, and Cloudflare", () => {
		expect(visualGateBackendFor("bivia")).toBe("bivia");
		expect(visualGateModelsFor("bivia").map((m) => m.id)).toEqual(["dec-1"]);
		expect(visualGateModelsFor("openrouter").map((m) => m.id)).toContain("typesafe/jev-1.14");
		expect(visualGateModelsFor("dazzi").map((m) => m.id)).toContain("typesafe/jev-1.14");
		expect(visualGateModelsFor("openai").map((m) => m.id)).toContain("gpt-6-luna");
	});

	it("builds clean leaf updates for VLM, OCR, Off, and visual gate while preserving sibling settings", () => {
		const vlmEntry = model("openrouter", "google/gemini-3.5-flash-lite", {
			name: "Gemini 3.5 Flash Lite",
			api: "openai-completions",
		});
		const existing = { visualParse: { enabled: true, gate: { backend: "bivia", model: "dec-1" } } };
		expect(visualParseVlmConfigUpdates(vlmEntry, existing)).toEqual([
			{
				path: ["visualParse"],
				value: {
					enabled: true,
					gate: { backend: "bivia", model: "dec-1" },
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
					gate: { backend: "bivia", model: "dec-1" },
					extractor: { kind: "ocr" },
				},
			},
		]);

		expect(visualParseOffConfigUpdates()).toEqual([{ path: ["visualParse"], value: false }]);

		const gateEntry = model("bivia", "dec-1", { name: "Bivia (dec-1)", api: "" });
		expect(visualParseGateConfigUpdates(gateEntry, { visualParse: { enabled: true, extractor: { kind: "ocr" } } })).toEqual([
			{
				path: ["visualParse"],
				value: {
					enabled: true,
					extractor: { kind: "ocr" },
					gate: { backend: "bivia", model: "dec-1" },
				},
			},
		]);
		expect(visualParseGateAutoConfigUpdates()).toEqual([{ path: ["visualParse", "gate"], remove: true }]);
	});

	it("cleans up visualParse VLM and gate selections when disconnecting a provider", () => {
		const config = {
			visualParse: {
				enabled: true,
				gate: { backend: "openrouter", model: "typesafe/jev-1.14" },
				extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } },
			},
		};
		expect(providerRoleCleanup(config, "openrouter")).toEqual([{ path: ["visualParse"], value: false }]);

		const gateOnlyConfig = {
			visualParse: {
				enabled: true,
				gate: { backend: "bivia", model: "dec-1" },
				extractor: { kind: "ocr" },
			},
		};
		expect(providerRoleCleanup(gateOnlyConfig, "bivia")).toEqual([{ path: ["visualParse", "gate"], remove: true }]);
	});

	it("renders visualParse role in AiPage and reveals visualParseGate when enabled", async () => {
		const openrouter = provider("openrouter", "OpenRouter", {
			models: [
				model("openrouter", "google/gemini-3.5-flash-lite", { supportsImage: true }),
				model("openrouter", "text-only/model", { supportsImage: false }),
			],
		});

		await render([openrouter], {});
		expect(host.textContent).toContain("Visual page parsing");
		expect(host.textContent).not.toContain("Visual page gate");
		expect(roleSelectionFor("visualParse", {}, [openrouter])).toEqual({ kind: "special", value: "off" });

		await render([openrouter], {
			visualParse: {
				enabled: true,
				extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } },
			},
		});
		expect(host.textContent).toContain("Visual page parsing");
		expect(host.textContent).toContain("Visual page gate");
		expect(
			roleSelectionFor(
				"visualParse",
				{ visualParse: { enabled: true, extractor: { kind: "vlm", model: { provider: "openrouter", id: "google/gemini-3.5-flash-lite" } } } },
				[openrouter],
			),
		).toEqual({ kind: "model", provider: "openrouter", modelId: "google/gemini-3.5-flash-lite" });
	});
});
