/**
 * Evidence excerpt rendering, shared by the Inspector's Evidence half.
 *
 * Block/inline parsing lives in `state/answer-markdown`; this module is only the
 * React adapter, so the panel renders an excerpt with consistent markup. Images
 * an excerpt references render under their line; a relative link resolves
 * against the folder of the cited document.
 */

import type { ReactElement } from "react";
import { isImageOnlyLine, parseAnswerBlocks, parseInline, type AnswerBlock, type InlineSegment } from "../state/answer-markdown";
import { ImageRow, lineImages, type ImageActions } from "./AnswerImage";

/** Where an excerpt came from, for resolving and opening its images. */
export interface ExcerptImages {
	/** Folder of the cited document; null for datasource and web sources. */
	readonly folder: string | null;
	readonly actions: ImageActions;
}

/** One evidence excerpt, split into its markdown-ish blocks. */
export function EvidenceExcerpt({ text, images }: { readonly text: string; readonly images: ExcerptImages }): ReactElement {
	return (
		<>
			{parseAnswerBlocks(text).map((block, index) => (
				<EvidenceBlock key={`${index}`} block={block} images={images} />
			))}
		</>
	);
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
			<ImageRow images={figures} folder={images.folder} actions={images.actions} />
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
					<ImageRow images={lineImages(segments)} folder={images.folder} actions={images.actions} />
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
					<ImageRow images={lineImages(segments)} folder={images.folder} actions={images.actions} />
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
