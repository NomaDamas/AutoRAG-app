// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAZZI_PLAN_PROVIDER, ProviderIcon, providerMark, type ProviderIdentity } from "../src/renderer/src/components/settings/ProviderIcon";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const runtime = (id: string, name: string): ProviderIdentity => ({ id, name, kind: "runtime" });

async function render(provider: ProviderIdentity, small = false): Promise<HTMLElement> {
	await act(async () => {
		root.render(<ProviderIcon provider={provider} small={small} />);
	});
	const tile = host.querySelector<HTMLElement>(".settings-app-icon");
	if (tile === null) throw new Error("no icon tile");
	return tile;
}

describe("ProviderIcon", () => {
	it("draws a provider's logo in currentColor, so it follows the theme, and hides it from assistive tech", async () => {
		const tile = await render(runtime("openai", "OpenAI"));
		const svg = tile.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("fill")).toBe("currentColor");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
		expect(tile.getAttribute("aria-hidden")).toBe("true");
		expect(tile.textContent).toBe("");
		// Nothing pins a color: the tile's own text color is what the mark inherits.
		expect(tile.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/iu);
	});

	it("keeps the letter tile's box, with the same class for each size, so rows do not shift", async () => {
		const letter = await render(runtime("radius", "Radius"));
		expect(letter.textContent).toBe("R");
		const letterClass = letter.className;
		expect(letterClass).toBe("settings-app-icon");
		const letterSmallClass = (await render(runtime("radius", "Radius"), true)).className;
		expect(letterSmallClass).toBe("settings-app-icon is-sm");

		const logo = await render(runtime("openai", "OpenAI"));
		expect(logo.className).toBe(letterClass);
		expect(logo.querySelector("svg")?.getAttribute("width")).toBe("18");
		const logoSmall = await render(runtime("openai", "OpenAI"), true);
		expect(logoSmall.className).toBe(letterSmallClass);
		expect(logoSmall.querySelector("svg")?.getAttribute("width")).toBe("12");
	});

	it("falls back to the first letter for a provider with no logo, and for local and custom servers", async () => {
		expect((await render(runtime("typesafe", "TypeSafe"))).textContent).toBe("T");
		const local = await render({ id: "openai", name: "Openai proxy", kind: "custom" });
		expect(local.textContent).toBe("O");
		expect(local.querySelector("svg")).toBeNull();
		expect((await render({ id: "ollama", name: "Ollama", kind: "local" })).querySelector("svg")).toBeNull();
	});

	it("tells OpenAI, OpenAI Codex and OpenRouter apart, which the first letter could not", async () => {
		const drawn = new Set<string>();
		for (const [id, name] of [["openai", "OpenAI"], ["openai-codex", "OpenAI Codex (legacy)"], ["openrouter", "OpenRouter"]] as const) {
			const tile = await render(runtime(id, name));
			drawn.add([...tile.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|"));
		}
		expect(drawn.size).toBe(3);
	});

	it("keeps a logo's own partial opacity (Azure's layered mark)", async () => {
		const tile = await render(runtime("azure", "Azure"));
		expect([...tile.querySelectorAll("path")].some((path) => path.getAttribute("fill-opacity") !== null)).toBe(true);
	});

	it("gives the Dazzi plan the Dazzi logo", async () => {
		const tile = await render(DAZZI_PLAN_PROVIDER, true);
		expect(tile.querySelector("img")).not.toBeNull();
		expect(tile.querySelector("img")?.getAttribute("alt")).toBe("");
		expect(tile.querySelector("svg")).toBeNull();
	});
});

describe("providerMark", () => {
	it("returns null when there is no logo, so the caller keeps its own letter markup", () => {
		expect(providerMark(runtime("radius", "Radius"), 16)).toBeNull();
		expect(providerMark(runtime("anthropic", "Anthropic"), 16)).not.toBeNull();
	});
});
