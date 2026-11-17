import { Check } from "lucide-react";
import { useEffect, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isModelProblem } from "../../../shared/app-error";
import type { ErrorFixAction, ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import { dismissErrorFixDialog, hasRetryTask, retryErrorFix, retryErrorTask, stopErrorFix, useErrorFixSession } from "../hooks/useErrorFix";
import { describeAppError, type ErrorActionId } from "../state/app-error";
import { actionLabel } from "../state/error-fix";
import { cn } from "../lib/cn";
import { ErrorDetails } from "./ErrorDetails";
import { SparklesIcon } from "./icons";
import { NoticeBadge } from "./primitives/NoticeCard";

/**
 * "AI로 해결하기" (Figma 548:14977–14981, 중요 알림): the self-healing helper's state in one small card — looking for the
 * cause, fixed, stopped, could not fix, or needs the person. Closing while it runs hides the card and the repair goes on
 * in the background (the sidebar shows its progress); only 중단 cancels it.
 */

export interface ErrorFixDialogProps {
	readonly onOpenSettings: (page: ErrorFixSettingsPage) => void;
	/** Opens the Settings page of one configured data source, by its alias. */
	readonly onOpenSource: (alias: string) => void;
}

/** Figma Button, size 28: the secondary white with the border, the primary the accent fill. */
function Button({ primary = false, onClick, children }: { readonly primary?: boolean; readonly onClick: () => void; readonly children: ReactNode }): ReactElement {
	return (
		<button
			type="button"
			className={cn(
				"inline-flex h-28 flex-none items-center justify-center gap-4 px-10 rounded-6 border text-meta font-medium leading-[16px] whitespace-nowrap cursor-pointer transition-opacity duration-(--dur-color) ease-out hover:opacity-80",
				primary ? "border-transparent bg-accent text-on-accent" : "border-border bg-window text-ink-body",
			)}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

type FixState = "healing" | "healthy" | "attention" | "error" | "stopped";

/** The 16px mark before the title: sparkles while it works, a check once fixed, the badge when it needs attention. */
function StateMark({ state }: { readonly state: FixState }): ReactElement | null {
	if (state === "healing") return <SparklesIcon size={16} className="flex-none text-accent" />;
	if (state === "healthy") return <Check className="flex-none text-accent" size={16} strokeWidth={2} aria-hidden="true" />;
	if (state === "attention") return <NoticeBadge tone="warning" />;
	if (state === "error") return <NoticeBadge tone="error" />;
	return null;
}

export function ErrorFixDialog({ onOpenSettings, onOpenSource }: ErrorFixDialogProps): ReactElement | null {
	const { t } = useTranslation();
	const session = useErrorFixSession();
	const { dialogOpen, message, run } = session;

	useEffect(() => {
		if (!dialogOpen) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") dismissErrorFixDialog();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [dialogOpen]);

	if (!dialogOpen || message === null || run.status === "idle") return null;

	const openSettings = (page: ErrorFixSettingsPage): void => {
		onOpenSettings(page);
		dismissErrorFixDialog();
	};
	const go = (action: ErrorFixAction): void => {
		if (action.kind === "settings") onOpenSettings(action.target);
		else onOpenSource(action.target);
		dismissErrorFixDialog();
	};
	const settingsButton = (id: ErrorActionId, label: string, primary: boolean): ReactElement | null =>
		id === "fix" ? null : (
			<Button key={id} primary={primary} onClick={() => openSettings(id === "open-plan" ? "plan" : "ai")}>
				{label}
			</Button>
		);

	let state: FixState = "stopped";
	let title: ReactNode = null;
	let copy: ReactNode = null;
	let footer: ReactNode = null;
	let actions: ReactNode = null;
	const close = <Button onClick={dismissErrorFixDialog}>{t("common.close")}</Button>;
	if (run.status === "running") {
		state = "healing";
		// The agent's live intent is the title while it works; the line under it says the card may be closed.
		title = (
			<span className="shimmer" role="status">
				{run.progress ?? t("appError.fix.running")}
			</span>
		);
		copy = t("appError.fix.runningHint");
		actions = (
			<>
				{close}
				<Button onClick={stopErrorFix}>{t("appError.fix.stop")}</Button>
			</>
		);
	} else if (run.status === "done") {
		const { result } = run;
		if (result.status === "fixed") {
			state = "healthy";
			title = t("appError.fix.status.fixed");
			// What the AI changed, in its own words, then what to do now.
			copy = result.summary.trim() === "" ? t("appError.fix.fixedHint") : `${result.summary.trim()}
${t("appError.fix.fixedHint")}`;
		} else if (result.status === "needs-user") {
			state = "attention";
			title = t("appError.fix.status.needsUser");
			copy =
				result.nextSteps.length === 0 ? (
					result.summary
				) : (
					<ol className="m-0 flex list-decimal flex-col pl-16">
						{result.nextSteps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
				);
		} else {
			state = "error";
			title = t("appError.fix.status.cannotFix");
			copy = t("appError.fix.cannotFixHint");
			footer = <ErrorDetails message={message} className="mt-0" quiet />;
		}
		actions = (
			<>
				{close}
				{result.actions.map((action, index) => (
					<Button key={`${action.kind}:${action.target}`} primary={index === 0} onClick={() => go(action)}>
						{actionLabel(action, t)}
					</Button>
				))}
				{result.status === "fixed" && result.actions.length === 0 && hasRetryTask(message) ? (
					<Button primary onClick={() => retryErrorTask(message)}>
						{t("common.retry")}
					</Button>
				) : null}
			</>
		);
	} else if (run.status === "failed") {
		const view = describeAppError(run.message, null, t);
		state = "error";
		title = view.kind === "other" ? t("appError.fix.failedTitle") : view.title;
		copy = view.kind === "other" || view.hint === null ? null : view.hint;
		footer = <ErrorDetails message={run.message} className="mt-0" quiet />;
		actions = (
			<>
				{close}
				{isModelProblem(view.kind) ? (
					view.actions.map((entry) => settingsButton(entry.id, entry.label, entry.primary))
				) : (
					<Button primary onClick={retryErrorFix}>
						{t("common.retry")}
					</Button>
				)}
			</>
		);
	} else if (run.status === "stopped") {
		state = "stopped";
		title = t("appError.fix.stopped");
		actions = close;
	}

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) dismissErrorFixDialog();
			}}
		>
			<div
				className="flex max-h-[82vh] w-[373px] max-w-[92vw] flex-col gap-12 overflow-y-auto rounded-12 border border-border bg-window px-16 py-14 shadow-[var(--shadow-notice)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={t("appError.fix.title")}
				data-healing-state={state}
			>
				<div className="flex items-center gap-8">
					<StateMark state={state} />
					<strong className="min-w-0 flex-1 text-[14px] font-bold leading-[20px] text-ink">{title}</strong>
				</div>
				{copy === null ? null : <div className="min-w-0 whitespace-pre-wrap text-meta leading-[1.5] text-ink-muted">{copy}</div>}
				<div className="flex flex-wrap items-end gap-8">
					{footer === null ? null : <div className="min-w-0">{footer}</div>}
					<span className="flex-1" />
					{actions}
				</div>
			</div>
		</div>
	);
}
