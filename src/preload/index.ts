import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createBridge } from "../shared/bridge";
import type { DevLabel } from "../shared/app-info";
import { createPreviewBridge } from "../preview/node/bridge";
import { createActionsBridge } from "./actions-bridge";
import { createFsBridge } from "./fs-bridge";
import { createLiveBridge } from "./live-bridge";
import { createOsRequestBridge } from "./os-request-bridge";
import { createSearchBridge } from "./search-bridge";
import { createSettingsBridge } from "./settings-bridge";
import { installAppearancePreload } from "./appearance";
import { connectFsWorker } from "./worker-link";

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
const fsWorker = connectFsWorker(ipcRenderer);
contextBridge.exposeInMainWorld("autorag", {
	...createBridge(readDevLabelArg(), process.platform),
	fs: createFsBridge(ipcRenderer, fsWorker),
	actions: createActionsBridge(ipcRenderer),
	live: createLiveBridge(fsWorker),
	osRequests: createOsRequestBridge(ipcRenderer),
	preview: createPreviewBridge(ipcRenderer),
	search: createSearchBridge(ipcRenderer),
	settings: createSettingsBridge(ipcRenderer),
	// Electron dropped `File.path`; only the preload can map a dropped file to its disk path.
	pathForFile: (file: File) => webUtils.getPathForFile(file),
});
