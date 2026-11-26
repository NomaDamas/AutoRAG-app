/**
 * What used to be Settings → 정보, split where each part is looked for:
 * - `ComponentVersionsRow` sits under 일반's 앱 버전 row: the librarian's and the pinned tools' versions
 *   (`minsync`, `inl`, `mailcrawl`, `lazykatok`), folded away until asked for, and saying so on its row when one
 *   differs from what Dazzi pins.
 * - `EmbeddingDaemonSection` sits on 인덱싱: the shared local embedding server's health and its safe restart.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ToolComponentVersion, ToolVersionsSnapshot } from "../../../../shared/tool-versions-contract";
import { ChevronDownIcon } from "../icons";
import { NoticeCard } from "../primitives/NoticeCard";
import { cn } from "../../lib/cn";
import { PlainRow } from "./SettingsKit";

function useToolVersions(): {
	readonly snapshot: ToolVersionsSnapshot | null;
	readonly loading: boolean;
	readonly load: () => Promise<void>;
	readonly setSnapshot: (snapshot: ToolVersionsSnapshot) => void;
} {
	const bridge = window.autorag?.toolVersions;
	const [snapshot, setSnapshot] = useState<ToolVersionsSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
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
	return { snapshot, loading, load, setSnapshot };
}

/** Whether a component is not what Dazzi pins: another copy first on PATH, or a bundle that disagrees with the pin. */
function differs(component: ToolComponentVersion): boolean {
	return component.pathMismatch || component.manifestMismatch || (component.bundled !== null && component.bundled !== component.pinned);
}

/**
 * 구성 요소 버전 under 앱 버전 on 일반: one row, folded by default, that opens to the librarian and each pinned tool
 * with its version on the right. A component says more than its version only when it is not what Dazzi pins.
 */
export function ComponentVersionsRow(): ReactElement | null {
	const { t } = useTranslation();
	const { snapshot } = useToolVersions();
	const [open, setOpen] = useState(false);
	if (snapshot === null) return null;
	// Dazzi's own version is 앱 버전, right above.
	const components = snapshot.components.filter((component) => component.id !== "app");
	const off = components.filter(differs).length + snapshot.manifestDrift.length;
	const note = (component: ToolComponentVersion): string | null => {
		const parts: string[] = [];
		if (component.manifestMismatch) parts.push(t("settingsCore.about.manifestMismatch", { bundled: component.bundled ?? "", pinned: component.pinned }));
		else if (component.bundled !== null && component.bundled !== component.pinned) parts.push(t("settingsCore.about.bundledAndPinnedHint", { bundled: component.bundled, pinned: component.pinned }));
		if (component.pathMismatch && component.pathVersion !== null) {
			parts.push(t("settingsCore.about.pathMismatch", { pathVersion: component.pathVersion, path: component.pathLocation ?? "PATH", expected: component.bundled ?? component.pinned }));
		}
		return parts.length === 0 ? null : parts.join(" · ");
	};
	return (
		<>
			<PlainRow name={t("settingsCore.about.versionsTitle")} hint={off > 0 ? t("settingsCore.about.versionsOff", { count: off }) : t("settingsCore.about.versionsHint")}>
				<button type="button" className="linear-btn" aria-expanded={open} data-action="component-versions-toggle" onClick={() => setOpen((value) => !value)}>
					{open ? t("settingsCore.about.versionsHide") : t("settingsCore.about.versionsShow")}
					<ChevronDownIcon size={12} className={cn("ml-4 transition-transform duration-(--dur-color)", open && "rotate-180")} />
				</button>
			</PlainRow>
			{open ? (
				<div className="flex flex-col gap-10 rounded-8 bg-subtle-alt px-14 py-12" data-component-versions>
					{snapshot.manifestDrift.length > 0 ? (
						<NoticeCard tone="warning" title={t("settingsCore.about.manifestDriftTitle")}>
							{t("settingsCore.about.manifestDriftDetail", {
								tools: snapshot.manifestDrift.map((entry) => `${entry.name} (${entry.manifest ?? "missing"} vs ${entry.pinned})`).join(", "),
							})}
						</NoticeCard>
					) : null}
					{components.map((component) => {
						const detail = note(component);
						return (
							<div key={component.id} className="flex flex-col gap-2">
								<div className="flex items-center justify-between gap-12 text-meta leading-[18px]">
									<span className="min-w-0 truncate text-ink-body">{component.name}</span>
									<span
										className={cn("flex-none", detail === null ? "text-ink-muted" : "text-warning")}
										data-tool-version={component.id}
										data-path-mismatch={component.pathMismatch ? "true" : "false"}
									>
										{component.bundled ?? component.pinned}
									</span>
								</div>
								{detail === null ? null : <small className="text-badge leading-[16px] text-warning [overflow-wrap:anywhere]">{detail}</small>}
							</div>
						);
					})}
				</div>
			) : null}
		</>
	);
}

/** 로컬 임베딩 서버 on 인덱싱: whether the shared embedding daemon answers, and a restart when Dazzi started an old one. */
export function EmbeddingDaemonSection(): ReactElement | null {
	const { t } = useTranslation();
	const bridge = window.autorag?.toolVersions;
	const { snapshot, loading, load, setSnapshot } = useToolVersions();
	const [restarting, setRestarting] = useState(false);
	const [restartError, setRestartError] = useState<string | null>(null);
	const daemon = snapshot?.daemon ?? null;
	if (daemon === null) return null;

	const handleRestart = async (): Promise<void> => {
		if (bridge === undefined || restarting) return;
		setRestarting(true);
		setRestartError(null);
		try {
			const response = await bridge.restartDaemon();
			setSnapshot(response.snapshot);
			if (!response.ok) setRestartError(t("settingsCore.about.restartFailed", { message: response.message ?? response.reason ?? "unknown" }));
		} catch (error) {
			setRestartError(t("settingsCore.about.restartFailed", { message: error instanceof Error ? error.message : String(error) }));
		} finally {
			setRestarting(false);
		}
	};

	let hint: string;
	if (!daemon.running) {
		hint = t("settingsCore.about.daemonStopped", { owner: daemon.owner, engine: daemon.engine, pinned: daemon.pinnedVersion });
	} else if (daemon.outdated && daemon.version !== null && daemon.port !== null) {
		hint = daemon.owned
			? t("settingsCore.about.daemonOutdatedOwned", { engine: daemon.engine, version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion })
			: t("settingsCore.about.daemonOutdatedExternal", { engine: daemon.engine, version: daemon.version, port: daemon.port, pinned: daemon.pinnedVersion });
	} else {
		const base =
			daemon.version !== null && daemon.port !== null
				? t("settingsCore.about.daemonRunning", { owner: daemon.owner, engine: daemon.engine, version: daemon.version, port: daemon.port })
				: t("settingsCore.about.daemonRunningUnknownVersion", { owner: daemon.owner, port: daemon.port ?? 0 });
		const ownership = daemon.owned ? t("settingsCore.about.daemonOwned") : t("settingsCore.about.daemonExternal");
		const instance = daemon.instance !== null && daemon.pid !== null ? ` · ${t("settingsCore.about.daemonInstance", { instance: daemon.instance, pid: daemon.pid })}` : "";
		hint = `${base} · ${ownership}${instance}`;
	}

	return (
		<>
		<hr className="scope-divider" />
		<section className="scope-section scope-section--row scope-section--setting" data-index-scope="embedding-daemon">
			<div className="scope-section-text">
				<h3 className="scope-section-title">{t("settingsCore.about.daemonName")}</h3>
				<p className="scope-section-desc">{hint}</p>
				{restartError === null ? null : (
					<NoticeCard tone="error" title={t("settingsCore.about.daemonName")} onClose={() => setRestartError(null)}>
						{restartError}
					</NoticeCard>
				)}
			</div>
			<div className="flex flex-none items-center gap-8">
				{daemon.canRestart ? (
					<button type="button" className="linear-btn settings-btn-primary" data-testid="about-restart-daemon" disabled={restarting} onClick={() => void handleRestart()}>
						{restarting ? t("settingsCore.about.restartingDaemon") : t("settingsCore.about.restartDaemon")}
					</button>
				) : null}
				<button type="button" className="linear-btn" disabled={loading || restarting} onClick={() => void load()}>
					{t("settingsCore.about.refresh")}
				</button>
			</div>
		</section>
		</>
	);
}
