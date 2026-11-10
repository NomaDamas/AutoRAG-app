/**
 * The inspector's AI chat (see `state/inspector-chat.ts`): AI Search in the
 * right column, beside the file it is about.
 *
 *   InspectorChatDock  the Info view's foot: "이어서 대화" (back to the tab's
 *                      chat, with a dot when an answer landed unseen) or
 *                      "AI 요약", and the composer, which only types and always
 *                      starts a new chat about the selection.
 *   InspectorChatView  the chat itself, in place of the Info view: the title
 *                      opens the recent AI Search history, questions (each with
 *                      the file it brought in), answers whose numbered
 *                      citations show their source on hover, and the composer.
 *                      ⛶ opens the same chat in an AI Search tab; × goes back
 *                      to the Info view (Figma 328:3991, 328:5742).
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { isAppLanguage } from "../../../shared/language-contract";
import { appendTranscript, type VoiceBridge } from "../../../shared/voice-contract";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../shared/i18n/core";
import type { ChatAttachment, CitationEvidence } from "../../../shared/search-contract";
import { groupChatHistory, HISTORY_BUCKET_KEYS, historyEmptyText, type ChatHistoryGroup } from "../state/history";
import { cn } from "../lib/cn";
import { evidenceHeading, evidenceKind, isLocalEvidenceSource, unresolvedCitationNumbers } from "../state/evidence";
import { hasUnreadAnswer, relativeAge, type InspectorChatTab, type InspectorTurn } from "../state/inspector-chat";
import { useVoiceInput } from "../state/useVoiceInput";
import { MicrophonePermissionDialog } from "./MicrophonePermissionDialog";
import { ProseBlocks } from "./AiSearchPanel";
import { ApprovalModeMenu, useApprovalMode } from "./ApprovalModeMenu";
import type { ImageActions } from "./AnswerImage";
import {
	ArrowUpIcon,
	CloseIcon,
	ExpandIcon,
	FileIcon,
	HistoryIcon,
	MaximizeIcon,
	MicIcon,
	ChatNewIcon,
	PanelCloseIcon,
	SparklesIcon,
	TitleChevronIcon,
} from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { FileTile } from "./primitives/FileTile";

/** Time since `at`, worded short in its largest unit: "방금", "5분 전", "2시간 전", "3일 전", "1달 전", "1년 전". */
function useAgo(): (at: number, now: number) => string {
	const { t } = useTranslation();
	return (at, now) => {
		const { unit, count } = relativeAge(at, now);
		switch (unit) {
			case "now":
				return t("inspector.chat.justNow");
			case "minutes":
				return t("inspector.chat.minutesAgo", { count });
			case "hours":
				return t("inspector.chat.hoursAgo", { count });
			case "days":
				return t("inspector.chat.daysAgo", { count });
			case "months":
				return t("inspector.chat.monthsAgo", { count });
			case "years":
				return t("inspector.chat.yearsAgo", { count });
		}
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
	const approval = useApprovalMode();
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
				<div className="flex items-center gap-8">
					<ApprovalModeMenu mode={approval.mode} onChange={approval.setMode} compact />
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

/** The dock's round chips ("이어서 대화", "AI 요약"). */
const DOCK_CHIP =
	"inline-flex max-w-full items-center gap-6 rounded-full border border-divider bg-window py-8 pl-9 pr-10 text-meta leading-[16px] text-ink shadow-[0_2px_5px_rgba(20,20,41,0.07)] cursor-pointer enabled:hover:bg-hover disabled:text-ink-muted disabled:cursor-default";

export interface InspectorChatDockProps {
	readonly tab: InspectorChatTab;
	readonly now: number;
	/** The selection as chat attachments; empty when nothing can be asked about. */
	readonly targets: readonly ChatAttachment[];
	readonly running: boolean;
	/** A question typed here: it starts a new chat about the selection. */
	readonly onAsk: (text: string) => boolean;
	/** "AI 요약" about the selection, in a new chat. */
	readonly onSummarize: () => void;
	readonly onStop: () => void;
	/** "이어서 대화": the tab's chat, as it was. */
	readonly onResume: () => void;
}

export function InspectorChatDock({ tab, now, targets, running, onAsk, onSummarize, onStop, onResume }: InspectorChatDockProps): ReactElement {
	const { t } = useTranslation();
	const ago = useAgo();
	const chat = tab.chat;
	const placeholder = t(askPlaceholder(targets, "inspector.chat.placeholderAny"));
	return (
		// With nothing selected the dock is the panel's foot on its own: no divider above it, and the chat footer's padding.
		<div className={cn("inspector-chat-dock flex flex-col gap-4", targets.length === 0 ? "px-8 pt-8 pb-10" : "px-12 pb-12")}>
			{targets.length === 0 ? null : <div className="mb-4 h-px bg-divider" aria-hidden="true" />}
			{chat !== null ? (
				<div className="flex">
					<button type="button" className={cn("inspector-chat-continue", DOCK_CHIP)} onClick={onResume}>
						<span className="flex text-ink-muted" aria-hidden="true">
							<HistoryIcon size={13} />
						</span>
						<span className="truncate">{t("inspector.chat.continue")}</span>
						<span className="flex-none text-ink-faint">· {ago(chat.updatedAt, now)}</span>
						{hasUnreadAnswer(tab) ? <span className="size-5 flex-none rounded-full bg-accent" role="img" aria-label={t("inspector.chat.unread")} /> : null}
					</button>
				</div>
			) : targets.length === 0 ? null : (
				<div className="flex">
					<button type="button" className={DOCK_CHIP} disabled={running} onClick={onSummarize}>
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

const SOURCE_ACTION =
	"inline-flex items-center gap-4 rounded-8 border border-divider bg-transparent py-4 pl-8 pr-9 text-[10.5px] leading-[15.75px] text-ink-body cursor-pointer hover:bg-hover";

/** What a citation number stands for, shown over the answer while the number is hovered (Figma 328:3841). */
function SourceCard({
	item,
	onReveal,
	onPreview,
}: {
	readonly item: CitationEvidence;
	readonly onReveal: (path: string) => void;
	readonly onPreview: (path: string, excerpts: readonly string[]) => void;
}): ReactElement {
	const { t } = useTranslation();
	const local = isLocalEvidenceSource(item.source) ? item.source : null;
	const excerpt = item.excerpts[0] ?? item.summary;
	return (
		<div className="inspector-chat-source overflow-hidden rounded-8 border border-divider bg-window shadow-menu" role="tooltip">
			<div className="flex items-center gap-6 px-10 py-8">
				<span className="flex size-18 flex-none items-center justify-center rounded-5 bg-accent text-badge font-medium text-on-accent">{item.number}</span>
				<span className="min-w-0 flex-1 truncate text-meta font-medium leading-[16px] text-ink">{evidenceHeading(item.title, item.source)}</span>
			</div>
			{excerpt.length === 0 && local === null ? null : (
				<div className="flex flex-col gap-6 border-t border-border px-8 pt-8 pb-10">
					{excerpt.length === 0 ? null : (
						<p className="block m-0 text-meta leading-[1.5] text-ink-body line-clamp-6">
							<MarkedExcerpt text={excerpt} />
						</p>
					)}
					{local === null ? null : (
						<div className="flex flex-wrap gap-4">
							<button type="button" className={SOURCE_ACTION} onClick={() => onReveal(local)}>
								<FileIcon size={12} />
								{t("inspector.chat.showInList")}
							</button>
							<button type="button" className={SOURCE_ACTION} onClick={() => onPreview(local, item.excerpts)}>
								<ExpandIcon size={12} />
								{t("inspector.chat.preview")}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** The citation number under the pointer (or focus) and where its card goes, below the number's line. */
interface HoveredCitation {
	readonly number: number;
	readonly top: number;
}

/** The citation number button an event came from inside `root`, if any. */
function citationAt(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? (target.closest("button.cite") as HTMLElement | null) : null;
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
	const answerRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<HoveredCitation | null>(null);
	const hideTimer = useRef<number | null>(null);
	const keep = (): void => {
		if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		hideTimer.current = null;
	};
	const hideSoon = (): void => {
		keep();
		hideTimer.current = window.setTimeout(() => setHovered(null), 160);
	};
	useEffect(() => keep, []);
	const show = (cite: HTMLElement): void => {
		const root = answerRef.current;
		const number = Number(cite.textContent);
		if (root === null || !Number.isFinite(number) || !evidence.some((item) => item.number === number)) return;
		keep();
		setHovered({ number, top: cite.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 4 });
	};
	const onOver = (event: ReactMouseEvent<HTMLDivElement>): void => {
		const cite = citationAt(event.target);
		if (cite !== null) show(cite);
		else if (event.target instanceof Element && event.target.closest(".inspector-chat-source") !== null) keep();
		else if (hovered !== null) hideSoon();
	};
	const card = hovered === null ? null : (evidence.find((item) => item.number === hovered.number) ?? null);
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
					<div
						ref={answerRef}
						className="inspector-chat-answer relative block min-w-0 text-meta font-medium leading-[1.5] text-ink-body break-words [&_.cite]:bg-accent [&_.cite]:font-medium [&_.cite]:text-on-accent"
						onMouseOver={onOver}
						onMouseLeave={hideSoon}
						onFocus={(event) => {
							const cite = citationAt(event.target);
							if (cite !== null) show(cite);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") setHovered(null);
						}}
					>
						<ProseBlocks
							text={text}
							selected={null}
							unresolved={unresolvedCitationNumbers(text, evidence)}
							onCitation={(number) => setHovered((current) => (current?.number === number ? null : current))}
							imageActions={imageActions}
						/>
						{card === null || hovered === null ? null : (
							<div className="absolute right-0 left-0 z-20" style={{ top: hovered.top }} onMouseEnter={keep}>
								<SourceCard item={card} onReveal={onReveal} onPreview={onPreview} />
							</div>
						)}
					</div>
				) : null}
				{live && (text.length === 0 || turn.progress !== "") ? (
					<div className="flex min-w-0 items-center text-tile text-ink-muted" role="status">
						<span className="shimmer min-w-0 truncate" title={turn.progress === "" ? undefined : turn.progress}>
							{turn.progress === "" ? t("inspector.chat.thinking") : turn.progress}
						</span>
					</div>
				) : null}
				{turn.error === null ? null : <p className="block m-0 text-tile text-danger-text">{turn.error}</p>}
				{turn.stopped && turn.error === null ? <p className="block m-0 text-tile text-ink-muted">{t("inspector.chat.stopped")}</p> : null}
			</div>
		</>
	);
}

/** The chat title's menu: the recent AI Search chats, grouped by day; picking one makes it the tab's chat. */
function ChatHistoryMenu({
	currentChatId,
	onPick,
	onClose,
}: {
	readonly currentChatId: string | null;
	readonly onPick: (chatId: string) => void;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [groups, setGroups] = useState<readonly ChatHistoryGroup[] | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let alive = true;
		const list = window.autorag?.search?.historyList;
		if (list === undefined) {
			setGroups([]);
			return;
		}
		void list()
			.then((items) => {
				if (alive) setGroups(groupChatHistory(items, new Date()));
			})
			.catch(() => {
				if (alive) setGroups([]);
			});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(() => {
		const onDown = (event: MouseEvent): void => {
			if (!(event.target instanceof Node) || menuRef.current?.contains(event.target) === true) return;
			if (event.target instanceof Element && event.target.closest(".inspector-chat-title") !== null) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);
	return (
		<div
			ref={menuRef}
			className="inspector-chat-history absolute top-full left-8 z-30 mt-2 flex max-h-[360px] w-208 flex-col gap-6 overflow-y-auto rounded-12 border border-divider bg-window py-12 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
			role="menu"
			aria-label={t("inspector.chat.history")}
		>
			{groups === null ? null : groups.length === 0 ? (
				<span className="block px-16 py-4 text-meta text-ink-muted">{historyEmptyText("")}</span>
			) : (
				groups.map((group) => (
					<div key={group.label} className="flex flex-col">
						<span className="block px-16 text-[10.5px] leading-[15.75px] text-ink-muted">{t(HISTORY_BUCKET_KEYS[group.label])}</span>
						{group.items.map((item) => (
							<button
								type="button"
								role="menuitem"
								key={item.id}
								className={cn(
									"mx-8 block truncate rounded-8 border-0 px-16 py-8 text-left text-meta leading-[16px] text-ink cursor-pointer hover:bg-hover",
									item.id === currentChatId ? "bg-selected-nav" : "bg-transparent",
								)}
								title={item.title}
								onClick={() => onPick(item.id)}
							>
								{item.title}
							</button>
						))}
					</div>
				))
			)}
		</div>
	);
}

export interface InspectorChatViewProps {
	readonly tab: InspectorChatTab;
	/** The selection's name: the title of a chat started here (a chat opened from history shows its own). */
	readonly targetName: string;
	/** What the next question carries of the selection, as cards with their ×. */
	readonly pending: readonly ChatAttachment[];
	readonly running: boolean;
	readonly imageActions: ImageActions;
	readonly onAsk: (text: string) => boolean;
	readonly onStop: () => void;
	/** × : back to the Info view (the sidebar stays). */
	readonly onBack: () => void;
	readonly onNewChat: () => void;
	readonly onExpand: () => void;
	/** A chat picked from the title's history menu. */
	readonly onOpenChat: (chatId: string) => void;
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
	onOpenChat,
	onDismiss,
	onReveal,
	onPreview,
}: InspectorChatViewProps): ReactElement {
	const { t } = useTranslation();
	const [historyOpen, setHistoryOpen] = useState(false);
	const turns = tab.chat?.turns ?? [];
	/** A chat picked from history carries its own title; a chat started here is titled by the selection it is about. */
	const title = tab.chat?.title ?? targetName;
	const headButton = cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-body" }), "size-28 rounded-6 disabled:cursor-default");
	return (
		<div className="inspector-chat flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={t("inspector.chat.title")}>
			<div className="relative flex h-35 flex-none items-center gap-4 border-y border-divider bg-subtle-alt py-6 pl-12 pr-8">
				{/* At least 30px before the buttons (Figma 328:3802): a wider sidebar shows more of the title, and once it is whole the gap grows. */}
				<div className="flex min-w-0 flex-1 pr-26">
					<button
						type="button"
						className="inspector-chat-title flex min-w-0 max-w-full items-center gap-4 border-0 bg-transparent p-0 text-left text-sm font-normal leading-[1.5] text-ink-body cursor-pointer hover:text-ink"
						aria-haspopup="menu"
						aria-expanded={historyOpen}
						title={title}
						onClick={() => setHistoryOpen((open) => !open)}
					>
						<span className="truncate">{title}</span>
						<span className="flex flex-none text-ink-muted" aria-hidden="true">
							<TitleChevronIcon size={16} />
						</span>
					</button>
				</div>
				<button type="button" className={headButton} aria-label={t("inspector.chat.newChat")} title={t("inspector.chat.newChat")} disabled={running} onClick={onNewChat}>
					<ChatNewIcon size={16} />
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.expand")} title={t("inspector.chat.expand")} disabled={running} onClick={onExpand}>
					<MaximizeIcon size={16} />
				</button>
				<button type="button" className={headButton} aria-label={t("inspector.chat.close")} title={t("inspector.chat.close")} onClick={onBack}>
					<PanelCloseIcon size={16} />
				</button>
				{historyOpen ? (
					<ChatHistoryMenu
						currentChatId={tab.chat?.chatId ?? null}
						onClose={() => setHistoryOpen(false)}
						onPick={(chatId) => {
							setHistoryOpen(false);
							if (chatId !== tab.chat?.chatId) onOpenChat(chatId);
						}}
					/>
				) : null}
			</div>
			<div
				className="flex min-h-0 flex-1 flex-col gap-20 overflow-y-auto px-12 py-10"
				ref={(node) => {
					if (node !== null) node.scrollTop = node.scrollHeight;
				}}
			>
				{turns.map((turn, index) => (
					<TurnView
						key={`${tab.chat?.chatId ?? ""}:${index}`}
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
