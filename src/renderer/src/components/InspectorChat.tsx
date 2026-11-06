/**
 * The inspector's AI chat (see `state/inspector-chat.ts`): AI Search in the
 * right column, beside the file it is about.
 *
 *   InspectorChatDock  the Info view's foot: the resume link and the composer
 *                      (the action bar's "AI 요약" asks here too). The first question carries the selection as
 *                      an attachment card.
 *   InspectorChatView  the chat itself, in place of the Info view: questions
 *                      (each with the file it brought in), answers with their
 *                      sources folded under them, and the composer. ⤢ opens
 *                      the same chat in an AI Search tab.
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment, CitationEvidence } from "../../../shared/search-contract";
import { cn } from "../lib/cn";
import { evidenceHeading, evidenceKind, isLocalEvidenceSource, unresolvedCitationNumbers } from "../state/evidence";
import { questionCount, type InspectorChatTab, type InspectorTurn } from "../state/inspector-chat";
import { ProseBlocks } from "./AiSearchPanel";
import type { ImageActions } from "./AnswerImage";
import {
	ArrowLeftIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CloseIcon,
	ExpandIcon,
	EyeIcon,
	HistoryIcon,
	MessagesIcon,
	NewChatIcon,
} from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { FileTile } from "./primitives/FileTile";

/** Minutes since `at`, worded short: "방금", "5분 전". */
function useAgo(): (at: number, now: number) => string {
	const { t } = useTranslation();
	return (at, now) => {
		const minutes = Math.floor((now - at) / 60_000);
		return minutes < 1 ? t("inspector.chat.justNow") : t("inspector.chat.minutesAgo", { count: minutes });
	};
}

function AttachmentCard({ att, onRemove }: { readonly att: ChatAttachment; readonly onRemove?: (() => void) | undefined }): ReactElement {
	const { t } = useTranslation();
	return (
		<span className="inspector-chat-att relative inline-flex max-w-full min-w-0 items-center gap-6 rounded-8 border border-border bg-input px-8 py-5" title={att.id}>
			<FileTile kind={att.kind === "folder" ? "folder" : evidenceKind(att.name)} size={18} />
			<span className="min-w-0 truncate text-meta font-medium text-ink">{att.name}</span>
			{onRemove === undefined ? null : (
				<button
					type="button"
					className="absolute -top-6 -right-6 flex size-16 items-center justify-center rounded-full border border-border-strong bg-window p-0 text-ink-muted cursor-pointer hover:text-ink"
					aria-label={t("inspector.chat.removeAttachment")}
					title={t("inspector.chat.removeAttachment")}
					onClick={onRemove}
				>
					<CloseIcon size={8} />
				</button>
			)}
		</span>
	);
}

function Composer({
	pending,
	removable,
	placeholder,
	running,
	onSend,
	onStop,
	onDismiss,
}: {
	readonly pending: ChatAttachment | null;
	/** The card can be taken off (a follow-up); a first question always carries the selection. */
	readonly removable: boolean;
	readonly placeholder: string;
	readonly running: boolean;
	/** False when the question was not sent (another inspector answer is still coming): the draft stays. */
	readonly onSend: (text: string) => boolean;
	readonly onStop: () => void;
	readonly onDismiss: (id: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");
	const [busyNotice, setBusyNotice] = useState(false);
	const send = (): void => {
		const text = draft.trim();
		if (text.length === 0) return;
		if (running) {
			// The draft stays: the person sends it once the answer lands.
			setBusyNotice(true);
			return;
		}
		if (!onSend(text)) {
			setBusyNotice(true);
			return;
		}
		setBusyNotice(false);
		setDraft("");
	};
	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
		// Enter that confirms a Korean/Japanese IME composition is not a send.
		if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		send();
	};
	return (
		<div className="inspector-chat-composer block">
			<div className="block rounded-10 border border-border-strong bg-window px-8 pt-6 pb-4">
				{pending === null ? null : (
					<div className="flex pb-6 pr-6">
						<AttachmentCard att={pending} onRemove={removable ? () => onDismiss(pending.id) : undefined} />
					</div>
				)}
				<div className="flex items-center gap-4">
					<input
						className="min-w-0 flex-1 h-28 border-0 bg-transparent p-0 text-sm text-ink outline-none placeholder:text-ink-muted"
						value={draft}
						placeholder={placeholder}
						aria-label={placeholder}
						onChange={(event) => {
							setDraft(event.target.value);
							setBusyNotice(false);
						}}
						onKeyDown={onKeyDown}
					/>
					{running ? (
						<button
							type="button"
							className="flex size-24 flex-none items-center justify-center rounded-full border-0 bg-selected-nav p-0 text-ink cursor-pointer"
							aria-label={t("inspector.chat.stop")}
							title={t("inspector.chat.stop")}
							onClick={onStop}
						>
							<span className="size-8 rounded-2 bg-current" aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							className="flex size-24 flex-none items-center justify-center rounded-full border-0 bg-accent p-0 text-on-accent cursor-pointer disabled:bg-selected-nav disabled:text-ink-muted disabled:cursor-default"
							aria-label={t("inspector.chat.send")}
							title={t("inspector.chat.send")}
							disabled={draft.trim().length === 0}
							onClick={send}
						>
							<ArrowUpIcon size={13} />
						</button>
					)}
				</div>
			</div>
			{busyNotice ? (
				<p className="block m-0 mt-4 text-tile text-ink-muted" role="status">
					{t("inspector.chat.busy")}
				</p>
			) : null}
		</div>
	);
}

export interface InspectorChatDockProps {
	readonly tab: InspectorChatTab;
	readonly now: number;
	/** The selection as a chat attachment; null when nothing can be asked about. */
	readonly target: ChatAttachment | null;
	readonly pending: ChatAttachment | null;
	readonly running: boolean;
	readonly onAsk: (text: string) => boolean;
	readonly onStop: () => void;
	readonly onResume: () => void;
	readonly onOpenHistory: () => void;
	readonly onDismiss: (id: string) => void;
}

export function InspectorChatDock({
	tab,
	now,
	target,
	pending,
	running,
	onAsk,
	onStop,
	onResume,
	onOpenHistory,
	onDismiss,
}: InspectorChatDockProps): ReactElement {
	const { t } = useTranslation();
	const ago = useAgo();
	const chat = tab.chat;
	const placeholder =
		chat !== null
			? t("inspector.chat.placeholderFollowUp")
			: target === null
				? t("inspector.chat.placeholderAny")
				: target.kind === "folder"
					? t("inspector.chat.placeholderFolder")
					: t("inspector.chat.placeholderFile");
	return (
		<div className="inspector-chat-dock flex-none border-t border-border bg-chrome px-10 pt-8 pb-10">
			{chat !== null ? (
				<button type="button" className="mb-6 flex max-w-full items-center gap-4 border-0 bg-transparent p-0 text-tile text-accent-text cursor-pointer" onClick={onResume}>
					<MessagesIcon size={12} />
					<span className="truncate">{t("inspector.chat.resume", { count: questionCount(chat), ago: ago(chat.updatedAt, now) })}</span>
				</button>
			) : tab.expired ? (
				<button type="button" className="mb-6 flex max-w-full items-center gap-4 border-0 bg-transparent p-0 text-tile text-accent-text cursor-pointer" onClick={onOpenHistory}>
					<HistoryIcon size={12} />
					<span className="truncate">{t("inspector.chat.expired")}</span>
				</button>
			) : null}
			<Composer pending={pending} removable={chat !== null} placeholder={placeholder} running={running} onSend={onAsk} onStop={onStop} onDismiss={onDismiss} />
		</div>
	);
}

function SourceList({
	evidence,
	onReveal,
	onPreview,
}: {
	readonly evidence: readonly CitationEvidence[];
	readonly onReveal: (path: string) => void;
	readonly onPreview: (path: string, excerpts: readonly string[]) => void;
}): ReactElement | null {
	const { t } = useTranslation();
	const [open, setOpen] = useState<number | null>(null);
	if (evidence.length === 0) return null;
	return (
		<div className="flex flex-col gap-4">
			{evidence.map((item) => {
				const expanded = open === item.number;
				const local = isLocalEvidenceSource(item.source) ? item.source : null;
				const heading = evidenceHeading(item.title, item.source);
				const excerpt = item.excerpts[0] ?? item.summary;
				return (
					<div key={item.number} className="overflow-hidden rounded-8 border border-border bg-window">
						<button
							type="button"
							className="flex w-full items-center gap-6 border-0 bg-transparent px-8 py-6 text-left text-tile text-ink cursor-pointer"
							aria-expanded={expanded}
							onClick={() => setOpen(expanded ? null : item.number)}
						>
							<span className="flex size-14 flex-none items-center justify-center rounded-4 bg-selected-nav text-badge text-ink-muted">{item.number}</span>
							<FileTile kind={evidenceKind(heading)} size={16} />
							<span className="min-w-0 flex-1 truncate">{heading}</span>
							{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
						</button>
						{expanded ? (
							<div className="block border-t border-border px-8 pt-6 pb-8">
								{excerpt.length === 0 ? null : <p className="block m-0 mb-6 text-tile leading-body text-ink-body line-clamp-6">{excerpt}</p>}
								{local !== null ? (
									<div className="flex flex-wrap gap-4">
										<button
											type="button"
											className="inline-flex h-24 items-center gap-4 rounded-6 border border-border-strong bg-transparent px-8 text-tile text-ink cursor-pointer hover:bg-hover"
											onClick={() => onReveal(local)}
										>
											{t("inspector.chat.showInList")}
										</button>
										<button
											type="button"
											className="inline-flex h-24 items-center gap-4 rounded-6 border border-border-strong bg-transparent px-8 text-tile text-ink cursor-pointer hover:bg-hover"
											onClick={() => onPreview(local, item.excerpts)}
										>
											<EyeIcon size={12} />
											{t("inspector.chat.preview")}
										</button>
									</div>
								) : null}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function TurnView({
	turn,
	live,
	imageActions,
	onReveal,
	onPreview,
}: {
	readonly turn: InspectorTurn;
	/** The turn's run is still streaming. */
	readonly live: boolean;
	readonly imageActions: ImageActions;
	readonly onReveal: (path: string) => void;
	readonly onPreview: (path: string, excerpts: readonly string[]) => void;
}): ReactElement {
	const { t } = useTranslation();
	const text = turn.answer?.answer ?? turn.draft;
	const evidence = turn.answer?.evidence ?? [];
	return (
		<>
			<div className="flex max-w-[90%] min-w-0 flex-col items-end gap-4 self-end">
				{turn.attachments.map((att) => (
					<AttachmentCard key={att.id} att={att} />
				))}
				<div className="block rounded-8 bg-input px-8 py-6 text-sm leading-body text-ink-body break-words whitespace-pre-wrap">{turn.question}</div>
			</div>
			{text.length > 0 ? (
				<div className="inspector-chat-answer block min-w-0 text-sm leading-body text-ink-body break-words">
					<ProseBlocks text={text} selected={null} unresolved={unresolvedCitationNumbers(text, evidence)} onCitation={() => {}} imageActions={imageActions} />
				</div>
			) : live ? (
				<p className="block m-0 text-tile text-ink-muted" role="status">
					{t("inspector.chat.thinking")}
				</p>
			) : null}
			{turn.error === null ? null : <p className="block m-0 text-tile text-danger-text">{turn.error}</p>}
			{turn.stopped && turn.error === null ? <p className="block m-0 text-tile text-ink-muted">{t("inspector.chat.stopped")}</p> : null}
			{live ? null : <SourceList evidence={evidence} onReveal={onReveal} onPreview={onPreview} />}
		</>
	);
}

export interface InspectorChatViewProps {
	readonly tab: InspectorChatTab;
	/** The selection's name, for the way back to its Info view. */
	readonly targetName: string;
	readonly pending: ChatAttachment | null;
	readonly running: boolean;
	readonly imageActions: ImageActions;
	readonly onAsk: (text: string) => boolean;
	readonly onStop: () => void;
	readonly onBack: () => void;
	readonly onNewChat: () => void;
	readonly onExpand: () => void;
	readonly onDismiss: (id: string) => void;
	/** Select the cited file in the file list (its folder opens first). */
	readonly onReveal: (path: string) => void;
	/** Quick Look the cited file at the cited passage. */
	readonly onPreview: (path: string, excerpts: readonly string[]) => void;
}

export function InspectorChatView({
	tab,
	targetName,
	pending,
	running,
	imageActions,
	onAsk,
	onStop,
	onBack,
	onNewChat,
	onExpand,
	onDismiss,
	onReveal,
	onPreview,
}: InspectorChatViewProps): ReactElement {
	const { t } = useTranslation();
	const turns = tab.chat?.turns ?? [];
	const headButton = cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "disabled:cursor-default");
	return (
		<div className="inspector-chat flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={t("inspector.chat.title")}>
			<div className="flex flex-none items-center gap-4 border-b border-border px-8 pb-6">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-4 border-0 bg-transparent px-4 py-4 text-left text-meta text-ink-muted cursor-pointer hover:text-ink"
					onClick={onBack}
				>
					<ArrowLeftIcon size={13} />
					<span className="truncate">{t("inspector.chat.back", { name: targetName })}</span>
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.newChat")} title={t("inspector.chat.newChat")} disabled={running} onClick={onNewChat}>
					<NewChatIcon size={14} />
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.expand")} title={t("inspector.chat.expand")} disabled={running} onClick={onExpand}>
					<ExpandIcon size={13} />
				</button>
			</div>
			<div
				className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-12 py-10"
				ref={(node) => {
					if (node !== null) node.scrollTop = node.scrollHeight;
				}}
			>
				{turns.map((turn, index) => (
					<TurnView
						key={`${index}`}
						turn={turn}
						live={running && index === turns.length - 1}
						imageActions={imageActions}
						onReveal={onReveal}
						onPreview={onPreview}
					/>
				))}
			</div>
			<div className="flex-none border-t border-border bg-chrome px-10 pt-8 pb-10">
				<Composer
					pending={pending}
					removable
					placeholder={t("inspector.chat.placeholderFollowUp")}
					running={running}
					onSend={onAsk}
					onStop={onStop}
					onDismiss={onDismiss}
				/>
			</div>
		</div>
	);
}
