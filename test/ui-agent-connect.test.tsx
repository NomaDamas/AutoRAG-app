// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnectSection } from "../src/renderer/src/components/settings/AgentConnectSection";
import { setAppLanguage } from "../src/shared/i18n";
import type { AgentConnectStatus } from "../src/shared/agent-connect-contract";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";

const bridge = vi.hoisted(() => {
	const listeners = new Set<(status: unknown) => void>();
	const agentConnect = {
		status: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		setAllowWrite: vi.fn(),
		rotateToken: vi.fn(),
		revealToken: vi.fn(),
		setHostname: vi.fn(),
		loginTunnel: vi.fn(),
		onChange: (listener: (status: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const settings = { set: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", agentConnect, settings });
	return { agentConnect, settings, emit: (status: unknown) => listeners.forEach((fn) => fn(status)) };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const QUICK_ON = { available: true, mode: "quick", hostname: null, loggedIn: false, state: "online", url: "https://quick-words.trycloudflare.com", error: null, errorCode: null } as const;
const QUICK_OFF = { ...QUICK_ON, state: "off", url: null } as const;

function status(patch: Partial<AgentConnectStatus> = {}): AgentConnectStatus {
	return { serving: true, mcpUrl: "https://quick-words.trycloudflare.com/mcp", oauth: true, allowWrite: false, tunnel: QUICK_ON, error: null, ...patch };
}

let host: HTMLDivElement;
let root: Root;
let written: string[];
let current: AppSettings;

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
}

async function render(settings: Partial<AppSettings>, initial: AgentConnectStatus): Promise<void> {
	current = { ...DEFAULT_SETTINGS, language: "en", ...settings };
	bridge.agentConnect.status.mockResolvedValue(initial);
	await act(async () => {
		root.render(<AgentConnectSection appSettings={current} onAppSettingsChanged={(next) => (current = next)} onSettingsError={() => undefined} />);
	});
	await settle();
}

beforeEach(async () => {
	await setAppLanguage("en");
	vi.clearAllMocks();
	written = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: vi.fn(async (text: string) => void written.push(text)) },
	});
	bridge.settings.set.mockImplementation(async (patch: Partial<AppSettings>) => ({ ...current, ...patch }));
	host = document.createElement("div");
	host.className = "settings-view";
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

const button = (text: string): HTMLButtonElement | undefined => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
async function click(element: Element | null | undefined): Promise<void> {
	expect(element).toBeTruthy();
	await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await settle();
}
const text = (): string => host.textContent ?? "";

describe("Settings → MCP → cloud agents", () => {
	it("shows only the switch while agent access is off, and nothing about an address or a token", async () => {
		await render({ agentAccess: false }, status({ serving: false, mcpUrl: null, oauth: false, tunnel: QUICK_OFF }));
		expect(host.querySelector('[role="switch"]')).not.toBeNull();
		expect(text()).not.toContain("trycloudflare");
		expect(button("Copy address")).toBeUndefined();
		expect(button("Show token")).toBeUndefined();
	});

	it("turns agent access on through the settings, not by starting the server itself", async () => {
		await render({ agentAccess: false }, status({ serving: false, mcpUrl: null, oauth: false, tunnel: QUICK_OFF }));
		await click(host.querySelector('[role="switch"]'));
		expect(bridge.settings.set).toHaveBeenCalledWith({ agentAccess: true });
		expect(bridge.agentConnect.start).not.toHaveBeenCalled();
	});

	it("shows the address to paste into the agent and copies exactly it", async () => {
		await render({ agentAccess: true }, status());
		expect(text()).toContain("https://quick-words.trycloudflare.com/mcp");
		await click(button("Copy address"));
		expect(written).toEqual(["https://quick-words.trycloudflare.com/mcp"]);
	});

	it("says a quick address changes on every start, and offers an own domain for a stable one", async () => {
		await render({ agentAccess: true }, status());
		expect(text()).toMatch(/changes/i);
		expect(host.querySelector('input[aria-label="Own domain"]')).not.toBeNull();
	});

	it("explains there is no public address when the tunnel cannot start, instead of showing a dead one", async () => {
		await render(
			{ agentAccess: true },
			status({ mcpUrl: null, oauth: false, tunnel: { ...QUICK_OFF, state: "error", error: "cloudflared is not installed", errorCode: "missing_binary" } }),
		);
		expect(text()).not.toContain("trycloudflare.com/mcp");
		expect(text()).toMatch(/cloudflared/i);
		expect(button("Copy address")).toBeUndefined();
	});

	it("shows a server error with its reason", async () => {
		await render({ agentAccess: true }, status({ serving: false, mcpUrl: null, oauth: false, error: "Cannot find package 'x'" }));
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Cannot find package");
	});

	it("never shows the owner token until asked, then copies it without rendering it", async () => {
		bridge.agentConnect.revealToken.mockResolvedValue("secret-owner-token-0123456789abcdef0123456789");
		await render({ agentAccess: true }, status());
		expect(text()).not.toContain("secret-owner-token");
		await click(button("Copy token"));
		expect(written).toEqual(["secret-owner-token-0123456789abcdef0123456789"]);
		expect(text()).not.toContain("secret-owner-token");
	});

	it("keeps write access off by default and says what turning it on lets an agent do", async () => {
		await render({ agentAccess: true }, status());
		const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Let agents change files and the index"]');
		expect(toggle?.getAttribute("aria-checked")).toBe("false");
		await click(toggle);
		expect(bridge.agentConnect.setAllowWrite).toHaveBeenCalledWith(true);
	});

	it("rotating the token asks first, then calls through", async () => {
		await render({ agentAccess: true }, status());
		await click(button("Reset token"));
		expect(bridge.agentConnect.rotateToken).not.toHaveBeenCalled();
		await click(button("Reset token — confirm"));
		expect(bridge.agentConnect.rotateToken).toHaveBeenCalledTimes(1);
	});

	it("follows status pushes from the main process", async () => {
		await render({ agentAccess: true }, status());
		await act(async () => bridge.emit(status({ mcpUrl: "https://other-words.trycloudflare.com/mcp" })));
		expect(text()).toContain("https://other-words.trycloudflare.com/mcp");
	});

	it("renders nothing in a remote browser session, which has no bridge to it", async () => {
		Reflect.set(globalThis.autorag as object, "agentConnect", undefined);
		await act(async () => {
			root.render(<AgentConnectSection appSettings={{ ...DEFAULT_SETTINGS, language: "en" }} onAppSettingsChanged={() => undefined} onSettingsError={() => undefined} />);
		});
		expect(host.textContent).toBe("");
		Reflect.set(globalThis.autorag as object, "agentConnect", bridge.agentConnect);
	});
});
