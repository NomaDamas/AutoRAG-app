/**
 * The interaction dock: what the AI Search panel shows in place of its composer
 * while the librarian's agent waits for the person (librarian v2.12).
 *
 * Two cards share the frame:
 *
 * - a **question** from `ask_user` — one question, or 2–4 shown as a stepper;
 *   options (single or multiple choice) and a "write your own answer" row;
 * - an **approval** from the file-change gate — the call, what it changes and
 *   why, with allow once / allow for the session / skip (deny).
 *
 * The person's answer goes back through the preload bridge; the dock never
 * touches run state. Stop is the panel's own handler, still reachable from the
 * dock's footer, and Escape dismisses the request (a question: `cancel`; an
 * approval: `deny`) instead of stopping the run.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import type {
	ApprovalRequest,
	InteractionAnswer,
	InteractionBridge,
	InteractionRequest,
	Question,
	QuestionRequest,
} from "../../../shared/interaction-contract";
import {
	allowOnceAnswer,
	allowSessionAnswer,
	answeredCount,
	approvalHeadlineKey,
	approvalNoteKey,
	approvalReasonVisible,
	buildAnswer,
	canSubmit,
	cancelAnswer,
	categoryKey,
	denyAnswer,
	draftAnswer,
	draftAt,
	initialQuestionState,
	selectOption,
	sessionAllowKey,
	setFreeform,
	setFreeformOpen,
	setStep,
	type QuestionState,
} from "../state/interaction";
import { CheckIcon } from "./icons";
import { noticeButtonClass } from "./primitives/NoticeCard";

/** A context longer than this (or more than three lines) starts collapsed with a Show more toggle. */
const CONTEXT_COLLAPSE_LIMIT = 200;

/** The preload bridge; undefined only where a unit test renders the dock without one. */
function interactionBridge(): InteractionBridge | undefined {
	return window.autorag?.interaction;
}

function answerRequest(id: string, answer: InteractionAnswer): void {
	void interactionBridge()?.answer(id, answer);
}

/** Whether the question's found-so-far context is long enough to hide behind "Show more". */
function contextIsLong(context: string): boolean {
	return context.length > CONTEXT_COLLAPSE_LIMIT || context.split("\n").length > 3;
}

const DOCK_CARD = "flex min-w-0 max-w-full flex-col gap-10 rounded-12 border border-border bg-input p-12 [overflow-wrap:anywhere]";
const PRIMARY_BUTTON =
	"inline-flex h-28 flex-none items-center justify-center gap-5 rounded-8 border-0 bg-accent px-12 text-meta font-medium text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-accent-hover disabled:cursor-default disabled:bg-border-strong";
const SECONDARY_BUTTON =
	"inline-flex h-28 flex-none items-center justify-center gap-5 rounded-8 border border-border bg-window px-12 text-meta font-medium text-ink-body cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-hover disabled:cursor-default disabled:text-ink-faint";
const GHOST_BUTTON =
	"inline-flex h-28 flex-none items-center justify-center gap-5 rounded-8 border-0 bg-transparent px-10 text-meta font-medium text-ink-muted cursor-pointer transition-colors duration-(--dur-color) ease-out enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-default disabled:text-ink-faint";
const OPTION_BUTTON =
	"flex w-full items-start gap-8 rounded-10 border px-10 py-8 text-left cursor-pointer transition-colors duration-(--dur-color) ease-out";
const FIELD =
	"w-full rounded-10 border border-border bg-window px-10 py-8 text-body text-ink-body outline-none placeholder:text-ink-muted focus:border-accent";

export interface InteractionDockProps {
	readonly request: InteractionRequest;
	/** Stop the run; the dock's footer Stop keeps it reachable while a request is open. */
	readonly onStop: () => void;
}

export function InteractionDock({ request, onStop }: InteractionDockProps): ReactElement {
	// Escape dismisses the request, never the run. Capture phase at the window so
	// it runs before the panel's own keydown listener whatever the focus is.
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			answerRequest(request.id, request.kind === "approval" ? denyAnswer() : cancelAnswer());
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [request]);

	return request.kind === "approval" ? (
		<ApprovalCard request={request} />
	) : (
		<QuestionCard request={request} onStop={onStop} />
	);
}

/** The dock's own Stop: the panel's stop handler stays reachable while a request is open. */
function StopButton({ onStop }: { readonly onStop: () => void }): ReactElement {
	const { t } = useTranslation();
	return (
		<button type="button" className={GHOST_BUTTON} onClick={onStop}>
			{t("interaction.stop")}
		</button>
	);
}

function QuestionCard({ request, onStop }: { readonly request: QuestionRequest; readonly onStop: () => void }): ReactElement {
	const { t } = useTranslation();
	const [state, setState] = useState<QuestionState>(() => initialQuestionState(request));
	const [showContext, setShowContext] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const headingId = useId();
	const total = request.questions.length;
	const step = state.step;
	const question: Question | undefined = request.questions[step];
	const draft = draftAt(state, step);

	useEffect(() => setShowContext(false), [step]);
	// Keyboard users start inside the list: number keys and the arrows work without a click first.
	useEffect(() => {
		if ((request.questions[step]?.options.length ?? 0) > 0) listRef.current?.focus();
	}, [request, step]);

	const answer = (next: QuestionState): void => {
		answerRequest(request.id, buildAnswer(request, next));
	};

	const pick = (title: string): void => {
		if (question === undefined) return;
		const next = selectOption(state, question, step, title);
		setState(next);
		// A single-choice single question needs no explicit Submit: picking answers it.
		if (!question.allowMultiple && total === 1) answer(next);
	};

	const onFreeformKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		const next = setFreeform(state, step, event.currentTarget.value);
		setState(next);
		// A single question submits on Enter, but an empty (or blank) answer is not an answer.
		if (total === 1 && question !== undefined && draftAnswer(question, draftAt(next, step)) !== null) answer(next);
	};

	/** Number keys pick, Arrow keys move focus; Space/Enter reach the focused option as a click. */
	const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[role]") ?? [])];
		if (buttons.length === 0) return;
		if (/^[1-9]$/u.test(event.key)) {
			const index = Number(event.key) - 1;
			const option = question?.options[index];
			if (option === undefined) return;
			event.preventDefault();
			buttons[index]?.focus();
			pick(option.title);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		event.preventDefault();
		const next = current < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const context = question?.context?.trim() ?? "";
	const freeformOpen = draft.freeformOpen || (question?.options.length ?? 0) === 0;
	const askingFreeform = question !== undefined && (question.allowFreeform || question.options.length === 0);

	return (
		<div
			className={DOCK_CARD}
			role="dialog"
			aria-labelledby={request.heading === undefined ? undefined : headingId}
			aria-label={request.heading === undefined ? t("interaction.questionAria") : undefined}
		>
			<div className="flex items-start gap-8">
				<span className="grid size-icon-sm flex-none place-items-center rounded-6 bg-accent-soft text-accent">
					<MessageCircleQuestion size={16} />
				</span>
				{request.heading === undefined ? null : (
					<strong id={headingId} className="min-w-0 flex-1 text-body font-semibold text-ink">
						{request.heading}
					</strong>
				)}
			</div>

			{question === undefined ? null : (
				<div className="flex flex-col gap-10">
					{total > 1 ? (
						<span className="text-badge font-medium text-ink-muted tabular-nums">{t("interaction.step", { current: step + 1, total })}</span>
					) : null}
					<strong className="text-body font-semibold text-ink">{question.question}</strong>

					{context === "" ? null : (
						<div className="text-meta leading-[1.5] text-ink-muted">
							<p className={`m-0 whitespace-pre-wrap ${showContext ? "" : "line-clamp-3"}`}>{context}</p>
							{contextIsLong(context) ? (
								<button
									type="button"
									className="mt-4 cursor-pointer border-0 bg-transparent p-0 text-badge font-medium text-accent-text"
									onClick={() => setShowContext((open) => !open)}
								>
									{showContext ? t("interaction.showLess") : t("interaction.showMore")}
								</button>
							) : null}
						</div>
					)}

					{question.options.length === 0 ? null : (
						<div
							ref={listRef}
							role={question.allowMultiple ? "group" : "radiogroup"}
							aria-label={question.question}
							className="flex flex-col gap-4 outline-none"
							tabIndex={-1}
							onKeyDown={onListKeyDown}
						>
							{question.options.map((option) => {
								const checked = draft.selections.includes(option.title);
								return (
									<button
										key={option.title}
										type="button"
										role={question.allowMultiple ? "checkbox" : "radio"}
										aria-checked={checked}
										className={`${OPTION_BUTTON} ${checked ? "border-accent bg-accent-soft" : "border-border bg-window hover:bg-hover"}`}
										onClick={() => pick(option.title)}
									>
										<span
											className={`mt-[2px] grid size-16 flex-none place-items-center border ${question.allowMultiple ? "rounded-4" : "rounded-full"} ${checked ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-transparent"}`}
										>
											{checked ? <CheckIcon size={10} /> : null}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block text-body font-medium text-ink">{option.title}</span>
											{option.description === undefined ? null : (
												<span className="mt-2 block text-meta text-ink-muted">{option.description}</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					)}

					{askingFreeform ? (
						freeformOpen ? (
							<textarea
								autoFocus
								value={draft.freeform}
								onChange={(event) => setState(setFreeform(state, step, event.target.value))}
								onKeyDown={onFreeformKeyDown}
								rows={2}
								placeholder={t("interaction.answerPlaceholder")}
								aria-label={t("interaction.writeOwn")}
								className={`${FIELD} resize-none`}
							/>
						) : (
							<button type="button" className={SECONDARY_BUTTON} onClick={() => setState(setFreeformOpen(state, step, true))}>
								{t("interaction.writeOwn")}
							</button>
						)
					) : null}
				</div>
			)}

			<div className="flex flex-col gap-8">
				{total > 1 ? (
					<div className="flex flex-wrap items-center gap-8">
						<span className="min-w-0 flex-1 text-meta text-ink-muted tabular-nums">
							{t("interaction.answeredCount", { answered: answeredCount(request, state), total })}
						</span>
						<button
							type="button"
							className={SECONDARY_BUTTON}
							disabled={step === 0}
							onClick={() => setState(setStep(state, step - 1, total))}
						>
							{t("interaction.back")}
						</button>
						{step < total - 1 ? (
							<button type="button" className={SECONDARY_BUTTON} onClick={() => setState(setStep(state, step + 1, total))}>
								{t("interaction.next")}
							</button>
						) : (
							<button type="button" className={PRIMARY_BUTTON} disabled={!canSubmit(request, state)} onClick={() => answer(state)}>
								{t("interaction.submit")}
							</button>
						)}
					</div>
				) : null}
				<div className="flex flex-wrap items-center gap-8">
					<StopButton onStop={onStop} />
					<button type="button" className={GHOST_BUTTON} onClick={() => answerRequest(request.id, cancelAnswer())}>
						{t("interaction.skip")}
					</button>
					<span className="flex-1" />
					{total <= 1 && question !== undefined && (question.allowMultiple || draft.freeform.trim() !== "") ? (
						<button type="button" className={PRIMARY_BUTTON} disabled={draftAnswer(question, draft) === null} onClick={() => answer(state)}>
							{t("interaction.submit")}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

/**
 * The file-change approval (Figma 564:1396): a shield and the question, the call in a grey box with what it does
 * under it, then 한 번만 허용 · 이 세션에서는 모두 허용 on the left and 건너뛰기 (deny) on the right. Escape denies too.
 */
function ApprovalCard({ request }: { readonly request: ApprovalRequest }): ReactElement {
	const { t } = useTranslation();
	const headlineId = useId();
	const reasonVisible = useMemo(() => approvalReasonVisible(request), [request]);
	const noteKey = approvalNoteKey(request);
	// The line under the call: what the gate flagged, then why (the judgement's reason, or the app's own note).
	const categories = request.categories.map((category) => t(categoryKey(category))).join(" · ");
	const why = reasonVisible ? request.reason : noteKey === null ? "" : t(noteKey);
	const detail = [categories, why].filter((part) => part !== "").join(" — ");

	return (
		<div
			className="flex flex-col gap-12 rounded-14 border border-border bg-window p-16 shadow-[var(--shadow-notice)]"
			role="alertdialog"
			aria-labelledby={headlineId}
		>
			<div className="flex items-center gap-8">
				<ShieldCheck size={16} strokeWidth={1.6} className="flex-none text-warn-text" aria-hidden="true" />
				<strong id={headlineId} className="min-w-0 flex-1 text-[14px] font-bold leading-[20px] text-ink break-keep">
					{t(approvalHeadlineKey(request))}
				</strong>
			</div>

			<div className="flex flex-col gap-6 rounded-8 bg-code px-12 py-10">
				<pre className="m-0 max-h-[180px] select-text overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-ink">{request.call}</pre>
				{detail === "" ? null : <p className="m-0 text-[11px] leading-[1.45] text-ink-muted">{detail}</p>}
			</div>

			<div className="flex flex-wrap items-center gap-8">
				<button type="button" className={noticeButtonClass(true)} onClick={() => answerRequest(request.id, allowOnceAnswer())}>
					{t("interaction.allowOnce")}
				</button>
				<button type="button" className={noticeButtonClass(false)} onClick={() => answerRequest(request.id, allowSessionAnswer())}>
					{t(sessionAllowKey(request))}
				</button>
				<span className="flex-1" />
				<button type="button" autoFocus className={noticeButtonClass(false)} onClick={() => answerRequest(request.id, denyAnswer())}>
					{t("interaction.skip")}
				</button>
			</div>
		</div>
	);
}
