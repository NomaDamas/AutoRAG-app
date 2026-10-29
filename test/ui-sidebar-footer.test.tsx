// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/renderer/src/components/Sidebar";
import { navGroups } from "../src/renderer/src/data/places";
import { setAppLanguage } from "../src/shared/i18n";
import type { AppUpdateBridge, AppUpdateMode, AppUpdateSnapshot, AppUpdateState } from "../src/shared/update-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;
let push: (snapshot: AppUpdateSnapshot) => void = () => undefined;
const bridge = {
	get: vi.fn<AppUpdateBridge["get"]>(),
	check: vi.fn<AppUpdateBridge["check"]>(),
	download: vi.fn<AppUpdateBridge["download"]>(),
	install: vi.fn<AppUpdateBridge["install"]>(),
	onChange: vi.fn<AppUpdateBridge["onChange"]>(),
};

function snapshot(state: AppUpdateState, mode: AppUpdateMode | null = "install"): AppUpdateSnapshot {
	return { currentVersion: "1.0.0", mode, state };
}

beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	bridge.get.mockResolvedValue(snapshot({ kind: "idle", checkedAt: null }));
	bridge.check.mockResolvedValue(snapshot({ kind: "idle", checkedAt: null }));
	bridge.download.mockResolvedValue(undefined);
	bridge.install.mockResolvedValue(undefined);
	bridge.onChange.mockImplementation((listener) => {
		push = listener;
		return () => undefined;
	});
	Reflect.set(globalThis, "autorag", { appUpdate: bridge });
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	Reflect.deleteProperty(globalThis, "autorag");
	vi.clearAllMocks();
	await setAppLanguage("ko");
});

async function renderSidebar(
	initial: AppUpdateSnapshot = snapshot({ kind: "idle", checkedAt: null }),
	props: { settingsActive?: boolean; onOpenSettings?: () => void; onOpenUsage?: () => void } = {},
): Promise<void> {
	bridge.get.mockResolvedValue(initial);
	const drop = { hovered: false, onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() };
	await act(async () => {
		root.render(
			<Sidebar
				groups={navGroups([])}
				activePath={null}
				settingsActive={props.settingsActive ?? false}
				showHotkeys
				onNavigate={vi.fn()}
				onEject={vi.fn()}
				onOpenSettings={props.onOpenSettings ?? vi.fn()}
				onOpenUsage={props.onOpenUsage ?? vi.fn()}
				onHideSidebar={vi.fn()}
				onOpenIndexing={vi.fn()}
				searchQuery=""
				searchRef={createRef()}
				searchFocused={false}
				onSearchFocus={vi.fn()}
				onSearchBlur={vi.fn()}
				onSubmitSearch={vi.fn()}
				aiSearchDrop={drop}
			/>,
		);
	});
}

const footer = (): HTMLElement => {
	const node = host.querySelector<HTMLElement>(".side-footer");
	if (node === null) throw new Error("no sidebar footer");
	return node;
};
const settingsButton = (): HTMLButtonElement => footer().querySelector<HTMLButtonElement>(".sidebar__item--settings") as HTMLButtonElement;
const usageButton = (): HTMLButtonElement => footer().querySelector<HTMLButtonElement>('[data-action="open-usage"]') as HTMLButtonElement;
const updateButton = (): HTMLButtonElement => footer().querySelector<HTMLButtonElement>('[data-action="app-update"]') as HTMLButtonElement;
const click = (node: HTMLElement): void => {
	act(() => {
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

describe("sidebar footer: settings and usage", () => {
	it("shows settings as an icon-only button at the far left, with the name as tooltip and accessible label", async () => {
		await renderSidebar();
		const button = settingsButton();
		expect(button.textContent?.trim()).toBe("");
		expect(button.getAttribute("aria-label")).toBe("Settings");
		expect(button.getAttribute("title")).toContain("Settings");
		expect(button.querySelector("svg")).not.toBeNull();
		expect(footer().querySelector("button")).toBe(button);
	});

	it("marks the settings button current while Settings is the active tab", async () => {
		await renderSidebar(undefined, { settingsActive: true });
		expect(settingsButton().getAttribute("aria-current")).toBe("true");
	});

	it("opens Settings from the gear and the usage page from the chart icon", async () => {
		const onOpenSettings = vi.fn();
		const onOpenUsage = vi.fn();
		await renderSidebar(undefined, { onOpenSettings, onOpenUsage });
		click(settingsButton());
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
		expect(onOpenUsage).not.toHaveBeenCalled();
		click(usageButton());
		expect(onOpenUsage).toHaveBeenCalledTimes(1);
		expect(usageButton().getAttribute("aria-label")).toBe("AI usage");
	});

	it("orders gear, usage, then the update control on the right", async () => {
		await renderSidebar();
		const order = [...footer().querySelectorAll("button")].filter((b) => b.classList.contains("sidebar__item--settings") || b.dataset.action !== undefined);
		expect(order.map((b) => b.dataset.action ?? "settings")).toEqual(["settings", "open-usage", "app-update"]);
	});

	it("names the buttons in Korean too", async () => {
		await setAppLanguage("ko");
		await renderSidebar();
		expect(settingsButton().getAttribute("aria-label")).toBe("설정");
		expect(usageButton().getAttribute("aria-label")).toBe("AI 사용량");
	});
});

describe("sidebar footer: update control", () => {
	it("is a disabled download icon on a build that cannot update", async () => {
		await renderSidebar(snapshot({ kind: "unsupported" }, null));
		expect(updateButton().dataset.state).toBe("unsupported");
		expect(updateButton().disabled).toBe(true);
		expect(updateButton().getAttribute("title")).toContain("1.0.0");
	});

	it("is a disabled, un-emphasised download icon while the app is up to date; clicking does nothing", async () => {
		await renderSidebar(snapshot({ kind: "idle", checkedAt: "2026-10-28T00:00:00.000Z" }));
		const button = updateButton();
		expect(button.dataset.state).toBe("idle");
		expect(button.disabled).toBe(true);
		expect(button.querySelector('[data-emphasis="true"]')).toBeNull();
		expect(button.getAttribute("title")).toContain("1.0.0");
		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.check).not.toHaveBeenCalled();
		expect(bridge.download).not.toHaveBeenCalled();
		expect(bridge.install).not.toHaveBeenCalled();
	});

	it("never offers a refresh glyph: the icon is the same download arrow in every state", async () => {
		await renderSidebar();
		const idleIcon = updateButton().querySelector("svg")?.getAttribute("class") ?? "";
		expect(idleIcon).toContain("lucide-download");
		act(() => push(snapshot({ kind: "available", version: "1.2.0", downloadUrl: null })));
		expect(updateButton().querySelector("svg")?.getAttribute("class") ?? "").toContain("lucide-download");
	});

	it("stays disabled while checking", async () => {
		await renderSidebar(snapshot({ kind: "checking" }));
		expect(updateButton().dataset.state).toBe("checking");
		expect(updateButton().disabled).toBe(true);
		expect(updateButton().querySelector('[data-emphasis="true"]')).toBeNull();
	});

	it("becomes an enabled, emphasised download when a check finds an update, and downloads on click", async () => {
		await renderSidebar();
		expect(updateButton().disabled).toBe(true);
		act(() => push(snapshot({ kind: "available", version: "1.2.0", downloadUrl: null })));
		const button = updateButton();
		expect(button.dataset.state).toBe("available");
		expect(button.disabled).toBe(false);
		expect(button.getAttribute("title")).toContain("1.2.0");
		expect(button.querySelector('[data-emphasis="true"]')).not.toBeNull();
		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.download).toHaveBeenCalledTimes(1);
		expect(bridge.check).not.toHaveBeenCalled();
	});

	it("in notify mode the same click hands the installer link to the main process", async () => {
		await renderSidebar(snapshot({ kind: "available", version: "1.2.0", downloadUrl: "https://dl.example.org/v1.2.0/Dazzi.dmg" }, "notify"));
		expect(updateButton().disabled).toBe(false);
		await act(async () => {
			updateButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.download).toHaveBeenCalledTimes(1);
	});

	it("shows download progress, stays emphasised, and ignores clicks meanwhile", async () => {
		await renderSidebar(snapshot({ kind: "downloading", version: "1.2.0", percent: 37 }));
		const button = updateButton();
		expect(button.dataset.state).toBe("downloading");
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("title")).toContain("37%");
		expect(button.querySelector('[data-emphasis="true"]')).not.toBeNull();
		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.download).not.toHaveBeenCalled();
		expect(bridge.install).not.toHaveBeenCalled();
	});

	it("offers restart-to-install once the update is downloaded", async () => {
		await renderSidebar(snapshot({ kind: "ready", version: "1.2.0" }));
		const button = updateButton();
		expect(button.dataset.state).toBe("ready");
		expect(button.disabled).toBe(false);
		expect(button.querySelector('[data-emphasis="true"]')).not.toBeNull();
		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.install).toHaveBeenCalledTimes(1);
		expect(bridge.download).not.toHaveBeenCalled();
	});

	it("a failed check leaves the icon disabled and puts the reason in the tooltip", async () => {
		await renderSidebar(snapshot({ kind: "error", message: "offline" }));
		expect(updateButton().dataset.state).toBe("error");
		expect(updateButton().disabled).toBe(true);
		expect(updateButton().getAttribute("title")).toContain("offline");
		await act(async () => {
			updateButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(bridge.check).not.toHaveBeenCalled();
	});

	it("renders no update control when the preload bridge is absent (browser-only run)", async () => {
		Reflect.deleteProperty(globalThis, "autorag");
		await renderSidebar();
		expect(updateButton()).toBeNull();
		expect(settingsButton()).not.toBeNull();
	});
});
