/**
 * The `autorag-thumb://` custom protocol serves the OS file-icon bytes the icon
 * provider cached, so the Finder IPC payload carries only a URL — never a
 * base64 data URL. Chromium's image pipeline then decodes/caches the PNG off
 * the main thread, and the URL's embedded cache identity lets it use the HTTP
 * cache across listings.
 *
 * URL contract: `autorag-thumb://local/?path=<absolute path>&mtime=<ISO stamp>`.
 * `mtime` is the same cache identity the provider keys on, so a changed file
 * yields a different URL (and a cache miss) while an unchanged one stays
 * immutable. `iconIdentityFromUrl` is the only decoder; it enforces the exact
 * host, path, and query shape — foreign schemes/hosts, a non-root path,
 * credentials/ports, unexpected or duplicate query parameters, relative or
 * NUL-bearing paths, and unparsable timestamps are all rejected.
 *
 * The responses carry permissive CORS so a renderer QA probe can read the
 * served pixels from a canvas; a 404 (the OS produced no icon for that
 * identity) and a 400 are `no-store` so Chromium never pins a miss — the
 * `<img>` keeps the letter tile and a later hit can still load.
 */

import { isAbsolute } from "node:path";
import type { IconStore } from "./file-icon";

/** Privileged scheme registered before app-ready in `icon-register.ts`. */
export const THUMB_SCHEME = "autorag-thumb";

const THUMB_HOST = "local";
const PNG_CONTENT_TYPE = "image/png";
/** The URL encodes the file's mtime, so a changed file always misses this cache. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** Icon URLs are same-app assets; allow canvas pixel reads for QA. */
const CORS_HEADER = { "access-control-allow-origin": "*" } as const;
const NO_STORE_HEADER = { "cache-control": "no-store", ...CORS_HEADER } as const;

/** Cache identity for one file icon: path plus the modifiedAt the bytes were made for. */
export interface IconIdentity {
	readonly path: string;
	readonly modifiedAt: string;
}

/**
 * Build the stable thumbnail URL for one cache identity. Values are
 * percent-encoded by `URLSearchParams`, so absolute paths (spaces, unicode,
 * `#`, `?`) round-trip verbatim.
 */
export function iconUrl(path: string, modifiedAt: string): string {
	const url = new URL(`${THUMB_SCHEME}://${THUMB_HOST}/`);
	url.searchParams.set("path", path);
	url.searchParams.set("mtime", modifiedAt);
	return url.toString();
}

/**
 * Decode a thumbnail URL back to its cache identity. Returns null — never
 * throws for input — unless the URL is exactly the `iconUrl` shape: the
 * `autorag-thumb:` scheme, the `local` host, a root path, no credentials or
 * port, exactly one `path` and one `mtime` query parameter, an absolute,
 * NUL-free path, and a parsable timestamp.
 */
export function iconIdentityFromUrl(raw: string): IconIdentity | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
	if (url.protocol !== `${THUMB_SCHEME}:`) return null;
	if (url.hostname !== THUMB_HOST || url.pathname !== "/") return null;
	if (url.username !== "" || url.password !== "" || url.port !== "") return null;
	const keys = [...new Set(url.searchParams.keys())].sort();
	if (keys.length !== 2 || keys[0] !== "mtime" || keys[1] !== "path") return null;
	if (url.searchParams.getAll("path").length !== 1 || url.searchParams.getAll("mtime").length !== 1) return null;
	const path = url.searchParams.get("path");
	if (path === null || path.length === 0 || path.includes("\0") || !isAbsolute(path)) return null;
	const modifiedAt = url.searchParams.get("mtime");
	if (modifiedAt === null || Number.isNaN(Date.parse(modifiedAt))) return null;
	return { path, modifiedAt };
}

/**
 * Answer one thumbnail request from the provider's byte cache. A malformed URL
 * is a 400; an identity the provider never cached (or produced nothing for) is
 * a 404, and the renderer's `<img>` keeps the letter tile fallback. Both
 * failures are `no-store`, so a miss is never pinned in the HTTP cache.
 */
export function handleIconRequest(request: Request, store: IconStore): Response {
	const identity = iconIdentityFromUrl(request.url);
	if (identity === null) return new Response("bad icon url", { status: 400, headers: NO_STORE_HEADER });
	const bytes = store.read(identity.path, identity.modifiedAt);
	if (bytes === null) return new Response("no icon", { status: 404, headers: NO_STORE_HEADER });
	return new Response(bytes, {
		status: 200,
		headers: {
			"content-type": PNG_CONTENT_TYPE,
			"content-length": String(bytes.byteLength),
			"cache-control": IMMUTABLE_CACHE,
			...CORS_HEADER,
		},
	});
}
