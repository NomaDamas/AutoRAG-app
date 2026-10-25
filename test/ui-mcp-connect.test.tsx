// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../src/renderer/src/components/settings/McpPage";
import { setAppLanguage } from "../src/shared/i18n";
import type { McpConnectInfo } from "../src/shared/settings-contract";

// The settings modules read `window.autorag.settings` while they are imported, so the bridge must exist first.
const bridge = vi.hoisted(() => {
	const settings = { mcpGet: vi.fn(), mcpConnectInfo: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings });
	return settings;
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const INFO: McpConnectInfo = {
	available: true,
	platform: "darwin",
	command: "/Applications/Dazzi.app/Contents/Resources/tools/node/bin/node",
	args: ["/Applications/Dazzi.app/Contents/Resources/app/out/main/mcp-server.js"],
	env: { AUTORAG_TOOLS_DIR: "/Applications/Dazzi.app/Contents/Resources/tools" },
};

let host: HTMLDivElement;
let root: Root;
let written: string[];

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.mcpGet.mockReset().mockResolvedValue({ path: "/x/mcp.json", exists: false, error: null, servers: [] });
	bridge.mcpConnectInfo.mockReset().mockResolvedValue(INFO);
	written = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: vi.fn(async (text: string) => {
				written.push(text);
			}),
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root.render(<McpPage />);
	});
	await settle();
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	await setAppLanguage("ko");
});

/** Let every already-resolved promise and its React update run. */
function settle(): Promise<void> {
	return act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function tab(label: string): HTMLButtonElement {
	const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === label);
	if (found === undefined) throw new Error(`no tab "${label}"`);
	return found;
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle();
}

const snippet = (): string => host.querySelector("pre.settings-snippet")?.textContent ?? "";
const copyButton = (): HTMLButtonElement => {
	const button = host.querySelector<HTMLButtonElement>(".settings-copy-btn");
	if (button === null) throw new Error("no copy button");
	return button;
};

describe("Settings → MCP → connect other agents", () => {
	it("shows the Claude Code command first and copies exactly the text on screen", async () => {
		expect(snippet()).toContain("claude mcp add");
		expect(snippet()).toContain(INFO.command);
		expect(snippet()).toContain(INFO.args[0]);
		await click(copyButton());
		expect(written).toEqual([snippet()]);
		expect(copyButton().textContent).toBe("Copied");
	});

	it("copies when the text itself is clicked, but not when the click ends a text selection", async () => {
		const pre = host.querySelector("pre.settings-snippet");
		if (pre === null) throw new Error("no snippet");
		vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "claude mcp" } as Selection);
		await click(pre);
		expect(written).toEqual([]);
		vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "" } as Selection);
		await click(pre);
		expect(written).toEqual([snippet()]);
	});

	it("each agent gets its own format, and the JSON one parses back to the launch", async () => {
		await click(tab("Codex"));
		expect(snippet()).toMatch(/^codex mcp add dazzi --env AUTORAG_TOOLS_DIR=\/Applications\/Dazzi\.app\/Contents\/Resources\/tools -- /u);
		await click(tab("Gemini CLI"));
		expect(snippet()).toMatch(/^gemini mcp add /u);
		await click(tab("JSON"));
		expect(JSON.parse(snippet())).toEqual({ mcpServers: { dazzi: { command: INFO.command, args: INFO.args, env: INFO.env } } });
	});

	it("the manual tab copies one value per row", async () => {
		await click(tab("Manual"));
		const rows = [...host.querySelectorAll<HTMLElement>("[data-mcp-field]")];
		expect(rows.map((row) => row.dataset.mcpField)).toEqual(["name", "transport", "command", "args", "env"]);
		const command = rows.find((row) => row.dataset.mcpField === "command");
		if (command === undefined) throw new Error("no command row");
		await click(command);
		expect(written).toEqual([INFO.command]);
		const env = rows.find((row) => row.dataset.mcpField === "env");
		if (env === undefined) throw new Error("no env row");
		await click(env);
		expect(written.at(-1)).toBe("AUTORAG_TOOLS_DIR=/Applications/Dazzi.app/Contents/Resources/tools");
	});

	it("read-only adds the server's switch to what is shown and what is copied, and turning it off removes it", async () => {
		const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Read-only"]');
		if (toggle === null) throw new Error("no read-only switch");
		await click(toggle);
		expect(snippet()).toContain("AUTORAG_MCP_READ_ONLY=1");
		await click(copyButton());
		expect(written.at(-1)).toContain("AUTORAG_MCP_READ_ONLY=1");
		await click(tab("JSON"));
		expect(JSON.parse(snippet()).mcpServers.dazzi.env).toEqual({ ...INFO.env, AUTORAG_MCP_READ_ONLY: "1" });
		await click(toggle);
		expect(snippet()).not.toContain("AUTORAG_MCP_READ_ONLY");
	});

	it("the arrow keys move between the agents", async () => {
		const first = tab("Claude Code");
		await act(async () => {
			first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(tab("Codex").getAttribute("aria-selected")).toBe("true");
		await act(async () => {
			tab("Codex").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
			tab("Claude Code").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		});
		expect(tab("Manual").getAttribute("aria-selected")).toBe("true");
	});

	it("says so when the clipboard refuses, instead of showing a false 'Copied'", async () => {
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
		await click(copyButton());
		expect(host.textContent).toContain("Couldn't copy");
		expect(copyButton().textContent).toBe("Copy");
	});
});

describe("a build without the server entry", () => {
	it("offers nothing to copy and says why", async () => {
		bridge.mcpConnectInfo.mockResolvedValue({ ...INFO, available: false });
		act(() => root.unmount());
		root = createRoot(host);
		await act(async () => {
			root.render(<McpPage />);
		});
		await settle();
		expect(host.querySelector("pre.settings-snippet")).toBeNull();
		expect(host.querySelector('[role="tablist"]')).toBeNull();
		expect(host.textContent).toContain("nothing to copy");
	});
});

describe("a development run, which needs no environment", () => {
	it("shows lines without environment flags and a manual tab without an environment row", async () => {
		bridge.mcpConnectInfo.mockResolvedValue({ ...INFO, env: {} });
		act(() => root.unmount());
		root = createRoot(host);
		await act(async () => {
			root.render(<McpPage />);
		});
		await settle();
		expect(snippet()).not.toContain(" -e ");
		await click(tab("Manual"));
		expect([...host.querySelectorAll<HTMLElement>("[data-mcp-field]")].map((row) => row.dataset.mcpField)).toEqual(["name", "transport", "command", "args"]);
	});
});
