import { contextBridge, ipcRenderer } from "electron";
import { installAppearancePreload } from "./appearance";
import { createQuickLookWindowBridge } from "../preview/node/bridge";

installAppearancePreload(ipcRenderer);
contextBridge.exposeInMainWorld("quickLook", createQuickLookWindowBridge(ipcRenderer, process.platform));
