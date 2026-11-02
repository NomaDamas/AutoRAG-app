import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AppUpdateBridge, AppUpdateSnapshot } from "../../../shared/update-contract";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { cn } from "../lib/cn";
import { DownloadIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";

type UpdateButtonState = AppUpdateSnapshot["state"]["kind"];

/** What a click does: take the update, or install a downloaded one. `null` = the button is inert. */
function actionFor(kind: UpdateButtonState, bridge: AppUpdateBridge): (() => Promise<unknown>) | null {
	switch (kind) {
		case "available":
			return () => bridge.download();
		case "ready":
			return () => bridge.install();
		case "unsupported":
		case "idle":
		case "checking":
		case "downloading":
		case "error":
			return null;
	}
}

/**
 * Sidebar footer, far right: the app-update control, always a download glyph.
 * While there is nothing to fetch (up to date, checking, failed, or a build that
 * cannot update) it is inert and dim; the updater checks on its own schedule.
 * Once a newer version exists it turns emphasised and clickable: it downloads
 * the update (install mode) or opens the installer link (notify mode), and a
 * downloaded update becomes restart-to-install. Renders nothing without the
 * preload bridge.
 */
export function SidebarUpdateButton(): ReactElement | null {
	const { t } = useTranslation();
	const { snapshot, bridge } = useAppUpdate();
	if (snapshot === null || bridge === null) return null;
	const { state, currentVersion, mode } = snapshot;
	const run = actionFor(state.kind, bridge);
	const emphasised = state.kind === "available" || state.kind === "downloading" || state.kind === "ready";
	let label: string;
	switch (state.kind) {
		case "unsupported":
			label = t("places.update.unsupported", { version: currentVersion });
			break;
		case "checking":
			label = t("places.update.checking");
			break;
		case "available":
			label = mode === "notify" ? t("places.update.availableManual", { version: state.version }) : t("places.update.available", { version: state.version });
			break;
		case "downloading":
			label = t("places.update.downloading", { version: state.version, percent: state.percent });
			break;
		case "ready":
			label = t("places.update.ready", { version: state.version });
			break;
		case "error":
			label = t("places.update.error", { message: state.message });
			break;
		case "idle":
			label = state.checkedAt === null ? t("places.update.current", { version: currentVersion }) : t("places.update.upToDate", { version: currentVersion });
			break;
	}
	return (
		<button
			type="button"
			className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "relative", emphasised && "text-accent-text")}
			data-action="app-update"
			data-state={state.kind}
			title={label}
			aria-label={label}
			aria-busy={state.kind === "checking" ? "true" : undefined}
			// A download in flight stays emphasised: only inert states dim to the disabled tone.
			disabled={run === null && !emphasised}
			aria-disabled={run === null ? "true" : undefined}
			onClick={() => {
				void run?.();
			}}
		>
			<span data-emphasis={emphasised ? "true" : undefined} className="flex items-center justify-center">
				<DownloadIcon size={16} className={cn(state.kind === "downloading" && "animate-pulse")} />
			</span>
			{emphasised ? <span aria-hidden="true" className="absolute top-4 right-4 size-6 rounded-full bg-accent" /> : null}
		</button>
	);
}
