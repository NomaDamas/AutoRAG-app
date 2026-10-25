import type { IpcRenderer, IpcRendererEvent } from "electron";
import { INDEX_PROBLEM_CHANNELS, type IndexProblem, type IndexProblemBridge } from "../shared/index-problem-contract";

/** Typed window.autorag.indexProblem wrappers over the contract channels. */
export function createIndexProblemBridge(ipcRenderer: IpcRenderer): IndexProblemBridge {
	return {
		get: () => ipcRenderer.invoke(INDEX_PROBLEM_CHANNELS.get),
		onChange: (listener) => {
			const handler = (_event: IpcRendererEvent, problem: IndexProblem): void => listener(problem);
			ipcRenderer.on(INDEX_PROBLEM_CHANNELS.changed, handler);
			return () => {
				ipcRenderer.removeListener(INDEX_PROBLEM_CHANNELS.changed, handler);
			};
		},
		retry: () => ipcRenderer.invoke(INDEX_PROBLEM_CHANNELS.retry),
		dismiss: () => ipcRenderer.invoke(INDEX_PROBLEM_CHANNELS.dismiss),
	};
}
