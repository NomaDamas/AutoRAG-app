import "@sentry/electron/preload";
import { createAccountBridge } from "./account-bridge";
import { createAnalyticsBridge } from "./analytics-bridge";
import { createAppUpdateBridge } from "./app-update-bridge";
import { createAutomationBridge } from "./automation-bridge";
import { createConversionBridge } from "./conversion-bridge";
import { contextBridge, ipcRenderer, webUtils, type IpcRenderer, type IpcRendererEvent } from "electron";
import { createBridge } from "../shared/bridge";
import type { DevLabel } from "../shared/app-info";
import { createPreviewBridge } from "../preview/node/bridge";
import { REMOTE_CHANNELS, type RemoteAccessBridge, type RemoteAccessStatus } from "../shared/remote-contract";
import { AGENT_CONNECT_CHANNELS, type AgentConnectBridge, type AgentConnectStatus } from "../shared/agent-connect-contract";
import { QUICK_SEARCH_CHANNELS, type QuickSearchSettingsBridge } from "../shared/quick-search-contract";
import { createActionsBridge } from "./actions-bridge";
import { createAppCustomizerBridge } from "./app-customizer-bridge";
import { createErrorFixBridge } from "./error-fix-bridge";
import { createMagicActionBridge } from "./magic-action-bridge";
import { createFsBridge } from "./fs-bridge";
import { createIndexActivityBridge } from "./index-activity-bridge";
import { createInteractionBridge } from "./interaction-bridge";
import { createIndexProblemBridge } from "./index-problem-bridge";
import { createLiveBridge } from "./live-bridge";
import { createModelDownloadBridge } from "./model-download-bridge";
import { createOnboardingBridge } from "./onboarding-bridge";
import { createOsRequestBridge } from "./os-request-bridge";
import { createSearchBridge } from "./search-bridge";
import { createSmartIndexingBridge } from "./smart-indexing-bridge";
import { createSettingsBridge } from "./settings-bridge";
import { createServicesBridge } from "./services-bridge";
import { createVoiceBridge } from "./voice-bridge";
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
	analytics: createAnalyticsBridge(ipcRenderer),
	appCustomizer: createAppCustomizerBridge(ipcRenderer),
	appUpdate: createAppUpdateBridge(ipcRenderer),
	account: createAccountBridge(ipcRenderer),
	automations: createAutomationBridge(ipcRenderer),
	voice: createVoiceBridge(ipcRenderer),
	conversion: createConversionBridge(ipcRenderer),
	indexActivity: createIndexActivityBridge(ipcRenderer),
	interaction: createInteractionBridge(ipcRenderer),
	indexProblem: createIndexProblemBridge(ipcRenderer),
	errorFix: createErrorFixBridge(ipcRenderer),
	magicAction: createMagicActionBridge(ipcRenderer),
	live: createLiveBridge(fsWorker),
	modelDownload: createModelDownloadBridge(ipcRenderer),
	onboarding: createOnboardingBridge(ipcRenderer),
	osRequests: createOsRequestBridge(ipcRenderer),
	preview: createPreviewBridge(ipcRenderer),
	search: createSearchBridge(ipcRenderer),
	smartIndexing: createSmartIndexingBridge(ipcRenderer),
	settings: createSettingsBridge(ipcRenderer),
	services: createServicesBridge(ipcRenderer),
	remote: createRemoteBridge(ipcRenderer),
	agentConnect: createAgentConnectBridge(ipcRenderer),
	quickSearch: {
		status: () => ipcRenderer.invoke(QUICK_SEARCH_CHANNELS.status),
		setRecording: (recording: boolean) => ipcRenderer.invoke(QUICK_SEARCH_CHANNELS.recording, recording),
	} satisfies QuickSearchSettingsBridge,
	// Electron dropped `File.path`; only the preload can map a dropped file to its disk path.
	pathForFile: (file: File) => webUtils.getPathForFile(file),
});

/** Agent access: the HTTP MCP server and tunnel that let a cloud agent search this machine's index. */
function createAgentConnectBridge(ipcRenderer: IpcRenderer): AgentConnectBridge {
	return {
		status: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.status),
		start: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.start),
		stop: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.stop),
		setAllowWrite: (allow) => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.setAllowWrite, allow),
		rotateToken: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.rotateToken),
		revealToken: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.revealToken),
		setHostname: (hostname) => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.setHostname, hostname),
		loginTunnel: () => ipcRenderer.invoke(AGENT_CONNECT_CHANNELS.loginTunnel),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, status: AgentConnectStatus): void => listener(status);
			ipcRenderer.on(AGENT_CONNECT_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(AGENT_CONNECT_CHANNELS.changed, handler);
			};
		},
	};
}

/** Remote access: live status, pairing codes, paired devices, and Quick Tunnel. */
function createRemoteBridge(ipcRenderer: IpcRenderer): RemoteAccessBridge {
	return {
		status: () => ipcRenderer.invoke(REMOTE_CHANNELS.status),
		start: () => ipcRenderer.invoke(REMOTE_CHANNELS.start),
		stop: () => ipcRenderer.invoke(REMOTE_CHANNELS.stop),
		startPairing: () => ipcRenderer.invoke(REMOTE_CHANNELS.startPairing),
		devices: () => ipcRenderer.invoke(REMOTE_CHANNELS.devices),
		renameDevice: (id, label) => ipcRenderer.invoke(REMOTE_CHANNELS.renameDevice, id, label),
		revokeDevice: (id) => ipcRenderer.invoke(REMOTE_CHANNELS.revokeDevice, id),
		revokeAllDevices: () => ipcRenderer.invoke(REMOTE_CHANNELS.revokeAllDevices),
		refreshNetwork: () => ipcRenderer.invoke(REMOTE_CHANNELS.refreshNetwork),
		startTunnel: () => ipcRenderer.invoke(REMOTE_CHANNELS.startTunnel),
		stopTunnel: () => ipcRenderer.invoke(REMOTE_CHANNELS.stopTunnel),
		loginTunnel: () => ipcRenderer.invoke(REMOTE_CHANNELS.loginTunnel),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, status: RemoteAccessStatus): void => listener(status);
			ipcRenderer.on(REMOTE_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(REMOTE_CHANNELS.changed, handler);
			};
		},
	};
}
