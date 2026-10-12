/**
 * The "New File" document formats shared by the main process (which writes the
 * template) and the renderer (which lists them in the New submenu).
 *
 * The catalog is the single source of truth for both sides: the renderer never
 * hard-codes a label or extension, and the main process rejects any id outside
 * the list, so the menu can never offer a file the service cannot write.
 */

import { t, type LocaleKey } from "./i18n/core";

export type NewFileFormatId = "text" | "markdown" | "rtf" | "word" | "excel" | "powerpoint";

export interface NewFileFormat {
	readonly id: NewFileFormatId;
	/** Locale key of the menu label. */
	readonly label: LocaleKey;
	/** Lowercase extension without the dot. */
	readonly extension: string;
}

export const NEW_FILE_FORMATS = [
	{ id: "text", label: "finderState.newFileFormats.text", extension: "txt" },
	{ id: "markdown", label: "finderState.newFileFormats.markdown", extension: "md" },
	{ id: "rtf", label: "finderState.newFileFormats.rtf", extension: "rtf" },
	{ id: "word", label: "finderState.newFileFormats.word", extension: "docx" },
	{ id: "excel", label: "finderState.newFileFormats.excel", extension: "xlsx" },
	{ id: "powerpoint", label: "finderState.newFileFormats.powerpoint", extension: "pptx" },
] as const satisfies readonly NewFileFormat[];

export function newFileFormat(id: NewFileFormatId): NewFileFormat {
	const format = NEW_FILE_FORMATS.find((candidate) => candidate.id === id);
	if (format === undefined) {
		throw new Error(t("finderState.newFileFormats.unknown", { id }));
	}
	return format;
}

/** Narrows an untrusted IPC payload to a catalog format id. */
export function isNewFileFormatId(value: unknown): value is NewFileFormatId {
	return typeof value === "string" && NEW_FILE_FORMATS.some((format) => format.id === value);
}
