// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWithRightSidebar } from "./support/settings-right-sidebar";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import { APP_CUSTOMIZER_SURFACES } from "../src/shared/app-customizer-contract";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot, type DataSourcesSnapshot } from "../src/shared/settings-contract";
import type { SettingsCategory } from "../src/renderer/src/components/SettingsView";

const bridge = vi.hoisted(() => {
	const customizerListeners = new Set<(event: AppCustomizerEvent) => void>();
	const settings = {
		get: vi.fn(),
		set: vi.fn(),
		onChanged: () => () => undefined,
		configGet: vi.fn(),
		configPatch: vi.fn(),
		sourcesList: vi.fn(),
		refreshScheduleGet: vi.fn(),
		providersList: vi.fn(),
		mcpGet: vi.fn(),
		embeddingGet: vi.fn(),
		credentialsList: vi.fn(),
		mcpConnectInfo: vi.fn(),
	};
	const appCustomizer = {
		send: vi.fn(),
		cancel: vi.fn(),
		reset: vi.fn(),
		answer: vi.fn(),
		onEvent: (fn: (event: AppCustomizerEvent) => void) => {
			customizerListeners.add(fn);
			return () => customizerListeners.delete(fn);
		},
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings,
		fs: { locations: vi.fn(), tags: vi.fn(), indexMap: vi.fn(), onIndexRefreshed: () => () => undefined },
		appCustomizer,
		appUpdate: { get: () => Promise.withResolvers<never>().promise, onChange: () => () => undefined },
		account: { get: () => Promise.withResolvers<never>().promise, onChange: () => () => undefined },
	});
	return {
		settings,
		appCustomizer,
		fs: (globalThis as unknown as { autorag: { fs: { indexMap: ReturnType<typeof vi.fn> } } }).autorag.fs,
		emit: (event: AppCustomizerEvent) => {
			for (const fn of customizerListeners) fn(event);
		},
	};
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: AutoRagConfigSnapshot = { configPath: "/x/config.json", configExists: true, error: null, config: { datasources: {}, searchPaths: ["/docs"] } };
const SOURCES: DataSourcesSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	refresh: { state: "idle", phase: null, finishedAt: null },
	local: { documentCount: 0, updatedAt: null },
	sources: [],
};

/** The Settings pages that gained an assistant, with the one that stays hidden until the assistant has a surface. */
const CONFIG_PAGES = ["general", "ai", "web", "indexing", "duplicates", "mcp", "apps"] as const;

let host: HTMLDivElement;
let root: Root;
let currentSettings: AppSettings;

function settle(): Promise<void> {
	return act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function open(category: SettingsCategory): Promise<void> {
	await act(async () => {
		root.render(<SettingsWithRightSidebar initialCategory={category} />);
	});
	await settle();
}

beforeEach(async () => {
	await setAppLanguage("en");
	currentSettings = structuredClone(DEFAULT_SETTINGS);
	bridge.settings.get.mockReset().mockImplementation(async () => currentSettings);
	bridge.settings.set.mockReset().mockImplementation(async () => currentSettings);
	bridge.settings.configGet.mockReset().mockResolvedValue(CONFIG);
	bridge.settings.configPatch.mockReset().mockResolvedValue(CONFIG);
	bridge.settings.sourcesList.mockReset().mockResolvedValue(SOURCES);
	bridge.settings.refreshScheduleGet.mockReset().mockResolvedValue({});
	bridge.settings.providersList.mockReset().mockResolvedValue([]);
	bridge.settings.mcpGet.mockReset().mockResolvedValue({ path: "/x/mcp.json", exists: false, error: null, servers: [] });
	bridge.settings.embeddingGet.mockReset().mockReturnValue(Promise.withResolvers<never>().promise);
	bridge.settings.credentialsList.mockReset().mockResolvedValue([]);
	bridge.settings.mcpConnectInfo.mockReset().mockResolvedValue({ available: false, platform: "darwin", command: "", args: [], env: {} });
	bridge.fs.indexMap.mockReset().mockReturnValue(Promise.withResolvers<never>().promise);
	bridge.appCustomizer.send.mockReset().mockResolvedValue(undefined);
	bridge.appCustomizer.cancel.mockReset().mockResolvedValue(undefined);
	bridge.appCustomizer.reset.mockReset().mockResolvedValue(undefined);
	bridge.appCustomizer.answer.mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

describe("Settings pages with an AI assistant in the right sidebar", () => {
	it("lists every Settings section the assistants cover as a surface", () => {
		expect([...APP_CUSTOMIZER_SURFACES].sort()).toEqual(["ai", "apps", "contextMenu", "duplicates", "general", "indexing", "mcp", "shortcuts", "sidebar", "web"]);
	});

	for (const page of CONFIG_PAGES) {
		it(`docks the ${page} assistant with its own surface and sends the message with it`, async () => {
			await open(page);

			const panel = host.querySelector('[data-testid="app-customizer-panel"]:not([hidden])');
			expect(panel?.getAttribute("data-surface")).toBe(page);
			// The panel names the section in plain words, not a developer term or an untranslated key.
			expect(panel?.getAttribute("aria-label")).toMatch(/^AI .+Assistant$/u);
			expect(panel?.textContent).not.toContain("settingsCore.");

			const suggestions = panel?.querySelectorAll<HTMLButtonElement>('[data-action="customizer-suggestion"]') ?? [];
			expect(suggestions.length).toBe(3);
			await act(async () => {
				suggestions[0]?.click();
			});
			await settle();

			expect(bridge.appCustomizer.send).toHaveBeenCalledTimes(1);
			const [, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
			expect(request).toMatchObject({ surface: page, message: suggestions[0]?.textContent?.trim() });
		});

		it(`invites to the ${page} assistant from the page head once the right sidebar is hidden`, async () => {
			await open(page);
			expect(host.querySelector(`[data-assistant-hero="${page}"]`)).toBeNull();

			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-sidebar"]')?.click();
			});
			await settle();
			const hero = host.querySelector<HTMLElement>(`[data-assistant-hero="${page}"]`);
			expect(hero).not.toBeNull();
			expect(hero?.textContent).not.toContain("settingsCore.");

			await act(async () => {
				hero?.querySelector<HTMLButtonElement>('[data-action="open-app-customizer"]')?.click();
			});
			await settle();
			expect(host.querySelector('[data-testid="app-customizer-panel"]:not([hidden])')?.getAttribute("data-surface")).toBe(page);
			expect(host.querySelector(`[data-assistant-hero="${page}"]`)).toBeNull();
		});
	}

	it("keeps one conversation per page: switching pages hides the other assistant instead of dropping it", async () => {
		await open("web");
		const input = host.querySelector<HTMLTextAreaElement>('[data-testid="app-customizer-input"]');
		expect(input).not.toBeNull();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const webTurns = host.querySelectorAll('[data-surface="web"] .customizer-turn').length;
		expect(webTurns).toBe(1);

		await act(async () => {
			[...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find((button) => button.textContent?.includes("Duplicate"))?.click();
		});
		await settle();
		expect(host.querySelector('[data-testid="app-customizer-panel"]:not([hidden])')?.getAttribute("data-surface")).toBe("duplicates");
		expect(host.querySelector('[data-surface="web"]')?.hasAttribute("hidden")).toBe(true);
		expect(host.querySelectorAll('[data-surface="web"] .customizer-turn').length).toBe(1);
	});

	it("shows what the agent changed and refreshes the page's own settings snapshot when it is done", async () => {
		await open("general");
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		currentSettings = { ...currentSettings, appearance: "dark" };
		await act(async () => {
			bridge.emit({
				type: "turn-done",
				runId,
				sessionId: request.sessionId,
				messages: ["Switched to dark mode."],
				changes: [{ kind: "general", summary: "Appearance changed to Dark", fields: ["appearance"] }],
				settings: currentSettings,
			});
		});
		await settle();
		expect(host.querySelector(".customizer-change-pill")?.textContent).toContain("Appearance changed to Dark");
		const select = host.querySelector<HTMLElement>('[aria-label="Appearance"], [aria-label="화면"]');
		expect(host.textContent).toContain("Dark");
		expect(select === null || select.textContent?.includes("Dark")).toBe(true);
	});

	it("re-reads the shared config after a turn that changed it, so the page beside the sidebar shows what the agent did", async () => {
		await open("web");
		const switchOf = (): HTMLElement | null => host.querySelector('[role="switch"][aria-label]');
		expect(switchOf()?.getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		bridge.settings.configGet.mockResolvedValue({ ...CONFIG, config: { ...CONFIG.config, webSearch: { enabled: false, provider: "duckduckgo" } } });
		await act(async () => {
			bridge.emit({ type: "turn-done", runId, sessionId: request.sessionId, messages: ["Turned it off."], changes: [{ kind: "ai", summary: "Web search off", fields: ["webSearch"] }], settings: currentSettings });
		});
		await settle();
		expect(switchOf()?.getAttribute("aria-checked")).toBe("false");
	});

	it("reloads a page that loads its own data (MCP servers) after a turn that changed something", async () => {
		await open("mcp");
		const callsBefore = bridge.settings.mcpGet.mock.calls.length;
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		bridge.settings.mcpGet.mockResolvedValue({ path: "/x/mcp.json", exists: true, error: null, servers: [{ name: "docs", config: { url: "https://example.com/mcp" }, transport: "http", enabled: true, exposure: "codemode", problem: null }] });
		await act(async () => {
			bridge.emit({ type: "turn-done", runId, sessionId: request.sessionId, messages: ["Added."], changes: [{ kind: "connections", summary: "MCP server docs added", fields: ["mcp.docs"] }], settings: currentSettings });
		});
		await settle();
		expect(bridge.settings.mcpGet.mock.calls.length).toBeGreaterThan(callsBefore);
		expect(host.querySelector('[data-mcp-server="docs"]')).not.toBeNull();
	});

	it("does not reload anything for a turn that changed nothing", async () => {
		await open("web");
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		const before = bridge.settings.configGet.mock.calls.length;
		await act(async () => {
			bridge.emit({ type: "turn-done", runId, sessionId: request.sessionId, messages: ["Nothing to change."], changes: [], settings: currentSettings });
		});
		await settle();
		expect(bridge.settings.configGet.mock.calls.length).toBe(before);
	});

	it("never keeps a credential the person pasted in the chat: the bubble shows it removed, and so does what is sent", async () => {
		await open("ai");
		const input = host.querySelector<HTMLTextAreaElement>('[data-testid="app-customizer-input"]');
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setter?.call(input, "use this key sk-ant-api03-PastedInChat0123456789abcdef for anthropic");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		await settle();
		expect(host.querySelector(".customizer-turn__user-bubble")?.textContent).not.toContain("PastedInChat");
		expect(host.querySelector(".customizer-turn__user-bubble")?.textContent).toContain("use this key");
		const [, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		expect(request.message).not.toContain("PastedInChat");
	});

	it("re-reads the connected providers on the AI page after a turn that brought one in, so the model it chose is not shown as broken", async () => {
		await open("ai");
		const before = bridge.settings.providersList.mock.calls.length;
		await act(async () => {
			host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
		});
		await settle();
		const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
		bridge.settings.providersList.mockResolvedValue([
			{ id: "custom-omp", name: "ompproxy", baseUrl: "http://x/v1", kind: "custom", authKinds: ["api_key"], subscription: false, authConfigured: true, authSource: "stored", apiKeyEnv: "OMP_KEY", models: [{ provider: "custom-omp", id: "model-a", name: "Model A", api: "openai-completions", available: true, baseUrl: null, apiKeyEnv: null }] },
		]);
		await act(async () => {
			bridge.emit({ type: "turn-done", runId, sessionId: request.sessionId, messages: ["Imported."], changes: [{ kind: "ai", summary: "Imported omp's ompproxy provider", fields: ["providers.custom-omp"] }], settings: currentSettings });
		});
		await settle();
		expect(bridge.settings.providersList.mock.calls.length).toBeGreaterThan(before);
		expect(host.textContent).toContain("ompproxy");
	});

	it("shows the config as it is when a page is opened, even if something else changed it since Settings was loaded", async () => {
		await open("web");
		const switchOf = (): HTMLElement | null => host.querySelector('[role="switch"][aria-label]');
		expect(switchOf()?.getAttribute("aria-checked")).toBe("true");
		// Changed outside this window (another window, the CLI, or the file edited on disk): no event reaches the page.
		bridge.settings.configGet.mockResolvedValue({ ...CONFIG, config: { ...CONFIG.config, webSearch: { enabled: false } } });
		await act(async () => {
			[...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find((button) => button.textContent?.includes("General") || button.textContent?.includes("일반"))?.click();
		});
		await settle();
		await act(async () => {
			[...host.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].find((button) => button.textContent?.includes("Web Search") || button.textContent?.includes("웹 검색"))?.click();
		});
		await settle();
		expect(switchOf()?.getAttribute("aria-checked")).toBe("false");
	});

	describe("prompt cards: what the assistant asks outside the chat", () => {
		async function startRun(): Promise<{ runId: string; sessionId: string }> {
			await open("ai");
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="customizer-suggestion"]')?.click();
			});
			await settle();
			const [runId, request] = bridge.appCustomizer.send.mock.calls[0] ?? [];
			return { runId, sessionId: request.sessionId };
		}

		it("shows a masked field for a secret, sends it once to the main process, and keeps it out of the page afterwards", async () => {
			const { runId, sessionId } = await startRun();
			await act(async () => {
				bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "secret", id: "p1", title: "API key for Anthropic", detail: "Stored encrypted on this computer. The AI never sees it.", hint: "ANTHROPIC_API_KEY" } });
			});
			await settle();
			const card = host.querySelector<HTMLElement>('[data-prompt="secret"]');
			expect(card?.textContent).toContain("API key for Anthropic");
			expect(card?.textContent).toContain("The AI never sees it.");
			const field = card?.querySelector<HTMLInputElement>("input");
			expect(field?.type).toBe("password");
			expect(field?.autocomplete).toBe("off");
			const save = card?.querySelector<HTMLButtonElement>('[data-action="prompt-submit"]');
			expect(save?.disabled).toBe(true);
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
				setter?.call(field, "sk-ant-api03-RendererSecret0123456789");
				field?.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="prompt-submit"]')?.click();
			});
			await settle();
			expect(bridge.appCustomizer.answer).toHaveBeenCalledWith("p1", { kind: "secret", value: "sk-ant-api03-RendererSecret0123456789" });
			expect(host.textContent).not.toContain("RendererSecret");
			expect(host.querySelector('[data-prompt="secret"]')).toBeNull();
		});

		it("brings a newly opened card into view, so its buttons are never left below the fold", async () => {
			const { runId, sessionId } = await startRun();
			const scrolled: Element[] = [];
			const original = Element.prototype.scrollIntoView;
			Element.prototype.scrollIntoView = function (this: Element) {
				scrolled.push(this);
			};
			try {
				await act(async () => {
					bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "confirm", id: "p-scroll", title: "Import?", lines: ["a", "b", "c", "d", "e", "f"] } });
				});
				await settle();
			} finally {
				Element.prototype.scrollIntoView = original;
			}
			expect(scrolled.some((element) => element.getAttribute("data-prompt") === "confirm")).toBe(true);
		});

		it("cancel answers cancelled and the card goes away", async () => {
			const { runId, sessionId } = await startRun();
			await act(async () => {
				bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "secret", id: "p2", title: "t", detail: "d" } });
			});
			await settle();
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="prompt-cancel"]')?.click();
			});
			await settle();
			expect(bridge.appCustomizer.answer).toHaveBeenCalledWith("p2", { kind: "cancelled" });
			expect(host.querySelector('[data-prompt="secret"]')).toBeNull();
		});

		it("lists exactly what will happen on a confirm card and answers yes or no", async () => {
			const { runId, sessionId } = await startRun();
			await act(async () => {
				bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "confirm", id: "p3", title: "Add MCP server docs?", lines: ["Runs: npx -y docs-mcp@1.2.3", "Needs: DOCS_TOKEN"] } });
			});
			await settle();
			const card = host.querySelector<HTMLElement>('[data-prompt="confirm"]');
			expect(card?.textContent).toContain("npx -y docs-mcp@1.2.3");
			expect(card?.textContent).toContain("DOCS_TOKEN");
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="prompt-confirm"]')?.click();
			});
			await settle();
			expect(bridge.appCustomizer.answer).toHaveBeenCalledWith("p3", { kind: "confirm", confirmed: true });
		});

		it("removes a card the main process closed (timeout or stop) without answering", async () => {
			const { runId, sessionId } = await startRun();
			await act(async () => {
				bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "confirm", id: "p4", title: "t", lines: [] } });
			});
			await settle();
			expect(host.querySelector('[data-prompt="confirm"]')).not.toBeNull();
			await act(async () => {
				bridge.emit({ type: "prompt-closed", runId, sessionId, promptId: "p4" });
			});
			await settle();
			expect(host.querySelector('[data-prompt="confirm"]')).toBeNull();
			expect(bridge.appCustomizer.answer).not.toHaveBeenCalled();
		});

		it("stopping the run closes its open card", async () => {
			const { runId, sessionId } = await startRun();
			await act(async () => {
				bridge.emit({ type: "prompt", runId, sessionId, prompt: { kind: "secret", id: "p5", title: "t", detail: "d" } });
			});
			await settle();
			await act(async () => {
				host.querySelector<HTMLButtonElement>('[data-action="stop-customizer-message"]')?.click();
			});
			await settle();
			expect(bridge.appCustomizer.cancel).toHaveBeenCalledWith(runId);
			expect(host.querySelector('[data-prompt="secret"]')).toBeNull();
		});
	});
});
