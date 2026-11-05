import { Mic } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { VoicePermission } from "../state/useVoiceInput";

/** The same button pair `RunErrorNotice` draws. */
const BUTTON = "inline-flex h-28 flex-none cursor-pointer items-center justify-center gap-6 rounded-8 border px-12 text-meta font-medium whitespace-nowrap transition-colors duration-(--dur-color) ease-out";
const PRIMARY_BUTTON = "border-transparent bg-accent text-on-accent hover:bg-accent-hover";
const SECONDARY_BUTTON = "border-border bg-window text-ink hover:bg-hover";

/**
 * Asks for the microphone when the operating system refuses it to Dazzi (macOS
 * after "Don't Allow", Windows with a privacy switch off). Neither system lets
 * an app grant itself the microphone after a refusal, so the main button opens
 * the system's own microphone settings; the dialog then waits, and the
 * recording starts by itself once the person comes back with it allowed.
 */
export function MicrophonePermissionDialog({
	state,
	platform,
	onOpenSettings,
	onClose,
}: {
	readonly state: Exclude<VoicePermission, null>;
	readonly platform: string;
	readonly onOpenSettings: () => void;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const windows = platform === "win32";
	const steps = windows ? t("aiSearch.micPermission.stepsWindows") : t("aiSearch.micPermission.stepsMac");

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		// Capture: the panel's own Escape (stop the run) must not see it while the dialog is up.
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="mic-permission-dialog flex w-[420px] flex-col gap-16 p-20 border border-border rounded-12 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-labelledby="mic-permission-title"
			>
				<div className="flex items-start gap-12">
					<span className="flex size-36 flex-none items-center justify-center rounded-10 bg-accent-soft text-accent" aria-hidden="true">
						<Mic size={18} strokeWidth={2} />
					</span>
					<div className="flex min-w-0 flex-col gap-6">
						<strong id="mic-permission-title" className="text-[14px] font-[650] text-ink">
							{t("aiSearch.micPermission.title")}
						</strong>
						<p className="m-0 text-[13px] leading-normal text-ink-body">{t("aiSearch.micPermission.body")}</p>
						<p className="m-0 text-[13px] leading-normal text-ink-body whitespace-pre-line">{steps}</p>
						{state === "waiting" ? (
							<p className="mic-permission-status m-0 text-meta text-ink-muted" role="status">
								{t("aiSearch.micPermission.waiting")}
							</p>
						) : state === "still-denied" ? (
							<p className="mic-permission-status m-0 text-meta text-danger-text" role="status">
								{t("aiSearch.micPermission.stillDenied")}
							</p>
						) : null}
					</div>
				</div>
				<div className="flex items-center justify-end gap-8">
					<button type="button" className={`${BUTTON} ${SECONDARY_BUTTON}`} onClick={onClose}>
						{t("aiSearch.micPermission.notNow")}
					</button>
					<button type="button" className={`${BUTTON} ${PRIMARY_BUTTON}`} autoFocus onClick={onOpenSettings}>
						{windows ? t("aiSearch.micPermission.openWindows") : t("aiSearch.micPermission.openMac")}
					</button>
				</div>
			</div>
		</div>
	);
}
