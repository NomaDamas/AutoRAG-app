/**
 * The "New File" document formats shared by the main process (which writes the
 * template) and the renderer (which lists them in the New submenu).
 *
 * The catalog is the single source of truth for both sides: the renderer never
 * hard-codes a label or extension, and the main process rejects any id outside
 * the list, so the menu can never offer a file the service cannot write.
 */

export type NewFileFormatId = "text" | "markdown" | "rtf" | "word" | "excel" | "powerpoint";

export interface NewFileFormat {
	readonly id: NewFileFormatId;
	/** Menu label, e.g. "Word 문서". */
	readonly label: string;
	/** Lowercase extension without the dot. */
	readonly extension: string;
}

export const NEW_FILE_FORMATS: readonly NewFileFormat[] = [
	{ id: "text", label: "텍스트 파일", extension: "txt" },
	{ id: "markdown", label: "Markdown 문서", extension: "md" },
	{ id: "rtf", label: "서식 있는 텍스트", extension: "rtf" },
	{ id: "word", label: "Word 문서", extension: "docx" },
	{ id: "excel", label: "Excel 스프레드시트", extension: "xlsx" },
	{ id: "powerpoint", label: "PowerPoint 프레젠테이션", extension: "pptx" },
];

export function newFileFormat(id: NewFileFormatId): NewFileFormat {
	const format = NEW_FILE_FORMATS.find((candidate) => candidate.id === id);
	if (format === undefined) {
		throw new Error(`알 수 없는 파일 형식입니다: ${id}`);
	}
	return format;
}

/** Narrows an untrusted IPC payload to a catalog format id. */
export function isNewFileFormatId(value: unknown): value is NewFileFormatId {
	return typeof value === "string" && NEW_FILE_FORMATS.some((format) => format.id === value);
}
