// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiPage } from "../src/renderer/src/components/settings/AiPage";
import { setAppLanguage } from "../src/shared/i18n";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";

// The settings modules read `window.autorag.settings` while they are imported, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const settings = {
		providersList: vi.fn(),
		embeddingGet: vi.fn(),
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

let host: HTMLDivElement;
let root: Root;

const model = (provider: string, id: string): ModelCatalogEntry => ({ provider, id, name: `Name ${id}`, api: "openai-responses", available: true, baseUrl: null, apiKeyEnv: null });

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

const snapshot = (config: AutoRagConfigSnapshot["config"]): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config });

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

const rowIcon = (name: string): Element | null =>
	[...host.querySelectorAll(".ai-service-row")].find((row) => row.querySelector(".ai-service-name")?.textContent === name)?.querySelector(".settings-app-icon") ?? null;

describe("AiPage provider icons", () => {
	it("draws each connected service with its logo and keeps the first letter for one without", async () => {
		await render([
			provider("openai", "OpenAI", { subscription: true }),
			provider("openai-codex", "OpenAI Codex (legacy)", { subscription: true }),
			provider("openrouter", "OpenRouter"),
			provider("radius", "Radius"),
		]);
		const drawn = ["OpenAI", "OpenAI Codex (legacy)", "OpenRouter"].map((name) => [...(rowIcon(name)?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d")).join("|"));
		expect(drawn.every((paths) => paths.length > 0)).toBe(true);
		expect(new Set(drawn).size).toBe(3);
		expect(rowIcon("Radius")?.querySelector("svg")).toBeNull();
		expect(rowIcon("Radius")?.textContent).toBe("R");
		// Same tile either way.
		expect(rowIcon("OpenAI")?.className).toBe(rowIcon("Radius")?.className);
	});

	it("keeps the letter for a server the user named like a vendor", async () => {
		await render([provider("openai", "OpenAI-compatible", { kind: "custom", baseUrl: "http://localhost:1234", authKinds: [] })]);
		expect(rowIcon("OpenAI-compatible")?.querySelector("svg")).toBeNull();
		expect(rowIcon("OpenAI-compatible")?.textContent).toBe("O");
	});

	it("puts the selected provider's logo on the role's model button", async () => {
		await render([provider("anthropic", "Anthropic"), provider("radius", "Radius")], { model: { provider: "anthropic", id: "m1" } });
		const trigger = host.querySelector('[data-role="answer"]');
		expect(trigger?.querySelector(".settings-app-icon.is-sm svg")).not.toBeNull();
		await render([provider("anthropic", "Anthropic"), provider("radius", "Radius")], { model: { provider: "radius", id: "m1" } });
		expect(host.querySelector('[data-role="answer"] .settings-app-icon.is-sm')?.textContent).toBe("R");
	});
});
