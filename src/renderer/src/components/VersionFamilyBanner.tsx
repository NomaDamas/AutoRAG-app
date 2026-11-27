import { useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { enqueueBackgroundTask } from "../hooks/useBackgroundTasks";
import type { VersionFamilyError } from "../state/version-family";
import { ErrorDetails } from "./ErrorDetails";
import { NoticeCard } from "./primitives/NoticeCard";

/**
 * Whether a 다시 확인 scan is running, window-wide: the scan outlives the card that started it (another folder, another
 * pane), and every pane's card shows the one-line notice while it runs.
 */
let checking = false;
const listeners = new Set<() => void>();
const setChecking = (next: boolean): void => {
	checking = next;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The explicit dupey error above every Finder view (missing CLI or failed scan). */
export function VersionFamilyBanner({
	error,
	onRetry,
}: {
	readonly error: VersionFamilyError | null;
	/** Scan again; resolves once it answers (false when it failed again), so the sidebar task can end as done or failed. */
	readonly onRetry: () => unknown;
}): ReactElement | null {
	const { t } = useTranslation();
	const running = useSyncExternalStore(subscribe, () => checking);
	if (error === null) {
		return null;
	}
	// 다시 확인 runs the whole scan again, which can take minutes on a large folder. It runs as a task in the sidebar's
	// activity list (with the other long jobs), and the card here steps back to one line until the scan answers.
	const retry = (): void => {
		if (checking) return;
		setChecking(true);
		void enqueueBackgroundTask({
			id: `dupey-recheck-${Date.now()}`,
			kind: "custom",
			headline: t("finder.versionBanner.taskHeadline"),
			doneHeadline: t("finder.versionBanner.taskDone"),
			failedHeadline: t("finder.versionBanner.taskFailed"),
			detail: null,
			run: async () => {
				if ((await onRetry()) === false) throw new Error(t("finder.versionBanner.taskFailed"));
			},
		})
			.catch(() => undefined)
			.finally(() => setChecking(false));
	};
	if (running) {
		return (
			<NoticeCard
				className="list__error mx-8 mt-8 flex-none"
				clipBelow={400}
				compact
				role="status"
				tone="warning"
				title={<span className="list__error-text shimmer font-medium" data-version-recheck>{t("finder.versionBanner.checkingLine")}</span>}
			/>
		);
	}
	// Figma 548:14204: the shared notice card above the list. The title and the line under it are in the app's
	// language; the tool's own words (English, from the main process) wait behind 자세히 보기.
	const missing = error.code === "dupey-missing";
	return (
		<NoticeCard
			className="list__error mx-8 mt-8 flex-none"
			clipBelow={400}
			tone="error"
			title={<span className="list__error-text font-medium">{t(missing ? "finder.versionBanner.missingTitle" : "finder.versionBanner.scanFailedTitle")}</span>}
			actions={[{ label: t("finder.versionBanner.retry"), primary: true, onClick: retry }]}
			footer={<ErrorDetails message={error.message} className="mt-0" quiet />}
		>
			<span className="text-meta leading-[18px] text-ink-muted">{t(missing ? "finder.versionBanner.missingHint" : "finder.versionBanner.scanFailedHint")}</span>
			{error.installCommand === null ? null : (
				<code className="list__error-command py-px px-5 border border-border rounded-5 bg-subtle font-mono text-badge text-ink">{error.installCommand}</code>
			)}
		</NoticeCard>
	);
}
