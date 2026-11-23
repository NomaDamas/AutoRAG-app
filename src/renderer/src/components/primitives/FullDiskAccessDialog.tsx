import { useCallback, useEffect, useState, type ReactElement } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../../../shared/i18n";

export type FullDiskAccessReason = "tagColors" | "source";

/**
 * The one-button Full Disk Access card, shown only when a feature that truly
 * needs it is asked for (Finder tag colours, KakaoTalk, or Apple Mail under
 * `~/Library/Mail`). One primary button whose state follows the live probe:
 * while ungranted it opens System Settings › Privacy & Security › Full Disk
 * Access (macOS offers Quit & Reopen there); once granted it reads "확인하고
 * 계속" and runs `onConfirmed`.
 */
export function FullDiskAccessDialog({
	reason,
	onClose,
	onConfirmed,
}: {
	readonly reason: FullDiskAccessReason;
	readonly onClose: () => void;
	readonly onConfirmed: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [granted, setGranted] = useState(false);

	const probe = useCallback(() => {
		void window.autorag.onboarding
			.permissions()
			.then((next) => setGranted(next.fullDiskAccess === true))
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		probe();
		const timer = window.setInterval(probe, 2000);
		window.addEventListener("focus", probe);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", probe);
		};
	}, [probe]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const title = granted ? t("fullDiskAccess.titleGranted") : t("fullDiskAccess.title");
	const lead = granted
		? t("fullDiskAccess.granted")
		: reason === "tagColors"
			? t("fullDiskAccess.leadTagColors")
			: t("fullDiskAccess.leadSource");

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="relative flex w-360 flex-col gap-16 p-18 border border-border rounded-12 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-fda-card={granted ? "granted" : "needed"}
			>
				<button
					type="button"
					className="absolute top-12 right-12 flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted cursor-pointer hover:bg-hover hover:text-ink"
					aria-label={t("common.close")}
					onClick={onClose}
				>
					<X size={14} aria-hidden="true" focusable="false" />
				</button>
				<div className="flex flex-col gap-6 pr-20">
					<strong className="text-[14px] font-[650] text-ink">{title}</strong>
					<p className="m-0 text-[13px] leading-normal text-ink-body">{lead}</p>
				</div>
				<div className="flex items-center justify-end">
					<button
						type="button"
						className="fr-btn fr-btn--primary fr-btn--sm"
						data-action={granted ? "confirm-fda" : "open-fda"}
						autoFocus
						onClick={() => {
							if (granted) onConfirmed();
							else void window.autorag.onboarding.openFullDiskAccess();
						}}
					>
						{granted ? t("fullDiskAccess.confirm") : t("fullDiskAccess.open")}
					</button>
				</div>
			</div>
		</div>
	);
}
