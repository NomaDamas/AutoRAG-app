// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import { DEFAULT_SETTINGS, type AppSettings, type AutoRagConfigSnapshot } from "../src/shared/settings-contract";

const setSettingsMock = vi.hoisted(() => {
	const fn = vi.fn();
	Reflect.set(globalThis, "autorag", {
		platform: "darwin",
		settings: { set: fn },
		appUpdate: { get: () => new Promise(() => undefined), onChange: () => () => undefined },
	});
	return fn;
});

import { GeneralPage } from "../src/renderer/src/components/settings/GeneralPage";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const CONFIG: AutoRagConfigSnapshot = {
	configPath: "/x/config.json",
	configExists: true,
	error: null,
	config: { languages: ["ko", "en"] },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	setSettingsMock.mockReset();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	host.remove();
	document.body.innerHTML = "";
});

describe("GeneralPage default file manager intercept switch", () => {
	it("shows the macOS Desktop/Finder interception sub-switch when defaultFileManager is ON and hides it when OFF", async () => {
		const onAppSettingsChanged = vi.fn();
		const onSettingsError = vi.fn();
		const onSaved = vi.fn();

		const renderWith = async (settings: AppSettings) => {
			await act(async () => {
				root.render(
					<GeneralPage
						appSettings={settings}
						onAppSettingsChanged={onAppSettingsChanged}
						onSettingsError={onSettingsError}
						snapshot={CONFIG}
						onSaved={onSaved}
					/>,
				);
				await flush();
			});
		};

		await renderWith({ ...DEFAULT_SETTINGS, defaultFileManager: true, defaultFileManagerInterceptReveal: true });
		const interceptRow = host.querySelector('[data-settings-row="default-file-manager-intercept"]');
		expect(interceptRow).not.toBeNull();
		expect(interceptRow?.textContent).toContain("바탕화면 폴더·새 Finder 창도 Dazzi로 열기");

		const toggle = interceptRow?.querySelector<HTMLButtonElement>('[role="switch"]');
		expect(toggle?.getAttribute("aria-checked")).toBe("true");

		const nextSettings: AppSettings = { ...DEFAULT_SETTINGS, defaultFileManager: true, defaultFileManagerInterceptReveal: false };
		setSettingsMock.mockResolvedValueOnce(nextSettings);

		await act(async () => {
			toggle?.click();
			await flush();
		});
		expect(setSettingsMock).toHaveBeenCalledWith({ defaultFileManagerInterceptReveal: false });
		expect(onAppSettingsChanged).toHaveBeenCalledWith(nextSettings);

		// When master defaultFileManager switch is OFF, sub-switch is hidden.
		await renderWith({ ...DEFAULT_SETTINGS, defaultFileManager: false, defaultFileManagerInterceptReveal: true });
		expect(host.querySelector('[data-settings-row="default-file-manager-intercept"]')).toBeNull();
	});

	it("renders localized English copy on macOS", async () => {
		await setAppLanguage("en");
		await act(async () => {
			root.render(
				<GeneralPage
					appSettings={{ ...DEFAULT_SETTINGS, defaultFileManager: true, defaultFileManagerInterceptReveal: true }}
					onAppSettingsChanged={vi.fn()}
					onSettingsError={vi.fn()}
					snapshot={CONFIG}
					onSaved={vi.fn()}
				/>,
			);
			await flush();
		});
		const interceptRow = host.querySelector('[data-settings-row="default-file-manager-intercept"]');
		expect(interceptRow?.textContent).toContain("Open Desktop folders and new Finder windows in Dazzi");
	});
});
