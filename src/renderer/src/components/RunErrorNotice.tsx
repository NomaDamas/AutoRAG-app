import { useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import type { SearchErrorAction } from "../../../shared/search-contract";
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
	/**
	 * Offers "AI로 고치기" when present; `onRetry` asks the question again once the AI fixed something.
	 * Absent for the error of an earlier turn, which is history, not something to repair now.
	 */
	readonly fix: { readonly onRetry: () => void } | null;
}

const BUTTON = "inline-flex h-28 flex-none cursor-pointer items-center justify-center gap-6 rounded-8 border px-12 text-meta transition-colors duration-(--dur-color) ease-out";

/**
 * A run's error in the red box under the question: what it means in plain words,
 * the original message, and on the right what to do about it. A model that cannot
 * be used says so and leads to its settings and the subscription; an error in the
 * app's own setup carries "AI로 고치기".
 */
export function RunErrorNotice({ message, action, onOpenSettings, onOpenSource, fix }: RunErrorNoticeProps): ReactElement {
	const { t } = useTranslation();
	const [fixing, setFixing] = useState(false);
	const view = describeAppError(message, action, t);
	const entries = view.actions.filter((entry) => entry.id !== "fix" || fix !== null);
	// Without the fix there is nothing to promise: an earlier turn's error just reads as what it is.
	const hint = view.kind === "other" && fix === null ? null : view.hint;

	const run = (entry: ErrorAction): void => {
		if (entry.id === "fix") setFixing(true);
		else onOpenSettings(entry.id === "open-plan" ? "plan" : "ai");
	};

	return (
		<div className="flex items-start gap-12 rounded-10 border border-danger-border bg-danger-bg-soft px-14 py-10 text-body text-danger-text" role="alert">
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				{view.title === null ? null : <strong className="font-semibold">{view.title}</strong>}
				{hint === null ? null : <span className="text-meta leading-normal">{hint}</span>}
				<ErrorDetails message={message} className={cn(view.title !== null && "text-meta opacity-80")} />
			</div>
			{entries.length === 0 ? null : (
				<div className="flex flex-none flex-col items-stretch gap-6">
					{entries.map((entry) => (
						<button
							key={entry.id}
							type="button"
							className={cn(BUTTON, entry.primary ? "border-danger-border bg-window font-medium text-danger-text hover:bg-hover" : "border-transparent bg-transparent text-danger-text hover:bg-hover")}
							onClick={() => run(entry)}
						>
							{entry.id === "fix" ? <SparklesIcon /> : null}
							{entry.label}
						</button>
					))}
				</div>
			)}
			{fixing && fix !== null
				? createPortal(
						<ErrorFixDialog message={message} onClose={() => setFixing(false)} onOpenSettings={onOpenSettings} onOpenSource={onOpenSource} onRetry={fix.onRetry} />,
						document.body,
					)
				: null}
		</div>
	);
}
