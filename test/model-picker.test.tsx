// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolePicker } from "../src/renderer/src/components/settings/ModelPicker";
import { setAppLanguage } from "../src/shared/i18n";
import type { ModelCatalogEntry, ProviderSummary } from "../src/shared/settings-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const model = (provider: string, id: string, name: string): ModelCatalogEntry => ({
	provider,
	id,
	name,
	api: "openai-responses",
	available: true,
	baseUrl: null,
	apiKeyEnv: null,
});

const provider = (id: string, name: string, models: readonly ModelCatalogEntry[]): ProviderSummary => ({
	id,
	name,
	baseUrl: null,
	kind: "runtime",
	authKinds: ["api_key"],
	subscription: false,
	authConfigured: true,
	authSource: "stored",
	apiKeyEnv: null,
	models,
});

const catalog = (providers: readonly ProviderSummary[]) =>
	providers.flatMap((item) => item.models.map((entry) => ({ provider: item, model: entry })));

const click = async (element: Element | null): Promise<void> => {
	if (element === null) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

const hover = async (element: Element | null): Promise<void> => {
	if (element === null) throw new Error("nothing to hover");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
	});
};

const pressKey = async (element: Element | null, key: string): Promise<void> => {
	if (element === null) throw new Error("nothing to focus");
	await act(async () => {
		element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
};

const typeQuery = async (input: HTMLInputElement | null, value: string): Promise<void> => {
	if (input === null) throw new Error("missing search input");
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	host.className = "settings-view";
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("RolePicker", () => {
	it("places search at the top, lists providers in default browse mode without inline models, and places specials at the bottom", async () => {
		const openai = provider("openai", "OpenAI", [model("openai", "gpt-6-luna", "GPT-6 Luna"), model("openai", "gpt-6-luna-mini", "GPT-6 Luna Mini")]);
		const anthropic = provider("anthropic", "Anthropic", [model("anthropic", "claude-haiku-5.5", "Claude Haiku 5.5")]);

		await act(async () => {
			root.render(
				<RolePicker
					role="decomposition"
					models={catalog([openai, anthropic])}
					specials={[
						{ value: "same", label: "Same as Answer Model" },
						{ value: "default", label: "Default Model" },
					]}
					selected={{ kind: "special", value: "same" }}
					onPick={vi.fn()}
					onSpecial={vi.fn()}
				/>,
			);
		});

		const search = host.querySelector(".settings-menu-search input");
		expect(search).not.toBeNull();
		// Search input comes before provider triggers and specials in DOM order.
		const openAiTrigger = host.querySelector('[data-provider-trigger="openai"]');
		const anthropicTrigger = host.querySelector('[data-provider-trigger="anthropic"]');
		const specialItem = [...host.querySelectorAll(".settings-menu-item")].find((item) => item.textContent?.includes("Same as Answer Model")) ?? null;

		expect(openAiTrigger).not.toBeNull();
		expect(anthropicTrigger).not.toBeNull();
		expect(specialItem).not.toBeNull();
		expect(search!.compareDocumentPosition(openAiTrigger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(anthropicTrigger!.compareDocumentPosition(specialItem!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// Models are not rendered until a provider submenu is opened or a search query is typed.
		expect(document.querySelector('[data-model-id="openai/gpt-6-luna"]')).toBeNull();
		expect(document.querySelector('[data-model-id="anthropic/claude-haiku-5.5"]')).toBeNull();
	});

	it("draws each provider with its logo, in browse mode and in search groups, and keeps the letter when it has none", async () => {
		const openai = provider("openai", "OpenAI", [model("openai", "gpt-6-luna", "GPT-6 Luna")]);
		const radius = provider("radius", "Radius", [model("radius", "r1", "Radius One")]);

		await act(async () => {
			root.render(<RolePicker role="answer" models={catalog([openai, radius])} specials={[]} selected={null} onPick={vi.fn()} onSpecial={vi.fn()} />);
		});
		const browseIcon = (id: string): Element | null => host.querySelector(`[data-provider-trigger="${id}"] .settings-app-icon.is-sm`);
		expect(browseIcon("openai")?.querySelector("svg")).not.toBeNull();
		expect(browseIcon("radius")?.querySelector("svg")).toBeNull();
		expect(browseIcon("radius")?.textContent).toBe("R");

		await typeQuery(host.querySelector<HTMLInputElement>(".settings-menu-search input"), "o");
		const groupIcons = [...host.querySelectorAll(".settings-menu-group.is-provider .settings-app-icon.is-sm")];
		expect(groupIcons).toHaveLength(2);
		expect(groupIcons.map((icon) => icon.querySelector("svg") !== null)).toEqual([true, false]);
	});

	it("opens a provider's model submenu on hover or click, switches providers cleanly, and picks a model", async () => {
		const onPick = vi.fn();
		const fireworks = provider("fireworks", "Fireworks", [model("fireworks", "accounts/fireworks/models/glm-5p3-flash", "GLM 5.3 Flash")]);
		const opencode = provider("opencode", "OpenCode Go", [model("opencode", "glm-5.3", "GLM-5.3"), model("opencode", "kimi-k3", "Kimi K3")]);

		await act(async () => {
			root.render(
				<RolePicker
					role="answer"
					models={catalog([fireworks, opencode])}
					specials={[]}
					selected={{ kind: "model", provider: "opencode", modelId: "glm-5.3" }}
					onPick={onPick}
					onSpecial={vi.fn()}
				/>,
			);
		});

		await hover(host.querySelector('[data-provider-trigger="fireworks"]'));
		expect(document.querySelector('.settings-submenu[data-provider-submenu="fireworks"]')).not.toBeNull();
		expect(document.querySelector('[data-model-id="fireworks/accounts/fireworks/models/glm-5p3-flash"]')).not.toBeNull();
		expect(document.querySelector('[data-model-id="opencode/glm-5.3"]')).toBeNull();

		await hover(host.querySelector('[data-provider-trigger="opencode"]'));
		expect(document.querySelector('.settings-submenu[data-provider-submenu="fireworks"]')).toBeNull();
		expect(document.querySelector('.settings-submenu[data-provider-submenu="opencode"]')).not.toBeNull();

		const selectedItem = document.querySelector('[data-model-id="opencode/glm-5.3"]');
		expect(selectedItem?.getAttribute("aria-checked")).toBe("true");

		await click(document.querySelector('[data-model-id="opencode/kimi-k3"]'));
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ provider: "opencode", id: "kimi-k3" }));
	});

	it("supports keyboard ArrowRight to open a provider submenu and ArrowLeft to return focus to the provider row", async () => {
		const fireworks = provider("fireworks", "Fireworks", [model("fireworks", "accounts/fireworks/models/glm-5p3-flash", "GLM 5.3 Flash")]);

		await act(async () => {
			root.render(
				<RolePicker
					role="answer"
					models={catalog([fireworks])}
					specials={[]}
					onPick={vi.fn()}
					onSpecial={vi.fn()}
				/>,
			);
		});

		const providerBtn = host.querySelector<HTMLButtonElement>('[data-provider-trigger="fireworks"]');
		await pressKey(providerBtn, "ArrowRight");
		const firstModel = document.querySelector<HTMLButtonElement>('[data-model-id="fireworks/accounts/fireworks/models/glm-5p3-flash"]');
		expect(firstModel).not.toBeNull();

		await pressKey(firstModel, "ArrowLeft");
		expect(document.querySelector('.settings-submenu[data-provider-submenu="fireworks"]')).toBeNull();
	});

	it("switches to provider-grouped inline results with dividers when searching, and hides any open submenu", async () => {
		const onPick = vi.fn();
		const fireworks = provider("fireworks", "Fireworks", [
			model("fireworks", "accounts/fireworks/models/glm-5p3-flash", "GLM 5.3 Flash"),
			model("fireworks", "accounts/fireworks/models/qwen3p8-max", "Qwen3.8 Max"),
		]);
		const opencode = provider("opencode", "OpenCode Go", [model("opencode", "glm-5.3", "GLM-5.3")]);
		const anthropic = provider("anthropic", "Anthropic", [model("anthropic", "claude-haiku-5.5", "Claude Haiku 5.5")]);

		await act(async () => {
			root.render(
				<RolePicker
					role="answer"
					models={catalog([fireworks, opencode, anthropic])}
					specials={[]}
					onPick={onPick}
					onSpecial={vi.fn()}
				/>,
			);
		});

		await hover(host.querySelector('[data-provider-trigger="fireworks"]'));
		expect(document.querySelector(".settings-submenu")).not.toBeNull();

		const input = host.querySelector<HTMLInputElement>(".settings-menu-search input");
		await typeQuery(input, "glm");

		// Submenu closes once search mode activates.
		expect(document.querySelector(".settings-submenu")).toBeNull();
		expect(host.querySelector("[data-provider-trigger]")).toBeNull();

		// Matching providers render as grouped sections; non-matching providers/models are omitted.
		const groups = [...host.querySelectorAll(".settings-menu-group > span:not(.settings-app-icon)")].map((el) => el.textContent?.trim());
		expect(groups).toEqual(["Fireworks", "OpenCode Go"]);
		expect(host.querySelector('[data-model-id="fireworks/accounts/fireworks/models/glm-5p3-flash"]')).not.toBeNull();
		expect(host.querySelector('[data-model-id="opencode/glm-5.3"]')).not.toBeNull();
		expect(host.querySelector('[data-model-id="fireworks/accounts/fireworks/models/qwen3p8-max"]')).toBeNull();
		expect(host.querySelector('[data-model-id="anthropic/claude-haiku-5.5"]')).toBeNull();

		// Shows search-specific empty message when nothing matches.
		await typeQuery(input, "nonexistent-model-xyz");
		expect(host.querySelector(".settings-menu-empty")?.textContent).toContain("No matching models");
	});

	it("shows each model's full name and full id in a two-line row with a full tooltip so long OpenRouter/Fireworks models stay distinguishable", async () => {
		const openrouter = provider("openrouter", "OpenRouter", [
			model("openrouter", "anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5"),
			model("openrouter", "anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5"),
			model("openrouter", "~anthropic/claude-sonnet-latest", "Anthropic: Claude Sonnet Latest"),
		]);
		const fireworks = provider("fireworks", "Fireworks", [
			model("fireworks", "accounts/fireworks/models/deepseek-v4p1-flash-1017", "DeepSeek V4.1 Flash 1017"),
		]);

		await act(async () => {
			root.render(
				<RolePicker
					role="answer"
					models={catalog([openrouter, fireworks])}
					specials={[]}
					selected={{ kind: "model", provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" }}
					onPick={vi.fn()}
					onSpecial={vi.fn()}
				/>,
			);
		});

		// Browse mode submenu: two-line model rows with full title tooltip.
		await hover(host.querySelector('[data-provider-trigger="openrouter"]'));
		const submenuItems = [...document.querySelectorAll<HTMLButtonElement>(".settings-submenu .settings-menu-item")];
		expect(submenuItems).toHaveLength(3);
		for (const item of submenuItems) {
			expect(item.classList.contains("is-model")).toBe(true);
			const textWrap = item.querySelector(".settings-model-item-text");
			expect(textWrap).not.toBeNull();
			expect(textWrap?.querySelector("span")).not.toBeNull();
			expect(textWrap?.querySelector("small")).not.toBeNull();
		}
		expect(submenuItems[0]?.getAttribute("title")).toBe("Anthropic: Claude Haiku 4.5\nanthropic/claude-haiku-4.5");
		expect(submenuItems[1]?.getAttribute("title")).toBe("Anthropic: Claude Haiku 5.5\nanthropic/claude-haiku-5.5");
		expect(submenuItems[1]?.querySelector(".settings-model-item-text span")?.textContent).toBe("Anthropic: Claude Haiku 5.5");
		expect(submenuItems[1]?.querySelector(".settings-model-item-text small")?.textContent).toBe("anthropic/claude-haiku-5.5");
		expect(submenuItems[1]?.getAttribute("aria-checked")).toBe("true");

		// Search mode: marks the picker container as searching (so it can widen) and uses the same two-line model row.
		const picker = host.querySelector(".settings-model-picker");
		expect(picker?.classList.contains("is-searching")).toBe(false);
		await typeQuery(host.querySelector<HTMLInputElement>(".settings-menu-search input"), "claude");
		expect(picker?.classList.contains("is-searching")).toBe(true);

		const searchItems = [...host.querySelectorAll<HTMLButtonElement>(".settings-model-search-section .settings-menu-item")];
		expect(searchItems).toHaveLength(3);
		expect(searchItems[2]?.classList.contains("is-model")).toBe(true);
		expect(searchItems[2]?.getAttribute("title")).toBe("Anthropic: Claude Sonnet Latest\n~anthropic/claude-sonnet-latest");
		expect(searchItems[2]?.querySelector(".settings-model-item-text span")?.textContent).toBe("Anthropic: Claude Sonnet Latest");
		expect(searchItems[2]?.querySelector(".settings-model-item-text small")?.textContent).toBe("~anthropic/claude-sonnet-latest");
	});

	it("avoids duplicate tooltip text when model name equals id while preserving the id element", async () => {
		const openrouter = provider("openrouter", "OpenRouter", [
			model("openrouter", "cohere/rerank-v3.5", "cohere/rerank-v3.5"),
		]);

		await act(async () => {
			root.render(
				<RolePicker
					role="rerank"
					models={catalog([openrouter])}
					specials={[]}
					selected={null}
					onPick={vi.fn()}
					onSpecial={vi.fn()}
				/>,
			);
		});

		await hover(host.querySelector('[data-provider-trigger="openrouter"]'));
		const item = document.querySelector<HTMLButtonElement>(".settings-submenu .settings-menu-item");
		expect(item?.getAttribute("title")).toBe("cohere/rerank-v3.5");
		// Still exposes <small> for consumers/QA that inspect the model id, or displays both cleanly.
		expect(item?.querySelector("small")?.textContent).toBe("cohere/rerank-v3.5");
	});
});
