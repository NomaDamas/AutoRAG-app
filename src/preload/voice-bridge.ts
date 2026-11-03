import type { IpcRenderer } from "electron";
import { VOICE_CHANNELS, type VoiceBridge } from "../shared/voice-contract";

/** Typed window.autorag.voice wrappers over ipcRenderer.invoke on the contract channels. */
export function createVoiceBridge(ipcRenderer: IpcRenderer): VoiceBridge {
	return {
		transcribe: (clip) => ipcRenderer.invoke(VOICE_CHANNELS.transcribe, clip),
		prepare: () => ipcRenderer.invoke(VOICE_CHANNELS.prepare),
	};
}
