// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsPage } from "../src/renderer/src/components/settings/AppsPages";
import type { AutoRagConfigSnapshot } from "../src/shared/settings-contract";

// AppsPages reads `window.autorag.settings` while it is being imported; hoisted code runs before the imports,
// so the one bridge object the module captures is the one the tests spy on.
const bridge = vi.hoisted(() => {
	const settings = { configSet: vi.fn() };
	Reflect.set(globalThis, "autorag", { platform: "win32", settings });
	return { settings };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const snapshot: AutoRagConfigSnapshot = { configPath: "C:/x/config.json", configExists: true, error: null, config: {} };

beforeEach(() => {
	bridge.settings.configSet.mockReset();
	bridge.settings.configSet.mockResolvedValue(snapshot);
	Reflect.set(globalThis, "autorag", { platform: "win32", settings: bridge.settings });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<AppsPage snapshot={snapshot} onSaved={vi.fn()} sources={null} sourcesPending={false} onOpenSource={vi.fn()} />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	Reflect.deleteProperty(globalThis, "autorag");
	vi.restoreAllMocks();
});

/** Connect → type the connection id → press Enter, the way a user adds a connection. */
async function connect(app: string, alias: string): Promise<void> {
	const row = [...host.querySelectorAll<HTMLElement>(".settings-list-row")].find((candidate) => candidate.querySelector(".settings-list-title")?.textContent === app);
	await act(async () => row?.querySelector("button")?.click());
	const input = document.body.querySelector<HTMLInputElement>("input");
	expect(input).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, alias);
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => document.body.querySelector<HTMLButtonElement>(".settings-modal .settings-btn-primary")?.click());
}

describe("adding a connection from Settings → 연결된 앱", () => {
	it("Slack is saved reading Slack Desktop (wiretap), as the onboarding path does; slacrawl's API sync needs a token and exits nonzero (#396)", async () => {
		await connect("Slack", "slack");
		expect(bridge.settings.configSet).toHaveBeenCalledTimes(1);
		expect(bridge.settings.configSet).toHaveBeenCalledWith(["datasources", "slack"], { connector: { syncSource: "wiretap" } });
	});

	it("a second Slack connection keeps its type and the same preset", async () => {
		await connect("Slack", "slack-work");
		expect(bridge.settings.configSet).toHaveBeenCalledWith(["datasources", "slack-work"], { type: "slack", connector: { syncSource: "wiretap" } });
	});

	it("Discord has nothing to preset: discrawl's wiretap is its only no-token path already", async () => {
		await connect("Discord", "discord");
		expect(bridge.settings.configSet).toHaveBeenCalledWith(["datasources", "discord"], {});
	});
});
