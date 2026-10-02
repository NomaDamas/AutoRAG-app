import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactElement } from "react";
import "./ai-animations.css";
import type { AnswerPhase, AnswerPhaseName, ChatAttachment, ChatSummary, CitationEvidence, SearchStreamEvent } from "../../../shared/search-contract";
import type { SearchBridge } from "../../../shared/search-contract";
import { parseAnswerBlocks, parseInline, type AnswerBlock } from "../state/answer-markdown";
import { groupChatHistory, historyEmptyText } from "../state/history";
import { cn } from "../lib/cn";
import { CloseIcon, HistoryIcon, PlusIcon, SearchIcon, SendIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";

const autorag = (window as unknown as { readonly autorag: { readonly search: SearchBridge } }).autorag;

const NO_THINKING: Readonly<Record<AnswerPhaseName, boolean>> = { quick: false, deep: false };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function AiSearchPanel({
	selectedEvidence,
	onSelectEvidence,
	onPublish,
}: {
	readonly selectedEvidence: number | null;
	readonly onSelectEvidence: (selected: number) => void;
	readonly onPublish: (evidence: readonly CitationEvidence[], sessionId: string | null) => void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const [quick, setQuick] = useState<AnswerPhase | null>(null);
	const [deep, setDeep] = useState<AnswerPhase | null>(null);
	const [quickDraft, setQuickDraft] = useState("");
	const [deepDraft, setDeepDraft] = useState("");
	const [thinking, setThinking] = useState<Readonly<Record<AnswerPhaseName, boolean>>>(NO_THINKING);
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
	const [chatId, setChatId] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [history, setHistory] = useState<readonly ChatSummary[]>([]);
	const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
	const queryRef = useRef(query);
	const historySeq = useRef(0);

	useEffect(() => {
		queryRef.current = query;
	}, [query]);

	useEffect(() => {
		const unsubscribe = autorag.search.onEvent?.((event: SearchStreamEvent) => {
			if (event.searchId !== searchIdRef.current) return;
			switch (event.type) {
				case "progress":
					setProgress(event.text);
					break;
				case "thinking":
					setThinking((current) => ({ ...current, [event.phase]: true }));
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

	useEffect(() => {
		onPublish(evidence, sessionId);
	}, [evidence, sessionId, onPublish]);

	const historyGroups = useMemo(() => groupChatHistory(history, new Date()), [history]);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			const meta = event.metaKey || event.ctrlKey;
			if (meta && event.shiftKey && event.key.toLowerCase() === "h") {
				event.preventDefault();
				toggleHistory();
				return;
			}
			if (historyOpen) return;
			if (meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				newChat();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const text = query.trim();
		if (text.length === 0 || searchId !== null) return;
		const nextChatId = crypto.randomUUID();
		const nextSearchId = crypto.randomUUID();
		setSearchId(nextSearchId);
		setQuick(null);
		setDeep(null);
		setQuickDraft("");
		setDeepDraft("");
		setThinking(NO_THINKING);
		setSessionId(null);
		setError(null);
		setStopped(false);
		setSubmittedQuery(text);
		setProgress("Reviewing the query.");
		setChatId(nextChatId);
		const sent = attachments;
		setAttachments([]);
		try {
			// Resolves when the run ends; the answer itself arrives as events.
			await autorag.search.start(nextSearchId, nextChatId, text, sent);
		} catch (startError) {
			if (searchIdRef.current !== nextSearchId) return;
			setError(errorMessage(startError));
			setProgress("");
			setSearchId(null);
		}
	}

	async function openHistory(): Promise<void> {
		historySeq.current += 1;
		const seq = historySeq.current;
		const items = await autorag.search.historyList();
		if (seq !== historySeq.current) return;
		setHistory(items);
		setHistoryQuery("");
		setHistoryOpen(true);
	}

	function closeHistory(): void {
		setHistoryOpen(false);
	}

	function toggleHistory(): void {
		if (historyOpen) {
			closeHistory();
			return;
		}
		void openHistory();
	}

	/** The store owns the matching (title + first Quick answer); a stale reply never lands after a newer keystroke. */
	async function searchHistory(value: string): Promise<void> {
		setHistoryQuery(value);
		historySeq.current += 1;
		const seq = historySeq.current;
		const items = await autorag.search.historySearch(value);
		if (seq !== historySeq.current) return;
		setHistory(items);
	}

	function newChat(): void {
		setQuick(null);
		setDeep(null);
		setQuickDraft("");
		setDeepDraft("");
		setThinking(NO_THINKING);
		setError(null);
		setStopped(false);
		setProgress("");
		setQuery("");
		setSubmittedQuery(null);
		setAttachments([]);
		setChatId(null);
		setHistoryOpen(false);
	}

	async function loadHistory(id: string): Promise<void> {
		const record = await autorag.search.historyGet(id);
		const assistant = record?.messages.findLast((message) => message.role === "assistant");
		if (assistant?.role !== "assistant") return;
		const user = record?.messages.findLast((message) => message.role === "user");
		setQuick(assistant.quick);
		setDeep(assistant.deep);
		setQuickDraft(assistant.quick?.answer ?? "");
		setDeepDraft(assistant.deep?.answer ?? "");
		setThinking(NO_THINKING);
		setSessionId(assistant.sessionId);
		setSubmittedQuery(user?.role === "user" ? user.text : null);
		setStopped(assistant.stopped);
		setError(null);
		setProgress("");
		setChatId(id);
		setHistoryOpen(false);
	}

	async function stop(): Promise<void> {
		if (searchId === null) return;
		await autorag.search.cancel(searchId);
		setSearchId(null);
		setProgress("");
		setStopped(true);
	}

	return (
		<section className="ai relative flex flex-col min-w-0 min-h-0 border-l border-border" aria-label="AI Search">
			<div className="ai__header flex flex-none items-center gap-10 h-bar py-0 pr-12 pl-20 bg-chrome border-b border-border">
				<span className="ai__title flex-none text-body font-semibold whitespace-nowrap">AI Search</span>
				<div className="ai__header-actions flex items-center gap-2 ml-auto">
					<button type="button" className={cn("icon-button", historyOpen && "icon-button--active", iconButtonClass({ active: historyOpen }))} title="Chat history ⌘⇧H" aria-label="Chat history" onClick={() => void toggleHistory()}><HistoryIcon /></button>
					<button type="button" className={cn("icon-button", iconButtonClass())} title="New chat ⌘N" aria-label="New chat" onClick={newChat}><PlusIcon /></button>
				</div>
			</div>
			{historyOpen ? (
				<>
					<div className="ai__history-scrim absolute inset-0 z-[25]" aria-hidden="true" onClick={closeHistory} />
					<div className="ai__history-popover absolute top-[52px] right-12 z-[26] flex flex-col w-[min(var(--w-history),calc(100%_-_24px))] max-h-[72%] border border-border rounded-12 bg-window shadow-window overflow-hidden animate-[rise_var(--dur-popover)_var(--ease-out)]" aria-label="Chat history">
						<div className="ai__history-header flex flex-none items-center gap-8 h-[44px] px-12 border-b border-border text-ink-muted">
							<SearchIcon className="ai__history-search-icon" />
							<input
								autoFocus
								value={historyQuery}
								onChange={(event) => void searchHistory(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										closeHistory();
										return;
									}
									if (event.key !== "Enter") return;
									event.preventDefault();
									const first = history[0];
									if (first !== undefined) void loadHistory(first.id);
								}}
								placeholder="대화 기록 검색"
								aria-label="대화 기록 검색"
								className="flex-1 min-w-0 h-row border-0 outline-none bg-transparent text-ink text-body"
							/>
							<button type="button" className={cn("icon-button", iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }))} aria-label="Close history" onClick={closeHistory}><CloseIcon size={12} /></button>
						</div>
						<div className="ai__history-list flex flex-1 flex-col gap-2 min-h-0 p-6 overflow-auto">
							{historyGroups.length === 0 ? (
								<span className="ai__history-empty py-[28px] px-12 text-ink-muted text-meta text-center">{historyEmptyText(historyQuery)}</span>
							) : (
								historyGroups.map((group) => (
									<div key={group.label}>
										<div className="ai__history-group pt-10 px-10 pb-4 text-ink-muted text-badge font-semibold">{group.label}</div>
										{group.items.map((item) => (
											<button
												type="button"
												key={item.id}
												className={cn("ai__history-item flex items-start gap-10 w-full py-8 px-10 border-0 rounded-8 text-ink text-left hover:bg-input", item.id === chatId ? "ai__history-item--current bg-accent-history-current" : "bg-transparent")}
												onClick={() => void loadHistory(item.id)}
											>
												<span className="ai__history-dot flex-none size-dot mt-[7px] rounded-full bg-transparent [.ai\_\_history-item--current_&]:bg-accent" />
												<span className="ai__history-text flex flex-1 flex-col gap-2 min-w-0">
													<strong className="text-body font-medium truncate">{item.title}</strong>
													<small className="text-ink-muted text-meta truncate">{item.snippet}</small>
												</span>
												<span className="ai__history-time flex-none mt-2 text-ink-muted text-badge">{item.time}</span>
											</button>
										))}
									</div>
								))
							)}
						</div>
					</div>
				</>
			) : null}
			<div className="ai__body flex flex-col flex-1 min-h-0 p-20 overflow-auto">
				<div className="ai__messages flex flex-1 flex-col gap-12 overflow-auto">
					{quick === null && deep === null && error === null && submittedQuery === null ? (
						<div className="ai__empty flex flex-col items-center gap-8 m-auto text-center">
							<div className="ai__empty-title text-title font-semibold">무엇을 찾아드릴까요?</div>
							<div className="ai__empty-sub max-w-[360px] text-ink-muted text-pretty break-keep">
								파일, 메일, Slack, Notion 전체에서 찾아 빠른 답변과 정확한 답변을 함께 드립니다.
							</div>
						</div>
					) : null}
					{submittedQuery === null ? null : <div className="ai__user-message flex flex-col items-end gap-4 ml-auto max-w-[88%]"><span className="text-ink-muted text-meta">You</span><p className="m-0 py-10 px-12 rounded-tl-10 rounded-tr-10 rounded-br-3 rounded-bl-10 bg-chip-sent text-ink-body break-keep">{submittedQuery}</p></div>}
					{submittedQuery === null ? null : <div className="ai__assistant-label text-ink-muted text-meta mt-2">Assistant</div>}
					{error === null ? null : <div className="ai__error p-12 border border-border rounded-10 bg-chrome">{error}</div>}
					{submittedQuery === null ? null : <AnswerCard label="Quick" phase={quick} draft={quickDraft} thinking={thinking.quick} pending={searchId !== null && quick === null} selectedEvidence={selectedEvidence} onCitation={onSelectEvidence} />}
					{submittedQuery === null ? null : <AnswerCard label="Deep" phase={deep} draft={deepDraft} thinking={thinking.deep} pending={searchId !== null && deep === null} selectedEvidence={selectedEvidence} onCitation={onSelectEvidence} />}
					{progress === "" ? null : <div className="ai__progress p-12 border border-border rounded-10 bg-chrome">{progress}</div>}
					{stopped ? <div className="ai__stopped p-12 border border-border rounded-10 bg-subtle-alt">응답 생성을 중단했습니다.</div> : null}
				</div>
				<form
					className="ai__composer flex flex-col gap-8 flex-none mt-12 p-8 border border-border rounded-10 bg-input shadow-[0_3px_12px_rgb(26_26_46_/_8%)]"
					onSubmit={(event) => void submit(event)}
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						event.preventDefault();
						const dropped = [...event.dataTransfer.files].map((file) => ({
							kind: "file" as const,
							id: (file as File & { readonly path?: string }).path ?? file.name,
							name: file.name,
						}));
						setAttachments((current) => [...current, ...dropped]);
					}}
				>
					{attachments.length > 0 ? <span className="ai__attachments text-ink-muted">{attachments.map((item) => item.name).join(", ")}</span> : null}
					<div className="ai__composer-row flex gap-8 w-full">
						<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="파일, 메일, 메신저 전체에서 물어보세요" aria-label="Ask AutoRAG" disabled={searchId !== null} className="min-w-0 flex-1 py-[9px] px-[11px] border-0 rounded-8 bg-transparent" />
						{searchId === null ? <button type="submit" className="ai__send-button inline-flex items-center justify-center size-row flex-none py-5 px-10 border-0 rounded-8 bg-ink text-on-badge cursor-pointer disabled:bg-border-strong disabled:text-ink-muted disabled:cursor-default" title="Ask AutoRAG" aria-label="Ask AutoRAG" disabled={query.trim().length === 0}><SendIcon /></button> : <button type="button" className="ai__send-button ai__send-button--stop inline-flex items-center justify-center size-row flex-none py-5 px-10 border-0 rounded-8 bg-ink text-on-badge cursor-pointer disabled:bg-border-strong disabled:text-ink-muted disabled:cursor-default" title="Stop search" aria-label="Stop search" onClick={() => void stop()}><span className="size-10 rounded-2 bg-current" /></button>}
					</div>
				</form>
			</div>
		</section>
	);
}

const THINKING_LETTERS = [..."Thinking"];

/** Shown while the model reasons; the reasoning text itself is never rendered. */
function ThinkingIndicator(): ReactElement {
	return (
		<div className="ai__thinking inline-flex self-start py-2 px-0 text-ink-faint text-body font-semibold tracking-label" role="status" aria-label="Thinking">
			{THINKING_LETTERS.map((letter, index) => (
				<span key={index} aria-hidden="true" className="inline-block animate-[ai-thinking-wave_1.6s_ease-in-out_infinite] [animation-delay:calc(var(--i)*0.08s)]" style={{ "--i": index } as CSSProperties}>{letter}</span>
			))}
		</div>
	);
}

function AnswerCard({
	label,
	phase,
	draft,
	thinking,
	pending,
	selectedEvidence,
	onCitation,
}: {
	readonly label: string;
	readonly phase: AnswerPhase | null;
	readonly draft: string;
	readonly thinking: boolean;
	readonly pending: boolean;
	readonly selectedEvidence: number | null;
	readonly onCitation: (selected: number) => void;
}): ReactElement {
	const answerText = phase !== null ? phase.answer : draft;
	const modifier = `ai__answer--${label.toLowerCase()}`;
	const isQuick = label === "Quick";
	if (answerText === "") {
		return (
			<article className={cn("ai__answer flex flex-col gap-8 py-14 px-16 border border-border rounded-10", modifier, isQuick ? "bg-window" : "bg-subtle-alt", "ai__answer--pending min-h-[82px]")}>
				<span className="ai__answer-label inline-flex items-center gap-8 text-ink font-semibold"><i className="inline-block size-6 rounded-full bg-accent [.ai\_\_answer--deep_&]:bg-accent" />{label}</span>
				{pending && thinking ? <ThinkingIndicator /> : <div className="ai__skeleton flex flex-col gap-8"><span className="block h-10 rounded-6 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer [&:nth-child(1)]:w-[86%]" /><span className="block h-10 rounded-6 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer [&:nth-child(2)]:w-[68%]" /><span className="block h-10 rounded-6 bg-[linear-gradient(90deg,var(--bg-input),var(--bg-window),var(--bg-input))] bg-[length:200%_100%] animate-shimmer [&:nth-child(3)]:w-[42%]" /></div>}
			</article>
		);
	}
	const streaming = phase === null && pending;
	return (
		<article className={cn("ai__answer flex flex-col gap-8 py-14 px-16 border border-border rounded-10", modifier, isQuick ? "bg-window" : "bg-subtle-alt", streaming && "ai__answer--streaming")}>
			<span className="ai__answer-label inline-flex items-center gap-8 text-ink font-semibold"><i className="inline-block size-6 rounded-full bg-accent [.ai\_\_answer--deep_&]:bg-accent" />{label}</span>
			<div className={cn("ai__answer-content flex flex-col gap-8", streaming && "[&>:last-child]:after:content-['▍'] [&>:last-child]:after:ml-2 [&>:last-child]:after:text-accent [&>:last-child]:after:animate-[ai-caret_1s_steps(2,start)_infinite]")}>
				{parseAnswerBlocks(answerText).map((block, index) => (
					<AnswerBlockView key={`${index}`} block={block} selected={selectedEvidence} onCitation={onCitation} />
				))}
			</div>
		</article>
	);
}

function AnswerBlockView({
	block,
	selected,
	onCitation,
}: {
	readonly block: AnswerBlock;
	readonly selected: number | null;
	readonly onCitation: (selected: number) => void;
}): ReactElement {
	const segments = parseInline(block.text).map((segment, index) => {
		switch (segment.kind) {
			case "bold":
				return <strong key={`${index}`}>{segment.text}</strong>;
			case "code":
				return <code key={`${index}`} className="ai__inline-code py-1 px-4 rounded-4 bg-code font-mono text-sm">{segment.text}</code>;
			case "citation":
				return (
					<button
						type="button"
						key={`${index}`}
						className={cn("ai__citation inline-flex items-center justify-center min-w-18 h-18 py-0 px-4 mx-2 my-0 border-0 rounded-5 text-badge font-semibold cursor-pointer align-[1px] transition-[background] duration-(--dur-color-slow) ease-[ease]", segment.number === selected ? "ai__citation--active bg-accent text-on-accent" : "bg-accent-chip text-accent-text")}
						onClick={() => onCitation(segment.number)}
					>
						{segment.number}
					</button>
				);
			default:
				return <span key={`${index}`}>{segment.text}</span>;
		}
	});
	switch (block.kind) {
		case "heading":
			return <><div className="ai__block ai__block--heading text-ink font-semibold [&_strong]:text-ink [&_strong]:font-semibold">{segments}</div></>;
		case "list":
			return (
				<div className="ai__block ai__block--list flex gap-8 text-ink-body text-body leading-body [&_strong]:text-ink [&_strong]:font-semibold">
					<span className="ai__block-marker text-ink-muted">–</span>
					<span>{segments}</span>
				</div>
			);
		case "quote":
			return <div className="ai__block ai__block--quote pl-10 text-ink-muted text-body leading-body shadow-[inset_2px_0_0_var(--border)] [&_strong]:text-ink [&_strong]:font-semibold">{segments}</div>;
		case "code":
			return <pre className="ai__block ai__block--code m-0 py-8 px-10 border border-border rounded-6 bg-code text-ink-body font-mono text-caption leading-read overflow-auto whitespace-pre [&_strong]:text-ink [&_strong]:font-semibold">{block.text}</pre>;
		default:
			return <p className="ai__block ai__block--paragraph m-0 text-ink-body text-body leading-body whitespace-pre-wrap break-keep [&_strong]:text-ink [&_strong]:font-semibold">{segments}</p>;
	}
}
