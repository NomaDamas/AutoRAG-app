// @vitest-environment happy-dom
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/renderer/src/components/SettingsView";
import { setAppLanguage } from "../src/shared/i18n";
import { DEFAULT_SETTINGS, type AutoRagConfigSnapshot } from "../src/shared/settings-contract";

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

const CONFIG: AutoRagConfigSnapshot = { configPath: "/x/config.json", configExists: true, error: null, config: { datasources: {}, searchPaths: [] } };
const SCHEDULE = { supported: false, mechanism: null, installed: false, wanted: false, intervalMs: null, lastTickAt: null, local: null, sources: {}, conflicts: [], error: null };

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.get.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
	bridge.configGet.mockReset().mockResolvedValue(CONFIG);
	bridge.sourcesList.mockReset().mockReturnValue(Promise.withResolvers<never>().promise);
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

interface ShellProps {
	readonly onBack?: () => void;
	readonly inspectorHidden?: boolean;
	readonly onShowInspector?: () => void;
	readonly navWidth?: number;
	readonly searchRef?: RefObject<HTMLInputElement | null>;
}

async function renderView(props: ShellProps = {}): Promise<void> {
	await act(async () => {
		root.render(
			<SettingsView
				navWidth={props.navWidth ?? 240}
				onBack={props.onBack ?? (() => undefined)}
				inspectorHidden={props.inspectorHidden ?? false}
				onShowInspector={props.onShowInspector ?? (() => undefined)}
				{...(props.searchRef === undefined ? {} : { searchRef: props.searchRef })}
			/>,
		);
	});
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

const nav = (): HTMLElement => host.querySelector<HTMLElement>("aside.settings-sidebar") as HTMLElement;

describe("Settings as a takeover of the window", () => {
	it("heads its own sidebar with a back button and the Settings title, above the search and the pages", async () => {
		await renderView();
		const head = nav().firstElementChild as HTMLElement;
		expect(head.classList.contains("settings-sidebar-head")).toBe(true);
		expect(head.textContent).toContain("Settings");
		expect(head.querySelector('button[aria-label="Back"]')).not.toBeNull();
		const search = nav().querySelector("input[type=search]") as Node;
		expect(search).not.toBeNull();
		expect(head.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("goes back when the back button is pressed", async () => {
		const onBack = vi.fn();
		await renderView({ onBack });
		await act(async () => {
			nav().querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
		});
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("takes the width of the column the window gives its sidebar", async () => {
		await renderView({ navWidth: 261 });
		expect(nav().style.width).toBe("261px");
	});

	it("shows the page content straight away: no tab strip or view/sort toolbar inside it", async () => {
		await renderView();
		expect(host.querySelector(".toolbar, .tabstrip, [aria-label='View'], [aria-label='Sort']")).toBeNull();
		expect(host.querySelector("main.settings-content .linear-title")).not.toBeNull();
	});

	it("offers to bring the right sidebar back only while it is hidden", async () => {
		const onShowInspector = vi.fn();
		await renderView({ inspectorHidden: false, onShowInspector });
		expect(host.querySelector('button[aria-label="Show inspector"]')).toBeNull();
		await renderView({ inspectorHidden: true, onShowInspector });
		const show = host.querySelector<HTMLButtonElement>('button[aria-label="Show inspector"]');
		expect(show).not.toBeNull();
		await act(async () => {
			show?.click();
		});
		expect(onShowInspector).toHaveBeenCalledTimes(1);
	});

	it("hands its search box to the window so the focus-search shortcut lands there", async () => {
		const searchRef = createRef<HTMLInputElement>();
		await renderView({ searchRef });
		expect(searchRef.current).toBe(nav().querySelector("input[type=search]"));
	});
});
