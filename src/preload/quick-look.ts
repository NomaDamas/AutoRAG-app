import { contextBridge, ipcRenderer } from "electron";
import { installAppearancePreload } from "./appearance";
import { createQuickLookWindowBridge } from "../preview/node/bridge";
import { languageFromArgv } from "../shared/language-contract";

installAppearancePreload(ipcRenderer);
contextBridge.exposeInMainWorld("quickLook", createQuickLookWindowBridge(ipcRenderer, process.platform, languageFromArgv(process.argv)));
