import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import type {
	PdfFormField,
	PdfMetadata,
	PdfPageNumberFormat,
	PdfPageNumberPosition,
	PdfSplitRequest,
} from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";

/** Renders arbitrary text (including Korean/CJK/emoji) to a crisp transparent PNG for pdf-lib embedding. */
export function renderTextStampPng(
	text: string,
	fontSizePx = 28,
	color = "#1D1D1F",
): { readonly dataUrl: string; readonly aspect: number } {
	const lines = text.split("\n");
	const dpr = 3;
	const padX = 10;
	const padY = 6;
	const lineHeight = Math.round(fontSizePx * 1.3);
	const measureCanvas = document.createElement("canvas");
	const mctx = measureCanvas.getContext("2d")!;
	const font = `500 ${fontSizePx}px "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
	mctx.font = font;
	const maxWidth = Math.max(40, ...lines.map((line) => Math.ceil(mctx.measureText(line || " ").width)));
	const logicalW = maxWidth + padX * 2;
	const logicalH = lines.length * lineHeight + padY * 2;

	const canvas = document.createElement("canvas");
	canvas.width = logicalW * dpr;
	canvas.height = logicalH * dpr;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);
	ctx.font = font;
	ctx.fillStyle = color;
	ctx.textBaseline = "top";
	lines.forEach((line, idx) => {
		ctx.fillText(line, padX, padY + idx * lineHeight);
	});
	return { dataUrl: canvas.toDataURL("image/png"), aspect: logicalW / logicalH };
}

/** Local calendar date as YYYY-MM-DD (stamps and the "Today" button). */
export function todayIso(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The Stamp menu's presets; the AI agent's `pdf_add_stamp` uses the same table, so both look identical. */
export const PRESET_STAMPS = [
	{ id: "approved", labelKey: "documentEditor.pdf.stampApproved", color: "#15803D" },
	{ id: "confidential", labelKey: "documentEditor.pdf.stampConfidential", color: "#B91C1C" },
	{ id: "draft", labelKey: "documentEditor.pdf.stampDraft", color: "#475569" },
	{ id: "reviewed", labelKey: "documentEditor.pdf.stampReviewed", color: "#1D4ED8" },
	{ id: "urgent", labelKey: "documentEditor.pdf.stampUrgent", color: "#C2410C" },
] as const;

/** Watermark quick picks; labels follow the app language (the AI agent's `pdf_add_watermark` presets use the same table). */
export const WATERMARK_PRESETS = [
	{ id: "confidential", labelKey: "documentEditor.pdf.stampConfidential" },
	{ id: "draft", labelKey: "documentEditor.pdf.stampDraft" },
	{ id: "copy", labelKey: "documentEditor.pdf.watermarkPresetCopy" },
	{ id: "sample", labelKey: "documentEditor.pdf.watermarkPresetSample" },
] as const;

/** Font stack shared by on-canvas text/note boxes and their committed PNGs, so both wrap identically. */
export const BOX_FONT_FAMILY = '"Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const BOX_LINE_HEIGHT = 1.32;
/** Inner padding (PDF points) of a plain text box. */
export const TEXT_BOX_PAD = { x: 4, y: 3 } as const;
/** Inner padding (PDF points) and corner radius of a sticky-note card. */
export const NOTE_BOX_PAD = { x: 10, y: 8 } as const;
export const NOTE_BOX_RADIUS = 5;

export type NotePaletteId = "yellow" | "pink" | "blue" | "green";

export interface NotePalette {
	readonly id: NotePaletteId;
	readonly fill: string;
	readonly stroke: string;
	readonly ink: string;
}

export const NOTE_PALETTES: readonly NotePalette[] = [
	{ id: "yellow", fill: "#FEF3A0", stroke: "#E2C33F", ink: "#3F2E06" },
	{ id: "pink", fill: "#FBD5E5", stroke: "#E39BBC", ink: "#4A1630" },
	{ id: "blue", fill: "#D6E8FD", stroke: "#93BDEB", ink: "#10304F" },
	{ id: "green", fill: "#D5F2D9", stroke: "#8FCB9A", ink: "#123A1C" },
];

export function notePalette(id: NotePaletteId): NotePalette {
	return NOTE_PALETTES.find((palette) => palette.id === id) ?? NOTE_PALETTES[0]!;
}

/**
 * Word-aware wrapping that mirrors the on-canvas textarea (`white-space: pre-wrap;
 * word-break: keep-all; overflow-wrap: anywhere`): lines break at spaces, and only a
 * word wider than the box is split between characters. Works for Korean/CJK/Latin.
 */
export function wrapBoxText(measure: (text: string) => number, text: string, maxWidth: number): string[] {
	const fits = (candidate: string): boolean => measure(candidate.trimEnd()) <= maxWidth;
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw === "") {
			lines.push("");
			continue;
		}
		const tokens = raw.match(/\S+\s*|\s+/gu) ?? [raw];
		let curr = "";
		for (const token of tokens) {
			if (fits(curr + token)) {
				curr += token;
				continue;
			}
			if (curr.trim() !== "") {
				lines.push(curr.trimEnd());
				curr = "";
			}
			if (fits(token)) {
				curr = token;
				continue;
			}
			for (const ch of token) {
				if (curr !== "" && !fits(curr + ch)) {
					lines.push(curr.trimEnd());
					curr = /\s/u.test(ch) ? "" : ch;
				} else {
					curr += ch;
				}
			}
		}
		lines.push(curr.trimEnd());
	}
	return lines;
}

function wrapWithFont(text: string, font: string, maxWidth: number): string[] {
	const mctx = document.createElement("canvas").getContext("2d");
	if (mctx === null) return text.split("\n");
	mctx.font = font;
	return wrapBoxText((candidate) => mctx.measureText(candidate).width, text, maxWidth);
}

/**
 * Renders a Keynote / PowerPoint-style on-canvas text box into a crisp 3x-DPI
 * transparent PNG whose logical width matches `boxWidthPt` (PDF points) and whose
 * line wrapping matches the on-canvas textarea (supports Korean/CJK/emoji).
 */
export function renderTextBoxPng(
	text: string,
	boxWidthPt: number,
	fontSizePt = 16,
	color = "#1D1D1F",
): { readonly dataUrl: string; readonly widthPt: number; readonly heightPt: number } {
	const dpr = 3;
	const logicalW = Math.max(40, Math.round(boxWidthPt));
	const lineHeight = fontSizePt * BOX_LINE_HEIGHT;
	const font = `500 ${fontSizePt}px ${BOX_FONT_FAMILY}`;
	const wrapped = wrapWithFont(text, font, Math.max(20, logicalW - TEXT_BOX_PAD.x * 2));
	const lineCount = Math.max(1, wrapped.length);
	const logicalH = Math.ceil(lineCount * lineHeight + TEXT_BOX_PAD.y * 2);

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(logicalW * dpr));
	canvas.height = Math.max(1, Math.round(logicalH * dpr));
	const ctx = canvas.getContext("2d");
	if (ctx !== null) {
		ctx.scale(dpr, dpr);
		ctx.font = font;
		ctx.fillStyle = color;
		ctx.textBaseline = "top";
		wrapped.forEach((line, idx) => {
			ctx.fillText(line, TEXT_BOX_PAD.x, TEXT_BOX_PAD.y + idx * lineHeight);
		});
	}
	return { dataUrl: canvas.toDataURL("image/png"), widthPt: logicalW, heightPt: logicalH };
}

/**
 * Renders one line of text (any script) tightly into a transparent PNG sized in PDF points, for page-number
 * headers and footers that standard PDF fonts cannot draw (Korean, Japanese, Chinese…).
 */
export function renderTextLinePng(
	text: string,
	fontSizePt: number,
	color: string,
): { readonly dataUrl: string; readonly widthPt: number; readonly heightPt: number } {
	const dpr = 4;
	const font = `500 ${fontSizePt}px ${BOX_FONT_FAMILY}`;
	const line = text.replace(/\s+/gu, " ").trim();
	const mctx = document.createElement("canvas").getContext("2d");
	let measured = line.length * fontSizePt * 0.6;
	if (mctx !== null) {
		mctx.font = font;
		measured = mctx.measureText(line).width;
	}
	const pad = 1;
	const widthPt = Math.max(1, Math.ceil(measured + pad * 2));
	const heightPt = Math.ceil(fontSizePt * BOX_LINE_HEIGHT);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(widthPt * dpr));
	canvas.height = Math.max(1, Math.round(heightPt * dpr));
	const ctx = canvas.getContext("2d");
	if (ctx !== null) {
		ctx.scale(dpr, dpr);
		ctx.font = font;
		ctx.fillStyle = color;
		ctx.textBaseline = "middle";
		ctx.fillText(line, pad, heightPt / 2);
	}
	return { dataUrl: canvas.toDataURL("image/png"), widthPt, heightPt };
}

/**
 * Renders an on-canvas sticky-note card (colored fill, hairline border, rounded corners)
 * into a crisp 3x-DPI PNG matching the box the person placed and typed into: same width,
 * same wrapping, and at least the height they dragged out.
 */
export function renderNoteBoxPng(
	text: string,
	boxWidthPt: number,
	fontSizePt: number,
	palette: NotePalette,
	minHeightPt = 0,
): { readonly dataUrl: string; readonly widthPt: number; readonly heightPt: number } {
	const dpr = 3;
	const logicalW = Math.max(60, Math.round(boxWidthPt));
	const lineHeight = fontSizePt * BOX_LINE_HEIGHT;
	const font = `500 ${fontSizePt}px ${BOX_FONT_FAMILY}`;
	const wrapped = wrapWithFont(text, font, Math.max(20, logicalW - NOTE_BOX_PAD.x * 2));
	const lineCount = Math.max(1, wrapped.length);
	const logicalH = Math.max(Math.ceil(minHeightPt), Math.ceil(lineCount * lineHeight + NOTE_BOX_PAD.y * 2));

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(logicalW * dpr));
	canvas.height = Math.max(1, Math.round(logicalH * dpr));
	const ctx = canvas.getContext("2d");
	if (ctx !== null) {
		ctx.scale(dpr, dpr);
		ctx.fillStyle = palette.fill;
		ctx.strokeStyle = palette.stroke;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(0.5, 0.5, logicalW - 1, logicalH - 1, NOTE_BOX_RADIUS);
		ctx.fill();
		ctx.stroke();
		ctx.font = font;
		ctx.fillStyle = palette.ink;
		ctx.textBaseline = "top";
		wrapped.forEach((line, idx) => {
			ctx.fillText(line, NOTE_BOX_PAD.x, NOTE_BOX_PAD.y + idx * lineHeight);
		});
	}
	return { dataUrl: canvas.toDataURL("image/png"), widthPt: logicalW, heightPt: logicalH };
}

/** Renders a rubber-stamp badge (e.g. APPROVED / CONFIDENTIAL) with double border into a crisp PNG. */
export function renderPresetStampPng(
	label: string,
	color: string,
	dateStr?: string,
): { readonly dataUrl: string; readonly aspect: number } {
	const dpr = 3;
	const padX = 24;
	const padY = 14;
	const titleFont = `800 32px "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
	const subFont = `600 13px "Pretendard Variable", -apple-system, BlinkMacSystemFont, sans-serif`;
	const measure = document.createElement("canvas").getContext("2d")!;
	measure.font = titleFont;
	const titleW = Math.ceil(measure.measureText(label).width);
	measure.font = subFont;
	const subW = dateStr ? Math.ceil(measure.measureText(dateStr).width) : 0;
	const logicalW = Math.max(150, titleW, subW) + padX * 2;
	const logicalH = (dateStr ? 64 : 46) + padY * 2;

	const canvas = document.createElement("canvas");
	canvas.width = logicalW * dpr;
	canvas.height = logicalH * dpr;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);

	// Subtle translucent fill + double rectangular stamp frame
	ctx.fillStyle = `${color}14`;
	ctx.strokeStyle = color;
	ctx.lineWidth = 3.5;
	ctx.beginPath();
	ctx.roundRect(4, 4, logicalW - 8, logicalH - 8, 8);
	ctx.fill();
	ctx.stroke();

	ctx.lineWidth = 1.25;
	ctx.beginPath();
	ctx.roundRect(9, 9, logicalW - 18, logicalH - 18, 5);
	ctx.stroke();

	ctx.fillStyle = color;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.font = titleFont;
	ctx.fillText(label, logicalW / 2, dateStr ? logicalH / 2 - 9 : logicalH / 2 + 1);
	if (dateStr) {
		ctx.font = subFont;
		ctx.fillText(dateStr, logicalW / 2, logicalH / 2 + 18);
	}
	return { dataUrl: canvas.toDataURL("image/png"), aspect: logicalW / logicalH };
}

/** Renders a rotated diagonal watermark PNG (supports Korean/CJK/Latin cleanly). */
export function renderWatermarkPng(
	text: string,
	color: string,
	angleDeg: number,
): string {
	const dpr = 2;
	const fontSize = 96;
	const font = `800 ${fontSize}px "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
	const measure = document.createElement("canvas").getContext("2d")!;
	measure.font = font;
	const tw = Math.max(120, Math.ceil(measure.measureText(text).width));
	const th = Math.ceil(fontSize * 1.25);

	const rad = (angleDeg * Math.PI) / 180;
	const cos = Math.abs(Math.cos(rad));
	const sin = Math.abs(Math.sin(rad));
	const rotW = Math.ceil(tw * cos + th * sin) + 40;
	const rotH = Math.ceil(tw * sin + th * cos) + 40;

	const canvas = document.createElement("canvas");
	canvas.width = rotW * dpr;
	canvas.height = rotH * dpr;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);
	ctx.translate(rotW / 2, rotH / 2);
	ctx.rotate(rad);
	ctx.font = font;
	ctx.fillStyle = color;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, 0, 0);
	return canvas.toDataURL("image/png");
}

function ModalShell({
	title,
	onClose,
	widthClass = "w-[440px]",
	children,
}: {
	readonly title: string;
	readonly onClose: () => void;
	readonly widthClass?: string;
	readonly children: ReactElement;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div className={cn("flex max-h-[85vh] max-w-[92vw] flex-col gap-12 rounded-modal-md border border-border bg-window p-16 shadow-xl", widthClass)}>
				<div className="flex items-center justify-between">
					<h3 className="m-0 text-body font-semibold text-ink">{title}</h3>
					<button
						type="button"
						aria-label={t("common.close")}
						className="flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink"
						onClick={onClose}
					>
						<X size={14} />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

export function WatermarkModal({
	selectedCount,
	onApply,
	onClose,
}: {
	readonly selectedCount: number;
	readonly onApply: (opts: {
		readonly text: string;
		readonly color: string;
		readonly opacity: number;
		readonly angle: number;
		readonly scale: number;
		readonly scope: "all" | "current" | "selected";
	}) => Promise<void>;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	// The default follows the app language (대외비 / CONFIDENTIAL / 社外秘 / 机密).
	const [text, setText] = useState(() => t("documentEditor.pdf.stampConfidential"));
	const [color, setColor] = useState("#64748B");
	const [opacity, setOpacity] = useState(0.22);
	const [angle, setAngle] = useState(-35);
	const [scale, setScale] = useState(0.65);
	const [scope, setScope] = useState<"all" | "current" | "selected">("all");
	const [submitting, setSubmitting] = useState(false);

	const submit = async (): Promise<void> => {
		if (text.trim() === "" || submitting) return;
		setSubmitting(true);
		try {
			await onApply({ text: text.trim(), color, opacity, angle, scale, scope });
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<ModalShell title={t("documentEditor.pdf.watermarkTitle")} onClose={onClose}>
			<div className="flex flex-col gap-12">
				<label className="flex flex-col gap-4 text-meta text-ink-muted">
					{t("documentEditor.pdf.watermarkText")}
					<input
						type="text"
						value={text}
						data-pdf-watermark-input="true"
						placeholder={t("documentEditor.pdf.watermarkPlaceholder")}
						className="h-30 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						onChange={(e) => setText(e.target.value)}
						autoFocus
					/>
				</label>

				<div className="flex flex-wrap items-center gap-6" role="group" aria-label={t("documentEditor.pdf.watermarkPresets")}>
					{WATERMARK_PRESETS.map((preset) => {
						const label = t(preset.labelKey);
						return (
							<button
								key={preset.id}
								type="button"
								data-pdf-watermark-preset={preset.id}
								aria-pressed={text === label}
								className={cn(
									"h-24 rounded-full border px-10 text-badge font-medium transition-colors",
									text === label ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink-body hover:bg-hover",
								)}
								onClick={() => setText(label)}
							>
								{label}
							</button>
						);
					})}
				</div>

				<div className="flex items-center gap-8">
					<span className="text-meta text-ink-muted">{t("documentEditor.pdf.strokeColor")}</span>
					{["#64748B", "#DC2626", "#2563EB", "#111827", "#16A34A"].map((c) => (
						<button
							key={c}
							type="button"
							aria-label={c}
							aria-pressed={color === c}
							className={cn("size-20 rounded-full border-2", color === c ? "scale-110 border-accent" : "border-border")}
							style={{ backgroundColor: c }}
							onClick={() => setColor(c)}
						/>
					))}
				</div>

				<div className="grid grid-cols-3 gap-10">
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						<span>
							{t("documentEditor.pdf.watermarkOpacity")} ({Math.round(opacity * 100)}%)
						</span>
						<input type="range" min={0.08} max={0.7} step={0.02} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						<span>
							{t("documentEditor.pdf.watermarkAngle")} ({angle}°)
						</span>
						<input type="range" min={-60} max={60} step={5} value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						<span>
							{t("documentEditor.pdf.watermarkScale")} ({Math.round(scale * 100)}%)
						</span>
						<input type="range" min={0.25} max={0.9} step={0.05} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
					</label>
				</div>

				<div className="flex flex-wrap items-center gap-6">
					<span className="text-meta text-ink-muted">{t("documentEditor.pdf.watermarkScope")}:</span>
					<button
						type="button"
						aria-pressed={scope === "all"}
						className={cn(
							"h-24 rounded-6 border px-8 text-badge font-medium",
							scope === "all" ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink",
						)}
						onClick={() => setScope("all")}
					>
						{t("documentEditor.pdf.scopeAllPages")}
					</button>
					<button
						type="button"
						aria-pressed={scope === "current"}
						className={cn(
							"h-24 rounded-6 border px-8 text-badge font-medium",
							scope === "current" ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink",
						)}
						onClick={() => setScope("current")}
					>
						{t("documentEditor.pdf.scopeCurrentPage")}
					</button>
					{selectedCount > 0 ? (
						<button
							type="button"
							aria-pressed={scope === "selected"}
							className={cn(
								"h-24 rounded-6 border px-8 text-badge font-medium",
								scope === "selected" ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink",
							)}
							onClick={() => setScope("selected")}
						>
							{t("documentEditor.pdf.scopeSelectedPages", { count: selectedCount })}
						</button>
					) : null}
				</div>

				<div className="flex justify-end gap-6 pt-4">
					<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						disabled={text.trim() === "" || submitting}
						data-pdf-watermark-apply="true"
						className="inline-flex h-28 items-center gap-4 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => void submit()}
					>
						{submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
						{t("documentEditor.pdf.applyWatermark")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

export function PageNumbersModal({
	onApply,
	onClose,
}: {
	readonly onApply: (opts: {
		readonly position: PdfPageNumberPosition;
		readonly format: PdfPageNumberFormat;
		readonly startNumber: number;
		readonly fontSize: number;
		readonly color: string;
		readonly headerText: string;
		readonly footerText: string;
	}) => Promise<void>;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [position, setPosition] = useState<PdfPageNumberPosition>("bottom-center");
	const [format, setFormat] = useState<PdfPageNumberFormat>("ofTotal");
	const [startNumber, setStartNumber] = useState(1);
	const [fontSize, setFontSize] = useState(10);
	const [color, setColor] = useState("#334155");
	const [headerText, setHeaderText] = useState("");
	const [footerText, setFooterText] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const positions: readonly { readonly id: PdfPageNumberPosition; readonly label: string }[] = [
		{ id: "top-left", label: t("documentEditor.pdf.posTopLeft") },
		{ id: "top-center", label: t("documentEditor.pdf.posTopCenter") },
		{ id: "top-right", label: t("documentEditor.pdf.posTopRight") },
		{ id: "bottom-left", label: t("documentEditor.pdf.posBottomLeft") },
		{ id: "bottom-center", label: t("documentEditor.pdf.posBottomCenter") },
		{ id: "bottom-right", label: t("documentEditor.pdf.posBottomRight") },
	];

	const submit = async (): Promise<void> => {
		if (submitting) return;
		setSubmitting(true);
		try {
			await onApply({
				position,
				format,
				startNumber: Math.max(1, Math.floor(startNumber) || 1),
				fontSize,
				color,
				headerText: headerText.trim(),
				footerText: footerText.trim(),
			});
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<ModalShell title={t("documentEditor.pdf.pageNumbersTitle")} onClose={onClose}>
			<div className="flex flex-col gap-12">
				<div className="flex flex-col gap-4">
					<span className="text-meta text-ink-muted">{t("documentEditor.pdf.pageNumberPosition")}</span>
					<div className="grid grid-cols-3 gap-6">
						{positions.map((pos) => (
							<button
								key={pos.id}
								type="button"
								aria-pressed={position === pos.id}
								className={cn(
									"h-26 rounded-6 border px-6 text-badge font-medium",
									position === pos.id ? "border-accent bg-accent-soft text-accent" : "border-border bg-window text-ink hover:bg-hover-row",
								)}
								onClick={() => setPosition(pos.id)}
							>
								{pos.label}
							</button>
						))}
					</div>
				</div>

				<div className="grid grid-cols-2 gap-10">
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.pageNumberFormat")}
						<select
							value={format}
							onChange={(e) => setFormat(e.target.value as PdfPageNumberFormat)}
							className="h-28 rounded-6 border border-border bg-window px-8 text-body text-ink"
						>
							<option value="number">{t("documentEditor.pdf.fmtNumber")}</option>
							<option value="ofTotal">{t("documentEditor.pdf.fmtOfTotal")}</option>
							<option value="dash">{t("documentEditor.pdf.fmtDash")}</option>
						</select>
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.startNumber")}
						<input
							type="number"
							min={1}
							max={10000}
							value={startNumber}
							onChange={(e) => setStartNumber(Math.max(1, Number(e.target.value) || 1))}
							className="h-28 rounded-6 border border-border bg-window px-8 text-body text-ink"
						/>
					</label>
				</div>

				<div className="grid grid-cols-2 gap-10">
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						<span>
							{t("documentEditor.pdf.textSize")} ({fontSize}pt)
						</span>
						<input type="range" min={8} max={20} step={1} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
					</label>
					<div className="flex flex-col gap-4 text-meta text-ink-muted">
						<span>{t("documentEditor.pdf.strokeColor")}</span>
						<div className="flex items-center gap-6 pt-2">
							{["#334155", "#111827", "#64748B", "#1D4ED8"].map((c) => (
								<button
									key={c}
									type="button"
									aria-label={c}
									aria-pressed={color === c}
									className={cn("size-18 rounded-full border-2", color === c ? "scale-110 border-accent" : "border-border")}
									style={{ backgroundColor: c }}
									onClick={() => setColor(c)}
								/>
							))}
						</div>
					</div>
				</div>

				<label className="flex flex-col gap-4 text-meta text-ink-muted">
					{t("documentEditor.pdf.headerText")}
					<input
						type="text"
						value={headerText}
						data-pdf-page-numbers-header="true"
						onChange={(e) => setHeaderText(e.target.value)}
						className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
					/>
				</label>
				<label className="flex flex-col gap-4 text-meta text-ink-muted">
					{t("documentEditor.pdf.footerText")}
					<input
						type="text"
						value={footerText}
						data-pdf-page-numbers-footer="true"
						onChange={(e) => setFooterText(e.target.value)}
						className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
					/>
				</label>

				<div className="flex justify-end gap-6 pt-4">
					<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						disabled={submitting}
						data-pdf-page-numbers-apply="true"
						className="inline-flex h-28 items-center gap-4 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => void submit()}
					>
						{submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
						{t("documentEditor.pdf.applyPageNumbers")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

export function SplitPdfModal({
	totalPages,
	onRunSplit,
	onClose,
}: {
	readonly totalPages: number;
	readonly onRunSplit: (request: Omit<PdfSplitRequest, "path">) => Promise<void>;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [mode, setMode] = useState<PdfSplitRequest["mode"]>("everyN");
	const [chunkSize, setChunkSize] = useState(Math.max(1, Math.ceil(totalPages / 2)));
	const [rangesSpec, setRangesSpec] = useState(totalPages >= 2 ? `1-${Math.ceil(totalPages / 2)}, ${Math.ceil(totalPages / 2) + 1}-${totalPages}` : "1");
	const [submitting, setSubmitting] = useState(false);

	const submit = async (): Promise<void> => {
		if (submitting) return;
		setSubmitting(true);
		try {
			await onRunSplit(
				mode === "everyN"
					? { mode, chunkSize: Math.max(1, chunkSize) }
					: mode === "ranges"
						? { mode, rangesSpec: rangesSpec.trim() }
						: { mode: "singlePages" },
			);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<ModalShell title={t("documentEditor.pdf.splitTitle")} onClose={onClose}>
			<div className="flex flex-col gap-12">
				<div className="flex flex-col gap-6">
					<label className="flex cursor-pointer items-center gap-8 text-body text-ink">
						<input type="radio" name="split-mode" checked={mode === "everyN"} onChange={() => setMode("everyN")} />
						{t("documentEditor.pdf.splitModeEveryN")}
					</label>
					{mode === "everyN" ? (
						<div className="flex items-center gap-8 pl-20">
							<span className="text-meta text-ink-muted">{t("documentEditor.pdf.splitChunkSize")}</span>
							<input
								type="number"
								min={1}
								max={Math.max(1, totalPages)}
								value={chunkSize}
								onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))}
								className="h-26 w-72 rounded-6 border border-border bg-window px-8 text-body text-ink"
							/>
						</div>
					) : null}

					<label className="flex cursor-pointer items-center gap-8 text-body text-ink">
						<input type="radio" name="split-mode" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
						{t("documentEditor.pdf.splitModeRanges")}
					</label>
					{mode === "ranges" ? (
						<div className="pl-20">
							<input
								type="text"
								value={rangesSpec}
								data-pdf-split-ranges="true"
								placeholder={t("documentEditor.pdf.splitRangesPlaceholder")}
								onChange={(e) => setRangesSpec(e.target.value)}
								className="h-28 w-full rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
							/>
						</div>
					) : null}

					<label className="flex cursor-pointer items-center gap-8 text-body text-ink">
						<input type="radio" name="split-mode" checked={mode === "singlePages"} onChange={() => setMode("singlePages")} />
						{t("documentEditor.pdf.splitModeSingle")}
					</label>
				</div>

				<div className="flex justify-end gap-6 pt-4">
					<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						disabled={submitting || (mode === "ranges" && rangesSpec.trim() === "")}
						data-pdf-split-run="true"
						className="inline-flex h-28 items-center gap-4 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent disabled:opacity-40"
						onClick={() => void submit()}
					>
						{submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
						{t("documentEditor.pdf.splitRun")}
					</button>
				</div>
			</div>
		</ModalShell>
	);
}

export function PdfPropertiesModal({
	path,
	onSave,
	onClose,
}: {
	readonly path: string;
	readonly onSave: (metadata: PdfMetadata) => Promise<void>;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [loading, setLoading] = useState(true);
	const [title, setTitle] = useState("");
	const [author, setAuthor] = useState("");
	const [subject, setSubject] = useState("");
	const [keywords, setKeywords] = useState("");
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		window.autorag.documentEditor
			.pdfReadMetadata(path)
			.then((meta) => {
				if (cancelled) return;
				setTitle(meta.title);
				setAuthor(meta.author);
				setSubject(meta.subject);
				setKeywords(meta.keywords);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const submit = async (): Promise<void> => {
		if (submitting) return;
		setSubmitting(true);
		try {
			await onSave({ title, author, subject, keywords });
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<ModalShell title={t("documentEditor.pdf.propertiesTitle")} onClose={onClose}>
			{loading ? (
				<div className="flex items-center justify-center gap-8 py-24 text-meta text-ink-muted">
					<Loader2 size={14} className="animate-spin" />
					{t("documentEditor.loading")}
				</div>
			) : (
				<div className="flex flex-col gap-10">
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.propTitle")}
						<input
							type="text"
							value={title}
							data-pdf-prop-title="true"
							onChange={(e) => setTitle(e.target.value)}
							className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						/>
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.propAuthor")}
						<input
							type="text"
							value={author}
							data-pdf-prop-author="true"
							onChange={(e) => setAuthor(e.target.value)}
							className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						/>
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.propSubject")}
						<input
							type="text"
							value={subject}
							data-pdf-prop-subject="true"
							onChange={(e) => setSubject(e.target.value)}
							className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						/>
					</label>
					<label className="flex flex-col gap-4 text-meta text-ink-muted">
						{t("documentEditor.pdf.propKeywords")}
						<input
							type="text"
							value={keywords}
							data-pdf-prop-keywords="true"
							onChange={(e) => setKeywords(e.target.value)}
							className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
						/>
					</label>
					<div className="flex justify-end gap-6 pt-4">
						<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={submitting}
							data-pdf-prop-save="true"
							className="inline-flex h-28 items-center gap-4 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent disabled:opacity-40"
							onClick={() => void submit()}
						>
							{submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
							{t("documentEditor.pdf.propSave")}
						</button>
					</div>
				</div>
			)}
		</ModalShell>
	);
}

export function PdfFormsModal({
	path,
	onSave,
	onClose,
}: {
	readonly path: string;
	readonly onSave: (values: Readonly<Record<string, string | boolean>>, flatten: boolean) => Promise<void>;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [loading, setLoading] = useState(true);
	const [fields, setFields] = useState<readonly PdfFormField[]>([]);
	const [values, setValues] = useState<Record<string, string | boolean>>({});
	const [flatten, setFlatten] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		window.autorag.documentEditor
			.pdfReadFormFields(path)
			.then((loaded) => {
				if (cancelled) return;
				setFields(loaded);
				const initial: Record<string, string | boolean> = {};
				for (const f of loaded) initial[f.name] = f.value;
				setValues(initial);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const updateField = useCallback((name: string, next: string | boolean) => {
		setValues((curr) => ({ ...curr, [name]: next }));
	}, []);

	const submit = async (): Promise<void> => {
		if (submitting || fields.length === 0) return;
		setSubmitting(true);
		try {
			await onSave(values, flatten);
		} finally {
			setSubmitting(false);
		}
	};

	const mountedRef = useRef(true);
	useEffect(() => () => { mountedRef.current = false; }, []);

	return (
		<ModalShell title={t("documentEditor.pdf.formsTitle")} onClose={onClose} widthClass="w-[500px]">
			{loading ? (
				<div className="flex items-center justify-center gap-8 py-24 text-meta text-ink-muted">
					<Loader2 size={14} className="animate-spin" />
					{t("documentEditor.loading")}
				</div>
			) : fields.length === 0 ? (
				<div className="flex flex-col gap-12">
					<p className="m-0 text-body leading-[1.5] text-ink-muted">{t("documentEditor.pdf.formsEmpty")}</p>
					<div className="flex justify-end">
						<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
							{t("common.close")}
						</button>
					</div>
				</div>
			) : (
				<div className="flex min-h-0 flex-col gap-12">
					<div className="flex max-h-[48vh] flex-col gap-10 overflow-y-auto pr-4">
						{fields.map((field) => (
							<div key={field.name} className="flex flex-col gap-4">
								{field.kind === "checkbox" ? (
									<label className="inline-flex cursor-pointer items-center gap-8 text-body text-ink">
										<input
											type="checkbox"
											disabled={field.readOnly}
											data-pdf-form-field={field.name}
											checked={Boolean(values[field.name])}
											onChange={(e) => updateField(field.name, e.target.checked)}
											className="size-14 accent-accent"
										/>
										<span>{field.name}</span>
									</label>
								) : field.kind === "dropdown" || field.kind === "radio" ? (
									<label className="flex flex-col gap-4 text-meta text-ink-muted">
										{field.name}
										<select
											disabled={field.readOnly}
											data-pdf-form-field={field.name}
											value={String(values[field.name] ?? "")}
											onChange={(e) => updateField(field.name, e.target.value)}
											className="h-28 rounded-6 border border-border bg-window px-8 text-body text-ink"
										>
											<option value="">—</option>
											{(field.options ?? []).map((opt) => (
												<option key={opt} value={opt}>
													{opt}
												</option>
											))}
										</select>
									</label>
								) : (
									<label className="flex flex-col gap-4 text-meta text-ink-muted">
										{field.name}
										<input
											type="text"
											disabled={field.readOnly}
											data-pdf-form-field={field.name}
											value={String(values[field.name] ?? "")}
											onChange={(e) => updateField(field.name, e.target.value)}
											className="h-28 rounded-6 border border-border bg-window px-10 text-body text-ink outline-none focus:border-accent"
										/>
									</label>
								)}
							</div>
						))}
					</div>

					<label className="inline-flex cursor-pointer items-center gap-6 text-meta text-ink-muted select-none">
						<input
							type="checkbox"
							checked={flatten}
							data-pdf-form-flatten="true"
							onChange={(e) => setFlatten(e.target.checked)}
							className="size-13 accent-accent"
						/>
						{t("documentEditor.pdf.formsFlatten")}
					</label>

					<div className="flex justify-end gap-6 pt-2">
						<button type="button" className="h-28 rounded-7 border border-border bg-window px-12 text-meta text-ink" onClick={onClose}>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={submitting}
							data-pdf-form-save="true"
							className="inline-flex h-28 items-center gap-4 rounded-7 border-0 bg-accent px-14 text-meta font-semibold text-on-accent disabled:opacity-40"
							onClick={() => void submit()}
						>
							{submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
							{t("documentEditor.pdf.formsSave")}
						</button>
					</div>
				</div>
			)}
		</ModalShell>
	);
}
