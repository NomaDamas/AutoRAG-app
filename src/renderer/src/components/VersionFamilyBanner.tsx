import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { VersionFamilyError } from "../state/version-family";
import { NoticeCard } from "./primitives/NoticeCard";

/** The explicit dupey error above the Finder view. */
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
	const message =
		error.scan === undefined
			? error.message
			: error.scan.reason === "timeout"
				? t("finder.versionBanner.scanTimeout", { name: error.scan.name })
				: t("finder.versionBanner.scanFailed", { name: error.scan.name, detail: error.message });
	// Figma 548:14204: the shared notice card above the list; the install command sits in the explanation.
	return (
		<NoticeCard
			className="list__error mx-8 mt-8 flex-none"
			tone="error"
			title={<span className="list__error-text whitespace-pre-wrap font-medium">{message}</span>}
			actions={[{ label: t("finder.versionBanner.retry"), primary: true, onClick: onRetry }]}
		>
			{error.installCommand === null ? null : (
				<code className="list__error-command py-px px-5 border border-border rounded-5 bg-subtle font-mono text-badge text-ink">{error.installCommand}</code>
			)}
		</NoticeCard>
	);
}
