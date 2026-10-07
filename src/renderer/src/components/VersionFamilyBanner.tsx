import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { VersionFamilyError } from "../state/version-family";

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
	return (
		<div
			className="list__error flex flex-wrap items-center gap-8 mx-8 mt-8 px-10 py-8 border border-danger-border rounded-8 bg-danger-bg-soft text-danger-text text-meta"
			role="alert"
		>
			<span className="list__error-text flex-[1_1_240px] min-w-0 whitespace-pre-wrap">{error.message}</span>
			{error.installCommand === null ? null : (
				<code className="list__error-command py-px px-5 border border-danger-border rounded-5 bg-window font-mono text-badge">
					{error.installCommand}
				</code>
			)}
			<button
				type="button"
				className="list__error-retry h-pill px-10 border border-danger-border rounded-6 bg-window text-danger-text text-meta cursor-pointer"
				onClick={onRetry}
			>
				{t("finder.versionBanner.retry", "다시 확인")}
			</button>
		</div>
	);
}
