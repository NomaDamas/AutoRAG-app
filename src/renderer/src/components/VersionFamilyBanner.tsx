import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { VersionFamilyError } from "../state/version-family";
import { ErrorDetails } from "./ErrorDetails";
import { NoticeCard } from "./primitives/NoticeCard";

/** The explicit dupey error above every Finder view (missing CLI or failed scan). */
export function VersionFamilyBanner({
	error,
	onRetry,
}: {
	readonly error: VersionFamilyError | null;
	/** Scan again; when it returns a promise, the notice says it is checking until the promise settles. */
	readonly onRetry: () => unknown;
}): ReactElement | null {
	const { t } = useTranslation();
	// 다시 확인 runs the whole scan again, which can take minutes on a large folder: until it answers, the button
	// says so and cannot be pressed twice, and the line under the title says what is happening.
	const [checking, setChecking] = useState(false);
	if (error === null) {
		return null;
	}
	const retry = (): void => {
		if (checking) return;
		setChecking(true);
		void Promise.resolve(onRetry()).finally(() => setChecking(false));
	};
	// Figma 548:14204: the shared notice card above the list. The title and the line under it are in the app's
	// language; the tool's own words (English, from the main process) wait behind 자세히 보기.
	const missing = error.code === "dupey-missing";
	return (
		<NoticeCard
			className="list__error mx-8 mt-8 flex-none"
			clipBelow={400}
			tone="error"
			title={<span className="list__error-text font-medium">{t(missing ? "finder.versionBanner.missingTitle" : "finder.versionBanner.scanFailedTitle")}</span>}
			actions={[{ label: checking ? t("finder.versionBanner.checking") : t("finder.versionBanner.retry"), primary: true, disabled: checking, onClick: retry }]}
			footer={<ErrorDetails message={error.message} className="mt-0" quiet />}
		>
			<span className="text-meta leading-[18px] text-ink-muted" role={checking ? "status" : undefined}>
				{checking ? t("finder.versionBanner.checkingHint") : t(missing ? "finder.versionBanner.missingHint" : "finder.versionBanner.scanFailedHint")}
			</span>
			{error.installCommand === null ? null : (
				<code className="list__error-command py-px px-5 border border-border rounded-5 bg-subtle font-mono text-badge text-ink">{error.installCommand}</code>
			)}
		</NoticeCard>
	);
}
