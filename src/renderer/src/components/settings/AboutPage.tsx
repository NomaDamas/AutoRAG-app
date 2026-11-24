/**
 * Settings → About: resolved versions of the app, `@autorag/librarian`, pinned
 * tools (`minsync`, `inl`, `mailcrawl`, `lazykatok`), PATH mismatch flags, and
 * the shared local embedding daemon's health & safe restart control.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ToolComponentVersion, ToolVersionsSnapshot } from "../../../../shared/tool-versions-contract";
import { NoticeCard } from "../primitives/NoticeCard";
import { PlainDivider, PlainRow, PlainSection, SettingsPageHead } from "./SettingsKit";

export function AboutPage(): ReactElement {
	const { t } = useTranslation();
	const bridge = window.autorag?.toolVersions;
	const [snapshot, setSnapshot] = useState<ToolVersionsSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [restarting, setRestarting] = useState(false);
	const [restartError, setRestartError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		if (bridge === undefined) {
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			setSnapshot(await bridge.get());
		} finally {
			setLoading(false);
		}
	}, [bridge]);

	useEffect(() => {
		void load();
	}, [load]);

	const handleRestart = async (): Promise<void> => {
		if (bridge === undefined || restarting) return;
		setRestarting(true);
		setRestartError(null);
		try {
			const response = await bridge.restartDaemon();
			setSnapshot(response.snapshot);
			if (!response.ok) {
				setRestartError(t("settingsCore.about.restartFailed", { message: response.message ?? response.reason ?? "unknown" }));
			}
		} catch (error) {
			setRestartError(t("settingsCore.about.restartFailed", { message: error instanceof Error ? error.message : String(error) }));
		} finally {
			setRestarting(false);
		}
	};

	const daemon = snapshot?.daemon ?? null;

	const daemonHint = (): string => {
		if (daemon === null) return "";
		if (!daemon.running) {
			return t("settingsCore.about.daemonStopped", { owner: daemon.owner, engine: daemon.engine, pinned: daemon.pinnedVersion });
		}
		if (daemon.outdated && daemon.version !== null && daemon.port !== null) {
			return daemon.owned
				? t("settingsCore.about.daemonOutdatedOwned", { engine: daemon.engine, version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion })
				: t("settingsCore.about.daemonOutdatedExternal", { engine: daemon.engine, version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion });
		}
		const base =
			daemon.version !== null && daemon.port !== null
				? t("settingsCore.about.daemonRunning", { owner: daemon.owner, engine: daemon.engine, version: daemon.version, port: daemon.port })
				: t("settingsCore.about.daemonRunningUnknownVersion", { owner: daemon.owner, port: daemon.port ?? 0 });
		const ownership = daemon.owned ? t("settingsCore.about.daemonOwned") : t("settingsCore.about.daemonExternal");
		const instanceDetail =
			daemon.instance !== null && daemon.pid !== null
				? ` · ${t("settingsCore.about.daemonInstance", { instance: daemon.instance, pid: daemon.pid })}`
				: "";
		return `${base} · ${ownership}${instanceDetail}`;
	};

	const componentHint = (component: ToolComponentVersion): string => {
		const parts: string[] = [];
		if (component.bundled === null) {
			parts.push(t("settingsCore.about.notBundled", { pinned: component.pinned }));
		} else if (component.manifestMismatch) {
			parts.push(t("settingsCore.about.manifestMismatch", { bundled: component.bundled, pinned: component.pinned }));
		} else if (component.bundled !== component.pinned) {
			parts.push(t("settingsCore.about.bundledAndPinnedHint", { bundled: component.bundled, pinned: component.pinned }));
		} else {
			parts.push(t("settingsCore.about.pinnedHint", { version: component.pinned }));
		}
		if (component.pathMismatch && component.pathVersion !== null) {
			parts.push(
				t("settingsCore.about.pathMismatch", {
					pathVersion: component.pathVersion,
					path: component.pathLocation ?? "PATH",
					expected: component.bundled ?? component.pinned,
				}),
			);
		}
		return parts.join(" · ");
	};

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.about")} description={t("settingsCore.about.description")} />
			{snapshot === null && loading ? (
				<p className="linear-section-desc">{t("common.loading")}</p>
			) : snapshot === null ? null : (
				<div className="plain-sections">
					{snapshot.manifestDrift.length > 0 ? (
						<NoticeCard tone="warning" title={t("settingsCore.about.manifestDriftTitle")}>
							{t("settingsCore.about.manifestDriftDetail", {
								tools: snapshot.manifestDrift.map((entry) => `${entry.name} (${entry.manifest ?? "missing"} vs ${entry.pinned})`).join(", "),
							})}
						</NoticeCard>
					) : null}
					{restartError !== null ? (
						<NoticeCard tone="error" title={t("settingsCore.about.daemonName")} onClose={() => setRestartError(null)}>
							{restartError}
						</NoticeCard>
					) : null}
					<PlainSection title={t("settingsCore.about.daemonTitle")}>
						<PlainRow name={t("settingsCore.about.daemonName")} hint={daemonHint()}>
							<div className="flex items-center gap-8">
								{daemon?.canRestart ? (
									<button
										type="button"
										className="linear-btn settings-btn-primary"
										data-testid="about-restart-daemon"
										disabled={restarting}
										onClick={() => void handleRestart()}
									>
										{restarting ? t("settingsCore.about.restartingDaemon") : t("settingsCore.about.restartDaemon")}
									</button>
								) : null}
								<button type="button" className="linear-btn" disabled={loading || restarting} onClick={() => void load()}>
									{t("settingsCore.about.refresh")}
								</button>
							</div>
						</PlainRow>
					</PlainSection>
					<PlainDivider />
					<PlainSection title={t("settingsCore.about.versionsTitle")}>
						{snapshot.components.map((component) => (
							<PlainRow
								key={component.id}
								name={component.name}
								hint={componentHint(component)}
							>
								<span
									className={`font-mono text-meta ${component.pathMismatch || component.manifestMismatch ? "text-warning" : "text-ink-muted"}`}
									data-tool-version={component.id}
									data-path-mismatch={component.pathMismatch ? "true" : "false"}
								>
									{component.bundled ?? component.pinned}
								</span>
							</PlainRow>
						))}
					</PlainSection>
				</div>
			)}
		</>
	);
}
