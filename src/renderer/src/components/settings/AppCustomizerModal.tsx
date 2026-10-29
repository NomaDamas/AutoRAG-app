import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowUp, Check, Lock, RotateCcw, Square, X } from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppCustomizerBridge, AppCustomizerChange, AppCustomizerEvent } from "../../../../shared/app-customizer-contract";
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

export function AppCustomizerModal({
	onClose,
	onSettingsUpdated,
	onOpenAiSettings,
}: {
	readonly onClose: () => void;
	readonly onSettingsUpdated: (settings: AppSettings) => void;
	readonly onOpenAiSettings?: (() => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const titleId = useId();
	const [sessionId, setSessionId] = useState(() => makeId("customizer-sess"));
	const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
	const [input, setInput] = useState("");
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	activeRunIdRef.current = activeRunId;
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

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

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				if (activeRunIdRef.current !== null) {
					stopRun();
				} else {
					onClose();
				}
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose, stopRun]);

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
				setTurns((prev) =>
					prev.map((turn) => (turn.id === runId ? { ...turn, status: "error", error: t("settingsCore.sidebar.modal.unavailable") } : turn)),
				);
				return;
			}
			void bridge.send(runId, { sessionId, message: trimmed }).catch((cause: unknown) => {
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
		[sessionId, t],
	);

	const resetChat = useCallback((): void => {
		if (activeRunIdRef.current !== null) {
			void getCustomizerBridge()?.cancel(activeRunIdRef.current);
		}
		void getCustomizerBridge()?.reset(sessionId);
		setActiveRunId(null);
		setTurns([]);
		setSessionId(makeId("customizer-sess"));
		textareaRef.current?.focus();
	}, [sessionId]);

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			sendMessage(input);
		}
	};

	const suggestions = [
		t("settingsCore.sidebar.modal.promptMinimal"),
		t("settingsCore.sidebar.modal.promptReorder"),
		t("settingsCore.sidebar.modal.promptCleanSections"),
		t("settingsCore.sidebar.modal.promptReset"),
	];

	const running = activeRunId !== null;

	return createPortal(
		<div
			className="settings-modal-backdrop customizer-modal-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="customizer-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-testid="app-customizer-modal"
			>
				<header className="customizer-modal__head">
					<div className="customizer-modal__brand">
						<span className="customizer-modal__icon" aria-hidden="true">
							<img src={dazziMark} alt="" className="customizer-modal__logo" draggable={false} />
						</span>
						<div className="customizer-modal__titles">
							<h2 id={titleId} className="customizer-modal__title">
								{t("settingsCore.sidebar.modal.title")}
							</h2>
							<p className="customizer-modal__subtitle">{t("settingsCore.sidebar.modal.subtitle")}</p>
						</div>
					</div>
					<div className="customizer-modal__head-actions">
						{turns.length > 0 ? (
							<button
								type="button"
								className="customizer-modal__icon-btn"
								data-action="reset-customizer-chat"
								title={t("settingsCore.sidebar.modal.newChat")}
								aria-label={t("settingsCore.sidebar.modal.newChat")}
								onClick={resetChat}
							>
								<RotateCcw size={14} />
							</button>
						) : null}
						<button
							type="button"
							className="customizer-modal__icon-btn"
							data-action="close-app-customizer"
							title={t("common.close")}
							aria-label={t("common.close")}
							onClick={onClose}
						>
							<X size={15} />
						</button>
					</div>
				</header>

				<div ref={scrollRef} className="customizer-modal__body">
					{turns.length === 0 ? (
						<div className="customizer-modal__empty">
							<div className="customizer-modal__empty-orb" aria-hidden="true">
								<img src={dazziMark} alt="" className="customizer-modal__empty-logo" draggable={false} />
							</div>
							<h3 className="customizer-modal__empty-title">{t("settingsCore.sidebar.modal.emptyTitle")}</h3>
							<p className="customizer-modal__empty-desc">{t("settingsCore.sidebar.modal.emptyDesc")}</p>
							<div className="customizer-modal__suggestions">
								{suggestions.map((promptText, idx) => (
									<button
										key={idx}
										type="button"
										className="customizer-suggestion-chip"
										data-action="customizer-suggestion"
										onClick={() => sendMessage(promptText)}
									>
										<img src={dazziMark} alt="" className="customizer-suggestion-chip__logo" aria-hidden="true" draggable={false} />
										<span>{promptText}</span>
									</button>
								))}
							</div>
						</div>
					) : (
						<div className="customizer-modal__turns">
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
												<span className="shimmer">
													{turn.progress.length > 0 ? turn.progress : t("settingsCore.sidebar.modal.thinking")}
												</span>
											</div>
										) : null}
										{turn.draft.length > 0 && turn.reply === null ? (
											<CustomizerReplyBody text={turn.draft} />
										) : null}
										{turn.reply !== null && turn.reply.length > 0 ? (
											<CustomizerReplyBody text={turn.reply} />
										) : null}
										{turn.error !== null ? (
											<div className="customizer-turn__error" role="alert">
												<p className="customizer-turn__error-text">{turn.error}</p>
												{onOpenAiSettings !== undefined ? (
													<button
														type="button"
														className="linear-btn"
														data-action="customizer-open-ai-settings"
														onClick={() => {
															onClose();
															onOpenAiSettings();
														}}
													>
														{t("settingsCore.sidebar.modal.openAiSettings")}
													</button>
												) : null}
											</div>
										) : null}
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<footer className="customizer-modal__foot">
					<div className="customizer-composer">
						<textarea
							ref={textareaRef}
							rows={1}
							data-testid="app-customizer-input"
							className="customizer-composer__input"
							placeholder={t("settingsCore.sidebar.modal.placeholder")}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={handleKeyDown}
						/>
						{running ? (
							<button
								type="button"
								className="customizer-composer__send is-stop"
								data-action="stop-customizer-message"
								title={t("settingsCore.sidebar.modal.stop")}
								aria-label={t("settingsCore.sidebar.modal.stop")}
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
								title={t("settingsCore.sidebar.modal.send")}
								aria-label={t("settingsCore.sidebar.modal.send")}
								onClick={() => sendMessage(input)}
							>
								<ArrowUp size={15} strokeWidth={2.2} />
							</button>
						)}
					</div>
					<div className="customizer-modal__footnote">
						<Lock size={11} aria-hidden="true" />
						<span>{t("settingsCore.sidebar.modal.lockedNotice")}</span>
					</div>
				</footer>
			</div>
		</div>,
		document.body,
	);
}
