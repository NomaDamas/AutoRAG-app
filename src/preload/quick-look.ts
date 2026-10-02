import { contextBridge, ipcRenderer } from "electron";
import { createQuickLookWindowBridge } from "../preview/node/bridge";

contextBridge.exposeInMainWorld("quickLook", createQuickLookWindowBridge(ipcRenderer, process.platform));
