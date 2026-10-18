import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
		const byWidth = new Map<number, string[]>();
		for (const [name, width] of pdfWidths(html)) {
			if (!names.includes(name)) continue;
			const target = Math.min(RASTER_MAX, Math.max(RASTER_MIN, Math.ceil(width * RASTER_SCALE)));
			byWidth.set(target, [...(byWidth.get(target) ?? []), name]);
		}
		for (const [target, group] of byWidth) {
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
		}
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
