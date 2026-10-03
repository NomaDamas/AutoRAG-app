import { execFile } from "node:child_process";
import { extname } from "node:path";

/**
 * Asks Launch Services which app opens a path, through JavaScript for
 * Automation: no native module, about 100ms, and off the main thread.
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

/** Resolved names, so a repeat file type is answered in the same tick as its load. */
const known = new Map<string, string>();

function cacheKey(path: string, folder: boolean): string {
	const ext = extname(path).toLowerCase();
	if (folder) return `folder:${ext}`;
	return ext === "" ? `path:${path}` : `file:${ext}`;
}

/** The cached default app for `path`, when an earlier lookup already found it. */
export function knownDefaultApp(path: string, folder: boolean): string | null {
	return known.get(cacheKey(path, folder)) ?? null;
}

/**
 * The app "Open with" launches for `path`, or null when the platform does not
 * say. macOS only: Windows has no lookup that is both cheap and reliable from
 * Electron, so its button reads "Open".
 */
export function lookupDefaultApp(path: string, folder: boolean): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	if (process.platform !== "darwin") {
		resolve(null);
		return promise;
	}
	execFile("osascript", ["-l", "JavaScript", "-e", LAUNCH_SERVICES, path], { timeout: 3000 }, (error, stdout) => {
		const name = stdout.trim();
		if (error !== null || name === "") {
			resolve(null);
			return;
		}
		known.set(cacheKey(path, folder), name);
		resolve(name);
	});
	return promise;
}
