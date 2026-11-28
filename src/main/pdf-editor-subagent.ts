import { isAbsolute } from "node:path";
import type { SubagentDefinition, SubagentResult } from "@autorag/librarian";
import type { DocumentEditEvent } from "../preview/shared/annotation";
import type { PdfAssetRequest, PdfAssetResult } from "../shared/document-editor-contract";
import type { DocumentEditService } from "./document-edit-service";

export const PDF_EDITOR_SUBAGENT_NAME = "pdf-editor";

/**
 * What the main AutoRAG agent is told about the PDF editor. Static on purpose: it is part of the cached tool
 * description and system prompt, so nothing per request (open tabs, selection, dates) may go in here.
 */
export const PDF_EDITOR_SUBAGENT_DESCRIPTION =
	"Edits a PDF file in place with Dazzi's PDF editor: highlight, redact/whiteout, shapes and arrows, freehand, Korean/CJK text boxes, sticky-note memos, approval/confidential stamps, images, watermarks, page numbers, form filling, metadata, and page rotate/move/delete/insert/merge/split/extract. It locates existing text itself and visually checks its result before reporting. Pass the PDF's absolute path in `files`.";

export const PDF_EDITOR_SUBAGENT_GUIDANCE = [
	"- Delegate every change to a PDF's content, pages, form fields or metadata to `pdf-editor`; never edit PDFs with `bash`, `write`, scripts or conversions.",
	"- Put the PDF's absolute path in `files` (find it first if the user only named it) and write `task` as the user's request plus anything you already know (page numbers, exact wording to mark, which image file to insert). One PDF per task; use `tasks` for several PDFs.",
	"- Stamps and watermark presets follow the app language automatically; pass custom text only when the user asked for specific wording.",
	"- Read-only questions about a PDF (what it says, where something is) do not need `pdf-editor`: search or read the document instead.",
	"- Relay the subagent's summary in the user's language and say which file changed. If it reports a failure, explain it; do not retry the same edit another way.",
].join("\n");

/** A quoted absolute path (may contain spaces), or an unquoted one up to whitespace. */
const QUOTED_PDF_PATH = /["'`“”]((?:\/|[A-Za-z]:\\)[^"'`“”\n]*?\.pdf)["'`“”]/giu;
const BARE_PDF_PATH = /(?:^|[\s(])((?:\/|[A-Za-z]:\\)[^\s"'`“”]*?\.pdf)(?=$|[\s),.;:!?])/giu;

/** The PDFs a task is about: absolute `.pdf` paths in `files`, else absolute `.pdf` paths written in the task. */
export function pdfTargets(task: string, files: readonly string[]): readonly string[] {
	const fromFiles = files.filter((file) => isAbsolute(file) && file.toLowerCase().endsWith(".pdf"));
	if (fromFiles.length > 0) return [...new Set(fromFiles)];
	const quoted = [...task.matchAll(QUOTED_PDF_PATH)].map((match) => match[1]!);
	const bare = [...task.replace(QUOTED_PDF_PATH, " ").matchAll(BARE_PDF_PATH)].map((match) => match[1]!);
	return [...new Set([...quoted, ...bare].filter((path) => isAbsolute(path)))];
}

export interface PdfEditorSubagentDeps {
	readonly service: Pick<DocumentEditService, "start" | "cancel">;
	/** Renders content / finds text through the Dazzi window (see `PdfAssetBridge`); undefined while it is closed. */
	readonly renderAsset?: (request: PdfAssetRequest, tag: string) => Promise<PdfAssetResult>;
	readonly makeRunId?: () => string;
}

/**
 * The PDF editor agent offered to the main AutoRAG agent as a host subagent. It runs the very same
 * `document-edit` PDF agent as the editor's right sidebar (structured tools, per-file lock, live sync into an
 * open editor tab, mandatory visual QA) and hands back its summary.
 */
export function createPdfEditorSubagent(deps: PdfEditorSubagentDeps): SubagentDefinition {
	const makeRunId = deps.makeRunId ?? (() => `subagent-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	return {
		name: PDF_EDITOR_SUBAGENT_NAME,
		description: PDF_EDITOR_SUBAGENT_DESCRIPTION,
		guidance: PDF_EDITOR_SUBAGENT_GUIDANCE,
		mutatesFiles: true,
		async run({ task, files }, { signal, onUpdate }): Promise<SubagentResult> {
			const targets = pdfTargets(task, files);
			if (targets.length === 0) {
				return { output: "No PDF to edit: give the PDF's absolute path in `files`.", isError: true };
			}
			const reports: string[] = [];
			const changedFiles: string[] = [];
			let failed = false;
			for (const path of targets) {
				if (signal?.aborted === true) {
					reports.push(`${path}: cancelled before it started.`);
					failed = true;
					break;
				}
				const runId = makeRunId();
				let reply = "";
				let error: string | null = null;
				let cancelled = false;
				const send = (event: DocumentEditEvent): void => {
					if (event.runId !== runId) return;
					if (event.type === "progress" && event.text.trim() !== "") onUpdate?.(event.text);
					else if (event.type === "done") reply = event.reply;
					else if (event.type === "error") error = event.message;
					else if (event.type === "cancelled") cancelled = true;
				};
				const onAbort = (): void => void deps.service.cancel(runId);
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const outcome = await deps.service.start(
						runId,
						{ path, instruction: task, marks: [] },
						{
							send,
							screenshot: async () => null,
							...(deps.renderAsset === undefined ? {} : { renderAsset: (request: PdfAssetRequest) => deps.renderAsset!(request, runId) }),
						},
					);
					if (outcome.changed) changedFiles.push(path);
					if (cancelled) {
						failed = true;
						reports.push(`${path}: cancelled${outcome.changed ? " (some edits were already saved)" : ""}.`);
					} else if (error !== null) {
						failed = true;
						reports.push(`${path}: failed — ${error}`);
					} else {
						reports.push(`${path}: ${outcome.changed ? "edited" : "not changed"}.${reply.trim() === "" ? "" : `\n${reply.trim()}`}`);
					}
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			}
			return { output: reports.join("\n\n"), isError: failed && changedFiles.length === 0, changedFiles };
		},
	};
}
