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
import { composerAction, deliverSteers, restoreChat, settleSteers, type SteerItem } from "../state/steering";
import { isImageOnlyLine, parseAnswerBlocks, parseInline, type AnswerBlock } from "../state/answer-markdown";
import { summaryRequest, type SummaryLanguage } from "../state/ai-summary";
import { answerViewState } from "../state/answer-view";
import { attachmentsFromDrop, isAttachmentDrag, mergeAttachments } from "../state/attachments";
import { ImageRow, lineImages, type ImageActions } from "./AnswerImage";
import {
	collectSessionEvidence,
	evidenceKind,
	resolveActiveEvidence,
	unresolvedCitationNumbers,
	type EvidenceSelectionSource,
} from "../state/evidence";
import { groupChatHistory, HISTORY_BUCKET_KEYS, historyEmptyText } from "../state/history";
import { cn } from "../lib/cn";
import { enterKeyLabel, formatShortcut } from "../lib/shortcuts";
import { ArrowUpIcon, CheckIcon, CloseIcon, HistoryIcon, LinkIcon, PlusIcon, SparklesIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { FileTile } from "./primitives/FileTile";

const autorag = window.autorag;

/** History search fires this long after the last keystroke, so typing stays smooth. */
const HISTORY_SEARCH_DEBOUNCE_MS = 300;
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
	readonly onPublish: (evidence: readonly CitationEvidence[], sessionEvidence?: readonly CitationEvidence[]) => void;
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
	const [error, setError] = useState<string | null>(null);
	const [stopped, setStopped] = useState(false);
	const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
	const [submittedAttachments, setSubmittedAttachments] = useState<readonly ChatAttachment[]>([]);
	const [chatId, setChatId] = useState<string | null>(null);
	/** Earlier turns of this chat, oldest first; the live state above is the latest turn. */
	const [pastTurns, setPastTurns] = useState<readonly PastTurn[]>([]);
	const pastTurnsRef = useRef(pastTurns);
	pastTurnsRef.current = pastTurns;
	const chatIdRef = useRef(chatId);
	/** Which turn and phase's citation chip the user clicked last; null uses the newest non-empty turn. */
	const [evidenceSource, setEvidenceSource] = useState<EvidenceSelectionSource | null>(null);
	chatIdRef.current = chatId;
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [history, setHistory] = useState<readonly ChatSummary[]>([]);
	const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
	/** Corrections sent while the current run streamed, in send order. */
	const [steers, setSteers] = useState<readonly SteerItem[]>([]);
	/** Questions queued with ⌥Enter during a run, asked one by one once it ends. */
	const [queued, setQueued] = useState<readonly string[]>([]);
	const queuedRef = useRef(queued);
	queuedRef.current = queued;
	/** The current run already showed its Quick answer (read by steer timing). */
	const quickShownRef = useRef(false);
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

	const submittedQueryRef = useRef(submittedQuery);
	submittedQueryRef.current = submittedQuery;
	const submittedAttachmentsRef = useRef(submittedAttachments);
	submittedAttachmentsRef.current = submittedAttachments;
	const steersRef = useRef(steers);
	steersRef.current = steers;
	const quickRef = useRef(quick);
	quickRef.current = quick;
	const deepRef = useRef(deep);
	deepRef.current = deep;
	const quickDraftRef = useRef(quickDraft);
	quickDraftRef.current = quickDraft;
	const deepDraftRef = useRef(deepDraft);
	deepDraftRef.current = deepDraft;
	const stoppedRef = useRef(stopped);
	stoppedRef.current = stopped;
	const errorRef = useRef(error);
	errorRef.current = error;
	const deepElapsedRef = useRef(deepElapsed);
	deepElapsedRef.current = deepElapsed;

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
					setQuick(event.phase);
					setQuickDraft(event.phase.answer);
					if (deepRef.current === null) setDeepDraft("");
					setProgress("");
					quickShownRef.current = true;
					break;
				case "deep":
					setDeep(event.phase);
					setEvidenceSource(null);
					setDeepDraft(event.phase.answer);
					setDeepElapsed(startedAtRef.current === 0 ? null : Date.now() - startedAtRef.current);
					setProgress("");
					break;
				case "steer-delivered":
					setSteers(deliverSteers);
					break;
				case "error":
					setError(event.message);
					setProgress("");
					setSteers(settleSteers);
					setSearchId(null);
					break;
				case "cancelled":
					setStopped(true);
					setProgress("");
					setSteers(settleSteers);
					setSearchId(null);
					break;
				case "done":
					setProgress("");
					setSteers(settleSteers);
					setSearchId(null);
					break;
			}
		});
		return unsubscribe;
	}, []);

	// A question queued with ⌥Enter is asked as soon as the run it waited on ends.
	useEffect(() => {
		const [next, ...rest] = queued;
		if (searchId !== null || next === undefined) return;
		setQueued(rest);
		void runSearch(next, attachmentsRef.current);
	}, [searchId, queued]);

	const allTurnPhases = useMemo(
		() => [...pastTurns.map((turn) => ({ quick: turn.quick, deep: turn.deep })), { quick, deep }],
		[pastTurns, quick, deep],
	);
	const evidence = useMemo(
		() => resolveActiveEvidence(allTurnPhases, evidenceSource),
		[allTurnPhases, evidenceSource],
	);
	const sessionEvidence = useMemo(() => {
		const phases: (AnswerPhase | null)[] = [];
		for (const turn of pastTurns) {
			phases.push(turn.quick, turn.deep);
		}
		phases.push(quick, deep);
		return collectSessionEvidence(phases);
	}, [pastTurns, quick, deep]);

	// Only the visible tab's chat feeds the inspector; it keeps that evidence
	// while the user browses folders in other tabs.
	useEffect(() => {
		if (active) onPublish(evidence, sessionEvidence);
	}, [active, evidence, sessionEvidence, onPublish]);

	function selectPhaseCitation(turnIndex: number, phase: "quick" | "deep", number: number): void {
		const nextSource: EvidenceSelectionSource = { turnIndex, phase };
		setEvidenceSource(nextSource);
		const nextEvidence = resolveActiveEvidence(allTurnPhases, nextSource);
		if (active) onPublish(nextEvidence, sessionEvidence);
		onSelectEvidence(number);
	}

	const historyGroups = useMemo(() => groupChatHistory(history, new Date()), [history]);

	useEffect(() => {
		const body = bodyRef.current;
		if (body !== null) body.scrollTop = body.scrollHeight;
	}, [quick, deep, quickDraft, deepDraft, submittedQuery, progress, attachments, steers, queued, pastTurns]);

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
		// Only New chat starts a new chat; any other question continues the current one.
		const nextChatId = chatIdRef.current ?? crypto.randomUUID();
		const nextSearchId = crypto.randomUUID();
		if (submittedQueryRef.current !== null) {
			const finished: PastTurn = {
				question: submittedQueryRef.current,
				attachments: submittedAttachmentsRef.current,
				steers: steersRef.current,
				quick: quickRef.current,
				deep: deepRef.current,
				quickText: quickRef.current?.answer ?? quickDraftRef.current,
				deepText: deepRef.current?.answer ?? deepDraftRef.current,
				stopped: stoppedRef.current,
				error: errorRef.current,
				deepElapsed: deepElapsedRef.current,
			};
			setPastTurns((current) => [...current, finished]);
		}
		setSearchId(nextSearchId);
		setQuick(null);
		setEvidenceSource(null);
		setDeep(null);
		setQuickDraft("");
		setDeepDraft("");
		setError(null);
		setStopped(false);
		setSubmittedQuery(text);
		setSubmittedAttachments(sent);
		setSteers([]);
		quickShownRef.current = false;
		setDeepElapsed(null);
		setProgress(t("aiSearch.reviewing"));
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
		send(false);
	}

	/**
	 * Send the composer. Idle: a new question. During a run: Enter steers it
	 * (the text corrects the search in flight) and ⌥Enter queues the text as
	 * the next question. Steers carry text only; drafted attachments stay in
	 * the tray for the next question.
	 */
	function send(altKey: boolean): void {
		const text = query.trim();
		const runId = searchIdRef.current;
		const action = composerAction({ searching: runId !== null, altKey });
		if (action === "ask") {
			if (text.length > 0) void runSearch(text, attachments);
			return;
		}
		if (text.length === 0 || runId === null) return;
		setQuery("");
		if (action === "queue") {
			setQueued((current) => [...current, text]);
			return;
		}
		const id = crypto.randomUUID();
		setSteers((current) => [
			...current,
			{ id, text, timing: quickShownRef.current ? "after-quick" : "before-quick", status: "pending" },
		]);
		void autorag.search.steer(runId, text).then((accepted) => {
			if (accepted) return;
			// The run is past its last model request: ask the text as the next question instead.
			setSteers((current) => current.filter((steer) => steer.id !== id));
			setQueued((current) => [...current, text]);
		});
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
		setEvidenceSource(null);
		setQuery("");
		setSubmittedQuery(null);
		setSubmittedAttachments([]);
		setAttachments([]);
		setSteers([]);
		setQueued([]);
		setChatId(null);
		setPastTurns([]);
		setHistoryOpen(false);
		setDeepElapsed(null);
	}

	async function loadHistory(id: string): Promise<void> {
		clearHistoryDebounce();
		const record = await autorag.search.historyGet(id);
		if (record === null) return;
		const turns = restoreChat(record.messages);
		const latest = turns[turns.length - 1];
		if (latest === undefined) return;
		const assistant = latest.assistant;
		setPastTurns(
			turns.slice(0, -1).map((turn) => ({
				question: turn.question.text,
				attachments: turn.question.attachments,
				steers: turn.steers,
				quick: turn.assistant?.quick ?? null,
				deep: turn.assistant?.deep ?? null,
				quickText: turn.assistant?.quick?.answer ?? "",
				deepText: turn.assistant?.deep?.answer ?? "",
				stopped: turn.assistant?.stopped ?? false,
				error: null,
				deepElapsed: null,
			})),
		);
		setQuick(assistant?.quick ?? null);
		setDeep(assistant?.deep ?? null);
		setQuickDraft(assistant?.quick?.answer ?? "");
		setDeepDraft(assistant?.deep?.answer ?? "");
		setSubmittedQuery(latest.question.text);
		setSubmittedAttachments(latest.question.attachments);
		setSteers(latest.steers);
		setEvidenceSource(null);
		setQueued([]);
		setStopped(assistant?.stopped ?? false);
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
		setSteers(settleSteers);
		// Stop ends the whole turn: questions queued behind it go back to the composer, unasked.
		const unasked = queuedRef.current;
		if (unasked.length > 0) {
			setQuery((current) => [current.trim(), ...unasked].filter((text) => text !== "").join(" "));
			setQueued([]);
		}
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
	const searching = searchId !== null;
	const { skeleton, thinking } = answerViewState({
		pending: searching,
		quickReady,
		deepReady,
	});
	const showEmpty = submittedQuery === null && error === null && !quickReady && !deepReady;
	const steersBeforeQuick = steers.filter((steer) => steer.timing === "before-quick");
	const steersAfterQuick = steers.filter((steer) => steer.timing === "after-quick");
	const steerLabels = {
		pending: t("aiSearch.steerPending"),
		delivered: t("aiSearch.steerDelivered"),
		dropped: t("aiSearch.steerDropped"),
	};

	return (
		<section
			className={cn("ai relative min-h-0 flex-1 flex-col bg-subtle-alt", visible ? "flex" : "hidden")}
			aria-label={t("aiSearch.title")}
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
				<strong className="flex-none text-sm font-semibold text-ink">{t("aiSearch.title")}</strong>
				<span className="flex-1" />
				<button
					type="button"
					className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), historyOpen && "bg-selected-nav text-ink")}
					title={t("aiSearch.historyShortcut", { shortcut: formatShortcut({ key: "H", shift: true }) })}
					aria-label={t("aiSearch.history")}
					onClick={() => toggleHistory()}
				>
					<HistoryIcon size={15} />
				</button>
				<button
					type="button"
					className={iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" })}
					title={t("aiSearch.newChatShortcut", { shortcut: formatShortcut({ key: "N" }) })}
					aria-label={t("aiSearch.newChat")}
					onClick={() => newChat()}
				>
					<PlusIcon />
				</button>
			</div>

			{historyOpen ? (
				<>
					<div className="absolute inset-0 z-20" aria-hidden="true" onClick={closeHistory} />
					<div className="history absolute right-12 top-40 z-30 flex max-h-[72%] w-360 flex-col overflow-hidden rounded-12 border border-border bg-window shadow-menu" aria-label={t("aiSearch.history")}>
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
							placeholder={t("aiSearch.searchHistory")}
							aria-label={t("aiSearch.searchHistory")}
							className="h-[38px] w-full flex-none border-x-0 border-t-0 border-b border-divider bg-transparent px-12 text-sm text-ink outline-none placeholder:text-ink-muted"
						/>
						<div className="history-list min-h-0 flex-1 overflow-auto p-5">
							{historyGroups.length === 0 ? (
								<span className="block px-12 py-28 text-center text-meta text-ink-muted">{historyEmptyText(historyQuery)}</span>
							) : (
								historyGroups.map((group) => (
									<div key={group.label}>
										<div className="history-group px-8 py-8 text-tile font-bold text-ink-muted">
											{t(HISTORY_BUCKET_KEYS[group.label])}
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
							<strong className="block text-title font-semibold text-ink">{t("aiSearch.emptyPromptTitle")}</strong>
							<p className="mt-8 text-body leading-[1.5] text-ink-muted break-keep">{t("aiSearch.emptyPromptDesc")}</p>
						</div>
					) : null}

					{pastTurns.map((turn, index) => (
						<PastTurnView
							key={index}
							turn={turn}
							turnIndex={index}
							activeSource={evidenceSource}
							selectedEvidence={selectedEvidence}
							onCitation={selectPhaseCitation}
							steerLabels={steerLabels}
							imageActions={imageActions}
						/>
					))}

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

					{steersBeforeQuick.map((steer) => (
						<SteerBubble key={steer.id} steer={steer} labels={steerLabels} />
					))}

					{submittedQuery === null ? null : (
						<div className="message assistant-msg flex flex-col gap-14">
							{quickReady ? (
								<div className="assistant-prose flex flex-col gap-8 text-body leading-[1.55] text-ink-body">
									<ProseBlocks
										text={quickText}
										selected={
											evidenceSource === null ||
											(evidenceSource.turnIndex === pastTurns.length && evidenceSource.phase === "quick")
												? selectedEvidence
												: null
										}
										unresolved={quickUnresolved}
										onCitation={(number) => selectPhaseCitation(pastTurns.length, "quick", number)}
										imageActions={imageActions}
									/>
								</div>
							) : skeleton ? (
								<div className="flex flex-col gap-8">
									<span className="skeleton block h-8 w-[85%] rounded-4 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer" />
									<span className="skeleton block h-8 w-[65%] rounded-4 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer" />
								</div>
							) : null}

							{steersAfterQuick.map((steer) => (
								<SteerBubble key={steer.id} steer={steer} labels={steerLabels} />
							))}
							{thinking ? (
								<div className="water-wave-thinking my-6 flex items-center gap-8 text-meta text-ink-muted">
									<span className="size-7 flex-none rounded-full bg-info-dot animate-[pulseDot_1.4s_ease-in-out_infinite]" />
									<span className="min-w-0 truncate">{t("aiSearch.thinking")}{progress === "" ? "" : ` ${progress}`}</span>
								</div>
							) : null}

							{deepReady ? (
								<div className="flex flex-col gap-6">
									{deepElapsed === null ? null : (
										<div className="thinking-header flex items-center gap-5 text-meta font-medium text-ink-muted">
											<span>{t("aiSearch.workedFor", { time: formatElapsed(deepElapsed) })}</span>
										</div>
									)}
									<div className="assistant-prose flex flex-col gap-8 text-body leading-[1.55] text-ink-body">
										<ProseBlocks
											text={deepText}
											selected={
												evidenceSource === null ||
												(evidenceSource.turnIndex === pastTurns.length && evidenceSource.phase === "deep")
													? selectedEvidence
													: null
											}
											unresolved={deepUnresolved}
											onCitation={(number) => selectPhaseCitation(pastTurns.length, "deep", number)}
											imageActions={imageActions}
										/>
									</div>
								</div>
							) : null}
						</div>
					)}

					{stopped ? <div className="text-body text-ink-muted">{t("aiSearch.stopped")}</div> : null}

					{queued.length > 0 ? (
						<div className="queued-questions flex flex-col items-end gap-6" aria-label={t("aiSearch.queuedLabel")}>
							{queued.map((text, index) => (
								<div key={`${index}:${text}`} className="queued-question flex max-w-bubble-max items-center gap-8 rounded-10 border border-dashed border-border-strong px-12 py-6 text-meta text-ink-muted">
									<span className="flex-none font-medium">{t("aiSearch.queuedLabel")}</span>
									<span className="min-w-0 truncate text-ink-body">{text}</span>
									<button
										type="button"
										className="flex size-16 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-muted transition-[background,color] duration-(--dur-color) ease-out hover:bg-hover-strong hover:text-danger-text"
										aria-label={t("aiSearch.queuedRemove")}
										title={t("aiSearch.queuedRemove")}
										onClick={() => setQueued((current) => current.filter((_, position) => position !== index))}
									>
										<CloseIcon size={10} />
									</button>
								</div>
							))}
						</div>
					) : null}
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
										aria-label={t("finderComponents.removeAttachment")}
										title={t("finderComponents.removeAttachment")}
										onClick={() => removeAttachment(index)}
									>
										<CloseIcon size={10} />
									</button>
								</span>
							))}
						</div>
					) : null}
					{searching ? (
						<div className="steer-hint flex items-center gap-10 px-4 pb-6 text-tile text-ink-muted select-none" aria-hidden="true">
							<span className="size-6 flex-none rounded-full bg-info-dot animate-[pulseDot_1.4s_ease-in-out_infinite]" />
							<span className="min-w-0 flex-1 truncate">{t("aiSearch.steerHintLead")}</span>
							<span className="flex-none"><kbd className="font-sans font-semibold text-ink">{enterKeyLabel()}</kbd> {t("aiSearch.steerHintEnter")}</span>
							<span className="flex-none"><kbd className="font-sans font-semibold text-ink">{formatShortcut({ key: enterKeyLabel(), alt: true, primary: false })}</kbd> {t("aiSearch.steerHintAltEnter")}</span>
							<span className="flex-none"><kbd className="font-sans font-semibold text-ink">Esc</kbd> {t("aiSearch.stop")}</span>
						</div>
					) : null}
					<div className="compose-box flex min-h-40 items-center gap-7 rounded-12 border border-border bg-input px-11 py-4 transition-colors duration-(--dur-color) ease-out focus-within:border-accent">
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								// ⌥Enter queues; plain Enter goes through the form. A Hangul IME's composing Enter is no send.
								if (event.key !== "Enter" || !event.altKey || event.nativeEvent.isComposing) return;
								event.preventDefault();
								send(true);
							}}
							placeholder={searching ? t("aiSearch.steerPlaceholder") : t("finderComponents.composerPlaceholder")}
							aria-label={t("aiSearch.askDazzi")}
							className="h-30 min-w-0 flex-1 border-0 bg-transparent text-body text-ink-body outline-none placeholder:text-ink-muted"
						/>
						{searching && query.trim().length > 0 ? (
							<button
								type="submit"
								className="send steer-send flex size-32 flex-none items-center justify-center rounded-full border-0 bg-accent text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-accent-hover"
								title={t("aiSearch.steerSend")}
								aria-label={t("aiSearch.steerSend")}
							>
								<ArrowUpIcon />
							</button>
						) : null}
						{searching ? (
							<button
								type="button"
								className="send flex size-32 flex-none items-center justify-center rounded-full border-0 bg-ink text-on-accent cursor-pointer"
								title={t("aiSearch.stop")}
								aria-label={t("aiSearch.stop")}
								onClick={() => void stop()}
							>
								<Square size={10} strokeWidth={3} fill="currentColor" />
							</button>
						) : (
							<button
								type="submit"
								className="send flex size-32 flex-none items-center justify-center rounded-full border-0 bg-accent text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-accent-hover disabled:cursor-default disabled:bg-border-strong"
								title={t("aiSearch.askDazzi")}
								aria-label={t("aiSearch.askDazzi")}
								disabled={query.trim().length === 0 && attachments.length === 0}
							>
								<ArrowUpIcon />
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
					<span className="text-body font-medium text-ink">{dragOver ? t("aiSearch.dropAttach") : t("aiSearch.dropPrompt")}</span>
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

/**
 * A correction sent while the run streamed, right-aligned like the question.
 * Waiting: a dashed accent outline that breathes, with a pulsing dot. Taken by
 * the model: a solid bubble with a check. The run ended first: dimmed, struck.
 */
function SteerBubble({
	steer,
	labels,
}: {
	readonly steer: SteerItem;
	readonly labels: Readonly<Record<SteerItem["status"], string>>;
}): ReactElement {
	return (
		<div className="message steer-msg flex justify-end animate-rise" data-steer-status={steer.status}>
			<div className="flex max-w-bubble-max flex-col items-end gap-5">
				<div
					className={cn(
						"bubble steer-bubble rounded-10 border px-14 py-10 text-body leading-[1.5] break-words transition-[border-color,background-color,color] duration-(--dur-color) ease-out",
						steer.status === "pending" && "border-dashed border-accent bg-accent-wash text-ink-body animate-[steerWait_1.6s_ease-in-out_infinite]",
						steer.status === "delivered" && "border-border bg-input text-ink-body",
						steer.status === "dropped" && "border-border bg-input text-ink-muted line-through",
					)}
				>
					{steer.text}
				</div>
				<span className={cn("steer-status flex items-center gap-5 text-tile", steer.status === "pending" ? "text-accent-text" : "text-ink-muted")} role="status">
					{steer.status === "pending" ? (
						<span className="size-6 flex-none rounded-full bg-accent animate-[pulseDot_1.4s_ease-in-out_infinite]" aria-hidden="true" />
					) : steer.status === "delivered" ? (
						<CheckIcon size={11} />
					) : null}
					{labels[steer.status]}
				</span>
			</div>
		</div>
	);
}

/** A finished earlier turn of the chat, kept so the conversation reads top to bottom. */
interface PastTurn {
	readonly question: string;
	readonly attachments: readonly ChatAttachment[];
	readonly steers: readonly SteerItem[];
	readonly quick: AnswerPhase | null;
	readonly deep: AnswerPhase | null;
	readonly quickText: string;
	readonly deepText: string;
	readonly stopped: boolean;
	readonly error: string | null;
	readonly deepElapsed: number | null;
}

function PastTurnView({
	turn,
	turnIndex,
	activeSource,
	selectedEvidence,
	onCitation,
	steerLabels,
	imageActions,
}: {
	readonly turn: PastTurn;
	readonly turnIndex: number;
	readonly activeSource: EvidenceSelectionSource | null;
	readonly selectedEvidence: number | null;
	readonly onCitation: (turnIndex: number, phase: "quick" | "deep", number: number) => void;
	readonly steerLabels: Record<SteerItem["status"], string>;
	readonly imageActions: ImageActions;
}): ReactElement {
	const { t } = useTranslation();
	const before = turn.steers.filter((steer) => steer.timing === "before-quick");
	const after = turn.steers.filter((steer) => steer.timing === "after-quick");
	const prose = (text: string, phase: AnswerPhase | null, phaseKind: "quick" | "deep"): ReactElement => (
		<div className="assistant-prose flex flex-col gap-8 text-body leading-[1.55] text-ink-body">
			<ProseBlocks
				text={text}
				selected={
					activeSource?.turnIndex === turnIndex && activeSource.phase === phaseKind
						? selectedEvidence
						: null
				}
				unresolved={unresolvedCitationNumbers(text, phase?.evidence ?? [])}
				onCitation={(number) => onCitation(turnIndex, phaseKind, number)}
				imageActions={imageActions}
			/>
		</div>
	);
	return (
		<>
			<div className="message user-msg flex justify-end">
				<div className="user-bubble-wrap flex max-w-bubble-max flex-col items-end gap-6">
					{turn.attachments.length > 0 ? (
						<div className="ref-attachments flex flex-wrap justify-end gap-6">
							{turn.attachments.map((att) => (
								<RefFileChip key={`${att.id}:${att.name}`} att={att} />
							))}
						</div>
					) : null}
					<div className="bubble w-full rounded-10 border border-border bg-input px-14 py-10 text-body leading-[1.5] text-ink-body break-words">{turn.question}</div>
				</div>
			</div>
			{turn.error === null ? null : <div className="rounded-10 border border-danger-border bg-danger-bg-soft px-14 py-10 text-body text-danger-text">{turn.error}</div>}
			{before.map((steer) => (
				<SteerBubble key={steer.id} steer={steer} labels={steerLabels} />
			))}
			<div className="message assistant-msg flex flex-col gap-14">
				{turn.quickText === "" ? null : prose(turn.quickText, turn.quick, "quick")}
				{after.map((steer) => (
					<SteerBubble key={steer.id} steer={steer} labels={steerLabels} />
				))}
				{turn.deepText === "" ? null : (
					<div className="flex flex-col gap-6">
						{turn.deepElapsed === null ? null : (
							<div className="thinking-header flex items-center gap-5 text-meta font-medium text-ink-muted">
								<span>{t("aiSearch.workedFor", { time: formatElapsed(turn.deepElapsed) })}</span>
							</div>
						)}
						{prose(turn.deepText, turn.deep, "deep")}
					</div>
				)}
			</div>
			{turn.stopped ? <div className="text-body text-ink-muted">{t("aiSearch.stopped")}</div> : null}
		</>
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
