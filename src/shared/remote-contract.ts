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
