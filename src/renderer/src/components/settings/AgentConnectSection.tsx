/**
 * Settings → MCP 서버 → "클라우드 에이전트".
 *
 * Always-on cloud agents (Claude Duet, OpenAI dots, Meta Muse, Grok Bot) cannot start a program on this computer,
 * so they connect to an address. The main process runs the librarian's MCP server over HTTP behind its own
 * Cloudflare tunnel (`agent-connect.ts`); this section switches that on, shows the address to give the agent, and
 * holds the few controls that matter for safety: write access (off), the owner token (never shown), and a reset.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AgentConnectStatus } from "../../../../shared/agent-connect-contract";
import { normalizeTunnelHostname, type RemoteTunnelStatus } from "../../../../shared/remote-contract";
import type { AppSettings } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";
import { errorText } from "./configSupport";
import { Row, Section, StatusDot } from "./SettingsKit";

/** How long "copied" stays before the button reads "copy" again. */
const COPIED_MS = 1800;
/** How long the reset button waits for its confirming second click. */
const CONFIRM_MS = 4000;

function tunnelTone(tunnel: RemoteTunnelStatus): "ok" | "warn" | "run" | "off" {
	return tunnel.state === "online" ? "ok" : tunnel.state === "starting" ? "run" : tunnel.state === "error" ? "warn" : "off";
}

export function AgentConnectSection({
	appSettings,
	onAppSettingsChanged,
	onSettingsError,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly onSettingsError: (message: string) => void;
}): ReactElement | null {
	const { t } = useTranslation();
	const bridge = window.autorag.agentConnect;
	const [status, setStatus] = useState<AgentConnectStatus | null>(null);
	const [copied, setCopied] = useState<"address" | "token" | null>(null);
	const [copyFailed, setCopyFailed] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [domainDraft, setDomainDraft] = useState(appSettings.agentTunnelHostname);
	const [domainError, setDomainError] = useState<string | null>(null);
	const [loggingIn, setLoggingIn] = useState(false);
	const timers = useRef<number[]>([]);

	useEffect(() => {
		if (bridge === undefined) return undefined;
		let live = true;
		bridge.status().then(
			(next) => live && setStatus(next),
			(cause: unknown) => onSettingsError(errorText(cause)),
		);
		const unsubscribe = bridge.onChange((next) => live && setStatus(next));
		return () => {
			live = false;
			unsubscribe();
		};
	}, [bridge, appSettings.agentAccess, onSettingsError]);

	useEffect(() => setDomainDraft(appSettings.agentTunnelHostname), [appSettings.agentTunnelHostname]);
	useEffect(
		() => () => {
			for (const id of timers.current) window.clearTimeout(id);
		},
		[],
	);

	// A remote browser session has no bridge to this; it must not show a switch it cannot work.
	if (bridge === undefined) return null;

	const setApp = async (patch: Partial<AppSettings>): Promise<void> => {
		try {
			onAppSettingsChanged(await window.autorag.settings.set(patch));
		} catch (cause) {
			onSettingsError(t("settingsCore.mcp.agents.domainInvalid", { value: errorText(cause) }));
		}
	};
	const later = (action: () => void, ms: number): void => {
		timers.current.push(window.setTimeout(action, ms));
	};
	const copy = async (kind: "address" | "token", value: () => Promise<string>): Promise<void> => {
		try {
			await navigator.clipboard.writeText(await value());
			setCopyFailed(false);
			setCopied(kind);
			later(() => setCopied(null), COPIED_MS);
		} catch {
			setCopied(null);
			setCopyFailed(true);
		}
	};
	const run = async (action: () => Promise<AgentConnectStatus>): Promise<void> => {
		try {
			setStatus(await action());
		} catch (cause) {
			onSettingsError(errorText(cause));
		}
	};
	const saveDomain = (): void => {
		const trimmed = domainDraft.trim();
		const normalized = trimmed === "" ? "" : normalizeTunnelHostname(trimmed);
		if (normalized === null) {
			setDomainError(t("settingsCore.mcp.agents.domainInvalid", { value: trimmed }));
			return;
		}
		setDomainError(null);
		setDomainDraft(normalized);
		if (normalized !== appSettings.agentTunnelHostname) void setApp({ agentTunnelHostname: normalized });
	};

	const on = appSettings.agentAccess;
	const tunnel = status?.tunnel;
	const reason = status?.error ?? tunnel?.error ?? "";

	return (
		<Section title={t("settingsCore.mcp.agents.title")} description={t("settingsCore.mcp.agents.desc")}>
			<Row name={t("settingsCore.mcp.agents.access")} hint={t("settingsCore.mcp.agents.accessHint")}>
				<Switch checked={on} ariaLabel={t("settingsCore.mcp.agents.access")} onChange={() => void setApp({ agentAccess: !on })} />
			</Row>
			{on && status !== null && tunnel !== undefined ? (
				<>
					{status.error !== null ? (
						<div className="settings-error" role="alert">
							{t("settingsCore.mcp.agents.serverFailed", { reason: status.error })}
						</div>
					) : null}
					<div className="settings-remote-status-line">
						<StatusDot tone={tunnelTone(tunnel)} />
						<span>{tunnel.state === "starting" ? t("settingsCore.mcp.agents.starting") : (status.mcpUrl ?? t("settingsCore.mcp.agents.noAddress"))}</span>
					</div>
					{status.mcpUrl !== null ? (
						<>
							<p className="settings-remote-desc">{t(tunnel.mode === "custom" ? "settingsCore.mcp.agents.customHint" : "settingsCore.mcp.agents.quickHint")}</p>
							<div className="settings-snippet-foot">
								<span className="settings-snippet-hint">{t("settingsCore.mcp.agents.address")}</span>
								<button type="button" className="linear-btn settings-copy-btn" onClick={() => void copy("address", async () => status.mcpUrl ?? "")}>
									{copied === "address" ? t("settingsCore.mcp.agents.copied") : t("settingsCore.mcp.agents.copyAddress")}
								</button>
							</div>
						</>
					) : tunnel.errorCode === "missing_binary" || !tunnel.available ? (
						<p className="settings-remote-error">{t("settingsCore.mcp.agents.missingBinary")}</p>
					) : reason !== "" ? (
						<p className="settings-remote-error">{t("settingsCore.mcp.agents.tunnelFailed", { reason })}</p>
					) : null}
					{tunnel.available ? (
						<details className="settings-remote-domain" open={appSettings.agentTunnelHostname !== ""}>
							<summary>{t("settingsCore.mcp.agents.domainToggle")}</summary>
							<p className="settings-remote-sub">{t("settingsCore.mcp.agents.domainHint")}</p>
							<div className="settings-remote-field">
								<input
									type="text"
									className="settings-source-desc__input"
									aria-label={t("settingsCore.mcp.agents.domainLabel")}
									placeholder="agents.example.com"
									spellCheck={false}
									value={domainDraft}
									onChange={(event) => {
										setDomainError(null);
										setDomainDraft(event.currentTarget.value);
									}}
									onBlur={saveDomain}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											event.currentTarget.blur();
										}
									}}
								/>
							</div>
							{domainError !== null ? <p className="settings-remote-error">{domainError}</p> : null}
							{tunnel.mode === "custom" && !tunnel.loggedIn ? (
								<div className="settings-remote-actions">
									<button
										type="button"
										className="linear-btn"
										disabled={loggingIn}
										onClick={() => {
											setLoggingIn(true);
											void run(() => bridge.loginTunnel()).finally(() => setLoggingIn(false));
										}}
									>
										{t("settingsCore.mcp.agents.domainLogin")}
									</button>
									<span className="settings-remote-sub">{t("settingsCore.mcp.agents.domainLoginHint")}</span>
								</div>
							) : null}
						</details>
					) : null}
					<Row name={t("settingsCore.mcp.agents.write")} hint={t("settingsCore.mcp.agents.writeHint")}>
						<Switch checked={status.allowWrite} ariaLabel={t("settingsCore.mcp.agents.write")} onChange={() => void run(() => bridge.setAllowWrite(!status.allowWrite))} />
					</Row>
					<Row name={t("settingsCore.mcp.agents.tokenTitle")} hint={t("settingsCore.mcp.agents.tokenHint")} stack>
						<div className="settings-remote-actions">
							<button type="button" className="linear-btn settings-copy-btn" onClick={() => void copy("token", () => bridge.revealToken())}>
								{copied === "token" ? t("settingsCore.mcp.agents.copied") : t("settingsCore.mcp.agents.copyToken")}
							</button>
							<button
								type="button"
								className="linear-btn"
								onClick={() => {
									if (!confirmReset) {
										setConfirmReset(true);
										later(() => setConfirmReset(false), CONFIRM_MS);
										return;
									}
									setConfirmReset(false);
									void run(() => bridge.rotateToken());
								}}
							>
								{confirmReset ? t("settingsCore.mcp.agents.resetTokenConfirm") : t("settingsCore.mcp.agents.resetToken")}
							</button>
						</div>
						<p className="settings-remote-sub">{t("settingsCore.mcp.agents.resetTokenHint")}</p>
					</Row>
					{copyFailed ? <div className="settings-error" role="alert">{t("settingsCore.mcp.agents.copyFailed")}</div> : null}
					<p className="settings-remote-sub">{t("settingsCore.mcp.agents.checkHint")}</p>
				</>
			) : null}
		</Section>
	);
}
