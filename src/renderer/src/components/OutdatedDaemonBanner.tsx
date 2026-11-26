import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ToolVersionsSnapshot } from "../../../shared/tool-versions-contract";
import { NoticeCard } from "./primitives/NoticeCard";

/**
 * Shown above the file list only when the shared local embedding daemon
 * reports a version older than `src/shared/tool-pins.json`. Offers a one-click
 * restart when Dazzi owns the daemon, and a read-only link to Settings → About
 * when the daemon was started outside Dazzi (never killing a user-started server).
 */
export function OutdatedDaemonBanner({ onOpenSettings }: { readonly onOpenSettings: () => void }): ReactElement | null {
	const { t } = useTranslation();
	const bridge = window.autorag?.toolVersions;
	const [snapshot, setSnapshot] = useState<ToolVersionsSnapshot | null>(null);
	const [dismissedPid, setDismissedPid] = useState<number | null>(null);
	const [restarting, setRestarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (bridge === undefined) return;
		let live = true;
		void bridge.get().then(
			(next) => {
				if (live) setSnapshot(next);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [bridge]);

	const daemon = snapshot?.daemon;
	if (daemon === undefined || !daemon.outdated || daemon.version === null || daemon.port === null) return null;
	if (daemon.pid !== null && daemon.pid === dismissedPid) return null;

	const dismiss = (): void => setDismissedPid(daemon.pid ?? -1);

	const handleRestart = async (): Promise<void> => {
		if (bridge === undefined || restarting) return;
		setRestarting(true);
		setError(null);
		try {
			const response = await bridge.restartDaemon();
			setSnapshot(response.snapshot);
			if (!response.ok) {
				setError(t("settingsCore.about.restartFailed", { message: response.message ?? response.reason ?? "unknown" }));
			}
		} catch (cause) {
			setError(t("settingsCore.about.restartFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
		} finally {
			setRestarting(false);
		}
	};

	const detail =
		error ??
		(daemon.owned
			? t("settingsCore.about.bannerOwnedDetail", { version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion })
			: t("settingsCore.about.bannerExternalDetail", { version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion }));

	return (
		<NoticeCard
			className="mx-8 mt-8 flex-none"
			floating
			tone={error !== null ? "error" : "warning"}
			title={t("settingsCore.about.bannerTitle")}
			onClose={dismiss}
			actions={
				daemon.canRestart
					? [
							{ label: t("common.later"), onClick: dismiss },
							{
								label: restarting ? t("settingsCore.about.restartingDaemon") : t("settingsCore.about.restartDaemon"),
								primary: true,
								onClick: () => void handleRestart(),
							},
						]
					: [
							{ label: t("common.later"), onClick: dismiss },
							{ label: t("settingsCore.about.openSettings"), primary: true, onClick: onOpenSettings },
						]
			}
		>
			{detail}
		</NoticeCard>
	);
}
