/**
 * Inspector — the right column (v7 Bloom). Two stacked halves:
 *
 *   Info     preview paper, name, kind·size·date, index/trash/copy chips, the
 *            dupey Versions family, the metadata rows, and the 4-button action
 *            bar. 52px head when it is the only half, 42px in split mode.
 *   Evidence the citation half shown while a citation is selected: tabs,
 *            preview, title, thumbs feedback (real `search.feedback` IPC), and
 *            the source excerpt + reveal breadcrumb.
 *
 * All callbacks are real IPC-backed actions supplied by App; this component
 * renders no fabricated data. Esc handling stays in App's keymap.
 */

import { useState, type ReactElement, type ReactNode } from "react";
import type { IndexStatus } from "../../../shared/index-contract";
import type { CitationEvidence } from "../../../shared/search-contract";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import {
	evidenceCrumbs,
	evidenceDetail,
	evidenceKind,
	feedbackToastText,
	nextEvidenceFeedback,
	type EvidenceFeedback,
} from "../state/evidence";
import { basename, dirname } from "../state/paths";
import { RELATION_LABELS } from "../state/version-family";
import { EvidenceExcerpt, renderInline } from "./EvidenceBlocks";
import {
	CheckIcon,
	CloseIcon,
	CopyIcon,
	EyeIcon,
	ShareIcon,
	SparklesIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
	TrashIcon,
} from "./icons";
import { FileTile } from "./primitives/FileTile";

export interface InspectorFamilyMember {
	readonly path: string;
	readonly name: string;
	readonly relation: "exact" | "near" | "contains";
	readonly where: string;
}

export interface InspectorFamily {
	readonly headPath: string;
	readonly headName: string;
	readonly members: readonly InspectorFamilyMember[];
}

export interface InspectorProps {
	/** Focused/selected entry; null renders the empty-state placeholder. */
	readonly entry: FinderEntry | null;
	readonly indexStatus: IndexStatus | null;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly onQuickLook: (entry: FinderEntry) => void;
	readonly onAskAi: (entry: FinderEntry) => void;
	/** Dupey family of `entry`; null when it has no versions. */
	readonly family: InspectorFamily | null;
	readonly onOpenMember: (path: string) => void;
	readonly evidence: readonly CitationEvidence[];
	/** True in split mode: the Evidence half takes the lower 50%. */
	readonly evidenceVisible: boolean;
	readonly evidenceSelected: number;
	readonly sessionId: string | null;
	readonly onSelectEvidence: (n: number) => void;
	readonly onCloseEvidence: () => void;
	/** Show in Finder. */
	readonly onRevealPath: (path: string) => void;
	readonly onQuickLookPath: (path: string) => void;
	readonly onToast: (msg: string) => void;
}

const HEAD_BUTTON =
	"flex flex-none items-center justify-center size-icon-sm p-0 border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-border-strong disabled:cursor-default disabled:hover:bg-transparent";

export function Inspector({
	entry,
	indexStatus,
	onToggleIndex,
	onTrash,
	onCopyPath,
	onQuickLook,
	onAskAi,
	family,
	onOpenMember,
	evidence,
	evidenceVisible,
	evidenceSelected,
	sessionId,
	onSelectEvidence,
	onCloseEvidence,
	onRevealPath,
	onQuickLookPath,
	onToast,
}: InspectorProps): ReactElement {
	const split = evidenceVisible && evidence.length > 0;
	return (
		<aside
			className="inspector w-inspector min-w-0 h-full flex flex-col bg-subtle border-l border-border overflow-hidden"
			aria-label="Inspector"
		>
			<InfoHalf
				entry={entry}
				indexStatus={indexStatus}
				split={split}
				family={family}
				onOpenMember={onOpenMember}
				onToggleIndex={onToggleIndex}
				onTrash={onTrash}
				onCopyPath={onCopyPath}
				onQuickLook={onQuickLook}
				onAskAi={onAskAi}
			/>
			{split ? (
				<EvidenceHalf
					evidence={evidence}
					selected={evidenceSelected}
					sessionId={sessionId}
					onSelect={onSelectEvidence}
					onClose={onCloseEvidence}
					onReveal={onRevealPath}
					onQuickLook={onQuickLookPath}
					onToast={onToast}
				/>
			) : null}
		</aside>
	);
}

function InfoHalf({
	entry,
	indexStatus,
	split,
	family,
	onOpenMember,
	onToggleIndex,
	onTrash,
	onCopyPath,
	onQuickLook,
	onAskAi,
}: {
	readonly entry: FinderEntry | null;
	readonly indexStatus: IndexStatus | null;
	readonly split: boolean;
	readonly family: InspectorFamily | null;
	readonly onOpenMember: (path: string) => void;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly onQuickLook: (entry: FinderEntry) => void;
	readonly onAskAi: (entry: FinderEntry) => void;
}): ReactElement {
	const [brief, setBrief] = useState(false);
	const included = indexStatus === null || !indexStatus.excluded;

	return (
		<div className={cn("inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative", split && "h-[50%] max-h-[50%]")}>
			<div className={cn("inspector-head flex-none flex items-center gap-8 px-12 border-b border-border bg-chrome", split ? "h-42" : "h-52")}>
				<strong className={cn("font-semibold text-ink", split ? "text-sm" : "text-body")}>Info</strong>
				<span className="flex-1" />
				<button
					type="button"
					className={HEAD_BUTTON}
					title="경로 복사"
					aria-label="경로 복사"
					disabled={entry === null}
					onClick={() => {
						if (entry !== null) onCopyPath(entry);
					}}
				>
					<ShareIcon size={16} />
				</button>
			</div>

			{entry === null ? (
				<div className="flex-1 flex items-center justify-center px-10 text-center text-sm text-ink-muted leading-body">
					파일을 선택하면
					<br />
					미리보기와 정보를 표시합니다.
				</div>
			) : (
				<div className={cn("inspector-body flex-1 min-h-0 overflow-auto", split ? "px-14 pt-12 pb-18" : "px-16 pt-18 pb-24")}>
					<div className={cn("preview-paper flex-none flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised", split ? "h-100 mb-10" : "h-152 mb-14")}>
						{entry.iconUrl ? (
							<img
								className="max-w-full max-h-full object-contain"
								src={entry.iconUrl}
								alt=""
								aria-hidden="true"
								draggable={false}
							/>
						) : (
							<FileTile kind={entry.fileKind} large />
						)}
					</div>
					<div className="preview-title text-body font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere]">{entry.name}</div>
					<div className="preview-sub mt-4 text-meta text-ink-muted">
						{entry.kindLabel} · {entry.sizeLabel} · {entry.dateLabel}
					</div>

					<div className="chip-row flex flex-wrap gap-6 mt-12 mb-16">
						{entry.kind === "file" ? (
							<Chip onClick={() => onToggleIndex(entry)}>
								<CheckIcon size={12} />
								{included ? "인덱스 포함" : "인덱스 제외"}
							</Chip>
						) : null}
						<Chip onClick={() => onTrash(entry)}>
							<TrashIcon size={12} />휴지통
						</Chip>
						<Chip onClick={() => onCopyPath(entry)}>
							<CopyIcon size={12} />경로 복사
						</Chip>
					</div>

					{family === null ? null : <VersionsSection family={family} entry={entry} onOpenMember={onOpenMember} />}

					<div className="info-section border-t border-border pt-12 mt-12">
						<div className="section-title flex items-center justify-between mb-6">
							<span className="text-meta font-semibold text-ink">일반 정보</span>
							<button
								type="button"
								className="p-0 border-0 bg-transparent text-accent-text text-badge cursor-pointer"
								onClick={() => setBrief((current) => !current)}
							>
								{brief ? "전체 정보" : "간략히"}
							</button>
						</div>
						<dl className="m-0">
							<InfoRow label="종류" value={entry.kindLabel} />
							<InfoRow label="크기" value={entry.sizeLabel} />
							{brief ? null : <InfoRow label="위치" value={entry.location} />}
							{brief ? null : <InfoRow label="수정한 날짜" value={entry.dateLabel} />}
						</dl>
					</div>
				</div>
			)}

			<div className="inspector-actions flex-none grid grid-cols-4 gap-2 border-t border-border bg-chrome px-10 pt-10 pb-12">
				<ActionButton icon={<EyeIcon size={16} />} label="Quick Look" disabled={entry === null} onClick={() => entry !== null && onQuickLook(entry)} />
				<ActionButton icon={<CopyIcon size={16} />} label="경로 복사" disabled={entry === null} onClick={() => entry !== null && onCopyPath(entry)} />
				<ActionButton icon={<SparklesIcon size={16} />} label="AI 요약" disabled={entry === null} onClick={() => entry !== null && onAskAi(entry)} />
				<ActionButton icon={<TrashIcon size={16} />} label="휴지통" disabled={entry === null} onClick={() => entry !== null && onTrash(entry)} />
			</div>
		</div>
	);
}

function Chip({ children, onClick }: { readonly children: ReactNode; readonly onClick: () => void }): ReactElement {
	return (
		<button
			type="button"
			className="inline-flex items-center gap-4 h-pill px-8 rounded-full border border-border bg-window text-badge font-semibold text-ink-body whitespace-nowrap cursor-pointer transition-[border-color] duration-(--dur-color) ease-[ease] hover:border-border-strong"
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
	return (
		<div className="flex justify-between gap-8 py-3 text-meta">
			<dt className="flex-none text-ink-muted">{label}</dt>
			<dd className="m-0 min-w-0 text-ink text-right [overflow-wrap:anywhere]">{value}</dd>
		</div>
	);
}

function ActionButton({
	icon,
	label,
	disabled,
	onClick,
}: {
	readonly icon: ReactElement;
	readonly label: string;
	readonly disabled: boolean;
	readonly onClick: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			className="inspector-action min-w-0 flex flex-col items-center gap-6 px-2 py-6 rounded-8 border-0 bg-transparent text-ink-muted text-tile leading-[1.25] text-center cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:bg-hover hover:text-ink disabled:text-ink-faint disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-ink-faint"
			disabled={disabled}
			onClick={onClick}
		>
			{icon}
			<span className="max-w-full">{label}</span>
		</button>
	);
}

function VersionsSection({
	family,
	entry,
	onOpenMember,
}: {
	readonly family: InspectorFamily;
	readonly entry: FinderEntry;
	readonly onOpenMember: (path: string) => void;
}): ReactElement {
	const rows = [
		{ path: family.headPath, name: family.headName, relation: "latest" as const, where: dirname(family.headPath) },
		...family.members.map((member) => ({ path: member.path, name: member.name, relation: member.relation, where: member.where })),
	];
	return (
		<div className="info-section border-t border-border pt-12 mt-12">
			<div className="section-title flex items-center justify-between mb-6">
				<span className="text-meta font-semibold text-ink">Versions</span>
				<span className="inline-flex items-center h-[19px] px-6 rounded-full bg-input text-tile font-semibold text-ink-body">{rows.length}</span>
			</div>
			<div className="flex flex-col">
				{rows.map((row) => (
					<button
						type="button"
						key={row.path}
						className={cn(
							"ver-row w-full min-h-26 flex items-center gap-7 px-5 py-3 rounded-5 border-0 bg-transparent text-left text-badge text-ink-body cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover",
							row.path === entry.path && "bg-accent-wash",
						)}
						onClick={() => onOpenMember(row.path)}
					>
						<VersionTag relation={row.relation} />
						<span className="ver-name flex-1 min-w-0 truncate">{row.name}</span>
						<span className="vwhere flex-none max-w-[40%] truncate text-tile text-ink-muted">{basename(row.where)}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function VersionTag({ relation }: { readonly relation: "latest" | "exact" | "near" | "contains" }): ReactElement {
	const tone =
		relation === "latest"
			? "bg-vtag-latest-bg text-vtag-latest-text"
			: relation === "near"
				? "bg-vtag-near-bg text-vtag-near-text"
				: relation === "exact"
					? "bg-vtag-exact-bg text-vtag-exact-text"
					: "bg-input text-ink-muted";
	return (
		<span className={cn("vtag flex-none inline-flex items-center h-16 px-6 rounded-4 text-tile font-semibold whitespace-nowrap leading-none", tone)}>
			{relation === "latest" ? "최신본" : RELATION_LABELS[relation]}
		</span>
	);
}

function EvidenceHalf({
	evidence,
	selected,
	sessionId,
	onSelect,
	onClose,
	onReveal,
	onQuickLook,
	onToast,
}: {
	readonly evidence: readonly CitationEvidence[];
	readonly selected: number;
	readonly sessionId: string | null;
	readonly onSelect: (n: number) => void;
	readonly onClose: () => void;
	readonly onReveal: (path: string) => void;
	readonly onQuickLook: (path: string) => void;
	readonly onToast: (msg: string) => void;
}): ReactElement {
	const [votes, setVotes] = useState<Readonly<Record<string, EvidenceFeedback>>>({});
	const item = evidence.find((entry) => entry.number === selected) ?? evidence[0];
	if (item === undefined) {
		return <div className="inspector-half is-split h-[50%] max-h-[50%]" aria-label="Evidence" hidden />;
	}
	const source = item.source;
	const number = item.number;
	const voteKey = `${sessionId ?? "paused"}:${number}`;
	const vote = votes[voteKey] ?? null;

	function sendVote(pick: "up" | "down"): void {
		const next = nextEvidenceFeedback(vote, pick);
		setVotes((current) => ({ ...current, [voteKey]: next }));
		if (next === null || sessionId === null) return;
		void window.autorag.search
			.feedback(sessionId, next === "up" ? [number] : [], next === "down" ? [number] : [])
			.then(() => onToast(feedbackToastText(number, pick)))
			.catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error)));
	}

	return (
		<div className="inspector-half is-split h-[50%] max-h-[50%] min-h-0 flex flex-col overflow-hidden relative border-t border-border shadow-[0_-2px_8px_rgba(0,0,0,0.04)]" aria-label="Evidence">
			<div className="inspector-head flex-none h-42 flex items-center gap-8 px-12 border-b border-border bg-chrome">
				<strong className="text-sm font-semibold text-ink">Evidence</strong>
				<span className="flex-1" />
				<button
					type="button"
					className={HEAD_BUTTON}
					title="Quick Look"
					aria-label="Quick Look"
					disabled={source === null}
					onClick={() => {
						if (source !== null) onQuickLook(source);
					}}
				>
					<EyeIcon size={16} />
				</button>
				<button type="button" className={HEAD_BUTTON} title="근거 닫기" aria-label="근거 닫기" onClick={onClose}>
					<CloseIcon size={12} />
				</button>
			</div>
			<div className="inspector-body flex-1 min-h-0 overflow-auto px-14 pt-12 pb-18">
				<div className="evidence-tabs flex gap-3 overflow-auto mb-10">
					{evidence.map((entry) => (
						<button
							type="button"
							key={entry.number}
							className={cn(
								"evidence-tab flex-none inline-flex items-center justify-center size-22 rounded-6 border text-badge font-semibold cursor-pointer transition-[background,color,border-color] duration-(--dur-color) ease-[ease]",
								entry.number === item.number ? "bg-accent border-accent text-on-accent" : "bg-window border-border text-ink-muted hover:text-ink",
							)}
							onClick={() => onSelect(entry.number)}
						>
							{entry.number}
						</button>
					))}
				</div>

				<div className="preview-paper flex-none h-100 flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised mb-10">
					<FileTile kind={evidenceKind(item.title)} large />
				</div>
				<div className="preview-title text-sm font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere]">
					{item.number}. {item.title}
				</div>
				<div className="preview-sub mt-4 text-badge text-ink-muted">
					{source === null ? evidenceDetail(item.confidence) : `${source} · ${evidenceDetail(item.confidence)}`}
				</div>

				<div className="feedback flex items-center gap-6 my-8">
					<button
						type="button"
						title="이 근거가 도움이 됨"
						aria-label="이 근거가 도움이 됨"
						className={cn(
							"flex items-center justify-center size-row rounded-6 border cursor-pointer transition-[background,color,border-color] duration-(--dur-color) ease-[ease]",
							vote === "up" ? "border-ok-border bg-ok-bg-soft text-ok-text" : "border-border bg-window text-ink-muted hover:bg-chrome hover:text-ink",
						)}
						onClick={() => sendVote("up")}
					>
						<ThumbsUpIcon />
					</button>
					<button
						type="button"
						title="이 근거는 도움이 안 됨"
						aria-label="이 근거는 도움이 안 됨"
						className={cn(
							"flex items-center justify-center size-row rounded-6 border cursor-pointer transition-[background,color,border-color] duration-(--dur-color) ease-[ease]",
							vote === "down" ? "border-danger-border bg-danger-bg-soft text-danger-text" : "border-border bg-window text-ink-muted hover:bg-chrome hover:text-ink",
						)}
						onClick={() => sendVote("down")}
					>
						<ThumbsDownIcon />
					</button>
				</div>

				<div className="text-badge font-semibold text-ink-muted">근거 내용 발췌</div>
				<div className="flex flex-col gap-8 mt-4">
					{item.summary.length === 0 ? null : (
						<div className="evidence__block evidence__block--paragraph text-caption leading-read text-ink-body text-pretty [&_strong]:text-ink [&_strong]:font-semibold">{renderInline(item.summary)}</div>
					)}
					{item.excerpts.map((excerpt, index) => (
						<EvidenceExcerpt key={`${index}`} text={excerpt} />
					))}
				</div>

				{source === null ? null : (
					<button
						type="button"
						className="mt-12 flex items-center gap-4 min-w-0 max-w-full h-chip px-8 rounded-6 border-0 bg-input text-badge text-ink-body cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:bg-hover-strong hover:text-ink"
						title="Show in Finder"
						onClick={() => onReveal(source)}
					>
						{evidenceCrumbs(source).map((segment, index) => (
							<span key={`${index}`} className="flex items-center gap-4 min-w-0 truncate">
								<span className={cn(segment.last && "font-semibold")}>{segment.label}</span>
								{segment.last ? null : <span className="text-ink-faint">›</span>}
							</span>
						))}
					</button>
				)}
			</div>
		</div>
	);
}
