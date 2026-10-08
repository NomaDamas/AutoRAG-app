import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type DragEvent as ReactDragEvent,
	type FormEvent,
	type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";
import type {
	AnswerPhase,
	ChatAttachment,
	ChatSummary,
	CitationEvidence,
	SearchStreamEvent,
} from "../../../shared/search-contract";
import { isImageOnlyLine, parseAnswerBlocks, parseInline, type AnswerBlock } from "../state/answer-markdown";
import { summaryRequest, type SummaryLanguage } from "../state/ai-summary";
import { answerViewState } from "../state/answer-view";
import { attachmentsFromDrop, isAttachmentDrag, mergeAttachments } from "../state/attachments";
import { ImageRow, lineImages, type ImageActions } from "./AnswerImage";
import { evidenceKind, unresolvedCitationNumbers } from "../state/evidence";
import { groupChatHistory, historyEmptyText } from "../state/history";
import { cn } from "../lib/cn";
import { formatShortcut } from "../lib/shortcuts";
import { ArrowUpIcon, CloseIcon, HistoryIcon, LinkIcon, PlusIcon, SparklesIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { FileTile } from "./primitives/FileTile";

const autorag = window.autorag;

/** History search fires this long after the last keystroke, so typing stays smooth. */
const HISTORY_SEARCH_DEBOUNCE_MS = 300;
const COMPOSER_PLACEHOLDER = "파일, 메일, 메신저 전체에서 물어보세요 (파일 드래그 앤 드롭 가능)";
const CENTERED = "mx-auto w-full max-w-[820px]";

/**
 * Imperative surface the shell drives on the active AI Search tab: ⌘K focuses
 * the composer, the sidebar's content search sends a query, "AI 요약" attaches
 * and sends in one step, and a drop on the tab / sidebar item attaches files.
 * Drops on the panel itself (Finder rows, files from other apps, browser links)
 * land here directly.
 */
export interface AiDockHandle {
	/** Seed the composer with `text` and send it at once. */
	sendQuery(text: string): void;
	/** Append draft attachments and focus the composer. */
	attach(atts: readonly ChatAttachment[]): void;
	/**
	 * "AI 요약": fold the target into the dock's drafts and send the summary run
	 * as one step. Sending is a single call because `attach` only reaches
	 * `attachmentsRef` on the next render, so an attach-then-send pair would
	 * leave the attachment out of the run.
	 */
	summarize(atts: readonly ChatAttachment[]): void;
	/** Focus the composer (pending until the panel is the visible tab). */
	focusComposer(): void;
}

export interface AiSearchPanelProps {
	/**
	 * The panel's tab is the focused one: it answers shortcuts and publishes
	 * its evidence. A hidden panel keeps its chat.
	 */
	readonly active: boolean;
	/** The panel's tab is on screen in some pane (split panes show several). */
	readonly visible: boolean;
	readonly selectedEvidence: number | null;
	readonly onSelectEvidence: (number: number) => void;
	readonly onPublish: (evidence: readonly CitationEvidence[], sessionId: string | null) => void;
	/** Images in an answer: a local picture opens in Quick Look, a web image's page in the OS browser. */
	readonly imageActions: ImageActions;
	/** The Interface language setting: "AI 요약" asks in this language. */
	readonly language: SummaryLanguage;
}

/** The parent folder of a local attachment, derived from its absolute path. */
function parentFolder(att: ChatAttachment): string | null {
	if (att.kind !== "file" && att.kind !== "folder") return null;
	const parts = att.id.split(/[\\/]/u).filter((part) => part.length > 0);
	return parts.length >= 2 ? parts[parts.length - 2] ?? null : null;
}

function formatElapsed(ms: number): string {
	return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export const AiSearchPanel = forwardRef<AiDockHandle, AiSearchPanelProps>(function AiSearchPanel(
	{ active, visible, selectedEvidence, onSelectEvidence, onPublish, imageActions, language },
	ref,
): ReactElement {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [quick, setQuick] = useState<AnswerPhase | null>(null);
	const [deep, setDeep] = useState<AnswerPhase | null>(null);
	const [quickDraft, setQuickDraft] = useState("");
	const [deepDraft, setDeepDraft] = useState("");
	const [progress, setProgress] = useState("");
	const [searchId, setSearchIdState] = useState<string | null>(null);
	// The event listener reads the active id from a ref: it is set before
	// search.start is invoked, so no event of the new run can arrive while a
	// re-subscription is still pending.
	const searchIdRef = useRef<string | null>(null);
	const setSearchId = (value: string | null): void => {
		searchIdRef.current = value;
		setSearchIdState(value);
	};
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stopped, setStopped] = useState(false);
	const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
	const [submittedAttachments, setSubmittedAttachments] = useState<readonly ChatAttachment[]>([]);
	const [chatId, setChatId] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [history, setHistory] = useState<readonly ChatSummary[]>([]);
	const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
	const [deepElapsed, setDeepElapsed] = useState<number | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	const [dragName, setDragName] = useState<string | null>(null);
	const lastDragAtRef = useRef(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const historySeq = useRef(0);
	const historyDebounce = useRef<number | null>(null);
	const startedAtRef = useRef(0);
	const pendingFocusRef = useRef(false);
	const activeRef = useRef(active);
	activeRef.current = active;
	const attachmentsRef = useRef(attachments);
	attachmentsRef.current = attachments;

	useEffect(() => {
		if (!active) {
			setHistoryOpen(false);
			return;
		}
		if (!pendingFocusRef.current) return;
		pendingFocusRef.current = false;
		inputRef.current?.focus();
	}, [active]);

	useEffect(
		() => () => {
			if (historyDebounce.current !== null) window.clearTimeout(historyDebounce.current);
		},
		[],
	);

	useEffect(() => {
		const unsubscribe = autorag.search.onEvent?.((event: SearchStreamEvent) => {
			if (event.searchId !== searchIdRef.current) return;
			switch (event.type) {
				case "progress":
					setProgress(event.text);
					break;
				case "thinking":
					// The reasoning text never crosses IPC; the panel's own pending
					// state drives the water-wave row, so the signal needs no state.
					break;
				case "quick-draft":
					setQuickDraft(event.text);
					break;
				case "deep-draft":
					setDeepDraft(event.text);
					break;
				case "quick":
					setSessionId(event.sessionId);
					setQuick(event.phase);
					setQuickDraft(event.phase.answer);
					setProgress("");
					break;
				case "deep":
					setSessionId(event.sessionId);
					setDeep(event.phase);
					setDeepDraft(event.phase.answer);
					setDeepElapsed(startedAtRef.current === 0 ? null : Date.now() - startedAtRef.current);
					setProgress("");
					break;
				case "error":
					setError(event.message);
					setProgress("");
					setSearchId(null);
					break;
				case "cancelled":
					setStopped(true);
					setProgress("");
					setSearchId(null);
					break;
				case "done":
					setProgress("");
					setSearchId(null);
					break;
			}
		});
		return unsubscribe;
	}, []);

	const evidence = useMemo(() => deep?.evidence ?? quick?.evidence ?? [], [deep, quick]);

	// Only the visible tab's chat feeds the inspector; it keeps that evidence
	// while the user browses folders in other tabs.
	useEffect(() => {
		if (active) onPublish(evidence, sessionId);
	}, [active, evidence, sessionId, onPublish]);

	const historyGroups = useMemo(() => groupChatHistory(history, new Date()), [history]);

	useEffect(() => {
		const body = bodyRef.current;
		if (body !== null) body.scrollTop = body.scrollHeight;
	}, [quick, deep, quickDraft, deepDraft, submittedQuery, progress, attachments]);

	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const meta = event.metaKey || event.ctrlKey;
			if (meta && event.shiftKey && event.key.toLowerCase() === "h") {
				event.preventDefault();
				toggleHistory();
				return;
			}
			if (historyOpen && event.key === "Escape") {
				event.preventDefault();
				setHistoryOpen(false);
				return;
			}
			if (historyOpen) return;
			if (event.key === "Escape" && searchIdRef.current !== null) {
				event.preventDefault();
				void stop();
				return;
			}
			if (meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				newChat();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	useEffect(() => {
		if (!visible) return;
		const onDragOver = (event: globalThis.DragEvent): void => {
			if (event.dataTransfer === null || !isAttachmentDrag(event.dataTransfer.types)) return;
			if (event.clientX <= 0 && event.clientY <= 0) {
				lastDragAtRef.current = 0;
				setDragActive(false);
				setDragOver(false);
				setDragName(null);
				return;
			}
			lastDragAtRef.current = Date.now();
			setDragActive(true);
		};
		const reset = (): void => {
			lastDragAtRef.current = 0;
			setDragActive(false);
			setDragOver(false);
			setDragName(null);
		};
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", reset);
		window.addEventListener("dragend", reset);
		const watchdog = window.setInterval(() => {
			if (lastDragAtRef.current !== 0 && Date.now() - lastDragAtRef.current > 1000) reset();
		}, 250);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", reset);
			window.removeEventListener("dragend", reset);
			window.clearInterval(watchdog);
			reset();
		};
	}, [visible]);

	async function runSearch(text: string, sent: readonly ChatAttachment[]): Promise<void> {
		if (searchIdRef.current !== null) return;
		const nextChatId = crypto.randomUUID();
		const nextSearchId = crypto.randomUUID();
		setSearchId(nextSearchId);
		setQuick(null);
		setDeep(null);
		setQuickDraft("");
		setDeepDraft("");
		setSessionId(null);
		setError(null);
		setStopped(false);
		setSubmittedQuery(text);
		setSubmittedAttachments(sent);
		setDeepElapsed(null);
		setProgress("Reviewing the query.");
		setChatId(nextChatId);
		startedAtRef.current = Date.now();
		setAttachments([]);
		setQuery("");
		try {
			// Resolves when the run ends; the answer itself arrives as events.
			await autorag.search.start(nextSearchId, nextChatId, text, sent);
		} catch (startError) {
			if (searchIdRef.current !== nextSearchId) return;
			setError(startError instanceof Error ? startError.message : String(startError));
			setProgress("");
			setSearchId(null);
		}
	}

	function submit(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		const text = query.trim();
		if (text.length === 0 || searchIdRef.current !== null) return;
		void runSearch(text, attachments);
	}

	function clearHistoryDebounce(): void {
		if (historyDebounce.current === null) return;
		window.clearTimeout(historyDebounce.current);
		historyDebounce.current = null;
	}

	async function openHistory(): Promise<void> {
		clearHistoryDebounce();
		historySeq.current += 1;
		const seq = historySeq.current;
		const items = await autorag.search.historyList();
		if (seq !== historySeq.current) return;
		setHistory(items);
		setHistoryQuery("");
		setHistoryOpen(true);
	}

	function closeHistory(): void {
		clearHistoryDebounce();
		setHistoryOpen(false);
	}

	function toggleHistory(): void {
		if (historyOpen) {
			closeHistory();
			return;
		}
		void openHistory();
	}

	/** The store owns the matching (every question and answer body); a stale reply never lands after a newer keystroke. */
	async function searchHistory(value: string): Promise<readonly ChatSummary[]> {
		setHistoryQuery(value);
		historySeq.current += 1;
		const seq = historySeq.current;
		const items = await autorag.search.historySearch(value);
		if (seq !== historySeq.current) return [];
		setHistory(items);
		return items;
	}

	/** Coalesce keystrokes so one query reaches the store per 300ms burst of typing. */
	function onHistoryQueryChange(value: string): void {
		setHistoryQuery(value);
		clearHistoryDebounce();
		historyDebounce.current = window.setTimeout(() => {
			historyDebounce.current = null;
			void searchHistory(value);
		}, HISTORY_SEARCH_DEBOUNCE_MS);
	}

	function newChat(): void {
		clearHistoryDebounce();
		setQuick(null);
		setDeep(null);
		setQuickDraft("");
		setDeepDraft("");
		setError(null);
		setStopped(false);
		setProgress("");
		setQuery("");
		setSubmittedQuery(null);
		setSubmittedAttachments([]);
		setAttachments([]);
		setChatId(null);
		setHistoryOpen(false);
		setDeepElapsed(null);
	}

	async function loadHistory(id: string): Promise<void> {
		clearHistoryDebounce();
		const record = await autorag.search.historyGet(id);
		const assistant = record?.messages.findLast((message) => message.role === "assistant");
		if (assistant?.role !== "assistant") return;
		const user = record?.messages.findLast((message) => message.role === "user");
		setQuick(assistant.quick);
		setDeep(assistant.deep);
		setQuickDraft(assistant.quick?.answer ?? "");
		setDeepDraft(assistant.deep?.answer ?? "");
		setSessionId(assistant.sessionId);
		setSubmittedQuery(user?.role === "user" ? user.text : null);
		setSubmittedAttachments(user?.role === "user" ? user.attachments : []);
		setStopped(assistant.stopped);
		setError(null);
		setProgress("");
		setChatId(id);
		setHistoryOpen(false);
		// The store keeps no timing, so a restored chat shows its deep answer
		// without a "Worked for Ns" label rather than inventing a duration.
		setDeepElapsed(null);
	}

	async function stop(): Promise<void> {
		const id = searchIdRef.current;
		if (id === null) return;
		// Drop the generating look before the IPC round trip: Stop is instant and
		// no pending shimmer or Thinking row survives the cancel, whatever the
		// backend was still doing.
		setSearchId(null);
		setProgress("");
		setStopped(true);
		await autorag.search.cancel(id);
	}

	function removeAttachment(index: number): void {
		setAttachments((current) => current.filter((_, position) => position !== index));
	}

	function ensureFocus(): void {
		if (activeRef.current) {
			inputRef.current?.focus();
			return;
		}
		// The effect above focuses the input once this tab is the visible one.
		pendingFocusRef.current = true;
	}

	useImperativeHandle(ref, () => ({
		sendQuery(text: string): void {
			const trimmed = text.trim();
			if (trimmed.length === 0 || searchIdRef.current !== null) return;
			setQuery(trimmed);
			void runSearch(trimmed, attachmentsRef.current);
		},
		attach(atts: readonly ChatAttachment[]): void {
			setAttachments((current) => mergeAttachments(current, atts));
			ensureFocus();
		},
		summarize(atts: readonly ChatAttachment[]): void {
			if (searchIdRef.current !== null) return;
			const request = summaryRequest(language, attachmentsRef.current, atts);
			void runSearch(request.prompt, request.attachments);
		},
		focusComposer(): void {
			ensureFocus();
		},
	}));

	function onDockDragEnter(event: ReactDragEvent): void {
		if (!isAttachmentDrag(event.dataTransfer.types)) return;
		lastDragAtRef.current = Date.now();
		event.preventDefault();
		setDragActive(true);
		setDragOver(true);
	}

	function onDockDragOver(event: ReactDragEvent): void {
		if (!isAttachmentDrag(event.dataTransfer.types)) return;
		lastDragAtRef.current = Date.now();
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setDragActive(true);
		setDragOver(true);
		const item = event.dataTransfer.items?.[0];
		const file = item?.kind === "file" ? item.getAsFile() : null;
		setDragName(file?.name ?? null);
	}

	function onDockDragLeave(event: ReactDragEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		setDragOver(false);
		setDragName(null);
	}

	function onDockDrop(event: ReactDragEvent): void {
		if (!isAttachmentDrag(event.dataTransfer.types)) return;
		event.preventDefault();
		const dropped = attachmentsFromDrop(event.dataTransfer, autorag.pathForFile);
		setDragActive(false);
		setDragOver(false);
		setDragName(null);
		if (dropped.length === 0) return;
		setAttachments((current) => mergeAttachments(current, dropped));
		ensureFocus();
	}

	const quickText = quick !== null ? quick.answer : quickDraft;
	const deepText = deep !== null ? deep.answer : deepDraft;
	// A phase's citations resolve against that phase's own evidence: the
	// librarian numbers quick and deep independently, and the verification
	// phase can cite fast-answer units that never reach its `results`, leaving
	// some chips with nothing to open.
	const quickUnresolved = useMemo(() => unresolvedCitationNumbers(quickText, quick?.evidence ?? []), [quickText, quick]);
	const deepUnresolved = useMemo(() => unresolvedCitationNumbers(deepText, deep?.evidence ?? []), [deepText, deep]);
	const quickReady = quickText !== "";
	const deepReady = deepText !== "";
	const { skeleton, thinking } = answerViewState({
		pending: searchId !== null,
		quickReady,
		deepReady,
	});
	const showEmpty = submittedQuery === null && error === null && !quickReady && !deepReady;

	return (
		<section
			className={cn("ai relative min-h-0 flex-1 flex-col bg-subtle-alt", visible ? "flex" : "hidden")}
			aria-label="AI Search"
			aria-hidden={visible ? undefined : true}
			data-focused={active ? "true" : undefined}
			onDragEnter={onDockDragEnter}
			onDragOver={onDockDragOver}
			onDragLeave={onDockDragLeave}
			onDrop={onDockDrop}
		>
			<div className="ai-head flex flex-none items-center gap-8 h-tab px-12 border-b border-border select-none">
				<span className="ai-mark grid flex-none place-items-center text-accent">
					<SparklesIcon />
				</span>
				<strong className="flex-none text-sm font-semibold text-ink">AI Search</strong>
				<span className="flex-1" />
				<button
					type="button"
					className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), historyOpen && "bg-selected-nav text-ink")}
					title={t("aiSearch.historyShortcut", { shortcut: formatShortcut({ key: "H", shift: true }), defaultValue: `Chat history ${formatShortcut({ key: "H", shift: true })}` })}
					aria-label="Chat history"
					onClick={() => toggleHistory()}
				>
					<HistoryIcon size={15} />
				</button>
				<button
					type="button"
					className={iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" })}
					title={t("aiSearch.newChatShortcut", { shortcut: formatShortcut({ key: "N" }), defaultValue: `New chat ${formatShortcut({ key: "N" })}` })}
					aria-label="New chat"
					onClick={() => newChat()}
				>
					<PlusIcon />
				</button>
			</div>

			{historyOpen ? (
				<>
					<div className="absolute inset-0 z-20" aria-hidden="true" onClick={closeHistory} />
					<div className="history absolute right-12 top-40 z-30 flex max-h-[72%] w-360 flex-col overflow-hidden rounded-12 border border-border bg-window shadow-menu" aria-label="Chat history">
						<input
							autoFocus
							value={historyQuery}
							onChange={(event) => onHistoryQueryChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									event.stopPropagation();
									closeHistory();
									return;
								}
								if (event.key !== "Enter") return;
								event.preventDefault();
								// Flush the debounce so Enter opens the first hit of what is typed right now.
								clearHistoryDebounce();
								const value = event.currentTarget.value;
								void searchHistory(value).then((items) => {
									const first = items[0];
									if (first !== undefined) void loadHistory(first.id);
								});
							}}
							placeholder={t("aiSearch.searchHistory", "대화 기록 검색")}
							aria-label={t("aiSearch.searchHistory", "대화 기록 검색")}
							className="h-[38px] w-full flex-none border-x-0 border-t-0 border-b border-divider bg-transparent px-12 text-sm text-ink outline-none placeholder:text-ink-muted"
						/>
						<div className="history-list min-h-0 flex-1 overflow-auto p-5">
							{historyGroups.length === 0 ? (
								<span className="block px-12 py-28 text-center text-meta text-ink-muted">{historyEmptyText(historyQuery, (k, opt) => (opt ? t(k, opt) : t(k)))}</span>
							) : (
								historyGroups.map((group) => (
									<div key={group.label}>
										<div className="history-group px-8 py-8 text-tile font-bold text-ink-muted">
											{group.label === "오늘" ? t("aiSearch.historyGroups.today", group.label) :
											 group.label === "어제" ? t("aiSearch.historyGroups.yesterday", group.label) :
											 group.label === "지난 7일" ? t("aiSearch.historyGroups.last7Days", group.label) :
											 group.label === "지난 30일" ? t("aiSearch.historyGroups.last30Days", group.label) :
											 t("aiSearch.historyGroups.older", group.label)}
										</div>
										{group.items.map((item) => (
											<button
												type="button"
												key={item.id}
												className={cn(
													"history-item flex w-full items-start gap-8 rounded-7 border-0 p-8 text-sm text-left cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-accent-history-current",
													item.id === chatId ? "current bg-accent-history-current" : "bg-transparent",
												)}
												onClick={() => void loadHistory(item.id)}
											>
												<span className={cn("hist-dot mt-5 size-5 flex-none rounded-full", item.id === chatId ? "bg-accent" : "bg-transparent")} />
												<span className="hist-copy min-w-0 flex-1">
													<b className="block truncate font-bold text-ink">{item.title}</b>
													<small className="mt-2 block truncate text-badge text-ink-muted">{item.snippet}</small>
												</span>
												<span className="hist-time flex-none text-tile text-ink-muted">{item.time}</span>
											</button>
										))}
									</div>
								))
							)}
						</div>
					</div>
				</>
			) : null}

			<div ref={bodyRef} className="ai-body min-h-0 flex-1 overflow-auto px-20 py-16">
				<div className={cn(CENTERED, "flex flex-col space-y-16")}>
					{showEmpty ? (
						<div className="ai-empty my-28 text-center">
							<strong className="block text-title font-semibold text-ink">{t("aiSearch.emptyPromptTitle", "무엇을 찾아드릴까요?")}</strong>
							<p className="mt-8 text-body leading-[1.5] text-ink-muted break-keep">{t("aiSearch.emptyPromptDesc", "파일, 메일, 메신저 전체에서 찾아 빠른 답변과 정밀한 답변을 함께 드립니다.")}</p>
						</div>
					) : null}

					{submittedQuery === null ? null : (
						<div className="message user-msg flex justify-end">
							<div className="user-bubble-wrap flex max-w-bubble-max flex-col items-end gap-6">
								{submittedAttachments.length > 0 ? (
									<div className="ref-attachments flex flex-wrap justify-end gap-6">
										{submittedAttachments.map((att) => (
											<RefFileChip key={`${att.id}:${att.name}`} att={att} />
										))}
									</div>
								) : null}
								<div className="bubble w-full rounded-10 border border-border bg-input px-14 py-10 text-body leading-[1.5] text-ink-body break-words">{submittedQuery}</div>
							</div>
						</div>
					)}

					{error === null ? null : <div className="rounded-10 border border-danger-border bg-danger-bg-soft px-14 py-10 text-body text-danger-text">{error}</div>}

					{submittedQuery === null ? null : (
						<div className="message assistant-msg flex flex-col gap-14">
							{quickReady ? (
								<div className="assistant-prose flex flex-col gap-8 text-body leading-[1.55] text-ink-body">
									<ProseBlocks text={quickText} selected={selectedEvidence} unresolved={quickUnresolved} onCitation={onSelectEvidence} imageActions={imageActions} />
								</div>
							) : skeleton ? (
								<div className="flex flex-col gap-8">
									<span className="skeleton block h-8 w-[85%] rounded-4 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer" />
									<span className="skeleton block h-8 w-[65%] rounded-4 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer" />
								</div>
							) : null}

							{thinking ? (
								<div className="water-wave-thinking my-6 flex items-center gap-8 text-meta text-ink-muted">
									<span className="size-7 flex-none rounded-full bg-info-dot animate-[pulseDot_1.4s_ease-in-out_infinite]" />
									<span className="min-w-0 truncate">{t("aiSearch.thinking", "Thinking…")}{progress === "" ? "" : ` ${progress}`}</span>
								</div>
							) : null}

							{deepReady ? (
								<div className="flex flex-col gap-6">
									{deepElapsed === null ? null : (
										<div className="thinking-header flex items-center gap-5 text-meta font-medium text-ink-muted">
											<span>{t("aiSearch.workedFor", { time: formatElapsed(deepElapsed), defaultValue: `Worked for ${formatElapsed(deepElapsed)}` })}</span>
										</div>
									)}
									<div className="assistant-prose flex flex-col gap-8 text-body leading-[1.55] text-ink-body">
										<ProseBlocks text={deepText} selected={selectedEvidence} unresolved={deepUnresolved} onCitation={onSelectEvidence} imageActions={imageActions} />
									</div>
								</div>
							) : null}
						</div>
					)}

					{stopped ? <div className="text-body text-ink-muted">{t("aiSearch.stopped", "응답 생성을 중단했습니다.")}</div> : null}
				</div>
			</div>

			<form className="composer flex-none px-20 pt-8 pb-14" onSubmit={submit}>
				<div className={CENTERED}>
					{attachments.length > 0 ? (
						<div className="composer-attach-tray flex flex-wrap items-center gap-6 pb-6">
							{attachments.map((att, index) => (
								<span key={`${att.id}:${att.name}`} className="composer-attach-pill inline-flex h-chip-draft items-center gap-5 rounded-5 bg-selected-nav px-8 text-badge text-ink" title={att.id}>
									<AttachmentGlyph att={att} />
									<span className="max-w-[180px] truncate">{att.name}</span>
									<button
										type="button"
										className="flex size-16 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-muted transition-[background,color] duration-(--dur-color) ease-out hover:bg-hover-strong hover:text-danger-text"
										aria-label="첨부 제거"
										title="첨부 제거"
										onClick={() => removeAttachment(index)}
									>
										<CloseIcon size={10} />
									</button>
								</span>
							))}
						</div>
					) : null}
					<div className="compose-box flex min-h-40 items-center gap-7 rounded-12 border border-border bg-input px-11 py-4 transition-colors duration-(--dur-color) ease-out focus-within:border-accent">
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("aiSearch.askAutoRAG", COMPOSER_PLACEHOLDER)}
							aria-label="Ask AutoRAG"
							disabled={searchId !== null}
							className="h-30 min-w-0 flex-1 border-0 bg-transparent text-body text-ink-body outline-none placeholder:text-ink-muted"
						/>
						{searchId === null ? (
							<button
								type="submit"
								className="send flex size-32 flex-none items-center justify-center rounded-full border-0 bg-accent text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-accent-hover disabled:cursor-default disabled:bg-border-strong"
								title="Ask AutoRAG"
								aria-label="Ask AutoRAG"
								disabled={query.trim().length === 0 && attachments.length === 0}
							>
								<ArrowUpIcon />
							</button>
						) : (
							<button
								type="button"
								className="send flex size-32 flex-none items-center justify-center rounded-full border-0 bg-ink text-on-accent cursor-pointer"
								title={t("aiSearch.stop", "중단")}
								aria-label={t("aiSearch.stop", "중단")}
								onClick={() => void stop()}
							>
								<Square size={10} strokeWidth={3} fill="currentColor" />
							</button>
						)}
					</div>
				</div>
			</form>

			{dragActive ? (
				<div className="pointer-events-none absolute inset-8 z-20 flex flex-col items-center justify-center gap-10 rounded-14 border-[1.5px] border-dashed border-accent bg-accent-drop-hover backdrop-blur-sm">
					<span className="relative flex size-64 items-center justify-center rounded-12 bg-accent-soft text-accent">
						<SparklesIcon size={28} />
						<span className="absolute -bottom-4 -right-4 flex size-22 items-center justify-center rounded-full bg-accent text-badge font-bold text-on-accent">+</span>
					</span>
					<span className="text-body font-medium text-ink">{dragOver ? t("aiSearch.dropAttach", "놓으면 대화에 첨부됩니다") : t("aiSearch.dropPrompt", "여기로 끌어서 AI에게 물어보기")}</span>
					{dragName === null ? null : <span className="text-meta text-ink-muted">{dragName}</span>}
				</div>
			) : null}
		</section>
	);
});

/** The 16px glyph of an attachment chip: the file-kind tile, the folder glyph, or a link badge. */
function AttachmentGlyph({ att }: { readonly att: ChatAttachment }): ReactElement {
	switch (att.kind) {
		case "url":
			return (
				<span className="flex size-16 flex-none items-center justify-center rounded-4 bg-accent-soft text-accent" aria-hidden="true">
					<LinkIcon size={11} />
				</span>
			);
		case "folder":
			return <FileTile kind="folder" size={16} />;
		case "file":
			return <FileTile kind={evidenceKind(att.name)} size={16} />;
	}
}

/** A referenced file badge above the user bubble (v7 `.ref-file-chip`). */
function RefFileChip({ att }: { readonly att: ChatAttachment }): ReactElement {
	const folder = parentFolder(att);
	return (
		<span className="ref-file-chip inline-flex h-chip items-center gap-6 rounded-6 border border-border bg-input px-8 text-ink" title={att.id}>
			<AttachmentGlyph att={att} />
			<span className="ref-chip-name text-meta font-medium text-ink">{att.name}</span>
			{folder === null ? null : <span className="ref-chip-sub text-badge text-ink-muted">· {folder}</span>}
		</span>
	);
}

function ProseBlocks({
	text,
	selected,
	unresolved,
	onCitation,
	imageActions,
}: {
	readonly text: string;
	readonly selected: number | null;
	/** Citation numbers with no matching evidence entry; their markers are dropped. */
	readonly unresolved: readonly number[];
	readonly onCitation: (number: number) => void;
	readonly imageActions: ImageActions;
}): ReactElement {
	return (
		<>
			{parseAnswerBlocks(text).map((block, index) => (
				<AnswerBlockView key={`${index}`} block={block} selected={selected} unresolved={unresolved} onCitation={onCitation} imageActions={imageActions} />
			))}
		</>
	);
}

function AnswerBlockView({
	block,
	selected,
	unresolved,
	onCitation,
	imageActions,
}: {
	readonly block: AnswerBlock;
	readonly selected: number | null;
	readonly unresolved: readonly number[];
	readonly onCitation: (number: number) => void;
	readonly imageActions: ImageActions;
}): ReactElement {
	if (block.kind === "code") {
		return <pre className="m-0 overflow-auto whitespace-pre rounded-6 border border-border bg-code px-10 py-8 font-mono text-caption text-ink-body">{block.text}</pre>;
	}
	const parsed = parseInline(block.text);
	const segments = parsed.map((segment, index) => {
		switch (segment.kind) {
			case "bold":
				return (
					<strong key={`${index}`} className="font-semibold text-ink">
						{segment.text}
					</strong>
				);
			case "code":
				return (
					<code key={`${index}`} className="rounded-4 bg-code px-4 py-1 font-mono text-caption text-ink-body">
						{segment.text}
					</code>
				);
			case "image":
				// A markdown image is the picture below the line; a path the model
				// wrote in the sentence stays readable where it was written.
				if (segment.source === "markdown") return null;
				return segment.source === "code" ? (
					<code key={`${index}`} className="rounded-4 bg-code px-4 py-1 font-mono text-caption text-ink-body break-all">
						{segment.target}
					</code>
				) : (
					<span key={`${index}`} className="break-all">
						{segment.target}
					</span>
				);
			case "citation":
				// A citation whose number has no matching evidence entry (a real
				// library behavior: see Marker-Inc-Korea/AutoRAG#1788) is dropped
				// from the rendered answer. There is nothing to open, so leaving a
				// dead marker would only mislead; the run's real evidence list is
				// unaffected.
				if (unresolved.includes(segment.number)) {
					return null;
				}
				return (
					<button
						type="button"
						key={`${index}`}
						className={cn(
							"cite mx-2 inline-flex h-18 min-w-18 items-center justify-center rounded-5 border-0 px-5 align-[1.5px] text-badge font-semibold cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease]",
							segment.number === selected ? "active bg-accent text-on-accent" : "bg-accent-wash text-accent-text hover:bg-accent-soft",
						)}
						onClick={() => onCitation(segment.number)}
					>
						{segment.number}
					</button>
				);
			default:
				return <span key={`${index}`}>{segment.text}</span>;
		}
	});
	const images = lineImages(parsed);
	let line: ReactElement;
	switch (block.kind) {
		case "heading":
			line = <div className="text-body font-semibold text-ink">{segments}</div>;
			break;
		case "list":
			line = (
				<div className="flex gap-8">
					<span className="text-ink-muted">–</span>
					<span>{segments}</span>
				</div>
			);
			break;
		case "quote":
			line = <div className="pl-10 text-ink-muted shadow-[inset_2px_0_0_var(--border)]">{segments}</div>;
			break;
		default:
			line = <p className="m-0 whitespace-pre-wrap break-keep">{segments}</p>;
	}
	if (images.length === 0) return line;
	return (
		<div className="flex flex-col gap-8">
			{isImageOnlyLine(parsed) ? null : line}
			<ImageRow images={images} folder={null} captioned={false} actions={imageActions} />
		</div>
	);
}
