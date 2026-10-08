import { execFile } from "node:child_process";
import { extname } from "node:path";

/**
 * Asks Launch Services which app opens a path, through JavaScript for
 * Automation: no native module and about 100ms. Spawning a child blocks the
 * caller's event loop for the fork, so this runs in the fs worker, never on
 * the main process.
 */
const LAUNCH_SERVICES = `
ObjC.import("AppKit");
function run(argv) {
	const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
	if (url.isNil()) return "";
	const bundle = $.NSBundle.bundleWithURL(url);
	if (!bundle.isNil()) {
		const info = bundle.localizedInfoDictionary.isNil() ? bundle.infoDictionary : bundle.localizedInfoDictionary;
		for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
			const value = info.isNil() ? $() : info.objectForKey(key);
			if (!value.isNil() && ObjC.unwrap(value) !== "") return ObjC.unwrap(value);
		}
	}
	return ObjC.unwrap(url.lastPathComponent).replace(/\\.app$/, "");
}`;

/**
 * The app "Open with" launches for `path`, or null when the platform does not
 * say. macOS only: Windows has no lookup that is both cheap and reliable from
 * Electron, so its button reads "Open".
 */
export function lookupDefaultApp(path: string): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	if (process.platform !== "darwin") {
		resolve(null);
		return promise;
	}
	execFile("osascript", ["-l", "JavaScript", "-e", LAUNCH_SERVICES, path], { timeout: 3000 }, (error, stdout) => {
		const name = stdout.trim();
		resolve(error !== null || name === "" ? null : name);
	});
	return promise;
}

export interface DefaultAppCache {
	/** The cached default app for `path`, when an earlier lookup already found it. */
	known(path: string, folder: boolean): string | null;
	/** Asks `lookup` and remembers a found name for every file of the same type. */
	resolve(path: string, folder: boolean): Promise<string | null>;
}

function cacheKey(path: string, folder: boolean): string {
	const ext = extname(path).toLowerCase();
	if (folder) return `folder:${ext}`;
	return ext === "" ? `path:${path}` : `file:${ext}`;
}

/** Resolved names, so a repeat file type is answered in the same tick as its load. */
export function createDefaultAppCache(lookup: (path: string) => Promise<string | null>): DefaultAppCache {
	const names = new Map<string, string>();
	return {
		known: (path, folder) => names.get(cacheKey(path, folder)) ?? null,
		async resolve(path, folder) {
			const name = await lookup(path).catch((error: unknown) => {
				console.warn(`[quick-look] default app lookup failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			});
			if (name !== null) names.set(cacheKey(path, folder), name);
			return name;
		},
	};
}
