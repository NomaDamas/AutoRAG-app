import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OfficePage } from "../shared/contract";
import { PREVIEW_BYTE_CAP } from "./read-file";

/** Quick Look lays a 26-slide deck out in about 1.3s; a dense document is faster. */
const QUICK_LOOK_TIMEOUT_MS = 30_000;
const SIPS_TIMEOUT_MS = 30_000;
/** Vector pictures (Quick Look writes EMF/WMF art as PDF) are rasterized at this multiple of their drawn size. */
const RASTER_SCALE = 3;
const RASTER_MIN = 64;
const RASTER_MAX = 2048;

export type OfficeRun = (command: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<void>;

export interface OfficeRenderDeps {
	readonly platform?: NodeJS.Platform;
	readonly run?: OfficeRun;
	readonly warn?: (message: string) => void;
	/** Largest page HTML handed to the viewer; defaults to the whole-file preview cap. */
	readonly maxBytes?: number;
}

const defaultRun: OfficeRun = (command, args, { timeoutMs }) =>
	new Promise<void>((resolve, reject) => {
		execFile(command, [...args], { timeout: timeoutMs }, (error, _stdout, stderr) => {
			if (error === null) resolve();
			else reject(new Error(stderr.trim().length > 0 ? stderr.trim() : error.message));
		});
	});

export type OfficeAttachment =
	| { readonly kind: "data"; readonly mime: string; readonly bytes: Uint8Array }
	| { readonly kind: "css"; readonly text: string };

/** The one Content-Security-Policy the page carries: pictures it embeds and its own styles, nothing else. */
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
/** Pages are drawn on white like paper, whatever the app's theme; the document's own styles come after and may override. */
const PAPER = "<style>html,body{background:#fff;color:#000}</style>";

function dataUri(mime: string, bytes: Uint8Array): string {
	return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

/**
 * Makes Quick Look's `Preview.html` a self-contained page that can be shown in
 * a `sandbox=""` frame: attachments the package holds are inlined, everything
 * that could fetch or run something (remote pictures, links, scripts, frames,
 * event handlers, other `<link>`s) is removed, and a CSP forbids the rest.
 * The generator escapes document text, and the sandbox and CSP are what hold
 * even if it did not; the rewriting here only keeps the page quiet and small.
 */
export function standaloneOfficeHtml(html: string, resolve: (name: string) => OfficeAttachment | null): string {
	let out = html
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<(iframe|object|embed|frame)\b[\s\S]*?(?:<\/\1\s*>|\/>|>)/gi, "")
		.replace(/(<[a-z][^>]*?)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1")
		.replace(/<link\b[^>]*?\bhref="([^"]*)"[^>]*>/gi, (_match, href: string) => {
			const attachment = resolve(href);
			return attachment?.kind === "css" ? `<style>${attachment.text}</style>` : "";
		})
		.replace(/<link\b[^>]*>/gi, "")
		.replace(/<img\b[^>]*>/gi, (tag) => {
			const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
			const attachment = src === undefined ? null : resolve(src);
			if (attachment?.kind !== "data") return "";
			return tag.replace(/\bsrc="[^"]*"/i, `src="${dataUri(attachment.mime, attachment.bytes)}"`);
		})
		.replace(/(<a\b[^>]*?)\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1");
	const head = /<head\b[^>]*>/i.exec(out);
	const injected = `${POLICY}${PAPER}`;
	if (head !== null) out = `${out.slice(0, head.index + head[0].length)}${injected}${out.slice(head.index + head[0].length)}`;
	else {
		const root = /<html\b[^>]*>/i.exec(out);
		out = root === null ? `<head>${injected}</head>${out}` : `${out.slice(0, root.index + root[0].length)}<head>${injected}</head>${out.slice(root.index + root[0].length)}`;
	}
	return out;
}

const SAFE_NAME = /^Attachment[\w.-]*$/;
const MIME_BY_EXT: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };

function extension(name: string): string {
	return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** Drawn width (CSS px) of every `<img>` that shows a PDF attachment, by attachment name. */
function pdfWidths(html: string): Map<string, number> {
	const widths = new Map<string, number>();
	for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
		const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
		if (src === undefined || !SAFE_NAME.test(src) || extension(src) !== "pdf") continue;
		const width = Number(/\bwidth:\s*([\d.]+)/i.exec(tag)?.[1] ?? 0);
		widths.set(src, Math.max(widths.get(src) ?? 0, width));
	}
	return widths;
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/**
 * The page macOS's own Office Quick Look generator draws for a legacy Office
 * file, as one self-contained HTML string: text with its fonts, colours, and
 * tables for Word, and every slide, picture, and shape for PowerPoint.
 * `qlmanage -p` writes the page and its pictures to a temp folder (about 0.1s
 * for a document, 1.3s for a 26-slide deck) and `sips` rasterizes the vector
 * art. Null when this is not macOS or the OS produced nothing; the viewer then
 * shows the extracted text. The temp folder is always removed.
 */
export async function renderOfficeHtml(path: string, deps: OfficeRenderDeps = {}): Promise<string | null> {
	if ((deps.platform ?? process.platform) !== "darwin") return null;
	const run = deps.run ?? defaultRun;
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const maxBytes = deps.maxBytes ?? PREVIEW_BYTE_CAP;
	const dir = await mkdtemp(join(tmpdir(), "autorag-office-"));
	try {
		await run("/usr/bin/qlmanage", ["-p", path, "-o", dir], { timeoutMs: QUICK_LOOK_TIMEOUT_MS });
		const pack = join(dir, `${basename(path)}.qlpreview`);
		const pagePath = join(pack, "Preview.html");
		if (!(await exists(pagePath))) {
			warn(`quick-look: Office preview for ${path} produced no page`);
			return null;
		}
		const html = await readFile(pagePath, "utf8");
		const names = (await readdir(pack)).filter((name) => SAFE_NAME.test(name) && html.includes(name));
		const attachments = new Map<string, OfficeAttachment>();
		for (const name of names) {
			const ext = extension(name);
			if (ext === "css") attachments.set(name, { kind: "css", text: await readFile(join(pack, name), "utf8") });
			else if (MIME_BY_EXT[ext] !== undefined) attachments.set(name, { kind: "data", mime: MIME_BY_EXT[ext], bytes: await readFile(join(pack, name)) });
		}
		// Each picture is rasterized at 3x its own drawn width, so a 66px icon is not
		// drawn at the 2048px a full-slide picture needs (that cost 3.3s on a 26-slide
		// deck). Widths are rounded up to the next power of two so the pictures fall
		// into a few sips runs: a process start costs more than a small picture.
		const byTarget = new Map<number, string[]>();
		for (const [name, width] of pdfWidths(html)) {
			if (!names.includes(name)) continue;
			const wanted = Math.min(RASTER_MAX, Math.max(RASTER_MIN, Math.ceil(width * RASTER_SCALE)));
			const target = Math.min(RASTER_MAX, 2 ** Math.ceil(Math.log2(wanted)));
			byTarget.set(target, [...(byTarget.get(target) ?? []), name]);
		}
		await Promise.all(
			[...byTarget].map(async ([target, group]) => {
				const out = join(dir, `raster-${target}`);
				try {
					await mkdir(out);
					await run("/usr/bin/sips", ["-s", "format", "png", "--resampleWidth", String(target), ...group.map((name) => join(pack, name)), "--out", out], { timeoutMs: SIPS_TIMEOUT_MS });
					for (const name of group) {
						const png = join(out, `${name.slice(0, -4)}.png`);
						if (await exists(png)) attachments.set(name, { kind: "data", mime: "image/png", bytes: await readFile(png) });
					}
				} catch (error) {
					warn(`quick-look: could not rasterize pictures of ${path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}),
		);
		const page = standaloneOfficeHtml(html, (name) => (SAFE_NAME.test(name) ? (attachments.get(name) ?? null) : null));
		if (Buffer.byteLength(page) > maxBytes) {
			warn(`quick-look: Office preview for ${path} is larger than ${maxBytes} bytes`);
			return null;
		}
		return page;
	} catch (error) {
		warn(`quick-look: Quick Look could not render ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** What identifies one version of a file: a changed file must never be served a stale page. */
export interface OfficeFileIdentity {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

export interface OfficeRenderCache {
	/** Starts rendering `file` in the background unless it is cached or running; only the newest queued prefetch is kept. */
	prefetch(file: OfficeFileIdentity): void;
	/** The settled page (null when the OS drew nothing), or undefined while it is unknown or still rendering. */
	peek(file: OfficeFileIdentity): string | null | undefined;
	/** The rendered page, joining a running render or starting one now; null when the OS draws nothing. Never rejects. */
	get(file: OfficeFileIdentity): Promise<string | null>;
}

export interface OfficeRenderCacheDeps {
	readonly render?: (path: string) => Promise<string | null>;
	/** Bytes of page HTML kept; the least recently used pages go first. Defaults to 96MB. */
	readonly maxBytes?: number;
	readonly warn?: (message: string) => void;
}

const CACHE_BYTES = 96 * 1024 * 1024;

function identityKey(file: OfficeFileIdentity): string {
	return `${file.path}\u0000${file.mtimeMs}\u0000${file.size}`;
}

/**
 * Rendering takes 0.1-0.7s for the OS plus up to 0.4s to rasterize pictures, so
 * a page rendered only when Space is pressed cannot appear in half a second.
 * The Finder asks for a render as soon as a file is selected; the open that
 * follows finds it finished, or joins it while it runs. Renders started by
 * selection run one at a time and a queued one is dropped when the selection
 * moves on; an explicit open always starts at once.
 */
export function createOfficeRenderCache(deps: OfficeRenderCacheDeps = {}): OfficeRenderCache {
	const render = deps.render ?? ((path: string) => renderOfficeHtml(path));
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const maxBytes = deps.maxBytes ?? CACHE_BYTES;
	const entries = new Map<string, Promise<string | null>>();
	const settled = new Map<string, string | null>();
	const sizes = new Map<string, number>();
	let bytes = 0;
	let queued: OfficeFileIdentity | null = null;
	let prefetching = false;

	const evict = (): void => {
		for (const key of entries.keys()) {
			if (bytes <= maxBytes || entries.size <= 1) break;
			if (!sizes.has(key)) continue;
			bytes -= sizes.get(key) ?? 0;
			sizes.delete(key);
			settled.delete(key);
			entries.delete(key);
		}
	};

	const start = (file: OfficeFileIdentity): Promise<string | null> => {
		const key = identityKey(file);
		const running = render(file.path)
			.catch((error: unknown) => {
				warn(`quick-look: Office render of ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			})
			.then((page) => {
				const size = page === null ? 0 : Buffer.byteLength(page);
				sizes.set(key, size);
				settled.set(key, page);
				bytes += size;
				evict();
				return page;
			});
		entries.set(key, running);
		return running;
	};

	const pump = (): void => {
		if (prefetching || queued === null) return;
		const file = queued;
		queued = null;
		if (entries.has(identityKey(file))) return pump();
		prefetching = true;
		void start(file).finally(() => {
			prefetching = false;
			pump();
		});
	};

	return {
		peek: (file) => settled.get(identityKey(file)),
		prefetch(file) {
			if (entries.has(identityKey(file))) return;
			queued = file;
			pump();
		},
		get(file) {
			const key = identityKey(file);
			const known = entries.get(key);
			if (known !== undefined) {
				// Refresh recency: re-insert at the end of the map's order.
				entries.delete(key);
				entries.set(key, known);
				return known;
			}
			if (queued !== null && identityKey(queued) === key) queued = null;
			return start(file);
		},
	};
}

export interface OpenOfficeDeps {
	readonly cache: Pick<OfficeRenderCache, "peek" | "get">;
	/** The OS first-page image: `peek` answers a cached URL without work, `load` renders it. */
	readonly firstPage: { readonly peek: () => string | null; readonly load: () => Promise<string | null> };
	/** Sends a later state of this open to the preview window. */
	readonly publish: (office: OfficePage) => void;
	/** False once the preview has moved on to another file; nothing more is published then. */
	readonly current: () => boolean;
}

/**
 * The state to open a legacy Office file with, answered in one tick. A page
 * already rendered opens finished. Otherwise the panel opens at once on the
 * first-page image (the OS thumbnail, tens of milliseconds, cached from the
 * selection) and `publish` delivers the first-page image if it was not cached,
 * then the whole page when it is drawn (0.4-5s: the OS service wakes slowly
 * after idle), or the end of the wait when the OS cannot draw the file.
 */
export function openOffice(file: OfficeFileIdentity, deps: OpenOfficeDeps): OfficePage {
	const cached = deps.cache.peek(file);
	if (cached !== undefined) return { firstPage: null, html: cached, pending: false };
	const cachedFirst = deps.firstPage.peek();
	let firstPage = cachedFirst;
	let finished = false;
	const emit = (): void => {
		if (!deps.current()) return;
		deps.publish({ firstPage, html: null, pending: true });
	};
	if (cachedFirst === null) {
		void deps.firstPage
			.load()
			.catch(() => null)
			.then((url) => {
				if (url === null || finished) return;
				firstPage = url;
				emit();
			});
	}
	void deps.cache.get(file).then((html) => {
		finished = true;
		if (!deps.current()) return;
		deps.publish({ firstPage, html, pending: false });
	});
	return { firstPage: cachedFirst, html: null, pending: true };
}
