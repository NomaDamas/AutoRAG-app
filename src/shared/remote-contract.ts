import type { AppSettings } from "./settings-contract";

/**
 * The remote access wire contract: how a browser served by the running Dazzi
 * talks to the same services the desktop renderer reaches through its preload.
 *
 * The browser cannot have a preload or a MessagePort, so the server exposes
 * three same-origin endpoints and one injected bootstrap script:
 *
 *   GET  /remote/bootstrap.js  defines window.autorag (every bridge) and the
 *                              appearance/platform attributes, before the bundle
 *   GET  /remote/events        one SSE stream of pushes for the session
 *   POST /remote/call          one bridge method: { target, method, args }
 *   POST /remote/upload        one dropped file's bytes, into a chosen folder
 *   GET  /remote/download      one file or folder (folder as a zip) to the browser
 *   GET  /remote/preview       file content for preview (image, video, text, pdf)
 *   GET  /remote/thumb         the same icon bytes the desktop draws
 *
 * Every request carries the session token (header `x-remote-token` or the
 * `?token=` query the bootstrap uses for direct navigations).
 */

export const REMOTE_ROUTES = {
	bootstrap: "/remote/bootstrap.js",
	events: "/remote/events",
	call: "/remote/call",
	upload: "/remote/upload",
	download: "/remote/download",
	preview: "/remote/preview",
	thumb: "/remote/thumb",
} as const;

export const REMOTE_TOKEN_HEADER = "x-remote-token";

/** Main <-> renderer channels for the remote-access setting's live status. */
export const REMOTE_CHANNELS = {
	status: "remote:status",
	start: "remote:start",
	stop: "remote:stop",
} as const;

/** What Settings shows about remote access, and the address a browser opens. */
export interface RemoteAccessStatus {
	readonly serving: boolean;
	readonly origin: string | null;
	readonly port: number;
	readonly sessions: number;
}

export interface RemoteAccessBridge {
	status(): Promise<RemoteAccessStatus>;
	start(): Promise<RemoteAccessStatus>;
	stop(): Promise<RemoteAccessStatus>;
}

/** One bridge method invocation. `target` is the bridge name (`fs`, `settings`, …). */
export interface RemoteCall {
	readonly target: string;
	readonly method: string;
	readonly args: readonly unknown[];
}

/** One push: the channel name a preload bridge would subscribe to, and its payload. */
export interface RemotePush {
	readonly channel: string;
	readonly payload: unknown;
}

/** The remote session's configuration, injected into the bootstrap script. */
export interface RemoteBootstrapConfig {
	readonly token: string;
	readonly platform: string;
	readonly appearance: AppSettings["appearance"];
	readonly language: AppSettings["language"];
	readonly version: string;
}

/**
 * Methods a browser cannot perform because they leave the page: they hand a
 * drag to the OS, pop a native dialog/ share sheet, or reveal a file in the
 * desktop's own file manager. `unsupported` is what the UI shows instead.
 */
export const REMOTE_NATIVE_ONLY_METHODS: Readonly<Record<string, readonly string[]>> = {
	fs: ["startDrag", "reveal", "open", "quickLook"],
	actions: ["run", "cancel", "share", "openWithApplications"],
	preview: ["show", "hide", "prefetch"],
	conversion: ["plan", "run", "cancel"],
	services: ["list", "run"],
	// `osRequests.take` only drains a queue this app fills; a browser can read it.

	onboarding: ["openFullDiskAccess", "pickFolders"],
	appUpdate: ["install", "download", "check"],
	account: ["signIn", "cancelSignIn", "sendEmailOtp", "verifyEmailOtp", "checkout", "useManagedModel", "signOut", "refresh"],
};

export const REMOTE_PREVIEW_UNSUPPORTED_CODE = "remote-preview-unsupported";
export const REMOTE_PREVIEW_FOLDER_CODE = "remote-preview-folder";

const TEXT_PLAIN_UTF8 = "text/plain; charset=utf-8";

const REMOTE_PREVIEW_TEXT_EXTENSIONS = [
	"txt", "text", "log", "md", "markdown", "mdx", "csv", "tsv",
	"json", "jsonc", "jsonl", "ndjson", "xml", "yaml", "yml",
	"toml", "ini", "cfg", "conf", "properties", "lock", "diff", "patch", "rst", "tex",
	"sql", "graphql", "gql", "proto",
	"css", "scss", "less", "html", "htm", "xhtml",
	"js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
	"py", "pyw", "go", "rs", "java", "c", "h", "cpp", "cc", "cxx", "hpp", "hh",
	"cs", "rb", "php", "sh", "bash", "zsh", "vue", "svelte", "astro",
	"lua", "pl", "swift", "kt", "kts", "scala", "dart", "r", "jl",
	"hs", "ex", "exs", "erl", "clj", "cljs", "vim", "cmake", "gradle",
] as const;

/**
 * Extensions a browser renders or plays directly in a preview tab (rather than
 * downloading or failing). Shared between the remote server's preview route and
 * the injected bootstrap's Quick Look guard.
 */
export const REMOTE_PREVIEW_MIMES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jfif: "image/jpeg",
	pjpeg: "image/jpeg",
	pjp: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
	ico: "image/x-icon",
	apng: "image/apng",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mkv: "video/x-matroska",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	wave: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	weba: "audio/webm",
	pdf: "application/pdf",
	...Object.fromEntries(REMOTE_PREVIEW_TEXT_EXTENSIONS.map((ext) => [ext, TEXT_PLAIN_UTF8])),
};

export function remotePreviewMime(filePath: string): string | null {
	const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	const base = filePath.slice(sep + 1);
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return null;
	return REMOTE_PREVIEW_MIMES[base.slice(dot + 1).toLowerCase()] ?? null;
}
