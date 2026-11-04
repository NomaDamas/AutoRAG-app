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
	pair: "/remote/pair",
	auth: "/remote/auth",
	health: "/remote/health",
} as const;

export const REMOTE_TOKEN_HEADER = "x-remote-token";
export const REMOTE_CSRF_HEADER = "x-dazzi-remote";

/** Main <-> renderer channels for the remote-access setting's live status, pairing, devices, and tunnel. */
export const REMOTE_CHANNELS = {
	status: "remote:status",
	start: "remote:start",
	stop: "remote:stop",
	startPairing: "remote:startPairing",
	devices: "remote:devices",
	renameDevice: "remote:renameDevice",
	revokeDevice: "remote:revokeDevice",
	revokeAllDevices: "remote:revokeAllDevices",
	refreshNetwork: "remote:refreshNetwork",
	startTunnel: "remote:startTunnel",
	stopTunnel: "remote:stopTunnel",
	loginTunnel: "remote:loginTunnel",
	changed: "remote:changed",
} as const;

/** One-time 6-digit pairing code minted on the host (10-minute TTL, 5-attempt burn). */
export interface RemotePairingCode {
	readonly code: string;
	readonly expiresAt: string;
}

/** A durably enrolled browser/device holding a hashed `dazzi_device` credential. */
export interface RemotePairedDevice {
	readonly id: string;
	readonly label: string;
	readonly createdAt: string;
	readonly lastSeenAt: string | null;
	readonly current?: boolean;
}

/** Why an outbound tunnel could not start; the Settings UI translates each one. */
export type RemoteTunnelErrorCode = "missing_binary" | "server_stopped" | "timeout" | "exited" | "disconnected" | "login_required" | "setup_failed";

/**
 * Outbound Cloudflare tunnel for HTTPS access from outside the local network.
 * `quick`: an account-less `https://<random>.trycloudflare.com` address that changes on every start.
 * `custom`: a named tunnel on the user's own Cloudflare domain (`remoteTunnelHostname`), stable across restarts.
 */
export interface RemoteTunnelStatus {
	readonly available: boolean;
	readonly mode: "quick" | "custom";
	/** The configured custom hostname (`remote.example.com`), or null for Quick Tunnel. */
	readonly hostname: string | null;
	/** `cloudflared tunnel login` has written `~/.cloudflared/cert.pem` (required for `custom`). */
	readonly loggedIn: boolean;
	readonly state: "off" | "starting" | "online" | "error";
	readonly url: string | null;
	readonly error: string | null;
	readonly errorCode: RemoteTunnelErrorCode | null;
}

/**
 * A bare DNS hostname the user owns on Cloudflare (`remote.example.com`): at least two labels, letters/digits/hyphens,
 * no scheme, port, path, or wildcard. Returns the lower-cased name, or null when it is not one.
 */
export function normalizeTunnelHostname(value: string): string | null {
	const name = value.trim().toLowerCase().replace(/\.$/, "");
	if (name.length === 0 || name.length > 253) return null;
	const labels = name.split(".");
	if (labels.length < 2) return null;
	const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
	return labels.every((part) => label.test(part)) && !/^\d+$/.test(labels.at(-1) ?? "") ? name : null;
}

/** How the current browser request authenticated to the remote server. */
export type RemoteAccessVia = "token" | "device";

/** Why an unauthenticated browser request reached the AccessGate instead of Finder. */
export type RemoteAccessRefusal = "pairing_required";

/**
 * Why the remote server is not serving although remote access is on: the listen error the system gave. A taken port
 * is not one: the server falls back to a nearby free port, then to one the OS picks.
 */
export interface RemoteServerError {
	readonly port: number;
	readonly message: string;
}

/** What Settings shows about remote access, how devices connect, and the addresses a browser opens. */
export interface RemoteAccessStatus {
	readonly serving: boolean;
	/** Complete token-bearing localhost URL (`http://localhost:<port>/?token=...`) on the host; `location.origin` in a remote browser. */
	readonly origin: string | null;
	/** Clean base origin (`http://localhost:<port>`) without the secret token. */
	readonly baseOrigin?: string | null;
	readonly port: number;
	readonly sessions: number;
	/** Active non-loopback LAN origins (`http://192.168.x.y:<port>`). */
	readonly lanOrigins?: readonly string[];
	readonly tunnel?: RemoteTunnelStatus;
	readonly pairing?: RemotePairingCode | null;
	readonly devices?: readonly RemotePairedDevice[];
	/** Present in a remote browser session to describe how it authenticated. */
	readonly via?: RemoteAccessVia;
	/** Set while remote access is on but the server could not start; cleared by the next successful start or by stop. */
	readonly serverError?: RemoteServerError | null;
}

export interface RemoteAccessBridge {
	status(): Promise<RemoteAccessStatus>;
	start(): Promise<RemoteAccessStatus>;
	stop(): Promise<RemoteAccessStatus>;
	startPairing(): Promise<RemotePairingCode>;
	devices(): Promise<readonly RemotePairedDevice[]>;
	renameDevice(id: string, label: string): Promise<RemotePairedDevice | null>;
	revokeDevice(id: string): Promise<boolean>;
	revokeAllDevices(): Promise<number>;
	refreshNetwork(): Promise<RemoteAccessStatus>;
	startTunnel(): Promise<RemoteAccessStatus>;
	stopTunnel(): Promise<RemoteAccessStatus>;
	/** Runs `cloudflared tunnel login` (opens the Cloudflare authorization page in the browser). */
	loginTunnel(): Promise<RemoteAccessStatus>;
	onChange(listener: (status: RemoteAccessStatus) => void): () => void;
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
	/** Optional: omitted for cookie-authenticated sessions where HttpOnly cookies carry authority. */
	readonly token?: string;
	readonly via?: RemoteAccessVia;
	readonly deviceId?: string | null;
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
	voice: ["transcribe", "prepare", "openMicrophoneSettings"],
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
