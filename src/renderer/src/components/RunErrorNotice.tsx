import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import type { SearchErrorAction } from "../../../shared/search-contract";
import { startErrorFix, useErrorFixSession, useErrorFixStore } from "../hooks/useErrorFix";
import { describeAppError, type ErrorAction } from "../state/app-error";
import { NoticeCard } from "./primitives/NoticeCard";
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
	/** Starts a new chat: the way out of a conversation that no longer fits the model. */
	readonly onNewChat: () => void;
	/** Puts the turn's question back in the composer, to ask it again about less at once. */
	readonly onRephrase: () => void;
	/** True on the live turn's error so "AI로 고치기" is offered; false on past turns. */
	readonly fix?: boolean;
}

/**
 * A run's error under the question, in the shared notice card: a neutral surface with the colour confined to the
 * status badge and the primary button.
 */
export function RunErrorNotice({ message, action, onOpenSettings, onOpenSource, onNewChat, onRephrase, fix = true }: RunErrorNoticeProps): ReactElement {
	const { t } = useTranslation();
	const session = useErrorFixSession();
	const store = useErrorFixStore();
	const view = describeAppError(message, action, t);
	const entries = view.actions.filter((entry) => entry.id !== "fix" || fix);
	// Without the fix there is nothing to promise: an earlier turn's error just reads as what it is.
	const hint = view.kind === "other" && !fix ? null : view.hint;
	// Amber, not red: the model is fine and the person has a way on (wait, reconnect, or ask in a new chat).
	const warnTone = view.kind === "rate-limit" || view.kind === "network" || view.kind === "context-overflow";
	const isFixingThis = fix && store.sessions.some((entry) => entry.run.status === "running" && entry.message === message);

	const run = (entry: ErrorAction): void => {
		if (entry.id === "fix") startErrorFix(message);
		else if (entry.id === "new-chat") onNewChat();
		else if (entry.id === "rephrase") onRephrase();
		else onOpenSettings(entry.id === "open-plan" ? "plan" : "ai");
	};
	return (
		// Figma 548:14204 (in the flow): the shared notice card; 자세히 보기 bottom left, the ways on bottom right.
		<>
		<NoticeCard
			tone={warnTone ? "warning" : "error"}
			title={view.title ?? message}
			footer={view.title === null ? undefined : <ErrorDetails message={message} className="mt-0" quiet />}
			actions={entries.map((entry) => ({
				label: entry.id === "fix" && isFixingThis ? t("appError.fix.sidebar.running") : entry.label,
				primary: entry.primary,
				icon: entry.id === "fix" ? <SparklesIcon /> : undefined,
				onClick: () => run(entry),
			}))}
		>
			{view.title === null ? null : hint}
		</NoticeCard>
		{fix && session.dialogOpen && document.getElementById("dazzi-error-fix-host") === null
			? createPortal(<ErrorFixDialog onOpenSettings={onOpenSettings} onOpenSource={onOpenSource} />, document.body)
			: null}
		</>
	);
}
