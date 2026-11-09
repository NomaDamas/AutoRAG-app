/**
 * The inspector's AI chat (see `state/inspector-chat.ts`): AI Search in the
 * right column, beside the file it is about.
 *
 *   InspectorChatDock  the Info view's foot: the resume link, "AI 요약", and the
 *                      composer, which only types: the question carries the
 *                      selection without showing it as cards.
 *   InspectorChatView  the chat itself, in place of the Info view: questions
 *                      (each with the file it brought in), answers with their
 *                      sources folded under them, and the composer. ⤢ opens
 *                      the same chat in an AI Search tab.
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { isAppLanguage } from "../../../shared/language-contract";
import { appendTranscript, type VoiceBridge } from "../../../shared/voice-contract";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../shared/i18n/core";
import type { ChatAttachment, CitationEvidence } from "../../../shared/search-contract";
import { cn } from "../lib/cn";
import { evidenceHeading, evidenceKind, isLocalEvidenceSource, unresolvedCitationNumbers } from "../state/evidence";
import { questionCount, type InspectorChatTab, type InspectorTurn } from "../state/inspector-chat";
import { useVoiceInput } from "../state/useVoiceInput";
import { MicrophonePermissionDialog } from "./MicrophonePermissionDialog";
import { ProseBlocks } from "./AiSearchPanel";
import type { ImageActions } from "./AnswerImage";
import {
	ArrowLeftIcon,
	ArrowUpIcon,
	CloseIcon,
	ExpandCornersIcon,
	ExpandIcon,
	FileIcon,
	HistoryIcon,
	MessagesIcon,
	MicIcon,
	NewChatIcon,
	SparklesIcon,
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

function AttachmentCard({
	att,
	onRemove,
	small = false,
}: {
	readonly att: ChatAttachment;
	readonly onRemove?: (() => void) | undefined;
	/** The composer's card: a 10.5px name instead of the conversation's 12px. */
	readonly small?: boolean;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<span className="inspector-chat-att relative inline-flex max-w-full min-w-0 items-center gap-6 rounded-8 border border-divider bg-window px-8 py-5" title={att.id}>
			<FileTile kind={att.kind === "folder" ? "folder" : evidenceKind(att.name)} size={18} />
			<span className={cn("min-w-0 truncate text-ink", small ? "text-badge leading-[16px]" : "text-meta leading-[1.4]")}>{att.name}</span>
			{onRemove === undefined ? null : (
				<button
					type="button"
					className="absolute -top-7 -right-7 flex size-16 items-center justify-center rounded-full border border-border-strong bg-window p-0 text-ink-muted cursor-pointer hover:text-ink"
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

/** The composer's blue round button. */
const composerButton =
	"flex size-24 flex-none items-center justify-center rounded-full border-0 bg-accent p-0 text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-accent-hover disabled:cursor-default";

/**
 * The empty composer's mic: dictation into the draft, as in AI Search. Clicking it again stops listening and the
 * transcript is added to whatever is typed.
 */
function VoiceButton({
	voice,
	onTranscript,
	onError,
}: {
	readonly voice: VoiceBridge;
	readonly onTranscript: (text: string) => void;
	readonly onError: (message: string | null) => void;
}): ReactElement {
	const { t, i18n } = useTranslation();
	const dictation = useVoiceInput({
		voice,
		language: isAppLanguage(i18n.language) ? i18n.language : "ko",
		onTranscript: (text) => {
			onError(null);
			onTranscript(text);
		},
		onError,
	});
	const label =
		dictation.phase === "listening" ? t("aiSearch.voiceStop") : dictation.phase === "transcribing" ? t("aiSearch.voiceTranscribing") : t("aiSearch.voiceStart");
	return (
		<>
			<button
				type="button"
				className={cn("inspector-chat-voice", composerButton)}
				aria-label={label}
				title={label}
				aria-pressed={dictation.phase === "listening"}
				disabled={dictation.phase === "transcribing"}
				onClick={() => {
					onError(null);
					dictation.toggle();
				}}
			>
				{dictation.phase === "listening" ? (
					<span className="size-8 rounded-2 bg-current" aria-hidden="true" />
				) : dictation.phase === "transcribing" ? (
					<span className="size-10 rounded-full border-[1.5px] border-on-accent/40 border-t-on-accent animate-spin" aria-hidden="true" />
				) : (
					<MicIcon size={13} />
				)}
			</button>
			{dictation.permission === null ? null : (
				<MicrophonePermissionDialog
					state={dictation.permission}
					platform={window.autorag?.platform ?? ""}
					onOpenSettings={dictation.openSettings}
					onClose={dictation.dismissPermission}
				/>
			)}
		</>
	);
}

function Composer({
	pending,
	placeholder,
	running,
	onSend,
	onStop,
	onDismiss,
}: {
	/** The cards above the input, each with its ×; empty for the Info view's composer, which only types. */
	readonly pending: readonly ChatAttachment[];
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
	const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
	const voice = window.autorag?.voice;
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
			<div className="flex flex-col gap-10 rounded-12 border border-divider bg-window py-8 pl-11 pr-12 shadow-[0_2px_5px_rgba(20,20,41,0.07)]">
				{pending.length === 0 ? null : (
					<div className="flex flex-wrap gap-x-10 gap-y-8 pt-2 pr-6">
						{pending.map((att) => (
							<AttachmentCard key={att.id} att={att} small onRemove={() => onDismiss(att.id)} />
						))}
					</div>
				)}
				<div className="flex items-center gap-4">
					<input
						className="min-w-0 flex-1 h-24 border-0 bg-transparent p-0 text-meta leading-[16px] text-ink outline-none placeholder:text-ink-faint"
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
					) : draft.trim().length === 0 && voice !== undefined ? (
						<VoiceButton voice={voice} onTranscript={(text) => setDraft((current) => appendTranscript(current, text))} onError={setVoiceNotice} />
					) : (
						<button
							type="button"
							className={composerButton}
							aria-label={t("inspector.chat.send")}
							title={t("inspector.chat.send")}
							disabled={draft.trim().length === 0}
							onClick={send}
						>
							<ArrowUpIcon size={12} />
						</button>
					)}
				</div>
			</div>
			{busyNotice ? (
				<p className="block m-0 mt-4 text-tile text-ink-muted" role="status">
					{t("inspector.chat.busy")}
				</p>
			) : null}
			{voiceNotice === null ? null : (
				<p className="block m-0 mt-4 text-tile text-ink-muted" role="alert">
					{voiceNotice}
				</p>
			)}
		</div>
	);
}

/** The composer's prompt for what the question is about: nothing in particular, a folder, a file, or several items. */
function askPlaceholder(about: readonly ChatAttachment[], none: LocaleKey): LocaleKey {
	if (about.length === 0) return none;
	if (about.length > 1) return "inspector.chat.placeholderItems";
	return about[0]?.kind === "folder" ? "inspector.chat.placeholderFolder" : "inspector.chat.placeholderFile";
}

export interface InspectorChatDockProps {
	readonly tab: InspectorChatTab;
	readonly now: number;
	/** The selection as chat attachments; empty when nothing can be asked about. */
	readonly targets: readonly ChatAttachment[];
	readonly running: boolean;
	readonly onAsk: (text: string) => boolean;
	/** "AI 요약" about the selection, asked in this chat. */
	readonly onSummarize: () => void;
	readonly onStop: () => void;
	readonly onResume: () => void;
	readonly onOpenHistory: () => void;
}

export function InspectorChatDock({ tab, now, targets, running, onAsk, onSummarize, onStop, onResume, onOpenHistory }: InspectorChatDockProps): ReactElement {
	const { t } = useTranslation();
	const ago = useAgo();
	const chat = tab.chat;
	const placeholder = t(askPlaceholder(targets, "inspector.chat.placeholderAny"));
	return (
		// With nothing selected the dock is the panel's foot on its own: no divider above it, and the chat footer's padding.
		<div className={cn("inspector-chat-dock flex flex-col gap-4", targets.length === 0 ? "px-8 pt-8 pb-10" : "px-12 pb-12")}>
			{targets.length === 0 ? null : <div className="mb-4 h-px bg-divider" aria-hidden="true" />}
			{chat !== null ? (
				<button type="button" className="mb-2 flex max-w-full items-center gap-4 border-0 bg-transparent p-0 text-tile text-accent-text cursor-pointer" onClick={onResume}>
					<MessagesIcon size={12} />
					<span className="truncate">{t("inspector.chat.resume", { count: questionCount(chat), ago: ago(chat.updatedAt, now) })}</span>
				</button>
			) : tab.expired ? (
				<button type="button" className="mb-2 flex max-w-full items-center gap-4 border-0 bg-transparent p-0 text-tile text-accent-text cursor-pointer" onClick={onOpenHistory}>
					<HistoryIcon size={12} />
					<span className="truncate">{t("inspector.chat.expired")}</span>
				</button>
			) : null}
			{targets.length === 0 ? null : (
				<div className="flex">
					<button
						type="button"
						className="inline-flex items-center gap-6 rounded-full border border-divider bg-window py-8 pl-9 pr-10 text-meta leading-[16px] text-ink shadow-[0_2px_5px_rgba(20,20,41,0.07)] cursor-pointer enabled:hover:bg-hover disabled:text-ink-muted disabled:cursor-default"
						disabled={running}
						onClick={onSummarize}
					>
						<span className="flex text-accent-text" aria-hidden="true">
							<SparklesIcon size={13} />
						</span>
						{t("inspector.actions.askAi")}
					</button>
				</div>
			)}
			<Composer pending={[]} placeholder={placeholder} running={running} onSend={onAsk} onStop={onStop} onDismiss={() => {}} />
		</div>
	);
}

/** An excerpt with its **marked** phrases (the cited passage) in the accent, the rest as plain text. */
function MarkedExcerpt({ text }: { readonly text: string }): ReactElement {
	const parts = text.split(/\*\*(.+?)\*\*/g);
	return (
		<>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					<span key={`${index}`} className="font-medium text-accent-text">
						{part}
					</span>
				) : (
					part
				),
			)}
		</>
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
					<div key={item.number} className="overflow-hidden rounded-8 border border-divider bg-window shadow-[0_0_4px_rgba(20,20,41,0.07)]">
						<button
							type="button"
							className="flex w-full items-center gap-6 rounded-8 border-0 bg-transparent px-10 py-8 text-left cursor-pointer hover:bg-hover"
							aria-expanded={expanded}
							onClick={() => setOpen(expanded ? null : item.number)}
						>
							<span className="flex size-16 flex-none items-center justify-center rounded-4 bg-selected-nav text-tile-xs font-medium text-ink-body">{item.number}</span>
							<span className="min-w-0 flex-1 truncate text-meta font-medium leading-[16px] text-ink">{heading}</span>
						</button>
						{expanded ? (
							<div className="flex flex-col gap-6 border-t border-border px-8 pt-8 pb-10">
								{excerpt.length === 0 ? null : (
									<p className="block m-0 text-meta leading-[1.5] text-ink-body line-clamp-6">
										<MarkedExcerpt text={excerpt} />
									</p>
								)}
								{local !== null ? (
									<div className="flex flex-wrap gap-4">
										<button
											type="button"
											className="inline-flex items-center gap-4 rounded-8 border border-border-strong bg-transparent py-4 pl-8 pr-9 text-[10.5px] leading-[15.75px] text-ink cursor-pointer hover:bg-hover"
											onClick={() => onReveal(local)}
										>
											<FileIcon size={12} />
											{t("inspector.chat.showInList")}
										</button>
										<button
											type="button"
											className="inline-flex items-center gap-4 rounded-8 border border-border-strong bg-transparent py-4 pl-8 pr-9 text-[10.5px] leading-[15.75px] text-ink cursor-pointer hover:bg-hover"
											onClick={() => onPreview(local, item.excerpts)}
										>
												<ExpandIcon size={12} />
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
				<div className="inspector-chat-question block rounded-[16px] bg-ink-body px-12 py-8 text-meta leading-[1.5] text-window break-words whitespace-pre-wrap">{turn.question}</div>
			</div>
			<div className="flex min-w-0 flex-col gap-8">
			{text.length > 0 ? (
				<div className="inspector-chat-answer block min-w-0 text-meta font-medium leading-[1.5] text-ink-body break-words">
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
			</div>
		</>
	);
}

export interface InspectorChatViewProps {
	readonly tab: InspectorChatTab;
	/** The selection's name, for the way back to its Info view. */
	readonly targetName: string;
	/** What the next question carries of the selection, as cards with their ×. */
	readonly pending: readonly ChatAttachment[];
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
			<div className="flex flex-none items-center gap-4 border-b border-border pb-6 pl-12 pr-8">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-8 border-0 bg-transparent p-0 text-left text-meta leading-[1.5] text-ink-body cursor-pointer hover:text-ink"
					onClick={onBack}
				>
					<ArrowLeftIcon size={13} />
					<span className="truncate">{t("inspector.chat.back", { name: targetName })}</span>
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.newChat")} title={t("inspector.chat.newChat")} disabled={running} onClick={onNewChat}>
					<NewChatIcon size={14} />
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.expand")} title={t("inspector.chat.expand")} disabled={running} onClick={onExpand}>
					<ExpandCornersIcon size={16} />
				</button>
			</div>
			<div
				className="flex min-h-0 flex-1 flex-col gap-20 overflow-y-auto px-12 py-10"
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
			<div className="flex-none px-8 pt-8 pb-10">
				<Composer
					pending={pending}
					placeholder={t(askPlaceholder(pending, "inspector.chat.placeholderFollowUp"))}
					running={running}
					onSend={onAsk}
					onStop={onStop}
					onDismiss={onDismiss}
				/>
			</div>
		</div>
	);
}
