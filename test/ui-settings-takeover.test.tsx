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
	it("has no title or back button in the sidebar's head; the back button is the first row under it, above the search and the pages", async () => {
		await renderView();
		const head = nav().firstElementChild as HTMLElement;
		expect(head.classList.contains("settings-sidebar-head")).toBe(true);
		expect(head.textContent?.trim()).toBe("");
		expect(head.querySelector("button")).toBeNull();
		expect(nav().querySelector(".settings-sidebar-title")).toBeNull();
		const search = nav().querySelector("label.side-search input") as Node;
		const back = nav().querySelector<HTMLButtonElement>("button.settings-sidebar-back") as Node;
		const firstPage = nav().querySelector(".settings-nav-item:not(.settings-sidebar-back)") as Node;
		expect(search).not.toBeNull();
		expect(back).not.toBeNull();
		expect(back.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(search.compareDocumentPosition(firstPage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(back.textContent?.trim()).toBe("Back");
	});

	it("wears the Finder sidebar's search: same field, a clear button once typed", async () => {
		await renderView();
		const input = nav().querySelector<HTMLInputElement>("label.side-search input") as HTMLInputElement;
		expect(input.placeholder).toBe("Search…");
		expect(input.getAttribute("aria-label")).toBe("Search settings");
		expect(nav().querySelector('button[aria-label="Clear search"]')).toBeNull();
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set as (value: string) => void;
		await act(async () => {
			setValue.call(input, "side");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const clear = nav().querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
		expect(clear).not.toBeNull();
		await act(async () => {
			clear?.click();
		});
		expect(input.value).toBe("");
	});

	it("goes back when the back button is pressed", async () => {
		const onBack = vi.fn();
		await renderView({ onBack });
		await act(async () => {
			nav().querySelector<HTMLButtonElement>("button.settings-sidebar-back")?.click();
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
		expect(searchRef.current).toBe(nav().querySelector("label.side-search input"));
	});
});
