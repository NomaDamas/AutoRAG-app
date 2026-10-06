import type { SettingsBridge } from "../../shared/settings-contract";

type RendererSettingsWindow = Window & {
	readonly autorag: {
		readonly settings: SettingsBridge;
	};
};

// The preload contract is installed before the renderer bundle executes.
const rendererWindow = window as unknown as RendererSettingsWindow;

export const settings: SettingsBridge = rendererWindow.autorag.settings;
