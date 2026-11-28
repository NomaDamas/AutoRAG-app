import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extname, isAbsolute } from "node:path";
import {
	isPdfEditOperation,
	PDF_NOTE_COLORS,
	PDF_STAMP_PRESETS,
	type PdfAssetRequest,
	type PdfAssetResult,
	type PdfEditOperation,
	type PdfNoteColor,
	type PdfPageNumberFormat,
	type PdfPageNumberPosition,
	type PdfStampPreset,
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
	/** Renders content / finds text through the open editor (same renderers as the toolbar); without it those tools are absent. */
	readonly renderAsset?: (request: PdfAssetRequest) => Promise<PdfAssetResult>;
	/** The profile's read fence (credentials and Dazzi's private folders stay off limits). */
	readonly guardRead?: (path: string) => Promise<void>;
}

const INSERTABLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "heic", "heif", "tif", "tiff"]);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

/** Bounds of a match's line boxes. */
function unionBox(rects: readonly { x: number; y: number; width: number; height: number }[]) {
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}

/**
 * The ellipse to circle text with. An ellipse the size of the text box cuts through its corners; it must
 * satisfy (w/rx)² + (h/ry)² ≤ 1 for half-sizes w, h. Of those, pick the one that overshoots the text by the
 * same distance (in points) on both axes, so a phrase in a line is not circled far into its neighbors,
 * then add a little air. Page size converts between normalized units and points.
 */
export function enclosingEllipse(
	box: { x: number; y: number; width: number; height: number },
	page: { widthPt: number; heightPt: number },
	round: (n: number) => number = (n) => n,
) {
	const w = Math.max(0.5, (box.width * page.widthPt) / 2);
	const h = Math.max(0.5, (box.height * page.heightPt) / 2);
	const kyFor = (kx: number): number => 1 / Math.sqrt(1 - 1 / (kx * kx));
	let lo = 1.0001;
	let hi = 50;
	for (let i = 0; i < 60; i += 1) {
		const mid = (lo + hi) / 2;
		if ((mid - 1) * w > (kyFor(mid) - 1) * h) hi = mid;
		else lo = mid;
	}
	const AIR_PT = 3;
	const rx = (hi * w + AIR_PT) / page.widthPt;
	const ry = (kyFor(hi) * h + AIR_PT) / page.heightPt;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const clamp = (n: number) => Math.min(1, Math.max(0, n));
	return { x1: round(clamp(cx - rx)), y1: round(clamp(cy - ry)), x2: round(clamp(cx + rx)), y2: round(clamp(cy + ry)) };
}

const unit = (description: string) => Type.Number({ minimum: 0, maximum: 1, description });
const VERIFY_HINT = "Call pdf_render_page on this page now to visually verify placement (no overlap with existing text, nothing clipped).";

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
			'- { kind: "drawShape", pageIndex, shape: "rect" | "ellipse" | "line" | "arrow", x1, y1, x2, y2, strokeColor: "#DC2626", strokeWidthPt: 2, fillColor?, opacity? } — rect/ellipse: (x1,y1)-(x2,y2) is the bounding box (to circle text use the `ellipse` returned by pdf_find_text — a box-sized ellipse would cut through the corners of the text); line/arrow: (x1,y1) is the tail and (x2,y2) the tip (end the tip just outside the target so it does not cover it). Omit fillColor for outlines.',
			'- { kind: "freehandPath", pageIndex, points: [{x, y}, ...], strokeColor, strokeWidthPt, opacity? }',
			'- { kind: "addText", pageIndex, text, x, y, fontSize?: 14, color?: "#1D1D1F" } (Latin/ASCII only — use pdf_add_text_box for Korean or any wrapped text)',
			'- { kind: "addTextWatermark", text, color?: "#64748B", opacity?: 0.22, angleDegrees?: 35, fontSize?: 54, pageIndices? } (Latin/ASCII only — use pdf_add_watermark for Korean)',
			'- { kind: "addPageNumbers", position: "bottom-center"|"bottom-right"|"bottom-left"|"top-center"|"top-right"|"top-left", format: "number"|"ofTotal"|"dash", startNumber: 1, fontSize: 10, color: "#334155", headerText?, footerText?, pageIndices? }',
			'- { kind: "setMetadata", metadata: { title, author, subject, keywords } }',
			'- { kind: "flattenForm" }',
			'- { kind: "stampImage", pageIndex, pngDataUrl: "data:image/png;base64,...", x, y, width, height, opacity? } (raw PNG; prefer pdf_add_text_box / pdf_add_note / pdf_add_stamp / pdf_insert_image)',
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

	const contentTools: ToolDefinition[] = [];
	const renderAsset = input.renderAsset;
	if (renderAsset !== undefined) {
		const pngOf = async (request: PdfAssetRequest) => {
			const result = await renderAsset(request);
			if (result.kind !== "png") throw new Error("The editor returned no image for this content.");
			return result;
		};
		/** Stamps a rendered PNG at (x, y) with `widthFraction`; height follows the PNG's aspect on this page. */
		const place = async (pageIndex: number, x: number, y: number, widthFraction: number, png: { dataUrl: string; aspect: number }) => {
			const size = await pdfIo.pageVisualSize(targetPath, pageIndex);
			const width = Math.min(1 - x, widthFraction);
			const height = Math.min(1 - y, (width * size.widthPt) / Math.max(0.01, png.aspect) / size.heightPt);
			const result = await pdfIo.apply(
				{ path: targetPath, operations: [{ kind: "stampImage", pageIndex, pngDataUrl: png.dataUrl, x, y, width, height }], force: true },
				"ai",
			);
			if (!result.ok) throw new Error("PDF edit failed due to conflict.");
			const r3 = (n: number) => Math.round(n * 1000) / 1000;
			return { ok: true, pageIndex, placedBox: { x: r3(x), y: r3(y), width: r3(width), height: r3(height) }, next: VERIFY_HINT };
		};
		const pageWidthPt = async (pageIndex: number, widthFraction: number): Promise<number> =>
			(await pdfIo.pageVisualSize(targetPath, pageIndex)).widthPt * widthFraction;

		contentTools.push(
			defineTool({
				name: "pdf_find_text",
				label: "Find Text in PDF",
				description:
					"Find every occurrence of a word or phrase in the PDF (case-insensitive, same engine as Dazzi's Find bar) and return its exact location as normalized 0..1 boxes (top-left origin, page as viewed). Each hit has `box` (the text's bounds), `rects` (per line), and `ellipse` ({x1,y1,x2,y2} for drawShape) sized so an ellipse fully clears the text's corners — use it as-is to circle the text. Use this tool before highlighting, circling, underlining, pointing an arrow at, redacting, or placing a note next to existing text, instead of guessing coordinates.",
				parameters: Type.Object({
					query: Type.String({ minLength: 1, description: "Text to find, e.g. 'Account SSN' or '계약 기간'." }),
					pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Optional 1-based pages to search; omit for all pages." })),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					const result = await renderAsset({
						kind: "findText",
						path: targetPath,
						query: params.query,
						...(params.pages === undefined ? {} : { pages: params.pages }),
					});
					if (result.kind !== "textHits") throw new Error("The editor returned no text search result.");
					const r4 = (n: number) => Math.round(n * 10000) / 10000;
					const pageSizes = new Map<number, { widthPt: number; heightPt: number }>();
					for (const hit of result.hits.slice(0, 60)) {
						if (!pageSizes.has(hit.pageIndex)) pageSizes.set(hit.pageIndex, await pdfIo.pageVisualSize(targetPath, hit.pageIndex));
					}
					const hits = result.hits.slice(0, 60).map((hit) => {
						const box = unionBox(hit.rects);
						return {
							pageNumber: hit.pageNumber,
							pageIndex: hit.pageIndex,
							box: { x: r4(box.x), y: r4(box.y), width: r4(box.width), height: r4(box.height) },
							ellipse: enclosingEllipse(box, pageSizes.get(hit.pageIndex)!, r4),
							rects: hit.rects.map((rect) => ({ x: r4(rect.x), y: r4(rect.y), width: r4(rect.width), height: r4(rect.height) })),
						};
					});
					return jsonResult({ query: params.query, matchCount: result.hits.length, hits });
				},
			}),
			defineTool({
				name: "pdf_add_text_box",
				label: "Add Text Box",
				description:
					"Place a text box on a page, exactly like the toolbar's Text tool. Supports Korean/CJK/emoji and multi-line text, wrapping inside `width`. (x, y) is the box's top-left corner in normalized 0..1 page coordinates; pageIndex is 0-based. Prefer this over pdf_apply_ops addText, which only supports Latin text.",
				parameters: Type.Object({
					pageIndex: Type.Integer({ minimum: 0 }),
					x: unit("Left edge, 0..1."),
					y: unit("Top edge, 0..1."),
					width: Type.Optional(Type.Number({ minimum: 0.03, maximum: 1, description: "Box width as a fraction of page width (default 0.4)." })),
					text: Type.String({ minLength: 1 }),
					fontSize: Type.Optional(Type.Number({ minimum: 6, maximum: 72, description: "Font size in points (default 14)." })),
					color: Type.Optional(Type.String({ description: "Hex color like #1D1D1F (default)." })),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					const widthFraction = params.width ?? 0.4;
					const color = params.color !== undefined && HEX_COLOR.test(params.color) ? params.color : "#1D1D1F";
					const png = await pngOf({
						kind: "textBox",
						text: params.text,
						widthPt: await pageWidthPt(params.pageIndex, Math.min(1 - params.x, widthFraction)),
						fontSizePt: params.fontSize ?? 14,
						color,
					});
					return jsonResult(await place(params.pageIndex, params.x, params.y, widthFraction, png));
				},
			}),
			defineTool({
				name: "pdf_add_note",
				label: "Add Sticky Note",
				description:
					"Stick a colored memo card (sticky note) on a page, exactly like the toolbar's Memo tool. Supports Korean/CJK and multi-line text. (x, y) is the card's top-left corner in normalized 0..1 page coordinates; pageIndex is 0-based. Put notes in margins or empty areas so they don't cover content.",
				parameters: Type.Object({
					pageIndex: Type.Integer({ minimum: 0 }),
					x: unit("Left edge, 0..1."),
					y: unit("Top edge, 0..1."),
					width: Type.Optional(Type.Number({ minimum: 0.08, maximum: 1, description: "Card width as a fraction of page width (default 0.3)." })),
					text: Type.String({ minLength: 1 }),
					color: Type.Optional(Type.Union(PDF_NOTE_COLORS.map((c) => Type.Literal(c)), { description: "Card color (default yellow)." })),
					fontSize: Type.Optional(Type.Number({ minimum: 8, maximum: 28, description: "Font size in points (default 13)." })),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					const widthFraction = params.width ?? 0.3;
					const png = await pngOf({
						kind: "note",
						text: params.text,
						widthPt: await pageWidthPt(params.pageIndex, Math.min(1 - params.x, widthFraction)),
						fontSizePt: params.fontSize ?? 13,
						noteColor: (params.color ?? "yellow") as PdfNoteColor,
					});
					return jsonResult(await place(params.pageIndex, params.x, params.y, widthFraction, png));
				},
			}),
			defineTool({
				name: "pdf_add_stamp",
				label: "Add Stamp",
				description:
					"Place a rubber-stamp badge, exactly like the toolbar's Stamp menu. Use a preset (approved, confidential, draft, reviewed, urgent — labels follow the app language) or a custom `text` (Korean OK) with an optional hex `color`. Adds today's date under the label unless includeDate is false. (x, y) is the top-left corner in normalized 0..1 page coordinates; pageIndex is 0-based.",
				parameters: Type.Object({
					pageIndex: Type.Integer({ minimum: 0 }),
					x: unit("Left edge, 0..1."),
					y: unit("Top edge, 0..1."),
					width: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1, description: "Stamp width as a fraction of page width (default 0.25)." })),
					preset: Type.Optional(Type.Union(PDF_STAMP_PRESETS.map((p) => Type.Literal(p)))),
					text: Type.Optional(Type.String({ minLength: 1, description: "Custom stamp label instead of a preset." })),
					color: Type.Optional(Type.String({ description: "Hex color for a custom stamp, e.g. #B91C1C." })),
					includeDate: Type.Optional(Type.Boolean()),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					if (params.preset === undefined && params.text === undefined) throw new Error("Give either a preset or a custom text for the stamp.");
					const png = await pngOf({
						kind: "stamp",
						...(params.preset === undefined ? {} : { preset: params.preset as PdfStampPreset }),
						...(params.text === undefined ? {} : { label: params.text }),
						...(params.color !== undefined && HEX_COLOR.test(params.color) ? { color: params.color } : {}),
						withDate: params.includeDate !== false,
					});
					return jsonResult(await place(params.pageIndex, params.x, params.y, params.width ?? 0.25, png));
				},
			}),
			defineTool({
				name: "pdf_insert_image",
				label: "Insert Image",
				description:
					"Insert a local image file (PNG, JPEG, WebP, GIF, BMP, SVG, TIFF, HEIC) onto a page, exactly like the toolbar's Image button. Transparent backgrounds stay transparent. (x, y) is the top-left corner in normalized 0..1 page coordinates; height follows the image's aspect ratio; pageIndex is 0-based.",
				parameters: Type.Object({
					path: Type.String({ minLength: 1, description: "Absolute path to the image file." }),
					pageIndex: Type.Integer({ minimum: 0 }),
					x: unit("Left edge, 0..1."),
					y: unit("Top edge, 0..1."),
					width: Type.Optional(Type.Number({ minimum: 0.02, maximum: 1, description: "Image width as a fraction of page width (default 0.35)." })),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					if (!isAbsolute(params.path)) throw new Error("Give the image's absolute path.");
					if (!INSERTABLE_IMAGE_EXTENSIONS.has(extname(params.path).slice(1).toLowerCase())) {
						throw new Error(`Unsupported image type: ${extname(params.path) || "(none)"}.`);
					}
					await input.guardRead?.(params.path);
					const png = await pngOf({ kind: "image", path: params.path });
					return jsonResult(await place(params.pageIndex, params.x, params.y, params.width ?? 0.35, png));
				},
			}),
			defineTool({
				name: "pdf_add_watermark",
				label: "Add Watermark",
				description:
					"Add a diagonal text watermark (Korean/CJK supported), exactly like the toolbar's Watermark dialog, to all pages or to `pageIndices` (0-based). Prefer this over pdf_apply_ops addTextWatermark, which only supports Latin text.",
				parameters: Type.Object({
					text: Type.String({ minLength: 1 }),
					color: Type.Optional(Type.String({ description: "Hex color (default #64748B)." })),
					opacity: Type.Optional(Type.Number({ minimum: 0.03, maximum: 1, description: "Default 0.18." })),
					angleDegrees: Type.Optional(Type.Number({ minimum: -90, maximum: 90, description: "Default 35." })),
					scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 1.5, description: "Watermark width relative to the page (default 0.7)." })),
					pageIndices: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
				}),
				execute: async (_callId, params) => {
					ensureLive();
					const png = await pngOf({
						kind: "watermark",
						text: params.text,
						color: params.color !== undefined && HEX_COLOR.test(params.color) ? params.color : "#64748B",
						angleDeg: params.angleDegrees ?? 35,
					});
					const result = await pdfIo.apply(
						{
							path: targetPath,
							operations: [
								{
									kind: "addWatermark",
									pngDataUrl: png.dataUrl,
									opacity: params.opacity ?? 0.18,
									scale: params.scale ?? 0.7,
									...(params.pageIndices === undefined ? {} : { pageIndices: params.pageIndices }),
								},
							],
							force: true,
						},
						"ai",
					);
					if (!result.ok) throw new Error("PDF edit failed due to conflict.");
					return jsonResult({ ok: true, pageCount: result.pageCount, next: "Call pdf_render_page on one or two pages to verify the watermark." });
				},
			}),
		);
	}

	return [
		pdfInspect,
		pdfRenderPage,
		pdfApplyOps,
		pdfFillForm,
		pdfExtractPages,
		pdfSplit,
		pdfSetMetadata,
		pdfAddPageNumbers,
		...contentTools,
	] as unknown as ToolDefinition[];
}
