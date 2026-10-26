import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isModelProblem } from "../../../shared/app-error";
import type { ErrorFixAction, ErrorFixChange, ErrorFixResult, ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import { describeAppError, type ErrorActionId } from "../state/app-error";
import { actionLabel, describeFixStep, initialErrorFixRun, reduceErrorFixRun, startErrorFixRun, type ErrorFixRun } from "../state/error-fix";
import { cn } from "../lib/cn";
import { ErrorDetails } from "./ErrorDetails";
import { CheckIcon, CloseIcon, SparklesIcon } from "./icons";

/**
 * "AI로 고치기": runs the error-fix helper agent for the error on screen and
 * shows what it does, what it changed (and where the old config is kept) and
 * what is left for the person. The agent runs on the AI Search model; when
 * that model cannot be used the dialog says so in the same words as the error
 * box and leads to Settings instead of pretending a retry would help.
 */

export interface ErrorFixDialogProps {
	/** The error as the person saw it. */
	readonly message: string;
	readonly onClose: () => void;
	readonly onOpenSettings: (page: ErrorFixSettingsPage) => void;
	/** Opens the Settings page of one configured data source, by its alias. */
	readonly onOpenSource: (alias: string) => void;
	/** Opens a folder in a Finder tab. */
	readonly onOpenFolder: (path: string) => void;
	/** Asks the question again; offered once something was fixed. */
	readonly onRetry: () => void;
}

const BUTTON = "inline-flex h-30 flex-none cursor-pointer items-center justify-center gap-6 rounded-6 border px-12 text-meta transition-colors duration-(--dur-color) ease-out";
const SECONDARY = "border-border bg-window text-ink hover:bg-hover";
const PRIMARY = "border-transparent bg-accent font-medium text-on-accent hover:bg-accent-hover";

function Button({ primary = false, onClick, children, ariaLabel }: { readonly primary?: boolean; readonly onClick: () => void; readonly children: ReactNode; readonly ariaLabel?: string }): ReactElement {
	return (
		<button type="button" className={cn(BUTTON, primary ? PRIMARY : SECONDARY)} aria-label={ariaLabel} onClick={onClick}>
			{children}
		</button>
	);
}

function ChangeList({ changes, backupPath }: { readonly changes: readonly ErrorFixChange[]; readonly backupPath: string | null }): ReactElement | null {
	const { t } = useTranslation();
	if (changes.length === 0) return null;
	const show = (value: string | null): string => value ?? t("appError.fix.unset");
	return (
		<div className="flex flex-col gap-6">
			<strong className="text-meta font-semibold text-ink">{t("appError.fix.changesTitle")}</strong>
			<ul className="m-0 flex list-none flex-col gap-4 p-0">
				{changes.map((change) => (
					<li key={change.path} className="flex flex-col gap-2 rounded-6 bg-chrome px-10 py-6 text-meta text-ink-body">
						<code className="font-mono font-semibold text-ink">{change.path}</code>
						<span className="break-all text-ink-muted">
							{show(change.before)} → {show(change.after)}
						</span>
					</li>
				))}
			</ul>
			{backupPath === null ? null : <span className="break-all text-meta text-ink-muted">{t("appError.fix.backup", { path: backupPath })}</span>}
		</div>
	);
}

function ResultBody({ result }: { readonly result: ErrorFixResult }): ReactElement {
	const { t } = useTranslation();
	const tone = result.status === "fixed" ? "text-ok-text" : result.status === "cannot-fix" ? "text-danger-text" : "text-ink";
	const heading = result.status === "fixed" ? t("appError.fix.status.fixed") : result.status === "needs-user" ? t("appError.fix.status.needsUser") : t("appError.fix.status.cannotFix");
	return (
		<>
			<div className={cn("flex items-center gap-6 text-body font-semibold", tone)}>
				{result.status === "fixed" ? <CheckIcon /> : null}
				<span>{heading}</span>
			</div>
			<p className="m-0 whitespace-pre-wrap text-body leading-normal text-ink-body">{result.summary}</p>
			{result.nextSteps.length === 0 ? null : (
				<div className="flex flex-col gap-4">
					<strong className="text-meta font-semibold text-ink">{t("appError.fix.nextStepsLabel")}</strong>
					<ul className="m-0 flex list-disc flex-col gap-2 pl-18 text-meta text-ink-body">
						{result.nextSteps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ul>
				</div>
			)}
			<ChangeList changes={result.changes} backupPath={result.backupPath} />
		</>
	);
}

export function ErrorFixDialog({ message, onClose, onOpenSettings, onOpenSource, onOpenFolder, onRetry }: ErrorFixDialogProps): ReactElement {
	const { t } = useTranslation();
	const [run, setRun] = useState<ErrorFixRun>(initialErrorFixRun);
	const [attempt, setAttempt] = useState(0);

	// One run per attempt. Leaving (or retrying) cancels the one in flight; a run that has ended ignores the cancel.
	useEffect(() => {
		const bridge = window.autorag.errorFix;
		const runId = crypto.randomUUID();
		setRun(startErrorFixRun(runId));
		const unsubscribe = bridge.onEvent((event) => setRun((current) => reduceErrorFixRun(current, event)));
		bridge.start(runId, { message, surface: "ai-search" }).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			setRun((current) => reduceErrorFixRun(current, { type: "error", runId, message: reason, changes: [], backupPath: null }));
		});
		return () => {
			unsubscribe();
			void bridge.cancel(runId);
		};
	}, [message, attempt]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const stop = (): void => {
		if (run.status === "running") void window.autorag.errorFix.cancel(run.runId);
	};
	const openSettings = (page: ErrorFixSettingsPage): void => {
		onOpenSettings(page);
		onClose();
	};
	/** Takes the person where the AI's button says, and closes the dialog: they are leaving for it. */
	const go = (action: ErrorFixAction): void => {
		if (action.kind === "settings") onOpenSettings(action.target);
		else if (action.kind === "source") onOpenSource(action.target);
		else onOpenFolder(action.target);
		onClose();
	};
	const settingsButton = (id: ErrorActionId, label: string, primary: boolean): ReactElement | null =>
		id === "fix" ? null : (
			<Button key={id} primary={primary} onClick={() => openSettings(id === "open-plan" ? "plan" : "ai")}>
				{label}
			</Button>
		);

	const steps = run.status === "idle" ? [] : run.steps;
	let body: ReactElement | null = null;
	let actions: ReactNode = null;
	if (run.status === "running") {
		body = <p className="m-0 text-meta leading-normal text-ink-body">{t("appError.fix.intro")}</p>;
		actions = <Button onClick={stop}>{t("aiSearch.stop")}</Button>;
	} else if (run.status === "done") {
		const { result } = run;
		body = <ResultBody result={result} />;
		actions = (
			<>
				{result.actions.map((action, index) => (
					<Button key={`${action.kind}:${action.target}`} primary={result.status === "needs-user" && index === 0} onClick={() => go(action)}>
						{actionLabel(action, t)}
					</Button>
				))}
				{result.status === "fixed" ? (
					<Button
						primary
						onClick={() => {
							onClose();
							onRetry();
						}}
					>
						{t("appError.fix.retrySearch")}
					</Button>
				) : null}
				<Button onClick={onClose}>{t("common.close")}</Button>
			</>
		);
	} else if (run.status === "failed") {
		const view = describeAppError(run.message, null, t);
		body = (
			<>
				<div className="flex flex-col gap-4">
					<strong className="text-body font-semibold text-danger-text">{view.kind === "other" ? t("appError.fix.failedTitle") : view.title}</strong>
					{view.kind === "other" ? null : <span className="text-meta leading-normal text-ink-body">{view.hint}</span>}
					<ErrorDetails message={run.message} className="line-clamp-4 text-meta text-ink-muted" />
				</div>
				<ChangeList changes={run.changes} backupPath={run.backupPath} />
			</>
		);
		actions = (
			<>
				{isModelProblem(view.kind) ? view.actions.map((entry) => settingsButton(entry.id, entry.label, entry.primary)) : <Button primary onClick={() => setAttempt((count) => count + 1)}>{t("common.retry")}</Button>}
				<Button onClick={onClose}>{t("common.close")}</Button>
			</>
		);
	} else if (run.status === "stopped") {
		body = (
			<>
				<p className="m-0 text-body text-ink-body">{t("appError.fix.stopped")}</p>
				<ChangeList changes={run.changes} backupPath={run.backupPath} />
			</>
		);
		actions = (
			<>
				<Button primary onClick={() => setAttempt((count) => count + 1)}>
					{t("common.retry")}
				</Button>
				<Button onClick={onClose}>{t("common.close")}</Button>
			</>
		);
	}

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="flex max-h-[80vh] w-[480px] max-w-[92vw] flex-col gap-12 overflow-y-auto rounded-10 border border-border bg-window p-16 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={t("appError.fix.title")}
			>
				<div className="flex items-center justify-between gap-8">
					<strong className="flex items-center gap-6 text-[13px] font-[650] text-ink">
						<SparklesIcon />
						{t("appError.fix.title")}
					</strong>
					<button
						type="button"
						className="flex size-24 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-muted hover:bg-hover-strong"
						aria-label={t("common.close")}
						onClick={onClose}
					>
						<CloseIcon />
					</button>
				</div>
				<div className="flex flex-col gap-2 rounded-6 bg-danger-bg-soft px-10 py-8 text-meta">
					<span className="font-semibold text-danger-text">{t("appError.fix.errorLabel")}</span>
					<ErrorDetails message={message} className="line-clamp-3 text-ink-body" />
				</div>
				{run.status === "running" ? <div className="flex items-center gap-6 text-body font-medium text-ink"><span className="animate-pulse">{t("appError.fix.running")}</span></div> : null}
				{body}
				{steps.length === 0 ? null : (
					<ol className="m-0 flex max-h-[140px] list-none flex-col gap-2 overflow-y-auto p-0 text-meta text-ink-muted">
						{steps.map((step, index) => (
							<li key={`${index}:${step.tool}:${step.detail ?? ""}`} className="break-all">
								{describeFixStep(step, t)}
							</li>
						))}
					</ol>
				)}
				<div className="flex flex-wrap items-center justify-end gap-8">{actions}</div>
			</div>
		</div>
	);
}
