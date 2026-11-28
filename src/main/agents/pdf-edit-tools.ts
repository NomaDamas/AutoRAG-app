import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	isPdfEditOperation,
	type PdfEditOperation,
	type PdfPageNumberFormat,
	type PdfPageNumberPosition,
} from "../../shared/document-editor-contract";
import type { PdfEditorIo } from "../pdf-editor-io";

function jsonResult(payload: unknown): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: undefined,
	};
}

export interface PdfAgentToolsInput {
	readonly targetPath: string;
	readonly pdfIo: PdfEditorIo;
	readonly cancelled: () => boolean;
	/** Whether the active LLM accepts image inputs; defaults to true. */
	readonly supportsImage?: boolean;
}

/**
 * First-class structured PDF tools for the `document-edit` agent.
 * Every mutation routes through the shared `PdfEditorIo` (the exact same
 * `pdf-lib` engine & per-file mutex the human UI toolbar uses), so simultaneous
 * human edits and AI edits serialize safely and live-sync immediately.
 */
export function createPdfAgentTools(input: PdfAgentToolsInput): readonly ToolDefinition[] {
	const { targetPath, pdfIo, cancelled } = input;
	const supportsImage = input.supportsImage !== false;
	const ensureLive = (): void => {
		if (cancelled()) throw new Error("The edit was cancelled.");
	};

	const pdfInspect = defineTool({
		name: "pdf_inspect",
		label: "Inspect PDF",
		description:
			"Inspect the target PDF: returns pageCount, size, metadata (title, author, subject, keywords), per-page dimensions/rotation/cropBox, and all AcroForm fields (name, kind, value, options, readOnly).",
		parameters: Type.Object({}),
		execute: async () => {
			ensureLive();
			const info = await pdfIo.inspect(targetPath);
			return jsonResult(info);
		},
	});

	const pdfRenderPage = defineTool({
		name: "pdf_render_page",
		label: "Render PDF Page Image",
		description:
			"Render one or more 1-based pages of the target PDF as PNG images directly into your visual context. Use this BEFORE layout-sensitive edits to see page layout, existing text/margins, and exact normalized 0..1 coordinates, and ALWAYS call it AFTER applying visual/layout edits to perform Visual QA (checking for overlap, clipping, misalignment, readability, or incomplete coverage).",
		parameters: Type.Object({
			pages: Type.Array(Type.Integer({ minimum: 1 }), {
				minItems: 1,
				maxItems: 6,
				description: "1-based page numbers to render visually (max 6 per call), e.g. [1] or [1, 2].",
			}),
			dpi: Type.Optional(
				Type.Integer({
					minimum: 72,
					maximum: 220,
					description: "Render resolution in DPI (default 144; use 180-200 for small text or dense forms).",
				}),
			),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const uniquePages = [...new Set(params.pages as readonly number[])].slice(0, 6);
			const rendered = [];
			for (const pageNumber of uniquePages) {
				ensureLive();
				rendered.push(
					await pdfIo.renderPageToPng(targetPath, pageNumber, {
						...(params.dpi === undefined ? {} : { dpi: params.dpi }),
					}),
				);
			}
			const summary = {
				pageCount: rendered[0]?.pageCount ?? 0,
				coordinateSystem: "normalized 0..1 from top-left (x=0 left edge, x=1 right edge, y=0 top edge, y=1 bottom edge)",
				imagesAttached: supportsImage,
				pages: rendered.map((r) => ({
					pageNumber: r.pageNumber,
					pageIndex: r.pageIndex,
					widthPt: r.widthPt,
					heightPt: r.heightPt,
					rotation: r.rotation,
					imageWidthPx: r.imageWidthPx,
					imageHeightPx: r.imageHeightPx,
				})),
				...(supportsImage
					? {}
					: { note: "The active model does not accept image inputs; rendered page metadata is returned without PNG image blocks." }),
			};
			const content: AgentToolResult<undefined>["content"] = [
				{ type: "text", text: JSON.stringify(summary, null, 2) },
				...(supportsImage
					? rendered.map((r) => ({
							type: "image" as const,
							data: r.png.toString("base64"),
							mimeType: "image/png",
						}))
					: []),
			];
			return { content, details: undefined };
		},
	});

	const pdfApplyOps = defineTool({
		name: "pdf_apply_ops",
		label: "Apply PDF Edits",
		description: [
			"Apply one or more Acrobat-style edit operations atomically to the target PDF via Dazzi's shared PDF engine (safe for concurrent human editing and automatically live-reloads the editor).",
			"Supported operation kinds (all spatial coordinates are top-left normalized 0..1 fractions of the visible page, and pageIndex is 0-based):",
			'- { kind: "rotatePage", pageIndex, deltaDegrees: 90 | -90 | 180 | 270 }',
			'- { kind: "deletePage", pageIndex }',
			'- { kind: "movePage", fromIndex, toIndex }',
			'- { kind: "duplicatePage", pageIndex }',
			'- { kind: "insertBlankPage", insertAtIndex, size?: "match" | "a4" | "letter" }',
			'- { kind: "cropPage", pageIndex, left, top, width, height }',
			'- { kind: "mergePdfs", sourcePaths: string[], insertAtIndex? }',
			'- { kind: "highlightRect", pageIndex, x, y, width, height, color: "#FDE047", opacity?: 0.35 }',
			'- { kind: "redactRect", pageIndex, x, y, width, height, color: "#000000" | "#FFFFFF" }',
			'- { kind: "drawShape", pageIndex, shape: "rect" | "ellipse" | "line" | "arrow", x1, y1, x2, y2, strokeColor: "#DC2626", strokeWidthPt: 2, fillColor?, opacity? }',
			'- { kind: "freehandPath", pageIndex, points: [{x, y}, ...], strokeColor, strokeWidthPt, opacity? }',
			'- { kind: "addText", pageIndex, text, x, y, fontSize?: 14, color?: "#1D1D1F" } (Latin/ASCII text)',
			'- { kind: "addTextWatermark", text, color?: "#64748B", opacity?: 0.22, angleDegrees?: 35, fontSize?: 54, pageIndices? } (Latin/ASCII diagonal watermark)',
			'- { kind: "addPageNumbers", position: "bottom-center"|"bottom-right"|"bottom-left"|"top-center"|"top-right"|"top-left", format: "number"|"ofTotal"|"dash", startNumber: 1, fontSize: 10, color: "#334155", headerText?, footerText?, pageIndices? }',
			'- { kind: "setMetadata", metadata: { title, author, subject, keywords } }',
			'- { kind: "flattenForm" }',
			'- { kind: "stampImage", pageIndex, pngDataUrl: "data:image/png;base64,...", x, y, width, height, opacity? } (use for CJK/Korean text stamps or custom images)',
		].join("\n"),
		parameters: Type.Object({
			operations: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
				minItems: 1,
				maxItems: 200,
				description: "Ordered list of PdfEditOperation objects to apply atomically.",
			}),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const rawOps = params.operations as readonly unknown[];
			const ops: PdfEditOperation[] = [];
			for (let i = 0; i < rawOps.length; i += 1) {
				const candidate = rawOps[i];
				if (!isPdfEditOperation(candidate)) {
					throw new Error(`Invalid PDF operation at index ${i}: ${JSON.stringify(candidate)}`);
				}
				ops.push(candidate);
			}
			const result = await pdfIo.apply({ path: targetPath, operations: ops, force: true }, "ai");
			if (!result.ok) {
				throw new Error("PDF edit failed due to conflict.");
			}
			return jsonResult({
				ok: true,
				appliedCount: ops.length,
				pageCount: result.pageCount,
				size: result.size,
				modifiedAt: result.modifiedAt,
			});
		},
	});

	const pdfFillForm = defineTool({
		name: "pdf_fill_form",
		label: "Fill PDF Form",
		description:
			"Fill AcroForm fields on the target PDF by field name (string for text/dropdown/radio, boolean for checkbox). Optionally flatten the form so fields become permanent non-editable content.",
		parameters: Type.Object({
			values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean()]), {
				description: "Map of AcroForm field name to value (string or boolean).",
			}),
			flatten: Type.Optional(Type.Boolean({ description: "If true, flatten the form after filling so fields are locked." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const result = await pdfIo.saveFormFields(
				{
					path: targetPath,
					values: params.values as Record<string, string | boolean>,
					...(params.flatten === undefined ? {} : { flatten: params.flatten }),
					force: true,
				},
				"ai",
			);
			if (!result.ok) {
				throw new Error("Saving PDF form fields failed.");
			}
			return jsonResult({
				ok: true,
				pageCount: result.pageCount,
				size: result.size,
				flattened: params.flatten === true,
			});
		},
	});

	const pdfExtractPages = defineTool({
		name: "pdf_extract_pages",
		label: "Extract PDF Pages",
		description: "Extract specific 1-based page numbers from the target PDF into a new sibling PDF file without modifying the original.",
		parameters: Type.Object({
			pages: Type.Array(Type.Integer({ minimum: 1 }), {
				minItems: 1,
				maxItems: 2000,
				description: "1-based page numbers to extract, e.g. [1, 3, 4].",
			}),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const result = await pdfIo.extract({ path: targetPath, pages: params.pages });
			return jsonResult(result);
		},
	});

	const pdfSplit = defineTool({
		name: "pdf_split",
		label: "Split PDF",
		description:
			"Split the target PDF into multiple sibling PDF files without modifying the original. Supports mode='everyN' (with chunkSize), mode='ranges' (with rangesSpec like '1-2, 3-5'), or mode='singlePages'.",
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("everyN"), Type.Literal("ranges"), Type.Literal("singlePages")]),
			chunkSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			rangesSpec: Type.Optional(Type.String({ description: "1-based page ranges separated by commas, e.g. '1-2, 3-5'." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const result = await pdfIo.split({
				path: targetPath,
				mode: params.mode,
				...(params.chunkSize === undefined ? {} : { chunkSize: params.chunkSize }),
				...(params.rangesSpec === undefined ? {} : { rangesSpec: params.rangesSpec }),
			});
			return jsonResult(result);
		},
	});

	const pdfSetMetadata = defineTool({
		name: "pdf_set_metadata",
		label: "Set PDF Properties",
		description: "Update the PDF document properties (title, author, subject, keywords). Any omitted field keeps its current value.",
		parameters: Type.Object({
			title: Type.Optional(Type.String()),
			author: Type.Optional(Type.String()),
			subject: Type.Optional(Type.String()),
			keywords: Type.Optional(Type.String()),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const current = await pdfIo.readMetadata(targetPath);
			const next = {
				title: params.title ?? current.title,
				author: params.author ?? current.author,
				subject: params.subject ?? current.subject,
				keywords: params.keywords ?? current.keywords,
			};
			const result = await pdfIo.apply({ path: targetPath, operations: [{ kind: "setMetadata", metadata: next }], force: true }, "ai");
			if (!result.ok) throw new Error("Failed to update PDF metadata.");
			return jsonResult({ ok: true, metadata: next });
		},
	});

	const pdfAddPageNumbers = defineTool({
		name: "pdf_add_page_numbers",
		label: "Add PDF Page Numbers",
		description: "Stamp page numbers (and optional Latin/ASCII header/footer) onto pages of the target PDF.",
		parameters: Type.Object({
			position: Type.Optional(
				Type.Union([
					Type.Literal("bottom-center"),
					Type.Literal("bottom-right"),
					Type.Literal("bottom-left"),
					Type.Literal("top-center"),
					Type.Literal("top-right"),
					Type.Literal("top-left"),
				]),
			),
			format: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("ofTotal"), Type.Literal("dash")])),
			startNumber: Type.Optional(Type.Integer({ minimum: 1 })),
			fontSize: Type.Optional(Type.Number({ minimum: 6, maximum: 36 })),
			color: Type.Optional(Type.String({ description: "Hex color like #334155" })),
			headerText: Type.Optional(Type.String()),
			footerText: Type.Optional(Type.String()),
			pageIndices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { description: "Optional 0-based page indices; omit for all pages." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const op: PdfEditOperation = {
				kind: "addPageNumbers",
				position: (params.position ?? "bottom-center") as PdfPageNumberPosition,
				format: (params.format ?? "ofTotal") as PdfPageNumberFormat,
				startNumber: params.startNumber ?? 1,
				fontSize: params.fontSize ?? 10,
				color: params.color ?? "#334155",
				...(params.headerText === undefined ? {} : { headerText: params.headerText }),
				...(params.footerText === undefined ? {} : { footerText: params.footerText }),
				...(params.pageIndices === undefined ? {} : { pageIndices: params.pageIndices }),
			};
			const result = await pdfIo.apply({ path: targetPath, operations: [op], force: true }, "ai");
			if (!result.ok) throw new Error("Failed to add page numbers.");
			return jsonResult({ ok: true, pageCount: result.pageCount });
		},
	});

	return [
		pdfInspect,
		pdfRenderPage,
		pdfApplyOps,
		pdfFillForm,
		pdfExtractPages,
		pdfSplit,
		pdfSetMetadata,
		pdfAddPageNumbers,
	] as unknown as ToolDefinition[];
}
