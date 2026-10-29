import { APPEARANCE_CHANNELS } from "../../shared/appearance-contract";
import { ACCOUNT_CHANNELS } from "../../shared/account-contract";
import { APP_UPDATE_CHANNELS } from "../../shared/update-contract";
import { AUTOMATION_CHANNELS } from "../../shared/automation-contract";
import { INDEX_ACTIVITY_CHANNELS } from "../../shared/index-activity-contract";
import { INDEX_PROBLEM_CHANNELS } from "../../shared/index-problem-contract";
import { INTERACTION_CHANNELS } from "../../shared/interaction-contract";
import { MODEL_DOWNLOAD_CHANNELS } from "../../shared/model-download-contract";
import { ONBOARDING_CHANNELS } from "../../shared/onboarding-contract";
import { OS_REQUEST_CHANNELS } from "../../shared/os-request-contract";
import { SEARCH_CHANNELS } from "../../shared/search-contract";
import { SETTINGS_CHANNELS } from "../../shared/settings-contract";
import { SMART_INDEXING_CHANNELS } from "../../shared/smart-indexing-contract";
import { FS_WORKER_PUSH } from "../../shared/fs-worker-protocol";
import { REMOTE_ROUTES, type RemoteBootstrapConfig } from "../../shared/remote-contract";

/**
 * Builds the script the remote server injects before the renderer bundle: it
 * defines `window.autorag` (the same bridge surface the preload exposes) over
 * the server's endpoints, so the Finder UI runs unmodified in a browser.
 *
 * Subscriptions become SSE channels: the main process forwards each push under
 * its IPC channel name, and the table below maps `target.method` to that name.
 */

const PUSH_CHANNELS: Readonly<Record<string, string>> = {
	"account.onChanged": ACCOUNT_CHANNELS.changed,
	"appUpdate.onChange": APP_UPDATE_CHANNELS.changed,
	"automations.onChange": AUTOMATION_CHANNELS.changed,
	"indexActivity.onChange": INDEX_ACTIVITY_CHANNELS.changed,
	"indexProblem.onChange": INDEX_PROBLEM_CHANNELS.changed,
	"interaction.onMode": INTERACTION_CHANNELS.modeChanged,
	"interaction.onRequest": INTERACTION_CHANNELS.request,
	"interaction.onClosed": INTERACTION_CHANNELS.closed,
	"modelDownload.onChange": MODEL_DOWNLOAD_CHANNELS.changed,
	"search.onEvent": SEARCH_CHANNELS.event,
	"settings.onProviderLoginEvent": SETTINGS_CHANNELS.providerLoginEvent,
	"smartIndexing.onEvent": SMART_INDEXING_CHANNELS.event,
	"osRequests.onAvailable": OS_REQUEST_CHANNELS.available,
	"onboarding.onScanProgress": ONBOARDING_CHANNELS.scanProgress,
	"fs.onLocationsChanged": FS_WORKER_PUSH.locationsChanged,
	"fs.onIndexRefreshed": FS_WORKER_PUSH.indexRefreshed,
	"live.onMessage": FS_WORKER_PUSH.live,
};

/** The bridge names the renderer reads; a call on one posts to the dispatcher. */
const TARGETS = [
	"fs",
	"live",
	"settings",
	"search",
	"interaction",
	"preview",
	"actions",
	"services",
	"conversion",
	"account",
	"automations",
	"appUpdate",
	"indexActivity",
	"indexProblem",
	"modelDownload",
	"onboarding",
	"osRequests",
	"smartIndexing",
	"analytics",
] as const;

export function buildRemoteBootstrapScript(config: RemoteBootstrapConfig): string {
	const bootstrapConfig = JSON.stringify(config);
	const pushChannels = JSON.stringify(PUSH_CHANNELS);
	const targets = JSON.stringify(TARGETS);
	return `/* Dazzi remote bootstrap: defines window.autorag for a browser session. */
(() => {
	const config = ${bootstrapConfig};
	const pushChannels = ${pushChannels};
	const targets = ${targets};
	const routes = ${JSON.stringify(REMOTE_ROUTES)};
	const base = new URL("/", location.href);
	const session = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
	const url = (route, params) => {
		const target = new URL(route, base);
		for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
		target.searchParams.set("token", config.token);
		target.searchParams.set("session", session);
		return target.toString();
	};
	// The renderer builds autorag-thumb:// and autorag-preview:// URLs in a few
	// places; a browser cannot load a custom scheme, so rewrite them anywhere
	// they appear in returned data or are constructed by the shared helpers.
	const rewriteString = (value) => {
		if (value.startsWith("autorag-thumb://")) {
			const parsed = new URL(value);
			return url(routes.thumb, {
				path: parsed.searchParams.get("path"),
				mtime: parsed.searchParams.get("mtime"),
				size: parsed.searchParams.get("size"),
			});
		}
		if (value.startsWith("autorag-preview://")) {
			const parsed = new URL(value);
			return url(routes.preview, { path: parsed.searchParams.get("path") });
		}
		return value;
	};
	const rewrite = (value) => {
		if (typeof value === "string") return rewriteString(value);
		if (Array.isArray(value)) return value.map(rewrite);
		if (value !== null && typeof value === "object") {
			const out = {};
			for (const [key, item] of Object.entries(value)) out[key] = rewrite(item);
			return out;
		}
		return value;
	};
	const listeners = new Map();
	const emit = (channel, payload) => {
		for (const listener of listeners.get(channel) ?? []) listener(rewrite(payload));
	};
	const events = () => {
		const source = new EventSource(url(routes.events));
		source.onmessage = (message) => {
			try {
				const parsed = JSON.parse(message.data);
				emit(parsed.channel, parsed.payload);
			} catch (error) {
				console.warn("remote push ignored", error);
			}
		};
		source.onerror = () => {
			for (const listener of listeners.get("__reconnect") ?? []) listener();
		};
	};
	const subscribe = (key, listener) => {
		const channel = pushChannels[key];
		if (channel === undefined) return () => {};
		let set = listeners.get(channel);
		if (set === undefined) {
			set = new Set();
			listeners.set(channel, set);
		}
		set.add(listener);
		return () => {
			listeners.get(channel)?.delete(listener);
		};
	};
	const call = async (target, method, args) => {
		const response = await fetch(url(routes.call), {
			method: "POST",
			headers: { "content-type": "application/json", "x-remote-session": session },
			body: JSON.stringify({ target, method, args: [...args] }),
		});
		if (!response.ok) throw new Error("remote call refused: " + response.status);
		const result = await response.json();
		if (result.ok !== true) {
			const error = new Error(result.error ?? "remote call failed");
			if (typeof result.code === "string") error.code = result.code;
			throw error;
		}
		return rewrite(result.value);
	};
	// Session clipboard: the desktop's clipboard is the user's own machine, so a
	// browser session keeps its own cut/copy list and pastes through it.
	let clipboard = null;
	const localClipboard = {
		clipboardSet: async (value) => { clipboard = value; },
		clipboardGet: async () => clipboard,
		copyPathsToClipboard: async (paths) => {
			clipboard = { op: "copy", paths };
			try { await navigator.clipboard.writeText([...paths].join("\\n")); } catch (error) { console.warn("clipboard text unavailable", error); }
		},
	};
	// Native-only actions get browser meanings: a row drag downloads it, a
	// double click downloads it, Quick Look opens the preview endpoint.
	const downloadUrl = (path) => url(routes.download, { path });
	// Handing a row to the OS and opening it are both a download here: the file
	// ends up on the browser user's machine, which is what either gesture means.
	const saveLocally = (paths) => {
		for (const path of paths) {
			const anchor = document.createElement("a");
			anchor.href = downloadUrl(path);
			anchor.download = String(path).split("/").pop() ?? "download";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
		}
	};
	// Every bridge method the renderer awaits returns a promise, even when the
	// browser action itself is synchronous (a click on a generated anchor).
	const nativeFs = {
		startDrag: saveLocally,
		open: async (path) => { saveLocally([path]); },
		// presentQuickLook calls both preview.show and fs.quickLook (which
		// only records Recents on the desktop); opening the tab belongs to preview.show.
		quickLook: async () => {},
		reveal: async () => {}, 
		// Dropped browser files have no host path; the renderer uploads them here.
		uploadFiles: async (folder, files) => {
			const results = [];
			for (const file of files) {
				const response = await fetch(url(routes.upload, { folder, name: file.name }), { method: "POST", body: file, headers: { "x-remote-session": session } });
				results.push({ name: file.name, ok: response.ok });
			}
			return results;
		},
	};
	// Quick Look is a window of its own on the desktop; here it is a one-shot
	// preview tab, so closed fires at once instead of leaving preview open
	// and spawning a new tab on every later selection or context-menu click.
	const previewClosed = new Set();
	const preview = {
		show: async (target) => {
			window.open(url(routes.preview, { path: target.path }), "_blank", "noopener");
			queueMicrotask(() => {
				for (const listener of previewClosed) listener();
			});
		},
		hide: async () => {},
		prefetch: () => {},
		onClosed: (listener) => {
			previewClosed.add(listener);
			return () => {
				previewClosed.delete(listener);
			};
		},
		onNavigate: () => () => {},
	};
	const actions = {
		capabilities: async () => ({ openWith: false, share: false, archive: false, imageFormats: [], videoContainers: [] }),
	};
	const services = {
		list: async () => [],
	};
	// Members named on* are subscriptions the page registers, so they must return
	// an unsubscribe function synchronously; everything else is a bridge call.
	const bridgeFor = (target, values) => {
		const seed = values ?? {};
		if (target === "fs") Object.assign(seed, nativeFs);
		if (target === "preview") Object.assign(seed, preview);
		if (target === "actions") Object.assign(seed, actions);
		if (target === "services") Object.assign(seed, services);
		return new Proxy(seed, {
			get: (own, name) => {
				if (typeof name !== "string") return undefined;
				if (name in own) return own[name];
				if (name.startsWith("on")) return (listener) => subscribe(target + "." + name, listener);
				return (...args) => call(target, name, args);
			},
		});
	};
	const autorag = {
		version: config.version,
		platform: config.platform,
		dev: null,
		pathForFile: () => "",
	};
	// A browser session is the client of remote access, so its own status is true
	// and its own address is this page; starting or stopping the host server stays
	// with the desktop that owns it.
	const remoteStatus = async () => ({
		serving: true,
		origin: location.origin,
		port: Number(location.port || 0),
		sessions: 1,
	});
	autorag.remote = { status: remoteStatus, start: remoteStatus, stop: remoteStatus };
	for (const target of targets) autorag[target] = bridgeFor(target);
	autorag.fs = Object.assign(bridgeFor("fs"), localClipboard);
	// Value-shaped members the renderer reads without calling (the desktop preload's).
	autorag.onboarding = bridgeFor("onboarding", { pending: false });
	// Analytics belongs to the desktop install; a browser session reports nothing.
	autorag.analytics = { track: () => {} };
	// Appearance and platform reach the stylesheets before the first paint, the
	// way the desktop preload mirrors them.
	document.documentElement.dataset.appearance = config.appearance;
	document.documentElement.dataset.platform = config.platform;
	listeners.set(${JSON.stringify(APPEARANCE_CHANNELS.changed)}, new Set([(value) => {
		if (value === "light" || value === "dark") document.documentElement.dataset.appearance = value;
	}]));
	window.__autoragRemote = { routes, token: config.token, base: base.toString(), url };
	window.autoragIsRemote = true;
	window.autorag = autorag;
	events();
})();
`;
}
