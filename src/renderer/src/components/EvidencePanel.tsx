import { useState, type ReactElement } from "react";
import type { CitationEvidence, SearchBridge } from "../../../shared/search-contract";
import { parseAnswerBlocks, parseInline, type AnswerBlock, type InlineSegment } from "../state/answer-markdown";
import {
	evidenceCrumbs,
	evidenceDetail,
	evidenceKind,
	feedbackToastText,
	nextEvidenceFeedback,
	type EvidenceFeedback,
} from "../state/evidence";
import { cn } from "../lib/cn";
import { ChevronsUpIcon, EyeIcon, ThumbsDownIcon, ThumbsUpIcon } from "./icons";
import { FileTile } from "./primitives/FileTile";

const autorag = (window as unknown as { readonly autorag: { readonly search: SearchBridge } }).autorag;

export function EvidencePanel({
	evidence,
	sessionId,
	selected,
	open,
	onToggleOpen,
	onSelect,
	onQuickLook,
	onReveal,
	onToast,
}: {
	readonly evidence: readonly CitationEvidence[];
	readonly sessionId: string | null;
	readonly selected: number;
	readonly open: boolean;
	readonly onToggleOpen: () => void;
	readonly onSelect: (number: number) => void;
	readonly onQuickLook: (source: string) => void;
	readonly onReveal: (source: string) => void;
	readonly onToast: (text: string) => void;
}): ReactElement {
	const [votes, setVotes] = useState<Readonly<Record<string, EvidenceFeedback>>>({});
	const candidate = evidence.find((entry) => entry.number === selected) ?? evidence[0];
	if (candidate === undefined) {
		return <section className="evidence flex flex-col min-h-0 bg-subtle border-t border-border flex-[0_0_var(--evidence-open-height)]" aria-label="Evidence" hidden />;
	}
	const item = candidate;
	const voteKey = `${sessionId ?? "paused"}:${item.number}`;
	const vote = votes[voteKey] ?? null;

	function sendVote(pick: "up" | "down"): void {
		const next = nextEvidenceFeedback(vote, pick);
		setVotes((current) => ({ ...current, [voteKey]: next }));
		if (next === null || sessionId === null) return;
		void autorag.search
			.feedback(sessionId, next === "up" ? [item.number] : [], next === "down" ? [item.number] : [])
			.then(() => onToast(feedbackToastText(item.number, pick)))
			.catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error)));
	}

	return (
		<section className={cn("evidence flex flex-col min-h-0 bg-subtle border-t border-border", open ? "flex-[0_0_var(--evidence-open-height)]" : "evidence--closed flex-[0_0_auto]")} aria-label="Evidence">
			<div className="evidence__strip flex items-end h-ev-strip bg-chrome border-b border-border [.evidence--closed_&]:border-b-transparent">
				<div className="evidence__tabs flex-1 min-w-0 flex items-end gap-2 overflow-x-auto [scrollbar-width:none] pl-12">
					{evidence.map((entry) => (
						<button
							type="button"
							key={entry.number}
							title={entry.title}
							className={cn("evidence__tab flex-[0_0_auto] w-40 h-[30px] flex items-center justify-center border border-b-0 rounded-t-8 -mb-px text-caption font-semibold cursor-pointer transition-[background] duration-(--dur-color-slow) ease-[ease] hover:bg-hover", entry.number === item.number ? "evidence__tab--active bg-subtle text-ink border-border" : "bg-transparent text-ink-muted border-transparent")}
							onClick={() => onSelect(entry.number)}
						>
							{entry.number}
						</button>
					))}
				</div>
				<button
					type="button"
					className="evidence__toggle w-[44px] self-stretch flex-none flex items-center justify-center border-none bg-transparent text-ink-body cursor-pointer hover:bg-hover"
					title="Toggle evidence ⌘E"
					aria-label="Toggle evidence"
					onClick={onToggleOpen}
				>
					<ChevronsUpIcon className="transition-[transform] duration-(--dur-color-slow) ease-[ease] [.evidence--closed_&]:[transform:rotate(180deg)]" />
				</button>
			</div>
			{open ? (
				<div className="evidence__view flex-1 min-h-0 flex flex-col">
					<div className="evidence__header flex flex-col gap-6 pt-14 pr-16 pb-10 pl-20 flex-none">
						<div className="evidence__title-row flex items-center gap-10">
							<FileTile kind={evidenceKind(item.title)} size={22} />
							<span className="evidence__title flex-1 min-w-0 text-body font-semibold text-ink truncate">
								{item.number}. {item.title}
							</span>
							<div className="evidence__votes flex items-center gap-4 flex-none">
								<button
									type="button"
									title="이 근거가 도움이 됨"
									className={cn("evidence__vote size-row flex items-center justify-center border rounded-6 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:text-ink", vote === "up" ? "evidence__vote--up-on border-ok-border bg-ok-bg-soft text-ok-text" : "border-border bg-window text-ink-muted")}
									onClick={() => sendVote("up")}
								>
									<ThumbsUpIcon />
								</button>
								<button
									type="button"
									title="이 근거는 도움이 안 됨"
									className={cn("evidence__vote size-row flex items-center justify-center border rounded-6 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:text-ink", vote === "down" ? "evidence__vote--down-on border-danger-border bg-danger-bg-soft text-danger-text" : "border-border bg-window text-ink-muted")}
									onClick={() => sendVote("down")}
								>
									<ThumbsDownIcon />
								</button>
							</div>
							<button
								type="button"
								className="evidence__quicklook h-row flex-none whitespace-nowrap flex items-center gap-6 py-0 px-10 border border-border rounded-6 bg-window text-ink text-caption font-medium cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] enabled:hover:bg-chrome disabled:text-ink-faint disabled:cursor-default"
								disabled={item.source === null}
								onClick={() => {
									if (item.source !== null) onQuickLook(item.source);
								}}
							>
								<EyeIcon />
								Quick Look
							</button>
						</div>
						<div className="evidence__where flex items-center gap-8 min-w-0 pl-row">
							<button
								type="button"
								className="evidence__crumb min-w-0 h-chip flex items-center gap-4 py-0 px-8 border-none rounded-6 bg-input text-ink-body text-caption cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-strong enabled:hover:text-ink disabled:text-ink-muted disabled:cursor-default"
								title="Show in Finder"
								disabled={item.source === null}
								onClick={() => {
									if (item.source !== null) onReveal(item.source);
								}}
							>
								{item.source === null
									? item.title
									: evidenceCrumbs(item.source).map((segment) => (
										<span key={segment.label} className="evidence__crumb-segment flex items-center gap-4 min-w-0 truncate">
											{segment.last ? null : null}
											<span className={cn(segment.last && "evidence__crumb-last font-semibold")}>{segment.label}</span>
											{segment.last ? null : <span className="evidence__crumb-separator text-ink-faint">›</span>}
										</span>
									))}
							</button>
							<span className="evidence__detail min-w-0 text-caption text-ink-muted truncate">{evidenceDetail(item.confidence)}</span>
						</div>
					</div>
					<div className="evidence__body flex-1 min-h-0 overflow-auto pt-4 pr-20 pb-20 pl-[52px] flex flex-col gap-8">
						{item.summary.length === 0 ? null : (
							<div className="evidence__block evidence__block--paragraph text-caption leading-read text-ink-body text-pretty [&_strong]:text-ink [&_strong]:font-semibold">{renderInline(item.summary)}</div>
						)}
						{item.excerpts.map((excerpt, index) => (
							<EvidenceExcerpt key={`${index}`} text={excerpt} />
						))}
					</div>
				</div>
			) : null}
		</section>
	);
}

function EvidenceExcerpt({ text }: { readonly text: string }): ReactElement {
	return (
		<>
			{parseAnswerBlocks(text).map((block, index) => (
				<EvidenceBlock key={`${index}`} block={block} />
			))}
		</>
	);
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

function renderInline(text: string): readonly ReactElement[] {
	return parseInline(text).map((segment, index) => <InlineSegment key={`${index}`} segment={segment} />);
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
