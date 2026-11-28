import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export interface OriginalCopyOptions {
	/** The PDF's per-file lock (`PdfEditorIo.withLock`), so a concurrent edit never yields a half-written copy. */
	readonly withLock: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;
	/** The word for "original" in the app language (원본 / original / オリジナル / 原件). */
	readonly label: () => string;
	readonly now?: () => Date;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `계약서 (원본 2026-11-28 15.04.12).pdf`: local time, dots instead of colons (Finder and Windows forbid `:`). */
export function originalCopyName(filePath: string, label: string, at: Date, attempt = 1): string {
	const ext = extname(filePath);
	const stem = basename(filePath, ext);
	const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
	const word = label.trim().replace(/[/\\:*?"<>|]/gu, "") || "original";
	return `${stem} (${word} ${stamp}${attempt > 1 ? ` ${attempt}` : ""})${ext}`;
}

/**
 * Saves a byte-identical copy of `filePath` next to it, before an AI edit, and returns the copy's path.
 * Never overwrites an existing file (a same-second second copy gets a ` 2`, ` 3`, … suffix).
 */
export function createOriginalCopier(options: OriginalCopyOptions): (filePath: string) => Promise<string> {
	return (filePath) =>
		options.withLock(filePath, async () => {
			const at = (options.now ?? (() => new Date()))();
			for (let attempt = 1; attempt <= 50; attempt += 1) {
				const target = join(dirname(filePath), originalCopyName(filePath, options.label(), at, attempt));
				try {
					await copyFile(filePath, target, constants.COPYFILE_EXCL);
					return target;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			throw new Error(`Could not find a free name for the original copy of ${basename(filePath)}.`);
		});
}
