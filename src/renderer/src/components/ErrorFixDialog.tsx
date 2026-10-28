import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isModelProblem } from "../../../shared/app-error";
import type { ErrorFixAction, ErrorFixResult, ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import { describeAppError, type ErrorActionId } from "../state/app-error";
import { actionLabel, initialErrorFixRun, reduceErrorFixRun, startErrorFixRun, type ErrorFixRun } from "../state/error-fix";
import { cn } from "../lib/cn";
import { ErrorDetails } from "./ErrorDetails";
import { CloseIcon, SparklesIcon } from "./icons";

/**
 * "AI로 고치기": runs the self-healing helper agent for the error on screen with
 * a calm visual, a single shimmering live progress line from the agent's pre-tool
 * intent, and a clean restored state on completion. Raw error text stays hidden
 * behind "자세히 보기" unless opened, and shell commands or config diffs are never
 * dumped onto the screen.
 */

export interface ErrorFixDialogProps {
	/** The error the run was started for. */
	readonly message: string;
	readonly onClose: () => void;
	readonly onOpenSettings: (page: ErrorFixSettingsPage) => void;
	/** Opens the Settings page of one configured data source, by its alias. */
	readonly onOpenSource: (alias: string) => void;
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

type HealingVisualState = "healing" | "healthy" | "attention" | "error" | "stopped";

function SelfHealingVisual({ state }: { readonly state: HealingVisualState }): ReactElement {
	if (state === "healing") {
		return (
			<div className="relative flex size-[88px] flex-none items-center justify-center" data-healing-state="healing" aria-hidden="true">
				<div
					className="absolute inset-4 rounded-full animate-[healBreath_2.8s_ease-in-out_infinite]"
					style={{ background: "radial-gradient(circle, var(--accent-soft) 0%, var(--ok-bg) 58%, transparent 76%)" }}
				/>
				<svg className="absolute inset-0 size-[88px]" viewBox="0 0 88 88" fill="none">
					<circle cx="44" cy="44" r="34" stroke="var(--border)" strokeWidth="1.5" opacity="0.6" />
					<g className="origin-center animate-[healOrbit_3.2s_linear_infinite]">
						<circle cx="44" cy="44" r="34" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="64 150" />
					</g>
					<g className="origin-center animate-[healOrbitReverse_4.4s_linear_infinite]">
						<circle cx="44" cy="44" r="27" stroke="var(--ok-dot)" strokeWidth="2" strokeLinecap="round" strokeDasharray="44 126" />
					</g>
					<circle cx="73" cy="24" r="2.2" fill="var(--accent)" className="origin-center animate-[healMote_2.4s_ease-in-out_infinite]" />
					<circle cx="16" cy="30" r="2" fill="var(--ok-dot)" className="origin-center animate-[healMote_2.4s_ease-in-out_0.8s_infinite]" />
					<circle cx="64" cy="72" r="1.8" fill="var(--ok-dot)" className="origin-center animate-[healMote_2.4s_ease-in-out_1.5s_infinite]" />
				</svg>
				<div className="relative flex size-[42px] items-center justify-center rounded-full border border-border bg-window text-accent shadow-raised">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M3 12h4l2.4-5 4.2 10 2.4-5H21" />
					</svg>
				</div>
			</div>
		);
	}

	if (state === "healthy") {
		return (
			<div className="relative flex size-[84px] flex-none items-center justify-center" data-healing-state="healthy" aria-hidden="true">
				<div className="absolute inset-6 rounded-full bg-ok-bg" />
				<svg className="absolute inset-0 size-[84px]" viewBox="0 0 84 84" fill="none">
					<circle cx="42" cy="42" r="32" stroke="var(--ok-border)" strokeWidth="2" />
				</svg>
				<div className="relative flex size-[46px] items-center justify-center rounded-full border border-ok-border bg-ok-bg text-ok-text animate-[healPop_0.35s_ease-out]">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
						<path d="M20 6 9 17l-5-5" />
					</svg>
				</div>
			</div>
		);
	}

	const coreClass =
		state === "error"
			? "border-danger-border bg-danger-bg-soft text-danger-text"
			: state === "attention"
				? "border-border bg-accent-soft text-accent"
				: "border-border bg-chrome text-ink-muted";

	return (
		<div className="relative flex size-[76px] flex-none items-center justify-center" data-healing-state={state} aria-hidden="true">
			<div className={cn("flex size-[46px] items-center justify-center rounded-full border animate-[healPop_0.28s_ease-out]", coreClass)}>
				{state === "attention" ? (
					<SparklesIcon />
				) : state === "error" ? (
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="9" />
						<line x1="12" y1="8" x2="12" y2="12.5" />
						<circle cx="12" cy="16" r="0.6" fill="currentColor" />
					</svg>
				) : (
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="7" y="7" width="10" height="10" rx="2" />
					</svg>
				)}
			</div>
		</div>
	);
}

function ResultBody({ result, errorMessage }: { readonly result: ErrorFixResult; readonly errorMessage: string }): ReactElement {
	const { t } = useTranslation();
	if (result.status === "fixed") {
		return (
			<div className="flex flex-col items-center gap-6 text-center">
				<SelfHealingVisual state="healthy" />
				<strong className="text-[15px] font-semibold text-ok-text">{t("appError.fix.status.fixed")}</strong>
				<p className="m-0 max-w-[320px] whitespace-pre-wrap text-meta leading-normal text-ink-body">{result.summary}</p>
			</div>
		);
	}
	const heading = result.status === "needs-user" ? t("appError.fix.status.needsUser") : t("appError.fix.status.cannotFix");
	const tone = result.status === "cannot-fix" ? "text-danger-text" : "text-ink";
	return (
		<div className="flex w-full flex-col items-center gap-8 text-center">
			<SelfHealingVisual state={result.status === "needs-user" ? "attention" : "error"} />
			<strong className={cn("text-[15px] font-semibold", tone)}>{heading}</strong>
			<p className="m-0 max-w-[330px] whitespace-pre-wrap text-meta leading-normal text-ink-body">{result.summary}</p>
			{result.nextSteps.length === 0 ? null : (
				<div className="flex w-full flex-col gap-4 rounded-8 bg-chrome px-12 py-8 text-left">
					<strong className="text-meta font-semibold text-ink">{t("appError.fix.nextStepsLabel")}</strong>
					<ul className="m-0 flex list-disc flex-col gap-2 pl-18 text-meta text-ink-body">
						{result.nextSteps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ul>
				</div>
			)}
			<ErrorDetails message={errorMessage} className="w-full items-center text-ink-muted" />
		</div>
	);
}

export function ErrorFixDialog({ message, onClose, onOpenSettings, onOpenSource }: ErrorFixDialogProps): ReactElement {
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
	const go = (action: ErrorFixAction): void => {
		if (action.kind === "settings") onOpenSettings(action.target);
		else onOpenSource(action.target);
		onClose();
	};
	const settingsButton = (id: ErrorActionId, label: string, primary: boolean): ReactElement | null =>
		id === "fix" ? null : (
			<Button key={id} primary={primary} onClick={() => openSettings(id === "open-plan" ? "plan" : "ai")}>
				{label}
			</Button>
		);

	let body: ReactElement | null = null;
	let actions: ReactNode = null;
	if (run.status === "running") {
		const statusText = run.progress ?? t("appError.fix.running");
		body = (
			<div className="flex flex-col items-center gap-10 py-4 text-center">
				<SelfHealingVisual state="healing" />
				<p className="m-0 max-w-[320px] text-body font-medium leading-normal text-ink-muted" role="status">
					<span className="shimmer">{statusText}</span>
				</p>
			</div>
		);
		actions = <Button onClick={stop}>{t("aiSearch.stop")}</Button>;
	} else if (run.status === "done") {
		const { result } = run;
		body = <ResultBody result={result} errorMessage={message} />;
		actions = (
			<>
				{result.actions.map((action, index) => (
					<Button key={`${action.kind}:${action.target}`} primary={index === 0} onClick={() => go(action)}>
						{actionLabel(action, t)}
					</Button>
				))}
				<Button primary={result.status === "fixed" && result.actions.length === 0} onClick={onClose}>
					{t("common.close")}
				</Button>
			</>
		);
	} else if (run.status === "failed") {
		const view = describeAppError(run.message, null, t);
		body = (
			<div className="flex w-full flex-col items-center gap-6 text-center">
				<SelfHealingVisual state="error" />
				<strong className="text-[15px] font-semibold text-danger-text">{view.kind === "other" ? t("appError.fix.failedTitle") : view.title}</strong>
				{view.kind === "other" || view.hint === null ? null : <p className="m-0 max-w-[330px] text-meta leading-normal text-ink-body">{view.hint}</p>}
				<ErrorDetails message={run.message} className="w-full items-center text-ink-muted" />
			</div>
		);
		actions = (
			<>
				{isModelProblem(view.kind) ? (
					view.actions.map((entry) => settingsButton(entry.id, entry.label, entry.primary))
				) : (
					<Button primary onClick={() => setAttempt((count) => count + 1)}>
						{t("common.retry")}
					</Button>
				)}
				<Button onClick={onClose}>{t("common.close")}</Button>
			</>
		);
	} else if (run.status === "stopped") {
		body = (
			<div className="flex flex-col items-center gap-6 py-2 text-center">
				<SelfHealingVisual state="stopped" />
				<p className="m-0 text-body font-medium text-ink-body">{t("appError.fix.stopped")}</p>
			</div>
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
				className="flex max-h-[82vh] w-[392px] max-w-[92vw] flex-col gap-16 overflow-y-auto rounded-12 border border-border bg-window p-18 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
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
				{body}
				<div className="flex flex-wrap items-center justify-center gap-8">{actions}</div>
			</div>
		</div>
	);
}
