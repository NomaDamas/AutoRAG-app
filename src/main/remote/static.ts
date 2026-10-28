import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Static serving for the remote browser UI. The renderer bundle is the same
 * `out/renderer` build the desktop window loads; serving `index.html` rewrites
 * it so a remote bootstrap script defines `window.autorag` before the bundle
 * runs (the one fatal gap measured in a plain browser; see
 * .omo/remote-dazzi/architecture/browser-probe.md).
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".wasm": "application/wasm",
	".ico": "image/x-icon",
};

export const REMOTE_BOOTSTRAP_PATH = "/remote/bootstrap.js";

/**
 * `index.html` with the remote bootstrap script inserted as the first script
 * of `<head>` and a CSP that keeps every bundled rule but lets the page talk
 * to its own origin over HTTP and WebSocket (the Electron CSP allows only
 * `autorag-preview:`/`blob:` beyond self, and `img-src`/`media-src`/`font-src`
 * must also accept the same origin's preview and thumbnail endpoints).
 */
export function rewriteIndexHtml(html: string): string {
	const script = `<script src="${REMOTE_BOOTSTRAP_PATH}"></script>`;
	let out = html.replace(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/, (_match, content: string) => {
		const csp = content
			.replaceAll("autorag-preview: autorag-thumb:", "http: ws:")
			.replaceAll("autorag-preview:", "http:")
			.replaceAll("autorag-thumb:", "http:");
		return `<meta http-equiv="Content-Security-Policy" content="${csp}"`;
	});
	if (out.includes("<head>")) {
		out = out.replace("<head>", `<head>\n\t\t${script}`);
	}
	return out;
}

export interface RemoteStaticFile {
	readonly body: Uint8Array;
	readonly contentType: string;
}

/** Read one asset under `root`; `null` when the path escapes the root or is missing. */
export async function readRemoteStatic(root: string, urlPath: string): Promise<RemoteStaticFile | null> {
	const decoded = decodeURIComponent(urlPath);
	if (decoded.includes("\0")) return null;
	const relative = normalize(decoded).replace(/^([/\\])+/, "");
	const full = resolve(join(root, relative));
	if (full !== root && !full.startsWith(root + sep)) return null;
	const type = CONTENT_TYPES[extname(full).toLowerCase()];
	if (type === undefined) return null;
	try {
		const body = await readFile(full);
		return { body, contentType: type };
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) return null;
		throw error;
	}
}
