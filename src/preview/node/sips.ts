import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withReadableFile } from "./provider-access";

/** A 48MP HEIC or a multi-hundred-megapixel scan on a spun-down HDD still decodes well inside this. */
export const SIPS_TIMEOUT_MS = 30_000;

export type SipsRun = (command: string, args: readonly string[], options: { readonly timeoutMs: number }) => Promise<void>;

export interface PixelSize {
	readonly width: number;
	readonly height: number;
}

/** Runs `sips` with `args`; resolves with its stdout, rejects with its stderr (or the spawn error). */
function execSips(args: readonly string[], timeoutMs: number): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("sips", [...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
		if (error === null) resolve(stdout);
		else reject(new Error(stderr.trim().length > 0 ? stderr.trim() : error.message));
	});
	return promise;
}

export const runSips: SipsRun = async (_command, args, { timeoutMs }) => {
	await execSips(args, timeoutMs);
};

/** The pixel size sips reports for an image, or null when it cannot read one. */
export async function pixelSize(path: string): Promise<PixelSize | null> {
	try {
		return await withReadableFile(
			path,
			async (localPath) => {
				const out = await execSips(["-g", "pixelWidth", "-g", "pixelHeight", localPath], SIPS_TIMEOUT_MS);
				const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
				const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
				if (!(width > 0 && height > 0)) throw new Error(`sips reported no pixel size for ${localPath}`);
				return { width, height };
			},
			true,
		);
	} catch {
		return null;
	}
}

export interface SipsConversion {
	readonly platform?: NodeJS.Platform;
	readonly run?: SipsRun;
	readonly warn?: (message: string) => void;
}

/**
 * Converts `path` with the system's own ImageIO (`sips`) into `outName` inside
 * a scratch folder and returns the bytes. `args` are the sips options without
 * the input and `--out`. Null when this is not macOS, the tool fails, or it
 * writes nothing; the scratch folder is always removed.
 */
export async function convertWithSips(path: string, outName: string, args: readonly string[], deps: SipsConversion): Promise<Uint8Array | null> {
	if ((deps.platform ?? process.platform) !== "darwin") return null;
	const run = deps.run ?? runSips;
	const dir = await mkdtemp(join(tmpdir(), "autorag-sips-"));
	try {
		return await withReadableFile(
			path,
			async (localPath) => {
				const out = join(dir, outName);
				await run("sips", [...args, "--out", out, localPath], { timeoutMs: SIPS_TIMEOUT_MS });
				const bytes = await readFile(out);
				return bytes.byteLength === 0 ? null : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			},
			true,
		);
	} catch (error) {
		(deps.warn ?? console.warn)(`quick-look: sips could not convert ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
