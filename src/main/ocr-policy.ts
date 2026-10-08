import type { CliConfig } from "@autorag/librarian/core";
import { isJsonObject } from "../shared/settings-contract";

/**
 * The app never runs the librarian's Tesseract OCR. `parserOptions.ocr.enabled`
 * is what registers the image OCR parser (png/jpg/...) and swaps kordoc's own
 * OCR for Tesseract, so it is pinned off in every config the app hands to the
 * librarian, whatever the shared config file says. The file itself is left
 * alone: the CLI and TUI keep reading their own setting.
 *
 * Only Tesseract is switched off. kordoc's built-in PP-OCRv5, which reads scan
 * pages when its model is cached, is a separate engine and stays as configured.
 */

/** `parserOptions` with `ocr.enabled` pinned to false and every other option kept. */
function parserOptionsWithoutOcr(parserOptions: Record<string, unknown> | undefined): Record<string, unknown> {
	const options = parserOptions ?? {};
	const ocr = isJsonObject(options.ocr) ? options.ocr : {};
	return { ...options, ocr: { ...ocr, enabled: false } };
}

/**
 * A datasource entry whose connector parses downloaded documents (cloud drive)
 * carries its own `parserOptions`; an entry without them already runs with no
 * OCR and is returned as is.
 */
export function withConnectorOcrDisabled<T>(entry: T): T {
	if (!isJsonObject(entry) || !isJsonObject(entry.connector) || !isJsonObject(entry.connector.parserOptions)) return entry;
	return { ...entry, connector: { ...entry.connector, parserOptions: parserOptionsWithoutOcr(entry.connector.parserOptions) } };
}

/** The same config with Tesseract off for local files and for every datasource connector. */
export function withOcrDisabled(config: CliConfig): CliConfig {
	const datasources =
		config.datasources === undefined
			? undefined
			: Object.fromEntries(Object.entries(config.datasources).map(([id, entry]) => [id, withConnectorOcrDisabled(entry)]));
	return {
		...config,
		parserOptions: parserOptionsWithoutOcr(config.parserOptions),
		...(datasources === undefined ? {} : { datasources }),
	};
}
