import type { ReactElement } from "react";
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
	readonly onRetry: () => void;
}): ReactElement | null {
	const { t } = useTranslation();
	if (error === null) {
		return null;
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
			actions={[{ label: t("finder.versionBanner.retry"), primary: true, onClick: onRetry }]}
			footer={<ErrorDetails message={error.message} className="mt-0" quiet />}
		>
			<span className="text-meta leading-[18px] text-ink-muted">{t(missing ? "finder.versionBanner.missingHint" : "finder.versionBanner.scanFailedHint")}</span>
			{error.installCommand === null ? null : (
				<code className="list__error-command py-px px-5 border border-border rounded-5 bg-subtle font-mono text-badge text-ink">{error.installCommand}</code>
			)}
		</NoticeCard>
	);
}
