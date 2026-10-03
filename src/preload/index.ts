import { contextBridge, ipcRenderer } from "electron";
import { createBridge } from "../shared/bridge";
import type { DevLabel } from "../shared/app-info";
import { createPreviewBridge } from "../preview/node/bridge";
import { createFsBridge } from "./fs-bridge";
import { createLiveBridge } from "./live-bridge";
import { createSearchBridge } from "./search-bridge";
import { createSettingsBridge } from "./settings-bridge";
import { installAppearancePreload } from "./appearance";

const DEV_LABEL_FLAG = "--autorag-dev-label=";

function readDevLabelArg(): DevLabel | null {
	const arg = process.argv.find((value) => value.startsWith(DEV_LABEL_FLAG));
	if (arg === undefined) return null;
	try {
		return JSON.parse(arg.slice(DEV_LABEL_FLAG.length)) as DevLabel;
	} catch {
		return null;
	}
}

installAppearancePreload(ipcRenderer);
contextBridge.exposeInMainWorld("autorag", {
	...createBridge(readDevLabelArg()),
	fs: createFsBridge(ipcRenderer),
	live: createLiveBridge(ipcRenderer),
	preview: createPreviewBridge(ipcRenderer),
	search: createSearchBridge(ipcRenderer),
	settings: createSettingsBridge(ipcRenderer),
});
