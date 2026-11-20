// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../src/renderer/src/components/settings/McpPage";
import { setAppLanguage } from "../src/shared/i18n";
import type { McpSnapshot } from "../src/shared/settings-contract";

// The settings modules read `window.autorag` while they are imported, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const settings = { mcpGet: vi.fn(), mcpConnectInfo: vi.fn(), mcpUpsert: vi.fn(), mcpRemove: vi.fn() };
	const fs = { open: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings, fs });
	return { settings, fs };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SNAPSHOT: McpSnapshot = {
	path: "/home/you/.dazzi/pi/mcp.json",
	exists: true,
	error: null,
	servers: [
		{ name: "filesystem", config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/docs"] }, transport: "stdio", enabled: true, exposure: "codemode", problem: null },
		{ name: "github", config: { url: "https://api.githubcopilot.com/mcp/", enabled: false }, transport: "http", enabled: false, exposure: "codemode", problem: null },
		{ name: "notion", config: { command: "notion-mcp-server" }, transport: "stdio", enabled: true, exposure: "codemode", problem: "command not found: notion-mcp-server" },
	],
};

let host: HTMLDivElement;
let root: Root;

async function render(snapshot: McpSnapshot): Promise<void> {
	bridge.settings.mcpGet.mockReset().mockResolvedValue(snapshot);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root.render(<McpPage />);
	});
	await settle();
}

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.settings.mcpConnectInfo.mockReset().mockResolvedValue({ available: false, platform: "darwin", command: "", args: [], env: {} });
	bridge.fs.open.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	await setAppLanguage("ko");
});

function settle(): Promise<void> {
	return act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const row = (name: string): HTMLElement => {
	const found = host.querySelector<HTMLElement>(`[data-mcp-server="${name}"]`);
	if (found === null) throw new Error(`no row ${name}`);
	return found;
};

describe("Settings → MCP → servers in Dazzi", () => {
	it("draws each server as a card row: name, kind, what it runs, its problem, and the switch", async () => {
		await render(SNAPSHOT);
		expect([...host.querySelectorAll("[data-mcp-server]")].map((element) => element.getAttribute("data-mcp-server"))).toEqual(["filesystem", "github", "notion"]);

		const local = row("filesystem");
		expect(local.querySelector(".sidebar-always-badge")?.textContent).toBe("Local");
		expect(local.querySelector(".sidebar-row-path")?.textContent).toBe("npx -y @modelcontextprotocol/server-filesystem /docs");
		expect(local.querySelector(".mcp-server-problem")).toBeNull();
		expect(local.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");

		const remote = row("github");
		expect(remote.classList.contains("is-muted")).toBe(true);
		expect(remote.querySelector(".sidebar-always-badge")?.textContent).toBe("Remote");
		expect(remote.querySelector(".sidebar-row-path")?.textContent).toBe("https://api.githubcopilot.com/mcp/");
		expect(remote.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");

		expect(row("notion").querySelector(".mcp-server-problem")?.textContent).toBe("command not found: notion-mcp-server");
		// The exposure moved into the edit dialog; the row no longer carries a select.
		expect(host.querySelector("[data-mcp-server] .linear-select")).toBeNull();
	});

	it("opens the config file from the card", async () => {
		await render(SNAPSHOT);
		const open = host.querySelector<HTMLButtonElement>('[data-action="open-mcp-config"]');
		expect(open?.textContent).toBe("Open Config File");
		await act(async () => {
			open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await settle();
		expect(bridge.fs.open).toHaveBeenCalledWith("/home/you/.dazzi/pi/mcp.json");
	});

	it("shows the empty line, and no open button while the file does not exist", async () => {
		await render({ path: "/home/you/.dazzi/pi/mcp.json", exists: false, error: null, servers: [] });
		expect(host.querySelector(".sidebar-card-empty")?.textContent).toBe("No servers added yet.");
		expect(host.querySelector('[data-action="add-mcp-server"]')?.textContent).toBe("Add server");
		expect(host.querySelector('[data-action="open-mcp-config"]')).toBeNull();
	});
	const press = async (element: Element | null): Promise<void> => {
		await act(async () => {
			element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await settle();
	};

	it("asks before removing in the small alert card, with 삭제 as the blue answer (Figma 580:15140)", async () => {
		await render(SNAPSHOT);
		await press(host.querySelector('[data-action="remove-mcp-filesystem"]'));
		const alert = host.querySelector<HTMLElement>(".settings-modal.settings-alert");
		expect(alert?.querySelector("h2")?.textContent).toBe('Remove "filesystem"?');
		const actions = [...(alert?.querySelectorAll(".settings-modal-actions button") ?? [])];
		expect(actions.map((button) => button.textContent)).toEqual(["Cancel", "Remove"]);
		expect(actions[1]?.classList.contains("settings-btn-primary")).toBe(true);
		expect(actions[1]?.classList.contains("is-danger")).toBe(false);
	});

	it("adds a server in the 매직 액션 만들기 format: name as title, 연결 방식 tabs, rows closed (Figma 598:3131)", async () => {
		await render(SNAPSHOT);
		await press(host.querySelector('[data-action="add-mcp-server"]'));
		const modal = host.querySelector<HTMLElement>('[data-testid="mcp-server-modal"]');
		expect(modal?.closest(".settings-modal")?.classList.contains("magic-editor-modal")).toBe(true);
		expect(modal?.querySelector<HTMLInputElement>(".magic-editor-name > input")?.placeholder).toBe("Server name");
		expect(modal?.querySelector('[data-testid="mcp-kind-stdio"]')?.getAttribute("aria-checked")).toBe("true");
		expect(modal?.textContent).toContain("One per line.");
		const sections = [...(modal?.querySelectorAll<HTMLDetailsElement>("details.magic-editor-section") ?? [])];
		expect(sections.map((section) => section.querySelector(".magic-editor-section-name")?.textContent)).toEqual(["Environment Variables", "How tools are offered", "Description"]);
		expect(sections.every((section) => !section.open)).toBe(true);
		expect(modal?.querySelector('[data-mcp-section="exposure"] .magic-editor-section-value')?.textContent).toBe("Code Mode");
		expect(modal?.querySelector('[role="radiogroup"][aria-label="How tools are offered"]')).not.toBeNull();
		// HTTP swaps the card to the URL and the first row to 헤더.
		await press(modal?.querySelector('[data-testid="mcp-kind-http"]') ?? null);
		expect(modal?.querySelector('[data-mcp-section="vars"] .magic-editor-section-name')?.textContent).toBe("Headers");
		expect(modal?.querySelector<HTMLInputElement>(".mcp-editor-line > input")?.placeholder).toBe("https://example.com/mcp");
	});

	it("opens the rows a server already uses when editing it, and names its variables", async () => {
		await render({ ...SNAPSHOT, servers: [{ ...SNAPSHOT.servers[0]!, config: { command: "npx", env: { TOKEN: "x" } } }] });
		await press(host.querySelector('[data-action="edit-mcp-filesystem"]'));
		const vars = host.querySelector<HTMLDetailsElement>('[data-mcp-section="vars"]');
		expect(vars?.open).toBe(true);
		expect(vars?.querySelector(".magic-editor-section-value")?.textContent).toBe("TOKEN");
		expect(host.querySelector<HTMLDetailsElement>('[data-mcp-section="description"]')?.open).toBe(false);
	});
});
