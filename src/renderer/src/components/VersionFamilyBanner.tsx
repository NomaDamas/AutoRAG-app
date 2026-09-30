import type { ReactElement } from "react";
import type { VersionFamilyError } from "../state/version-family";

/** The explicit dupey error above every Finder view (missing CLI or failed scan). */
export function VersionFamilyBanner({
	error,
	onRetry,
}: {
	readonly error: VersionFamilyError | null;
	readonly onRetry: () => void;
}): ReactElement | null {
	if (error === null) {
		return null;
	}
	return (
		<div className="list__error" role="alert">
			<span className="list__error-text">{error.message}</span>
			{error.installCommand === null ? null : <code className="list__error-command">{error.installCommand}</code>}
			<button type="button" className="list__error-retry" onClick={onRetry}>
				다시 확인
			</button>
		</div>
	);
}
