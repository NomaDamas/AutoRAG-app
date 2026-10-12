/**
 * Evidence excerpt rendering, shared by the Inspector's Evidence half.
 *
 * A chunk is cut out of a parsed document, so it may hold markdown, HTML rows
 * with no table around them, or a pipe table without its header.
 * `state/excerpt-format` detects and repairs each part; block/inline markdown
 * parsing lives in `state/answer-markdown`. This module is only the React
 * adapter. HTML goes through the same allowlist sanitizer as the Quick Look
 * markdown preview before it reaches the DOM. Images an excerpt references
 * render under their line; a relative link resolves against the folder of the
 * cited document.
 */

import { useMemo, type MouseEvent, type ReactElement } from "react";
import { sanitizeMarkdownHtml } from "../../../preview/ui/markdown-html";
import { webUrl } from "../../../shared/fs-contract";
import { isImageOnlyLine, parseAnswerBlocks, parseInline, type AnswerBlock, type InlineSegment } from "../state/answer-markdown";
import { splitExcerpt, type ExcerptPart } from "../state/excerpt-format";
import { ImageRow, lineImages, type ImageActions } from "./AnswerImage";

/** Where an excerpt came from, for resolving and opening its images. */
export interface ExcerptImages {
	/** Folder of the cited document; null for datasource and web sources. */
	readonly folder: string | null;
	readonly actions: ImageActions;
}

/** Narrow-column table: scrolls sideways instead of crushing its columns. */
const TABLE_WRAP = "evidence__table-wrap max-w-full overflow-x-auto rounded-6 border border-border bg-window";
const TABLE =
	"min-w-full border-collapse text-badge leading-[1.45] text-ink-body break-keep [overflow-wrap:anywhere] [&_td]:min-w-[64px] [&_th]:min-w-[64px] [&_td]:align-top [&_th]:align-top [&_td]:py-4 [&_th]:py-4 [&_td]:px-8 [&_th]:px-8 [&_td]:border-b [&_th]:border-b [&_td]:border-r [&_th]:border-r [&_td]:border-border [&_th]:border-border [&_td:last-child]:border-r-0 [&_th:last-child]:border-r-0 [&_tr:last-child>td]:border-b-0 [&_th]:bg-code [&_th]:font-semibold [&_th]:text-ink [&_th]:text-left [&_strong]:text-ink [&_strong]:font-semibold";
/** Flow content of chunk HTML, sized like the markdown blocks around it. */
const HTML_FLOW =
	"evidence__block evidence__block--html flex flex-col gap-6 min-w-0 text-caption leading-read text-ink-body text-pretty [&_p]:m-0 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0 [&_h4]:m-0 [&_h5]:m-0 [&_h6]:m-0 [&_h1]:text-body [&_h2]:text-body [&_h3]:text-body [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h1]:text-ink [&_h2]:text-ink [&_h3]:text-ink [&_ul]:m-0 [&_ol]:m-0 [&_ul]:pl-18 [&_ol]:pl-18 [&_ul]:list-disc [&_ol]:list-decimal [&_blockquote]:m-0 [&_blockquote]:pl-10 [&_blockquote]:text-ink-muted [&_blockquote]:shadow-[inset_2px_0_0_var(--border)] [&_pre]:m-0 [&_pre]:py-8 [&_pre]:px-10 [&_pre]:rounded-6 [&_pre]:bg-code [&_pre]:border [&_pre]:border-border [&_pre]:overflow-auto [&_pre]:font-mono [&_pre]:text-badge [&_code]:font-mono [&_code]:text-badge [&_a[href]]:text-accent-text [&_a[href]]:underline [&_a[href]]:cursor-pointer [&_img]:max-w-full [&_img]:rounded-6 [&_hr]:border-0 [&_hr]:h-px [&_hr]:bg-border [&_strong]:text-ink [&_strong]:font-semibold [&_b]:text-ink [&_b]:font-semibold";

/** One evidence excerpt, rendered part by part in the format each part was written in. */
export function EvidenceExcerpt({ text, images }: { readonly text: string; readonly images: ExcerptImages }): ReactElement {
	const parts = useMemo(() => splitExcerpt(text), [text]);
	return (
		<>
			{parts.map((part, index) => (
				<ExcerptPartView key={`${index}`} part={part} images={images} />
			))}
		</>
	);
}

function ExcerptPartView({ part, images }: { readonly part: ExcerptPart; readonly images: ExcerptImages }): ReactElement {
	switch (part.kind) {
		case "html":
			return <HtmlPart html={part.html} images={images} />;
		case "table":
			return (
				<div className={`evidence__block evidence__block--table ${TABLE_WRAP}`}>
					<table className={TABLE}>
						{part.header === null ? null : (
							<thead>
								<tr>
									{part.header.map((cell, column) => (
										<th key={`${column}`} style={{ textAlign: part.align[column] ?? "left" }}>
											{renderInline(parseInline(cell))}
										</th>
									))}
								</tr>
							</thead>
						)}
						<tbody>
							{part.rows.map((row, line) => (
								<tr key={`${line}`}>
									{row.map((cell, column) => (
										<td key={`${column}`} style={part.align[column] == null ? undefined : { textAlign: part.align[column] }}>
											{renderInline(parseInline(cell))}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		default:
			return (
				<>
					{parseAnswerBlocks(part.text).map((block, index) => (
						<EvidenceBlock key={`${index}`} block={block} images={images} />
					))}
				</>
			);
	}
}

/**
 * Sanitized chunk HTML. Tables get the same scrolling frame as pipe tables.
 * A link never navigates the Finder window: an http(s) link opens in the OS
 * browser, like a web evidence source; anything else stays inert.
 */
function HtmlPart({ html, images }: { readonly html: string; readonly images: ExcerptImages }): ReactElement {
	const safe = useMemo(() => {
		const clean = sanitizeMarkdownHtml(html, images.folder);
		return clean.replaceAll("<table>", `<div class="${TABLE_WRAP}"><table class="${TABLE}">`).replaceAll("</table>", "</table></div>");
	}, [html, images.folder]);
	const onClick = (event: MouseEvent<HTMLDivElement>): void => {
		const link = event.target instanceof Element ? event.target.closest("a") : null;
		if (link === null) return;
		event.preventDefault();
		const url = webUrl(link.getAttribute("href") ?? "");
		if (url !== null) images.actions.onOpenUrl(url);
	};
	return <div className={HTML_FLOW} onClick={onClick} dangerouslySetInnerHTML={{ __html: safe }} />;
}

/** Render one line of inline markdown: text, **bold**, `code`, [n] cites, and image references as written. */
export function renderInline(segments: readonly InlineSegment[]): readonly ReactElement[] {
	return segments.map((segment, index) => <InlineSegmentView key={`${index}`} segment={segment} />);
}

/** A line of inline markdown followed by the images it references. */
export function InlineWithImages({
	text,
	className,
	images,
}: {
	readonly text: string;
	readonly className: string;
	readonly images: ExcerptImages;
}): ReactElement {
	const segments = parseInline(text);
	const figures = lineImages(segments);
	const line = <div className={className}>{renderInline(segments)}</div>;
	if (figures.length === 0) return line;
	return (
		<>
			{isImageOnlyLine(segments) ? null : line}
			<ImageRow images={figures} folder={images.folder} captioned actions={images.actions} />
		</>
	);
}

function EvidenceBlock({ block, images }: { readonly block: AnswerBlock; readonly images: ExcerptImages }): ReactElement {
	switch (block.kind) {
		case "heading": {
			const segments = parseInline(block.text);
			return (
				<>
					<div className="evidence__block evidence__block--heading text-body font-semibold text-ink pt-4 [&_strong]:text-ink [&_strong]:font-semibold">
						<span className="evidence__block-prefix text-ink-muted font-regular">## </span>
						{renderInline(segments)}
					</div>
					<ImageRow images={lineImages(segments)} folder={images.folder} captioned actions={images.actions} />
				</>
			);
		}
		case "list": {
			const segments = parseInline(block.text);
			return (
				<>
					<div className="evidence__block evidence__block--list flex gap-8 text-caption leading-read text-ink-body [&_strong]:text-ink [&_strong]:font-semibold">
						<span className="evidence__block-prefix text-ink-muted font-regular [.evidence\_\_block--list_&]:flex-none">–</span>
						<span>{renderInline(segments)}</span>
					</div>
					<ImageRow images={lineImages(segments)} folder={images.folder} captioned actions={images.actions} />
				</>
			);
		}
		case "quote":
			return <InlineWithImages text={block.text} images={images} className="evidence__block evidence__block--quote text-caption leading-read text-ink-muted pl-10 shadow-[inset_2px_0_0_var(--border)] [&_strong]:text-ink [&_strong]:font-semibold" />;
		case "code":
			return <pre className="evidence__block evidence__block--code m-0 font-mono text-badge leading-read text-ink-body py-8 px-10 rounded-6 bg-code border border-border overflow-auto whitespace-pre [&_strong]:text-ink [&_strong]:font-semibold">{block.text}</pre>;
		default:
			return <InlineWithImages text={block.text} images={images} className="evidence__block evidence__block--paragraph text-caption leading-read text-ink-body text-pretty [&_strong]:text-ink [&_strong]:font-semibold" />;
	}
}

function InlineSegmentView({ segment }: { readonly segment: InlineSegment }): ReactElement | null {
	switch (segment.kind) {
		case "bold":
			return <strong>{segment.text}</strong>;
		case "code":
			return <code className="evidence__inline-code py-[1px] px-4 rounded-4 bg-code font-mono text-badge">{segment.text}</code>;
		case "citation":
			return <>{`[${segment.number}]`}</>;
		case "image":
			// A markdown image is shown below its line; a written path stays as text.
			if (segment.source === "markdown") return null;
			return segment.source === "code" ? (
				<code className="evidence__inline-code py-[1px] px-4 rounded-4 bg-code font-mono text-badge break-all">{segment.target}</code>
			) : (
				<span className="break-all">{segment.target}</span>
			);
		default:
			return <>{segment.text}</>;
	}
}
