import { parse as kordocParse } from "kordoc";
import type { KordocParseFn } from "@autorag/librarian";

/**
 * Per-file time budget for parsing. A file that spends longer than this is
 * skipped (the librarian records it as `parser-failed` and moves on) instead of
 * holding the whole index run, and onboarding with it, forever.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 180_000;

/**
 * kordoc's own `parse`, matching the librarian's default (plain markdown for
 * indexing). The librarian does not export its default, so the app supplies the
 * same call here to be able to wrap it.
 */
export const kordocDefaultParse: KordocParseFn = async (bytes, options) => {
	const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const result = await kordocParse(input, { plain: true, ...(options.ocr === undefined ? {} : { ocr: options.ocr }) });
	if (!result.success) return { success: false, fileType: result.fileType, error: result.error, ...(result.code === undefined ? {} : { code: result.code }) };
	return { success: true, fileType: result.fileType, markdown: result.markdown, ...(result.warnings === undefined ? {} : { warnings: result.warnings }) };
};

/**
 * Reject when `parse` has not settled within `timeoutMs`. The librarian turns
 * the rejection into a per-file skip. JavaScript cannot cancel the stuck call,
 * so it is abandoned, not killed; its result is discarded if it ever arrives.
 */
export function withFileTimeout(parse: KordocParseFn, timeoutMs: number): KordocParseFn {
	return async (bytes, options) => {
		const { promise, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error(`parsing timed out after ${timeoutMs}ms`)), timeoutMs);
		try {
			return await Promise.race([parse(bytes, options), promise]);
		} finally {
			clearTimeout(timer);
		}
	};
}
