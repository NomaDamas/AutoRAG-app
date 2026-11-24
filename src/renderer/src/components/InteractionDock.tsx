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

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Copy, Info, ShieldCheck } from "lucide-react";
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

/** Both cards (Figma 625:6871, 625:7022): a white tile with a 14px radius, 16px padding and 14px between its parts. */
const DOCK_CARD =
	"flex min-w-0 max-w-full flex-col gap-14 rounded-14 border border-divider bg-window p-16 shadow-[0_2px_6px_rgba(0,0,0,0.12)] [overflow-wrap:anywhere]";
const BUTTON = "inline-flex h-28 items-center justify-center gap-4 rounded-6 px-10 text-meta font-medium leading-[16px] cursor-pointer transition-opacity duration-(--dur-color) ease-out";
const PRIMARY_BUTTON = `${BUTTON} flex-none border-0 bg-accent text-on-accent enabled:hover:opacity-80 disabled:cursor-default disabled:opacity-50`;
const SECONDARY_BUTTON = `${BUTTON} border border-border bg-window text-ink-body enabled:hover:opacity-80`;
/** 건너뛰기 and 중단: muted text, no box. */
const LINK_BUTTON =
	"inline-flex h-28 flex-none items-center border-0 bg-transparent p-0 text-meta font-medium leading-[16px] text-ink-muted whitespace-nowrap cursor-pointer hover:text-ink";
const OPTION_BUTTON =
	"flex w-full items-start gap-10 rounded-6 border px-12 py-10 text-left cursor-pointer transition-colors duration-(--dur-color) ease-out";
const FIELD =
	"w-full rounded-6 border border-border bg-window px-12 py-8 text-meta leading-[16px] text-ink-body outline-none placeholder:text-ink-muted focus:border-accent";

/** The card's head: a 20px icon tile, then the title in bold and an optional muted line under it. */
function CardHead({
	icon,
	title,
	titleId,
	sub,
	trailing,
}: {
	readonly icon: ReactElement;
	readonly title: string;
	readonly titleId: string;
	readonly sub?: ReactNode;
	readonly trailing?: ReactNode;
}): ReactElement {
	return (
		<div className={`flex gap-10 ${sub === undefined || sub === null ? "items-center" : "items-start"}`}>
			<span className="grid size-20 flex-none place-items-center">{icon}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<strong id={titleId} className="text-[13px] font-bold leading-[17px] text-ink">
					{title}
				</strong>
				{sub}
			</div>
			{trailing}
		</div>
	);
}

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

/**
 * A question from `ask_user` (Figma 625:7022, 625:7171): an info icon and the question (a batch: its heading with
 * ‹ n / N › and a bar per question, the question under it), the options as radio rows, a dashed 직접 입력하기 row,
 * then 건너뛰기 · 중단 on the left and 보내기 (a batch's earlier questions: 다음) on the right.
 */
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
	const batch = total > 1;

	useEffect(() => setShowContext(false), [step]);
	// Keyboard users start inside the list: number keys and the arrows work without a click first.
	useEffect(() => {
		if ((request.questions[step]?.options.length ?? 0) > 0) listRef.current?.focus();
	}, [request, step]);

	const answer = (next: QuestionState): void => {
		answerRequest(request.id, buildAnswer(request, next));
	};

	// Picking marks the option; 보내기 sends it, so a slip of the mouse can still be changed.
	const pick = (title: string): void => {
		if (question === undefined) return;
		setState(selectOption(state, question, step, title));
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
	const last = step >= total - 1;

	const contextBlock =
		context === "" ? null : (
			<div className="text-[11px] leading-[16px] text-ink-muted">
				<p className={`m-0 whitespace-pre-wrap ${showContext ? "" : "line-clamp-3"}`}>{context}</p>
				{contextIsLong(context) ? (
					<button
						type="button"
						className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-accent-text"
						onClick={() => setShowContext((open) => !open)}
					>
						{showContext ? t("interaction.showLess") : t("interaction.showMore")}
					</button>
				) : null}
			</div>
		);

	const pager = batch ? (
		<div className="flex flex-none items-center gap-4 text-ink-muted">
			<button
				type="button"
				aria-label={t("interaction.prevQuestion")}
				title={t("interaction.prevQuestion")}
				disabled={step === 0}
				className="grid size-16 place-items-center rounded-4 border-0 bg-transparent p-0 text-ink-muted cursor-pointer enabled:hover:text-ink disabled:cursor-default disabled:opacity-40"
				onClick={() => setState(setStep(state, step - 1, total))}
			>
				<ChevronLeft size={13} strokeWidth={1.6} />
			</button>
			<span className="text-[11px] font-medium leading-[14px] tabular-nums">{t("interaction.step", { current: step + 1, total })}</span>
			<button
				type="button"
				aria-label={t("interaction.nextQuestion")}
				title={t("interaction.nextQuestion")}
				disabled={last}
				className="grid size-16 place-items-center rounded-4 border-0 bg-transparent p-0 text-ink-muted cursor-pointer enabled:hover:text-ink disabled:cursor-default disabled:opacity-40"
				onClick={() => setState(setStep(state, step + 1, total))}
			>
				<ChevronRight size={13} strokeWidth={1.6} />
			</button>
		</div>
	) : null;

	return (
		<div className={DOCK_CARD} role="dialog" aria-labelledby={headingId}>
			<CardHead
				icon={<Info size={16} strokeWidth={1.6} className="text-accent" aria-hidden="true" />}
				titleId={headingId}
				// One question is the card's title; a batch is titled by its heading and steps through its questions below.
				title={batch ? (request.heading ?? t("interaction.questionAria")) : (question?.question ?? request.heading ?? t("interaction.questionAria"))}
				sub={batch ? undefined : contextBlock}
				trailing={pager}
			/>

			{batch ? (
				<div className="flex gap-4" aria-hidden="true">
					{request.questions.map((_, index) => (
						<span key={index} className={`h-3 min-w-0 flex-1 rounded-2 ${index <= step ? "bg-accent" : "bg-border"}`} />
					))}
				</div>
			) : null}

			{batch && question !== undefined ? (
				<div className="flex flex-col gap-4">
					<p className="m-0 text-meta leading-[16px] text-ink">{question.question}</p>
					{contextBlock}
				</div>
			) : null}

			{question === undefined || question.options.length === 0 ? null : (
				<div
					ref={listRef}
					role={question.allowMultiple ? "group" : "radiogroup"}
					aria-label={question.question}
					className="flex flex-col gap-8 outline-none"
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
								className={`${OPTION_BUTTON} ${checked ? "border-accent bg-subtle-alt" : "border-border bg-window hover:bg-hover"}`}
								onClick={() => pick(option.title)}
							>
								<span
									className={`grid size-16 flex-none place-items-center border ${question.allowMultiple ? "rounded-4" : "rounded-full"} ${checked ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-window"}`}
								>
									{checked ? question.allowMultiple ? <CheckIcon size={10} /> : <span className="size-6 rounded-full bg-on-accent" /> : null}
								</span>
								<span className="flex min-w-0 flex-1 flex-col gap-3 leading-[16px]">
									<span className="text-meta font-medium text-ink">{option.title}</span>
									{option.description === undefined ? null : <span className="text-[11px] text-ink-muted">{option.description}</span>}
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
					<button
						type="button"
						className="flex w-full items-center rounded-6 border border-dashed border-border bg-window px-12 py-8 text-left text-meta leading-[16px] text-ink-muted cursor-pointer hover:bg-hover"
						onClick={() => setState(setFreeformOpen(state, step, true))}
					>
						{t("interaction.writeOwn")}
					</button>
				)
			) : null}

			<div className="flex flex-wrap items-center gap-8">
				<div className="flex items-center gap-16">
					<button type="button" className={LINK_BUTTON} onClick={() => answerRequest(request.id, cancelAnswer())}>
						{t("interaction.skip")}
					</button>
					<button type="button" className={LINK_BUTTON} onClick={onStop}>
						{t("interaction.stop")}
					</button>
				</div>
				<span className="flex-1" />
				{batch && !last ? (
					<button type="button" className={PRIMARY_BUTTON} onClick={() => setState(setStep(state, step + 1, total))}>
						{t("interaction.next")}
					</button>
				) : (
					<button
						type="button"
						className={PRIMARY_BUTTON}
						disabled={batch ? !canSubmit(request, state) : question === undefined || draftAnswer(question, draft) === null}
						onClick={() => answer(state)}
					>
						{t("interaction.submit")}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * The file-change approval (Figma 625:6871): a shield, the question and under it what the gate flagged and why; the
 * call in a grey box headed 실행할 명령 with a copy button; then 한 번만 허용 across the card, and 이 세션에서 항상 허용 with
 * 건너뛰기 (deny) under it. Escape denies too.
 */
function ApprovalCard({ request }: { readonly request: ApprovalRequest }): ReactElement {
	const { t } = useTranslation();
	const headlineId = useId();
	const reasonVisible = useMemo(() => approvalReasonVisible(request), [request]);
	const noteKey = approvalNoteKey(request);
	// The line under the headline: what the gate flagged, then why (the judgement's reason, or the app's own note).
	const categories = request.categories.map((category) => t(categoryKey(category))).join(" · ");
	const why = reasonVisible ? request.reason : noteKey === null ? "" : t(noteKey);
	const detail = [categories, why].filter((part) => part !== "").join(" — ");

	return (
		<div className={DOCK_CARD} role="alertdialog" aria-labelledby={headlineId}>
			<CardHead
				icon={<ShieldCheck size={16} strokeWidth={1.6} className="text-warn-text" aria-hidden="true" />}
				titleId={headlineId}
				title={t(approvalHeadlineKey(request))}
				sub={detail === "" ? undefined : <p className="m-0 text-[11px] leading-[16px] text-ink-muted">{detail}</p>}
			/>

			<div className="flex flex-col gap-6 rounded-6 bg-code px-12 py-10">
				<div className="flex items-center gap-8">
					<span className="min-w-0 flex-1 text-[11px] font-medium leading-[14px] text-ink-muted">{t("interaction.approval.command")}</span>
					<button
						type="button"
						data-action="copy-approval-call"
						aria-label={t("interaction.approval.copy")}
						title={t("interaction.approval.copy")}
						className="grid size-16 flex-none place-items-center rounded-4 border-0 bg-transparent p-0 text-ink-muted cursor-pointer hover:text-ink"
						onClick={() => void navigator.clipboard?.writeText(request.call)}
					>
						<Copy size={13} strokeWidth={1.4} />
					</button>
				</div>
				<pre className="m-0 max-h-[180px] select-text overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink">{request.call}</pre>
			</div>

			<div className="flex flex-col gap-8">
				<button type="button" className={`${PRIMARY_BUTTON} w-full`} onClick={() => answerRequest(request.id, allowOnceAnswer())}>
					{t("interaction.allowOnce")}
				</button>
				<div className="flex items-center gap-8">
					<button type="button" className={`${SECONDARY_BUTTON} min-w-0 flex-1`} onClick={() => answerRequest(request.id, allowSessionAnswer())}>
						{t(sessionAllowKey(request))}
					</button>
					<button type="button" autoFocus className={`${LINK_BUTTON} justify-center px-6`} onClick={() => answerRequest(request.id, denyAnswer())}>
						{t("interaction.skip")}
					</button>
				</div>
			</div>
		</div>
	);
}
