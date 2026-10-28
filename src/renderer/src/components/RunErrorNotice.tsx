import { CircleAlert } from "lucide-react";
import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import type { SearchErrorAction } from "../../../shared/search-contract";
import { startErrorFix, useErrorFixSession } from "../hooks/useErrorFix";
import { describeAppError, type ErrorAction } from "../state/app-error";
import { cn } from "../lib/cn";
import { ErrorDetails } from "./ErrorDetails";
import { ErrorFixDialog } from "./ErrorFixDialog";
import { SparklesIcon } from "./icons";
export interface RunErrorNoticeProps {
	readonly message: string;
	/** What the person can do about it, when the main process knows: a button that goes there. */
	readonly action: SearchErrorAction | null;
	/** Goes to a Settings page: the model settings, or Subscription & Usage. */
	readonly onOpenSettings: (page: ErrorFixSettingsPage) => void;
	/** Goes to the Settings page of one configured data source (an AI fix button names it by alias). */
	readonly onOpenSource: (alias: string) => void;
	/** True on the live turn's error so "AI로 고치기" is offered; false on past turns. */
	readonly fix?: boolean;
}

const BUTTON = "inline-flex h-28 flex-none cursor-pointer items-center justify-center gap-6 rounded-8 border px-12 text-meta font-medium whitespace-nowrap transition-colors duration-(--dur-color) ease-out";
const PRIMARY_BUTTON = "border-transparent bg-accent text-on-accent hover:bg-accent-hover";
const SECONDARY_BUTTON = "border-border bg-window text-ink hover:bg-hover";

/**
 * A run's error under the question: neutral card surface (`bg-subtle` + `border-border`)
 * with color confined to the left status icon badge and the right action button.
 */
export function RunErrorNotice({ message, action, onOpenSettings, onOpenSource, fix = true }: RunErrorNoticeProps): ReactElement {
	const { t } = useTranslation();
	const session = useErrorFixSession();
	const view = describeAppError(message, action, t);
	const entries = view.actions.filter((entry) => entry.id !== "fix" || fix);
	// Without the fix there is nothing to promise: an earlier turn's error just reads as what it is.
	const hint = view.kind === "other" && !fix ? null : view.hint;
	const warnTone = view.kind === "rate-limit" || view.kind === "network";
	const isFixingThis = fix && session.run.status === "running" && session.message === message;

	const run = (entry: ErrorAction): void => {
		if (entry.id === "fix") startErrorFix(message);
		else onOpenSettings(entry.id === "open-plan" ? "plan" : "ai");
	};
	return (
		<div className="flex items-start gap-12 rounded-10 border border-border bg-subtle px-14 py-12 text-body text-ink" role="alert">
			<div
				className={cn(
					"mt-1 flex size-28 flex-none items-center justify-center rounded-8",
					warnTone ? "bg-warn-bg text-warn-text" : "bg-danger-bg-soft text-danger-text",
				)}
				data-notice-icon
				aria-hidden="true"
			>
				<CircleAlert size={15} strokeWidth={2.1} />
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				{view.title === null ? (
					<span className="select-text whitespace-pre-wrap break-words text-ink">{message}</span>
				) : (
					<>
						<strong className="text-body font-semibold text-ink">{view.title}</strong>
						{hint === null ? null : <span className="text-meta leading-normal text-ink-muted">{hint}</span>}
						<ErrorDetails message={message} />
					</>
				)}
			</div>
			{entries.length === 0 ? null : (
				<div className="flex flex-none flex-wrap items-center gap-6 self-center">
					{entries.map((entry) => (
						<button
							key={entry.id}
							type="button"
							className={cn(BUTTON, entry.primary ? PRIMARY_BUTTON : SECONDARY_BUTTON)}
							onClick={() => run(entry)}
						>
							{entry.id === "fix" ? <SparklesIcon /> : null}
							{entry.id === "fix" && isFixingThis ? t("appError.fix.sidebar.running") : entry.label}
						</button>
					))}
				</div>
			)}
			{fix && session.dialogOpen && document.getElementById("dazzi-error-fix-host") === null
				? createPortal(<ErrorFixDialog onOpenSettings={onOpenSettings} onOpenSource={onOpenSource} />, document.body)
				: null}
		</div>
	);
}
