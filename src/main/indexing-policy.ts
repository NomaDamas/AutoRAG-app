import type { CliConfig } from "@autorag/librarian/core";
import { isJsonObject } from "../shared/settings-contract";
import { isCalendarDatasourceEntry } from "./calendar-mcp";

/**
 * Indexing features the app never runs, pinned off in every config it hands to
 * the librarian, whatever the shared config file says. The file itself is left
 * alone: the CLI and TUI keep reading their own settings.
 *
 * - OCR. `parserOptions.ocr.enabled` is the librarian's single OCR opt-in: on,
 *   kordoc claims image files (png/jpg/jpeg/webp) and OCRs scanned pages, with
 *   Tesseract injected for languages kordoc's built-in PP-OCRv5 cannot read.
 *   Pinned off, no image is parsed and scanned pages are left unrecognized. An
 *   explicit `parserOptions.kordoc.ocr` still applies to scanned pages.
 * - Jikji's media index. `jikji.enableMediaIndex` only records file facts
 *   (pixel size, bytes, format) for photos and videos, nothing about their
 *   content, so it adds cost without making any media searchable.
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

/** The Jikji block with the media index pinned off; `false` (Jikji disabled) and an absent block stay as they are. */
export function withMediaIndexDisabled(jikji: CliConfig["jikji"]): CliConfig["jikji"] {
	if (jikji === false || jikji === undefined) return jikji;
	return { ...jikji, enableMediaIndex: false };
}

/** The same config with Tesseract off for local files and every datasource connector, and Jikji's media index off. */
export function withIndexingPoliciesApplied(config: CliConfig): CliConfig {
	const datasources =
		config.datasources === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(config.datasources)
						.filter(([id, entry]) => !isCalendarDatasourceEntry(id, entry))
						.map(([id, entry]) => [id, withConnectorOcrDisabled(entry)]),
				);
	const jikji = withMediaIndexDisabled(config.jikji);
	return {
		...config,
		parserOptions: parserOptionsWithoutOcr(config.parserOptions),
		...(datasources === undefined ? {} : { datasources }),
		...(jikji === undefined ? {} : { jikji }),
	};
}
