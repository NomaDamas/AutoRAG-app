// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView, type SettingsCategory } from "../src/renderer/src/components/SettingsView";
import { setAppLanguage } from "../src/shared/i18n";
import { DEFAULT_SETTINGS, type AutoRagConfigSnapshot, type DataSourcesSnapshot } from "../src/shared/settings-contract";

// The settings modules read `window.autorag.settings` while they are imported, so the bridge must exist first.
// Its functions are re-armed per test; the object identity is what the modules captured.
const bridge = vi.hoisted(() => {
	const settings = {
		get: vi.fn(),
		configGet: vi.fn(),
		sourcesList: vi.fn(),
		refreshScheduleGet: vi.fn(),
	};
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings,
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return settings;
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: AutoRagConfigSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	config: { datasources: { slack: {} }, searchPaths: ["/docs"] },
};

const SOURCES: DataSourcesSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	refresh: { state: "idle", phase: null, finishedAt: null },
	local: { documentCount: 7, updatedAt: null },
	sources: [
		{
			id: "slack",
			type: "slack",
			description: "Slack",
			enabled: true,
			status: "ready",
			install: { state: "installed", binary: "slacrawl", path: "/bin/slacrawl", detail: "", app: { required: false, installed: null, name: "" } },
			agent: { state: "connected", skillName: "datasource-slack", tags: [], detail: "" },
			index: { state: "indexed", chunkCount: 179, unit: "message", indexedAt: null, detail: "" },
		},
	],
};

const SCHEDULE = { supported: false, mechanism: null, installed: false, wanted: false, intervalMs: null, lastTickAt: null, local: null, sources: {}, conflicts: [], error: null };

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.get.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
	bridge.configGet.mockReset().mockResolvedValue(CONFIG);
	bridge.sourcesList.mockReset();
	bridge.refreshScheduleGet.mockReset().mockResolvedValue(SCHEDULE);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

async function renderView(initialCategory: SettingsCategory): Promise<void> {
	await act(async () => {
		root.render(<SettingsView initialCategory={initialCategory} />);
	});
	await settle();
}

/** Let every already-resolved promise and its React update run. */
function settle(): Promise<void> {
	return act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function text(): string {
	return host.textContent ?? "";
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
}

const appearanceSelect = (): Element | null => host.querySelector('select[aria-label="Appearance"]');

describe("opening Settings while the datasource scan is still running", () => {
	it("shows the General page as soon as the app settings and config are read", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValue(scan.promise);

		await renderView("general");

		expect(appearanceSelect()).not.toBeNull();
		expect(text()).not.toContain("Loading settings");
	});

	it("starts the scan at once, in parallel with the other reads", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		const settings = Promise.withResolvers<typeof DEFAULT_SETTINGS>();
		bridge.get.mockReturnValue(settings.promise);
		bridge.sourcesList.mockReturnValue(scan.promise);

		await act(async () => {
			root.render(<SettingsView initialCategory="general" />);
		});

		// `get` has not answered, yet the scan is already under way: it is not queued behind it.
		expect(bridge.sourcesList).toHaveBeenCalledTimes(1);
		await act(async () => settings.resolve(DEFAULT_SETTINGS));
	});

	it("lists the configured connections in the sidebar before the scan returns", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValue(scan.promise);

		await renderView("general");

		expect(host.querySelector('.settings-nav-item--source[data-source-alias="slack"]')).not.toBeNull();
	});

	it("says it is checking, not that nothing is connected, on the Indexing page", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValue(scan.promise);

		await renderView("indexing");

		expect(text()).toContain("Checking…");
		expect(text()).not.toContain("No data sources connected");

		await act(async () => scan.resolve(SOURCES));
		await settle();

		expect(text()).toContain("179 messages");
		expect(text()).not.toContain("Checking…");
	});

	it("says it is checking, not that nothing is connected, on the All Connections page", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValue(scan.promise);

		await renderView("apps");

		expect(text()).toContain("Checking…");
		expect(text()).not.toContain("No apps connected");

		await act(async () => scan.resolve(SOURCES));
		await settle();

		expect(text()).toContain("179 messages");
		expect(text()).not.toContain("No apps connected");
	});

	it("keeps a connection's Update button off until its state is known", async () => {
		const scan = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValue(scan.promise);

		await renderView("source:slack");

		expect(buttonLabelled("Update now")?.disabled).toBe(true);
		expect(text()).toContain("Checking…");

		await act(async () => scan.resolve(SOURCES));
		await settle();

		expect(buttonLabelled("Update now")?.disabled).toBe(false);
	});
});

describe("once the scan has finished", () => {
	it("still tells the user when no data source is connected", async () => {
		bridge.sourcesList.mockResolvedValue({ ...SOURCES, sources: [] });

		await renderView("indexing");

		expect(text()).toContain("No data sources connected");
		expect(text()).not.toContain("Checking…");
	});

	it("keeps the page usable and stops saying it is checking when the scan fails", async () => {
		bridge.sourcesList.mockRejectedValue(new Error("probe exploded"));

		await renderView("indexing");

		expect(text()).not.toContain("Checking…");
		expect(text()).toContain("No data sources connected");
	});

	it("shows a config error the scan found without hiding the page", async () => {
		bridge.sourcesList.mockResolvedValue({ ...SOURCES, sources: [], error: "config is broken" });

		await renderView("general");

		expect(host.querySelector('[role="alert"]')?.textContent).toBe("config is broken");
		expect(appearanceSelect()).not.toBeNull();
	});

	it("does not let a config error from the first read be replaced by the scan's", async () => {
		bridge.configGet.mockResolvedValue({ ...CONFIG, error: "bad json" });
		bridge.sourcesList.mockResolvedValue({ ...SOURCES, error: "scan error" });

		await renderView("general");

		expect(host.querySelector('[role="alert"]')?.textContent).toBe("bad json");
	});
});

describe("a save while an earlier scan is still running", () => {
	it("keeps the newer scan's answer when the older one returns last", async () => {
		const opening = Promise.withResolvers<DataSourcesSnapshot>();
		const afterSave = Promise.withResolvers<DataSourcesSnapshot>();
		bridge.sourcesList.mockReturnValueOnce(opening.promise).mockReturnValueOnce(afterSave.promise);
		Object.assign(bridge, { configPatch: vi.fn().mockResolvedValue(CONFIG), refreshScheduleApply: vi.fn().mockResolvedValue(SCHEDULE) });
		await renderView("indexing");

		// Changing the refresh cadence saves the config, which starts a second scan.
		const interval = host.querySelector<HTMLSelectElement>('select[aria-label="Local folder refresh interval"]');
		expect(interval).not.toBeNull();
		await act(async () => {
			if (interval === null) return;
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(interval, String(60 * 60_000));
			interval.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await settle();
		expect(bridge.sourcesList).toHaveBeenCalledTimes(2);

		// The newer scan answers first with the fresh state; the older, slower one answers afterwards with stale data.
		await act(async () => afterSave.resolve(SOURCES));
		await settle();
		await act(async () => opening.resolve({ ...SOURCES, sources: [] }));
		await settle();

		expect(text()).toContain("179 messages");
		expect(text()).not.toContain("No data sources connected");
	});
});
