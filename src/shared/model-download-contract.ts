/**
 * The on-device embedding model's download, shared by the main process, the
 * preload and the renderer. The installer does not carry the Qwen3-Embedding
 * weights (~1.2 GB); the app fetches them when the user chooses local
 * embedding, in onboarding or in Settings, and shows this status while it runs.
 */

export const MODEL_DOWNLOAD_CHANNELS = {
	get: "modelDownload:get",
	start: "modelDownload:start",
	cancel: "modelDownload:cancel",
	changed: "modelDownload:changed",
} as const;

/**
 * `absent`: not on disk and nothing running (also what a cancelled download returns to; the partial file is kept
 * so the next start resumes). `downloading`: bytes are arriving. `ready`: every file is in MinSync's model cache.
 * `failed`: the last attempt stopped; `error` says why and a new start resumes.
 */
export type ModelDownloadState = "absent" | "downloading" | "ready" | "failed";

export interface ModelDownloadStatus {
	readonly state: ModelDownloadState;
	/** Bytes of the whole model that are on disk, including a resumed partial file. */
	readonly bytesDone: number;
	/** Size of the whole model. */
	readonly bytesTotal: number;
	/** The file being fetched right now. */
	readonly file: string | null;
	/** Why the last attempt failed, in the interface language; null otherwise. */
	readonly error: string | null;
}

export interface ModelDownloadBridge {
	get(): Promise<ModelDownloadStatus>;
	/** Starts the download, or joins one already running. Resolves with the status at the moment it started. */
	start(): Promise<ModelDownloadStatus>;
	/** Stops a running download; what was fetched stays for the next start. */
	cancel(): Promise<ModelDownloadStatus>;
	onChange(listener: (status: ModelDownloadStatus) => void): () => void;
}
