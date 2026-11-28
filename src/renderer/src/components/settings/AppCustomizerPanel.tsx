import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { AutomationDraftCard } from "../AutomationsView";
import { rightClickSentence } from "../RightClickWhen";
import {
	SidebarChatComposer,
	SidebarChatEmpty,
	SidebarChatProgress,
	SidebarChatShell,
	SidebarReplyBody,
} from "../SidebarChat";
import type { AppCustomizerBridge, AppCustomizerChange, AppCustomizerEvent, AppCustomizerPrompt, AppCustomizerPromptAnswer, AppCustomizerSurface, ConfigAssistantSurface } from "../../../../shared/app-customizer-contract";
import type { LocaleKey } from "../../../../shared/i18n/core";
import type { AppSettings } from "../../../../shared/settings-contract";
import { findSecrets, redactSecrets } from "../../../../shared/secret-guard";

type CustomizerWindow = Window & {
	readonly autorag?: { readonly appCustomizer?: AppCustomizerBridge; readonly settings?: { get(): Promise<AppSettings>; set(patch: Partial<AppSettings>): Promise<AppSettings> } };
};

/** One 매직 액션 만들기 press: the card it opened, and once 추가하기 saved it, the name it was saved under. */
interface MagicStarter {
	readonly key: number;
	readonly added: string | null;
}

function getCustomizerBridge(): AppCustomizerBridge | undefined {
	return (window as CustomizerWindow).autorag?.appCustomizer;
}

interface ChatTurn {
	readonly id: string;
	readonly userText: string;
	readonly messages: readonly string[];
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
	/** The composer's prompt (Figma 367:8865, 367:8820, 367:8586). */
	readonly placeholder: LocaleKey;
	readonly suggestions: readonly LocaleKey[];
	readonly thinking: LocaleKey;
	readonly openAiSettings: LocaleKey;
	readonly unavailable: LocaleKey;
}

/**
 * Every assistant but 우클릭 메뉴's opens the same way: one greeting and no example prompts, since most of what those
 * pages do takes one click and the assistant is there for whatever else the person wants. 우클릭 메뉴 keeps its
 * examples: Magic Actions are new to people and their requests are long.
 */
const OPEN_GREETING = {
	emptyTitle: "settingsCore.assistantGreeting.title",
	emptyDesc: "settingsCore.assistantGreeting.desc",
	placeholder: "settingsCore.assistantGreeting.placeholder",
	suggestions: [],
} as const satisfies Pick<SurfaceCopy, "emptyTitle" | "emptyDesc" | "placeholder" | "suggestions">;

/** The context-menu assistant has no copy of its own for the shared states and reuses the sidebar assistant's. */
const OWN_SURFACE_COPY: Readonly<Record<"sidebar" | "contextMenu" | "shortcuts", SurfaceCopy>> = {
	sidebar: {
		title: "settingsCore.sidebar.assistant.title",
		...OPEN_GREETING,
		thinking: "settingsCore.sidebar.assistant.thinking",
		openAiSettings: "settingsCore.sidebar.assistant.openAiSettings",
		unavailable: "settingsCore.sidebar.assistant.unavailable",
	},
	contextMenu: {
		title: "settingsCore.contextMenu.assistant.title",
		emptyTitle: "settingsCore.contextMenu.assistant.emptyTitle",
		emptyDesc: "settingsCore.contextMenu.assistant.emptyDesc",
		placeholder: "settingsCore.contextMenu.assistant.placeholder",
		suggestions: [
			"settingsCore.contextMenu.assistant.promptSummarizeDoc",
			"settingsCore.contextMenu.assistant.promptCompareFiles",
			"settingsCore.contextMenu.assistant.promptPaperToDiscord",
			"settingsCore.contextMenu.assistant.promptMaskToPdf",
		],
		thinking: "settingsCore.sidebar.assistant.thinking",
		openAiSettings: "settingsCore.sidebar.assistant.openAiSettings",
		unavailable: "settingsCore.sidebar.assistant.unavailable",
	},
	shortcuts: {
		title: "settingsCore.shortcuts.assistant.title",
		...OPEN_GREETING,
		thinking: "settingsCore.shortcuts.assistant.thinking",
		openAiSettings: "settingsCore.shortcuts.assistant.openAiSettings",
		unavailable: "settingsCore.shortcuts.assistant.unavailable",
	},
};

/** The assistants of the config pages share one set of states; only the words that name the page differ. */
function configSurfaceCopy(surface: ConfigAssistantSurface): SurfaceCopy {
	const base = `settingsCore.assistants.${surface}` as const;
	return {
		title: `${base}.title`,
		...OPEN_GREETING,
		thinking: "settingsCore.sidebar.assistant.thinking",
		openAiSettings: "settingsCore.sidebar.assistant.openAiSettings",
		unavailable: "settingsCore.sidebar.assistant.unavailable",
	};
}

function surfaceCopy(surface: AppCustomizerSurface): SurfaceCopy {
	return surface === "sidebar" || surface === "contextMenu" || surface === "shortcuts" ? OWN_SURFACE_COPY[surface] : configSurfaceCopy(surface);
}


/**
 * What the assistant asks outside the chat: a masked field for a secret, or a yes/no listing what will happen. The typed value
 * lives only in this field's state until it is sent to the main process, and is cleared the moment it is sent or the card closes.
 */
function PromptCard({ prompt, onAnswer }: { readonly prompt: AppCustomizerPrompt; readonly onAnswer: (answer: AppCustomizerPromptAnswer) => void }): ReactElement {
	const { t } = useTranslation();
	const [value, setValue] = useState("");
	const cardRef = useRef<HTMLDivElement>(null);
	// The card is the thing the person must act on: bring it, buttons included, into view when it opens.
	useEffect(() => {
		cardRef.current?.scrollIntoView({ block: "end" });
	}, []);
	if (prompt.kind === "confirm") {
		return (
			<div ref={cardRef} className="customizer-prompt" data-prompt="confirm" role="group" aria-label={prompt.title}>
				<div className="customizer-prompt__title">{prompt.title}</div>
				{prompt.lines.length > 0 ? (
					<ul className="customizer-prompt__lines">
						{prompt.lines.map((line, idx) => (
							<li key={idx}>{line}</li>
						))}
					</ul>
				) : null}
				<div className="customizer-prompt__actions">
					<button type="button" className="linear-btn" data-action="prompt-cancel" onClick={() => onAnswer({ kind: "confirm", confirmed: false })}>
						{t("settingsCore.assistantPrompt.no")}
					</button>
					<button type="button" className="linear-btn settings-btn-primary" data-action="prompt-confirm" onClick={() => onAnswer({ kind: "confirm", confirmed: true })}>
						{t("settingsCore.assistantPrompt.yes")}
					</button>
				</div>
			</div>
		);
	}
	const submit = (): void => {
		const typed = value;
		if (typed.trim().length === 0) return;
		setValue("");
		onAnswer({ kind: "secret", value: typed });
	};
	return (
		<div ref={cardRef} className="customizer-prompt" data-prompt="secret" role="group" aria-label={prompt.title}>
			<div className="customizer-prompt__title">{prompt.title}</div>
			<p className="customizer-prompt__detail">{prompt.detail}</p>
			{prompt.hint !== undefined ? <p className="customizer-prompt__hint">{prompt.hint}</p> : null}
			<input
				className="customizer-prompt__field"
				type="password"
				autoFocus
				autoComplete="off"
				spellCheck={false}
				value={value}
				placeholder={t("settingsCore.assistantPrompt.secretPlaceholder")}
				aria-label={prompt.title}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.nativeEvent.isComposing) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			<div className="customizer-prompt__actions">
				<button type="button" className="linear-btn" data-action="prompt-cancel" onClick={() => { setValue(""); onAnswer({ kind: "cancelled" }); }}>
					{t("common.cancel")}
				</button>
				<button type="button" className="linear-btn settings-btn-primary" data-action="prompt-submit" disabled={value.trim().length === 0} onClick={submit}>
					{t("settingsCore.assistantPrompt.save")}
				</button>
			</div>
		</div>
	);
}

function makeId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
	sourceAlias = null,
	hidden,
	focusRequest,
	prefill,
	onSettingsUpdated,
	onChangesApplied,
	onOpenAiSettings,
	starterRequest = 0,
}: {
	readonly surface: AppCustomizerSurface;
	/** Active datasource alias when docked beside a `source:<alias>` detail page. */
	readonly sourceAlias?: string | null;
	readonly hidden: boolean;
	/** Bumped when the user explicitly opens the panel; the composer takes focus then, never on a plain page visit. */
	readonly focusRequest: number;
	/** Optional prompt pre-filled into the composer (e.g. from Notification Center "Fix with AI"). */
	readonly prefill?: { readonly text: string; readonly nonce: number } | null | undefined;
	readonly onSettingsUpdated: (settings: AppSettings) => void;
	/** A turn ended with settings changed (even one the person stopped or that failed half way): the page beside the sidebar reads them again. */
	readonly onChangesApplied: () => void;
	readonly onOpenAiSettings: () => void;
	/**
	 * Bumped by 우클릭 메뉴's 매직 액션 만들기: the chat opens a new-action card, the same form as the 자동화 tab's
	 * 새 자동화 card set to 우클릭하면, under a "새 매직 액션 만들기" turn.
	 */
	readonly starterRequest?: number;
}): ReactElement {
	const { t } = useTranslation();
	const copy = surfaceCopy(surface);
	const [sessionId, setSessionId] = useState(() => makeId(`customizer-${surface}-sess`));
	const [turns, setTurns] = useState<readonly ChatTurn[]>([]);
	const [input, setInput] = useState("");
	/** The cards the assistant has open right now; at most one per run in practice. */
	const [prompts, setPrompts] = useState<readonly AppCustomizerPrompt[]>([]);
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	activeRunIdRef.current = activeRunId;
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const appliedPrefillNonce = useRef(0);
	const [starters, setStarters] = useState<readonly MagicStarter[]>([]);

	useEffect(() => {
		if (starterRequest > 0) setStarters((current) => (current.some((item) => item.key === starterRequest) ? current : [...current, { key: starterRequest, added: null }]));
	}, [starterRequest]);

	useEffect(() => {
		if (prefill === null || prefill === undefined || prefill.nonce === appliedPrefillNonce.current) return;
		appliedPrefillNonce.current = prefill.nonce;
		setInput(prefill.text);
	}, [prefill]);

	useEffect(() => {
		if (focusRequest > 0 && !hidden) {
			const el = textareaRef.current;
			if (el !== null) {
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			}
		}
	}, [focusRequest, hidden, prefill]);

	useEffect(() => {
		const bridge = getCustomizerBridge();
		if (bridge === undefined) return;
		return bridge.onEvent((event: AppCustomizerEvent) => {
			if (event.sessionId !== sessionId) return;
			if (event.type === "prompt") {
				setPrompts((current) => [...current.filter((entry) => entry.id !== event.prompt.id), event.prompt]);
				return;
			}
			if (event.type === "prompt-closed") {
				setPrompts((current) => current.filter((entry) => entry.id !== event.promptId));
				return;
			}
			setTurns((prev) =>
				prev.map((turn) => {
					if (turn.id !== event.runId) return turn;
					switch (event.type) {
						case "progress":
							return { ...turn, progress: event.text };
						case "draft":
							return {
								...turn,
								draft: event.text,
								...(event.text.length > 0 ? { progress: "" } : {}),
							};
						case "assistant-message":
							return {
								...turn,
								messages: [...turn.messages, event.text],
								draft: "",
								progress: "",
							};
						case "turn-done":
							return {
								...turn,
								status: "done",
								messages: event.messages,
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
			if (event.type !== "progress" && event.type !== "draft" && event.type !== "assistant-message" && event.changes.length > 0) onChangesApplied();
			if (event.type === "turn-done") {
				onSettingsUpdated(event.settings);
				setActiveRunId((current) => (current === event.runId ? null : current));
			} else if (event.type === "error" || event.type === "cancelled") {
				setActiveRunId((current) => (current === event.runId ? null : current));
			}
		});
	}, [sessionId, onSettingsUpdated, onChangesApplied]);

	const answerPrompt = useCallback((promptId: string, answer: AppCustomizerPromptAnswer): void => {
		setPrompts((current) => current.filter((entry) => entry.id !== promptId));
		void getCustomizerBridge()?.answer(promptId, answer);
	}, []);

	const stopRun = useCallback((): void => {
		const runId = activeRunIdRef.current;
		if (runId === null) return;
		setActiveRunId(null);
		setPrompts([]);
		setTurns((prev) =>
			prev.map((turn) =>
				turn.id === runId && turn.status === "running"
					? {
							...turn,
							status: "cancelled",
							messages: turn.draft.trim().length > 0 ? [...turn.messages, turn.draft.trim()] : turn.messages,
							progress: "",
							draft: "",
						}
					: turn,
			),
		);
		void getCustomizerBridge()?.cancel(runId);
	}, []);

	const sendMessage = useCallback(
		(rawText: string): void => {
			// A credential typed into the chat box is dropped here, before it is shown, kept or sent: the masked key field is the place for it.
			const trimmed = (findSecrets(rawText) > 0 ? redactSecrets(rawText) : rawText).trim();
			if (trimmed.length === 0 || activeRunIdRef.current !== null) return;
			const runId = makeId("customizer-run");
			setInput("");
			setActiveRunId(runId);
			setTurns((prev) => [
				...prev,
				{
					id: runId,
					userText: trimmed,
					messages: [],
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
			void bridge
				.send(runId, { sessionId, message: trimmed, surface, ...(sourceAlias !== null && sourceAlias.length > 0 ? { sourceAlias } : {}) })
				.catch((cause: unknown) => {
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
		[sessionId, surface, sourceAlias, copy, t],
	);

	const resetChat = useCallback((): void => {
		if (activeRunIdRef.current !== null) {
			void getCustomizerBridge()?.cancel(activeRunIdRef.current);
		}
		void getCustomizerBridge()?.reset(sessionId);
		setActiveRunId(null);
		setTurns([]);
		setStarters([]);
		setSessionId(makeId(`customizer-${surface}-sess`));
		textareaRef.current?.focus();
	}, [sessionId, surface]);

	const running = activeRunId !== null;
	const latestTurn = turns.at(-1);
	const followKey = `${turns.length}:${starters.length}:${latestTurn?.status ?? ""}:${latestTurn?.messages.length ?? 0}:${latestTurn?.draft.length ?? 0}:${latestTurn?.progress ?? ""}`;

	return (
		<SidebarChatShell
			aria-label={t(copy.title)}
			data-testid="app-customizer-panel"
			data-surface={surface}
			hidden={hidden}
			running={running}
			followKey={followKey}
			footer={
				<SidebarChatComposer
					textareaRef={textareaRef}
					inputTestId="app-customizer-input"
					value={input}
					onChange={setInput}
					onSend={() => sendMessage(input)}
					onStop={stopRun}
					onReset={resetChat}
					showReset={turns.length > 0}
					running={running}
					placeholder={t(copy.placeholder)}
					inputAriaLabel={t("settingsCore.sidebar.assistant.inputLabel")}
					sendLabel={t("settingsCore.sidebar.assistant.send")}
					stopLabel={t("settingsCore.sidebar.assistant.stop")}
					resetLabel={t("settingsCore.sidebar.assistant.newChat")}
					sendAction="send-customizer-message"
					stopAction="stop-customizer-message"
					resetAction="reset-customizer-chat"
					hidden={hidden}
				/>
			}
		>
			{turns.length === 0 && starters.length === 0 ? (
				<SidebarChatEmpty title={t(copy.emptyTitle)} description={t(copy.emptyDesc)} rise>
					{copy.suggestions.length === 0 ? null : (
						<div className="customizer-panel__suggestions">
							{copy.suggestions.map((key, index) => (
								<button
									key={key}
									type="button"
									className="customizer-suggestion-chip customizer-rise"
									style={{ "--rise-i": index } as CSSProperties}
									data-action="customizer-suggestion"
									onClick={() => sendMessage(t(key))}
								>
									<span>{t(key)}</span>
								</button>
							))}
						</div>
					)}
				</SidebarChatEmpty>
			) : (
				<div className="customizer-panel__turns">
					{turns.map((turn) => (
						<div key={turn.id} className="customizer-turn">
							<div className="customizer-turn__user-row">
								<div className="customizer-turn__user-bubble">{turn.userText}</div>
							</div>
							<div className="customizer-turn__assistant-row">
								{(turn.changes.length > 0 && turn.messages.length > 0 ? turn.messages.slice(0, -1) : turn.messages).map(
									(message, idx) => (
										<SidebarReplyBody key={idx} text={message} />
									),
								)}
								{turn.changes.length > 0 ? (
									<div className="customizer-turn__changes">
										{turn.changes.map((change, idx) => (
											<span key={idx} className="customizer-change-pill">
												<Check size={14} strokeWidth={1.8} aria-hidden="true" />
												<span>{change.summary}</span>
											</span>
										))}
									</div>
								) : null}
								{turn.changes.length > 0 && turn.messages.length > 0 ? (
									<SidebarReplyBody text={turn.messages[turn.messages.length - 1]!} />
								) : null}
								{turn.status === "running" && turn.draft.length > 0 ? (
									<SidebarReplyBody text={turn.draft} />
								) : null}
								{turn.status === "running"
									? prompts.map((prompt) => <PromptCard key={prompt.id} prompt={prompt} onAnswer={(answer) => answerPrompt(prompt.id, answer)} />)
									: null}
								{turn.status === "running" && turn.draft.length === 0 && prompts.length === 0 ? (
									<SidebarChatProgress text={turn.progress.length > 0 ? turn.progress : t(copy.thinking)} />
								) : null}
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
					{starters.map((starter) => (
						// As 새 자동화 does in the AI column: the person's 새 매직 액션 만들기, the reply, and the card, rising one after another.
						<div key={`starter-${starter.key}`} className="customizer-turn" data-magic-starter={starter.key}>
							<div className="customizer-turn__user-row animate-rise [animation-fill-mode:both]">
								<div className="customizer-turn__user-bubble">{t("settingsCore.contextMenu.assistant.starterUser")}</div>
							</div>
							<div className="customizer-turn__assistant-row">
								<div className="animate-rise [animation-delay:140ms] [animation-fill-mode:both]">
									<SidebarReplyBody text={t("settingsCore.contextMenu.assistant.starterReply")} />
								</div>
								{starter.added === null ? (
									// The card takes the column's whole width and follows it as the sidebar is resized.
									<div className="w-full min-w-0 self-stretch animate-rise [animation-delay:280ms] [animation-fill-mode:both]">
										<AutomationDraftCard
											initial={null}
											rightClickOnly
											onCreate={async () => false}
											onCreateMagicAction={async (action) => {
												// Hand the form request to the Settings assistant so it verifies in a temp sandbox and saves directly.
												const taskText = action.execution.kind === "agent" ? action.execution.prompt : action.execution.command;
												const target = rightClickSentence(t, action);
												const prompt = `${t("settingsCore.contextMenu.assistant.starterUser")}: ${target} — ${taskText}`;
												setStarters((current) => current.filter((item) => item.key !== starter.key));
												sendMessage(prompt);
												return true;
											}}
											onCancel={() => setStarters((current) => current.filter((item) => item.key !== starter.key))}
										/>
									</div>
								) : (
									<div className="customizer-turn__changes">
										<span className="customizer-change-pill">
											<Check size={14} strokeWidth={1.8} aria-hidden="true" />
											<span>{t("settingsCore.contextMenu.assistant.starterAdded", { title: starter.added })}</span>
										</span>
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</SidebarChatShell>
	);
}
