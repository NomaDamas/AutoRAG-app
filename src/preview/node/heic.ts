import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewDocument } from "../shared/contract";
import { PREVIEW_BYTE_CAP, readPreviewFile } from "./read-file";

/** The MIME type the converted bytes carry; the viewer keys on it to skip its own decoder. */
export const HEIC_PREVIEW_MIME = "image/jpeg";
/** sips `formatOptions`: JPEG quality 0-100. */
const JPEG_QUALITY = "85";
/** A 48MP HEIC on a spun-down HDD still decodes well inside this. */
const SIPS_TIMEOUT_MS = 30_000;

export type HeicRun = (command: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<void>;

export interface HeicDeps {
	readonly platform?: NodeJS.Platform;
	readonly run?: HeicRun;
	readonly warn?: (message: string) => void;
}

const defaultRun: HeicRun = (command, args, { timeoutMs }) =>
	new Promise<void>((resolve, reject) => {
		execFile(command, [...args], { timeout: timeoutMs }, (error, _stdout, stderr) => {
			if (error === null) resolve();
			else reject(new Error(stderr.trim().length > 0 ? stderr.trim() : error.message));
		});
	});

/**
 * Decodes a HEIC with the system's own ImageIO (`sips`) into a JPEG. The
 * in-renderer wasm decoder takes tens of seconds on a camera-size photo and
 * never finished on a 24MP iPhone HEIC; ImageIO does the same file in about
 * 0.2s and applies the HEIF rotation itself. Null when the platform has no
 * such tool or it produced nothing.
 */
async function decodeWithSips(path: string, deps: HeicDeps): Promise<Uint8Array | null> {
	if ((deps.platform ?? process.platform) !== "darwin") return null;
	const run = deps.run ?? defaultRun;
	const dir = await mkdtemp(join(tmpdir(), "autorag-heic-"));
	try {
		const out = join(dir, "preview.jpg");
		await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", JPEG_QUALITY, "--out", out, path], { timeoutMs: SIPS_TIMEOUT_MS });
		const bytes = await readFile(out);
		return bytes.byteLength === 0 ? null : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} catch (error) {
		(deps.warn ?? console.warn)(`quick-look: sips could not decode ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * The HEIC preview document. Where the OS can decode it, `bytes` is the
 * decoded JPEG (`mime` says so) and the HEIC itself is never read into
 * memory; otherwise it is the raw file, for the viewer's own wasm decoder.
 */
export async function readHeicPreview(path: string, deps: HeicDeps = {}): Promise<PreviewDocument> {
	const info = await readPreviewFile(path, 0);
	const jpeg = await decodeWithSips(path, deps);
	if (jpeg !== null) return { ...info, mime: HEIC_PREVIEW_MIME, bytes: jpeg };
	return readPreviewFile(path, PREVIEW_BYTE_CAP, true);
}
