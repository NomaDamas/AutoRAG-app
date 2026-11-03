import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Check, RotateCcw, Square } from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppCustomizerBridge, AppCustomizerChange, AppCustomizerEvent, AppCustomizerSurface } from "../../../../shared/app-customizer-contract";
import type { LocaleKey } from "../../../../shared/i18n/core";
import type { AppSettings } from "../../../../shared/settings-contract";
import { parseAnswerBlocks, parseInline, type InlineSegment } from "../../state/answer-markdown";

type CustomizerWindow = Window & { readonly autorag?: { readonly appCustomizer?: AppCustomizerBridge } };

function getCustomizerBridge(): AppCustomizerBridge | undefined {
	return (window as CustomizerWindow).autorag?.appCustomizer;
}

interface ChatTurn {
	readonly id: string;
	readonly userText: string;
	readonly reply: string | null;
	readonly draft: string;
	readonly progress: string;
	readonly changes: readonly AppCustomizerChange[];
	readonly error: string | null;
	readonly status: "running" | "done" | "error" | "cancelled";
}

interface SurfaceCopy {
	readonly title: LocaleKey;
	readonly emptyTitle: LocaleKey;
	readonly emptyDesc: LocaleKey;
	readonly suggestions: readonly [LocaleKey, LocaleKey, LocaleKey, LocaleKey];
	readonly thinking: LocaleKey;
	readonly placeholder: LocaleKey;
	readonly openAiSettings: LocaleKey;
	readonly unavailable: LocaleKey;
}

/** The context-menu assistant has no copy of its own for the shared states and reuses the sidebar assistant's. */
const SURFACE_COPY: Readonly<Record<AppCustomizerSurface, SurfaceCopy>> = {
	sidebar: {
		title: "settingsCore.sidebar.assistant.title",
		emptyTitle: "settingsCore.sidebar.assistant.emptyTitle",
		emptyDesc: "settingsCore.sidebar.assistant.emptyDesc",
		suggestions: [
			"settingsCore.sidebar.assistant.promptMinimal",
			"settingsCore.sidebar.assistant.promptReorder",
			"settingsCore.sidebar.assistant.promptCleanSections",
			"settingsCore.sidebar.assistant.promptReset",
		],
		thinking: "settingsCore.sidebar.assistant.thinking",
		placeholder: "settingsCore.sidebar.assistant.placeholder",
		openAiSettings: "settingsCore.sidebar.assistant.openAiSettings",
		unavailable: "settingsCore.sidebar.assistant.unavailable",
	},
	contextMenu: {
		title: "settingsCore.contextMenu.assistant.title",
		emptyTitle: "settingsCore.contextMenu.assistant.emptyTitle",
		emptyDesc: "settingsCore.contextMenu.assistant.emptyDesc",
		suggestions: [
			"settingsCore.contextMenu.assistant.promptSummarizePdf",
			"settingsCore.contextMenu.assistant.promptBatchScript",
			"settingsCore.contextMenu.assistant.promptCleanMenu",
			"settingsCore.contextMenu.assistant.promptReset",
		],
		thinking: "settingsCore.sidebar.assistant.thinking",
		placeholder: "settingsCore.contextMenu.assistant.placeholder",
		openAiSettings: "settingsCore.sidebar.assistant.openAiSettings",
		unavailable: "settingsCore.sidebar.assistant.unavailable",
	},
	shortcuts: {
		title: "settingsCore.shortcuts.assistant.title",
		emptyTitle: "settingsCore.shortcuts.assistant.emptyTitle",
		emptyDesc: "settingsCore.shortcuts.assistant.emptyDesc",
		suggestions: [
			"settingsCore.shortcuts.assistant.promptMacFinder",
			"settingsCore.shortcuts.assistant.promptWindowsExplorer",
			"settingsCore.shortcuts.assistant.promptSwap",
			"settingsCore.shortcuts.assistant.promptReset",
		],
		thinking: "settingsCore.shortcuts.assistant.thinking",
		placeholder: "settingsCore.shortcuts.assistant.placeholder",
		openAiSettings: "settingsCore.shortcuts.assistant.openAiSettings",
		unavailable: "settingsCore.shortcuts.assistant.unavailable",
	},
};

function makeId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderInlineSegments(segments: readonly InlineSegment[]): ReactElement[] {
	return segments.map((seg, idx) => {
		switch (seg.kind) {
			case "bold":
				return <strong key={idx}>{seg.text}</strong>;
			case "code":
				return <code key={idx}>{seg.text}</code>;
			case "link":
				return <span key={idx}>{ renderInlineSegments(seg.children) }</span>;
			case "citation":
				return <span key={idx}>[{seg.number}]</span>;
			case "image":
				return <span key={idx}>{seg.target}</span>;
			default:
				return <span key={idx}>{seg.text}</span>;
		}
	});
}

function CustomizerReplyBody({ text }: { readonly text: string }): ReactElement {
	const blocks = parseAnswerBlocks(text);
	return (
		<div className="customizer-turn__reply">
			{blocks.map((block, idx) => {
				if (block.kind === "code") {
					return (
						<pre key={idx} className="m-0 overflow-x-auto rounded-6 bg-code p-8 font-mono text-badge">
							<code>{block.text}</code>
						</pre>
					);
				}
				if (block.kind === "table") {
					return <p key={idx}>{(block.header ?? []).join(" · ")}</p>;
				}
				if (block.kind === "list") {
					return (
						<div key={idx} className="customizer-turn__reply-item">
							<span className="customizer-turn__reply-bullet" aria-hidden="true">•</span>
							<span>{renderInlineSegments(parseInline(block.text))}</span>
						</div>
					);
				}
				if (block.kind === "heading") {
					return (
						<p key={idx} className="font-semibold">
							{renderInlineSegments(parseInline(block.text))}
						</p>
					);
				}
				return <p key={idx}>{renderInlineSegments(parseInline(block.text))}</p>;
			})}
		</div>
	);
}

/**
 * The AI customization assistant for one customizable Settings section (`surface`), shown in the window's right
 * sidebar (`SettingsAssistantDock.tsx`). It has no header of its own: the page beside it already names the section,
 * and the toolbar's right-sidebar toggle shows and hides it. Settings keeps one panel per visited surface mounted and
 * hides the others, so a conversation and a running turn survive switching sections or hiding the sidebar; the page
 * beside it stays fully interactive and reflects every change the agent makes.
 */
export function AppCustomizerPanel({
	surface,
	hidden,
	focusRequest,
	onSettingsUpdated,
	onOpenAiSettings,
}: {
	readonly surface: AppCustomizerSurface;
	readonly hidden: boolean;
	/** Bumped when the user explicitly opens the panel; the composer takes focus then, never on a plain page visit. */
	readonly focusRequest: number;
	readonly onSettingsUpdated: (settings: AppSettings) => void;
	readonly onOpenAiSettings: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const copy = SURFACE_COPY[surface];
	const [sessionId, setSessionId] = useState(() => makeId(`customizer-${surface}-sess`));
	const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
	const [input, setInput] = useState("");
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	activeRunIdRef.current = activeRunId;
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (focusRequest > 0 && !hidden) textareaRef.current?.focus();
	}, [focusRequest, hidden]);

	useEffect(() => {
		const container = scrollRef.current;
		if (container !== null) {
			container.scrollTop = container.scrollHeight;
		}
	}, [turns]);

	useEffect(() => {
		const bridge = getCustomizerBridge();
		if (bridge === undefined) return;
		return bridge.onEvent((event: AppCustomizerEvent) => {
			if (event.sessionId !== sessionId) return;
			setTurns((prev) =>
				prev.map((turn) => {
					if (turn.id !== event.runId) return turn;
					switch (event.type) {
						case "progress":
							return { ...turn, progress: event.text };
						case "draft":
							return { ...turn, draft: event.text };
						case "turn-done":
							return {
								...turn,
								status: "done",
								reply: event.reply,
								draft: "",
								progress: "",
								changes: event.changes,
							};
						case "error":
							return {
								...turn,
								status: "error",
								error: event.message,
								draft: "",
								progress: "",
								changes: event.changes,
							};
						case "cancelled":
							return {
								...turn,
								status: "cancelled",
								draft: "",
								progress: "",
								changes: event.changes,
							};
					}
				}),
			);
			if (event.type === "turn-done") {
				onSettingsUpdated(event.settings);
				setActiveRunId((current) => (current === event.runId ? null : current));
			} else if (event.type === "error" || event.type === "cancelled") {
				setActiveRunId((current) => (current === event.runId ? null : current));
			}
		});
	}, [sessionId, onSettingsUpdated]);

	const stopRun = useCallback((): void => {
		const runId = activeRunIdRef.current;
		if (runId === null) return;
		setActiveRunId(null);
		setTurns((prev) =>
			prev.map((turn) => (turn.id === runId && turn.status === "running" ? { ...turn, status: "cancelled", progress: "", draft: "" } : turn)),
		);
		void getCustomizerBridge()?.cancel(runId);
	}, []);

	const sendMessage = useCallback(
		(rawText: string): void => {
			const trimmed = rawText.trim();
			if (trimmed.length === 0 || activeRunIdRef.current !== null) return;
			const runId = makeId("customizer-run");
			setInput("");
			setActiveRunId(runId);
			setTurns((prev) => [
				...prev,
				{
					id: runId,
					userText: trimmed,
					reply: null,
					draft: "",
					progress: "",
					changes: [],
					error: null,
					status: "running",
				},
			]);
			const bridge = getCustomizerBridge();
			if (bridge === undefined) {
				setActiveRunId(null);
				setTurns((prev) => prev.map((turn) => (turn.id === runId ? { ...turn, status: "error", error: t(copy.unavailable) } : turn)));
				return;
			}
			void bridge.send(runId, { sessionId, message: trimmed, surface }).catch((cause: unknown) => {
				setActiveRunId((current) => (current === runId ? null : current));
				setTurns((prev) =>
					prev.map((turn) =>
						turn.id === runId
							? { ...turn, status: "error", error: cause instanceof Error ? cause.message : String(cause) }
							: turn,
					),
				);
			});
		},
		[sessionId, surface, copy, t],
	);

	const resetChat = useCallback((): void => {
		if (activeRunIdRef.current !== null) {
			void getCustomizerBridge()?.cancel(activeRunIdRef.current);
		}
		void getCustomizerBridge()?.reset(sessionId);
		setActiveRunId(null);
		setTurns([]);
		setSessionId(makeId(`customizer-${surface}-sess`));
		textareaRef.current?.focus();
	}, [sessionId, surface]);

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			sendMessage(input);
		} else if (event.key === "Escape" && activeRunIdRef.current !== null) {
			event.preventDefault();
			stopRun();
		}
	};

	const running = activeRunId !== null;

	return (
		<aside className="customizer-panel" aria-label={t(copy.title)} data-testid="app-customizer-panel" data-surface={surface} hidden={hidden}>
			<div ref={scrollRef} className="customizer-panel__body">
				{turns.length === 0 ? (
					<div className="customizer-panel__empty">
						<div className="customizer-panel__empty-orb" aria-hidden="true">
							<img src={dazziMark} alt="" className="customizer-panel__empty-logo" draggable={false} />
						</div>
						<h3 className="customizer-panel__empty-title">{t(copy.emptyTitle)}</h3>
						<p className="customizer-panel__empty-desc">{t(copy.emptyDesc)}</p>
						<div className="customizer-panel__suggestions">
							{copy.suggestions.map((key) => (
								<button
									key={key}
									type="button"
									className="customizer-suggestion-chip"
									data-action="customizer-suggestion"
									onClick={() => sendMessage(t(key))}
								>
									<span>{t(key)}</span>
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="customizer-panel__turns">
						{turns.map((turn) => (
							<div key={turn.id} className="customizer-turn">
								<div className="customizer-turn__user-row">
									<div className="customizer-turn__user-bubble">{turn.userText}</div>
								</div>
								<div className="customizer-turn__assistant-row">
									{turn.changes.length > 0 ? (
										<div className="customizer-turn__changes">
											{turn.changes.map((change, idx) => (
												<span key={idx} className="customizer-change-pill">
													<Check size={12} strokeWidth={2.2} aria-hidden="true" />
													<span>{change.summary}</span>
												</span>
											))}
										</div>
									) : null}
									{turn.status === "running" && turn.draft === "" ? (
										<div className="customizer-turn__progress" role="status">
											<span className="shimmer">{turn.progress.length > 0 ? turn.progress : t(copy.thinking)}</span>
										</div>
									) : null}
									{turn.draft.length > 0 && turn.reply === null ? <CustomizerReplyBody text={turn.draft} /> : null}
									{turn.reply !== null && turn.reply.length > 0 ? <CustomizerReplyBody text={turn.reply} /> : null}
									{turn.error !== null ? (
										<div className="customizer-turn__error" role="alert">
											<p className="customizer-turn__error-text">{turn.error}</p>
											<button
												type="button"
												className="linear-btn"
												data-action="customizer-open-ai-settings"
												onClick={onOpenAiSettings}
											>
												{t(copy.openAiSettings)}
											</button>
										</div>
									) : null}
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<footer className="customizer-panel__foot">
				<div className="customizer-composer">
					<textarea
						ref={textareaRef}
						rows={2}
						data-testid="app-customizer-input"
						className="customizer-composer__input"
						placeholder={t(copy.placeholder)}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={handleKeyDown}
					/>
					{turns.length > 0 ? (
						<button
							type="button"
							className="customizer-composer__new-chat"
							data-action="reset-customizer-chat"
							title={t("settingsCore.sidebar.assistant.newChat")}
							aria-label={t("settingsCore.sidebar.assistant.newChat")}
							onClick={resetChat}
						>
							<RotateCcw size={14} />
						</button>
					) : null}
					{running ? (
						<button
							type="button"
							className="customizer-composer__send is-stop"
							data-action="stop-customizer-message"
							title={t("settingsCore.sidebar.assistant.stop")}
							aria-label={t("settingsCore.sidebar.assistant.stop")}
							onClick={stopRun}
						>
							<Square size={12} fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							className="customizer-composer__send"
							data-action="send-customizer-message"
							disabled={input.trim().length === 0}
							title={t("settingsCore.sidebar.assistant.send")}
							aria-label={t("settingsCore.sidebar.assistant.send")}
							onClick={() => sendMessage(input)}
						>
							<ArrowUp size={15} strokeWidth={2.2} />
						</button>
					)}
				</div>
			</footer>
		</aside>
	);
}
