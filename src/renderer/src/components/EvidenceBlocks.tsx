/**
 * Evidence excerpt rendering, shared by the Inspector's Evidence half.
 *
 * Block/inline parsing lives in `state/answer-markdown`; this module is only the
 * React adapter, so the panel renders an excerpt with consistent markup.
 */

import type { ReactElement } from "react";
import { parseAnswerBlocks, parseInline, type AnswerBlock, type InlineSegment } from "../state/answer-markdown";

/** One evidence excerpt, split into its markdown-ish blocks. */
export function EvidenceExcerpt({ text }: { readonly text: string }): ReactElement {
	return (
		<>
			{parseAnswerBlocks(text).map((block, index) => (
				<EvidenceBlock key={`${index}`} block={block} />
			))}
		</>
	);
}

/** Render one line of inline markdown: text, **bold**, `code`, and [n] cites. */
export function renderInline(text: string): readonly ReactElement[] {
	return parseInline(text).map((segment, index) => <InlineSegment key={`${index}`} segment={segment} />);
}

function EvidenceBlock({ block }: { readonly block: AnswerBlock }): ReactElement {
	switch (block.kind) {
		case "heading":
			return (
				<div className="evidence__block evidence__block--heading text-body font-semibold text-ink pt-4 [&_strong]:text-ink [&_strong]:font-semibold">
					<span className="evidence__block-prefix text-ink-muted font-regular">## </span>
					{renderInline(block.text)}
				</div>
			);
		case "list":
			return (
				<div className="evidence__block evidence__block--list flex gap-8 text-caption leading-read text-ink-body [&_strong]:text-ink [&_strong]:font-semibold">
					<span className="evidence__block-prefix text-ink-muted font-regular [.evidence\_\_block--list_&]:flex-none">–</span>
					<span>{renderInline(block.text)}</span>
				</div>
			);
		case "quote":
			return <div className="evidence__block evidence__block--quote text-caption leading-read text-ink-muted pl-10 shadow-[inset_2px_0_0_var(--border)] [&_strong]:text-ink [&_strong]:font-semibold">{renderInline(block.text)}</div>;
		case "code":
			return <pre className="evidence__block evidence__block--code m-0 font-mono text-badge leading-read text-ink-body py-8 px-10 rounded-6 bg-code border border-border overflow-auto whitespace-pre [&_strong]:text-ink [&_strong]:font-semibold">{block.text}</pre>;
		default:
			return <div className="evidence__block evidence__block--paragraph text-caption leading-read text-ink-body text-pretty [&_strong]:text-ink [&_strong]:font-semibold">{renderInline(block.text)}</div>;
	}
}

function InlineSegment({ segment }: { readonly segment: InlineSegment }): ReactElement {
	if (segment.kind === "bold") {
		return <strong>{segment.text}</strong>;
	}
	if (segment.kind === "code") {
		return <code className="evidence__inline-code py-[1px] px-4 rounded-4 bg-code font-mono text-badge">{segment.text}</code>;
	}
	return <>{segment.kind === "citation" ? `[${segment.number}]` : segment.text}</>;
}
