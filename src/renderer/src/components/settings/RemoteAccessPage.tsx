/**
 * Settings → Remote Access (its own page under 기본), inspired by Ovis (`devswha/ovis`).
 *
 * Off: only the Enable switch. On: one "Connect a device" card and the paired-device list.
 * The card separates the two things a new device needs:
 * 1. A route, which decides the address it opens: the same Wi-Fi (LAN address), Tailscale
 *    (`https://*.ts.net` or the tailnet IP), or the internet through a Cloudflare tunnel
 *    (a temporary trycloudflare.com address, or the user's own domain).
 * 2. The pairing code, the same for every route: the QR code is that route's address plus `?pair=CODE`.
 * The browser address (with its token) and the port sit behind "Details".
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import {
	normalizeTunnelHostname,
	type RemoteAccessStatus,
	type RemotePairedDevice,
	type RemotePairingCode,
	type RemoteTunnelStatus,
} from "../../../../shared/remote-contract";
import type { AppSettings } from "../../../../shared/settings-contract";
import { QrCode } from "./QrCode";
import { Row, Section, SettingsPageHead, StatusDot } from "./SettingsKit";
import { Switch } from "../primitives/Switch";

type ConnectRoute = "lan" | "tailscale" | "internet";

interface RelativeSeenLabels {
	readonly never: string;
	readonly justNow: string;
	readonly minutesAgo: (count: number) => string;
	readonly hoursAgo: (count: number) => string;
}

function formatRelativeSeen(iso: string | null, labels: RelativeSeenLabels): string {
	if (iso === null) return labels.never;
	const diffMinutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
	if (diffMinutes < 2) return labels.justNow;
	if (diffMinutes < 60) return labels.minutesAgo(diffMinutes);
	if (diffMinutes < 48 * 60) return labels.hoursAgo(Math.round(diffMinutes / 60));
	return new Date(iso).toLocaleDateString();
}

/** The route a fresh card opens on: whichever already has a working address, the internet tunnel first. */
function defaultRoute(status: RemoteAccessStatus | null): ConnectRoute {
	if (status?.tunnel?.state === "online") return "internet";
	if (status?.tailscale?.servingUrl) return "tailscale";
	if ((status?.lanOrigins?.length ?? 0) > 0) return "lan";
	if (status?.tailscale?.state === "running") return "tailscale";
	return "lan";
}

export function RemoteAccessPage({
	appSettings,
	onAppSettingsChanged,
	onSettingsError,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly onSettingsError: (message: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const setApp = async (patch: Partial<AppSettings>): Promise<void> => {
		try {
			onAppSettingsChanged(await window.autorag.settings.set(patch));
		} catch (cause) {
			onSettingsError(t("settingsCore.remote.settingsError", { error: cause instanceof Error ? cause.message : String(cause) }));
		}
	};
	const remoteBridge = window.autorag.remote;
	const canManageRemote = typeof remoteBridge?.status === "function";
	const isRemoteClient = window.autoragIsRemote === true;
	const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null);
	const [remotePort, setRemotePort] = useState(String(appSettings.remotePort));
	const [domainDraft, setDomainDraft] = useState(appSettings.remoteTunnelHostname);
	const [domainError, setDomainError] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [pickedRoute, setPickedRoute] = useState<ConnectRoute | null>(null);
	const [pickedLan, setPickedLan] = useState<string>("");
	const [localPairing, setLocalPairing] = useState<RemotePairingCode | null>(null);
	const [countdown, setCountdown] = useState<string>("");
	const [refreshingNet, setRefreshingNet] = useState(false);
	const [tunnelBusy, setTunnelBusy] = useState(false);
	const [loggingIn, setLoggingIn] = useState(false);
	const [renaming, setRenaming] = useState<{ readonly id: string; readonly label: string } | null>(null);
	const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
	const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
	const [applyingPort, setApplyingPort] = useState(false);
	const [serveBusy, setServeBusy] = useState(false);

	useEffect(() => {
		setRemotePort(String(appSettings.remotePort));
	}, [appSettings.remotePort]);
	useEffect(() => {
		setDomainDraft(appSettings.remoteTunnelHostname);
	}, [appSettings.remoteTunnelHostname]);

	const refreshStatus = useCallback((): void => {
		if (!canManageRemote) return;
		void remoteBridge.status().then(
			(status) => {
				setRemoteStatus(status);
				if (status.pairing !== undefined) setLocalPairing(status.pairing);
			},
			(cause: unknown) => {
				onSettingsError(t("settingsCore.remote.statusError", { error: cause instanceof Error ? cause.message : String(cause) }));
			},
		);
	}, [canManageRemote, onSettingsError, remoteBridge, t]);

	useEffect(() => {
		if (!canManageRemote) return;
		refreshStatus();
		const unsubscribe =
			typeof remoteBridge.onChange === "function"
				? remoteBridge.onChange((next) => {
						setRemoteStatus(next);
						if (next.pairing !== undefined) setLocalPairing(next.pairing);
					})
				: () => undefined;
		window.addEventListener("focus", refreshStatus);
		return () => {
			unsubscribe();
			window.removeEventListener("focus", refreshStatus);
		};
	}, [appSettings.remoteAccess, appSettings.remotePort, canManageRemote, refreshStatus, remoteBridge]);

	const activeCode = localPairing ?? remoteStatus?.pairing ?? null;

	useEffect(() => {
		if (activeCode === null) {
			setCountdown("");
			return;
		}
		const tick = (): void => {
			const ms = Date.parse(activeCode.expiresAt) - Date.now();
			if (ms <= 0) {
				setLocalPairing(null);
				setCountdown("");
				return;
			}
			setCountdown(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
		};
		tick();
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [activeCode]);

	const lanOrigins = useMemo(() => remoteStatus?.lanOrigins ?? [], [remoteStatus]);

	const serving = remoteStatus?.serving === true;
	const enabled = appSettings.remoteAccess || serving;
	const devices: readonly RemotePairedDevice[] = remoteStatus?.devices ?? [];
	const tailscale = remoteStatus?.tailscale;
	const tunnel: RemoteTunnelStatus | undefined = remoteStatus?.tunnel;
	const showInternetRoute = !isRemoteClient || tunnel?.state === "online";
	const route: ConnectRoute = pickedRoute === "internet" && !showInternetRoute ? "lan" : (pickedRoute ?? defaultRoute(remoteStatus));
	const lanAddress = pickedLan !== "" && lanOrigins.includes(pickedLan) ? pickedLan : (lanOrigins[0] ?? null);
	const tailscaleAddress =
		tailscale?.state === "running"
			? (tailscale.servingUrl ?? (tailscale.tailnetIp !== null && (remoteStatus?.port ?? 0) > 0 ? `http://${tailscale.tailnetIp}:${remoteStatus?.port}` : null))
			: null;
	const internetAddress = tunnel?.state === "online" ? tunnel.url : null;
	const routeAddress = route === "lan" ? lanAddress : route === "tailscale" ? tailscaleAddress : internetAddress;
	const browserAddress = serving ? remoteStatus.origin : null;
	const spacedCode = activeCode ? `${activeCode.code.slice(0, 3)} ${activeCode.code.slice(3)}` : null;
	const pairLink = activeCode !== null && routeAddress !== null ? `${routeAddress.replace(/\/$/, "")}/?pair=${activeCode.code}` : null;

	const copyText = async (text: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(text);
		} catch {
			onSettingsError(t("settingsCore.remote.copyError"));
		}
	};
	const reportError = (cause: unknown): void => onSettingsError(cause instanceof Error ? cause.message : String(cause));
	const serverError = enabled && !serving ? (remoteStatus?.serverError ?? null) : null;
	/** Save a port and (re)start on it now: the host moves a running server to the new port. */
	const applyPort = async (port: number): Promise<void> => {
		setApplyingPort(true);
		try {
			await setApp({ remotePort: port });
			setRemoteStatus(await remoteBridge.start());
		} catch (cause) {
			reportError(cause);
		} finally {
			setApplyingPort(false);
		}
	};

	const handleStartPairing = async (): Promise<void> => {
		try {
			setLocalPairing(await remoteBridge.startPairing());
		} catch (cause) {
			reportError(cause);
		}
	};
	const handleRefreshNetwork = async (): Promise<void> => {
		setRefreshingNet(true);
		try {
			setRemoteStatus(await remoteBridge.refreshNetwork());
		} catch (cause) {
			reportError(cause);
		} finally {
			setRefreshingNet(false);
		}
	};
	const handleTunnel = async (action: "start" | "stop" | "login"): Promise<void> => {
		const busy = action === "login" ? setLoggingIn : setTunnelBusy;
		busy(true);
		try {
			setRemoteStatus(await (action === "start" ? remoteBridge.startTunnel() : action === "stop" ? remoteBridge.stopTunnel() : remoteBridge.loginTunnel()));
		} catch (cause) {
			reportError(cause);
		} finally {
			busy(false);
		}
	};
	const handleTailscaleServe = async (action: "start" | "stop"): Promise<void> => {
		setServeBusy(true);
		try {
			setRemoteStatus(await (action === "start" ? remoteBridge.startTailscaleServe() : remoteBridge.stopTailscaleServe()));
		} catch (cause) {
			reportError(cause);
		} finally {
			setServeBusy(false);
		}
	};
	const saveDomain = (): void => {
		const trimmed = domainDraft.trim();
		const normalized = trimmed === "" ? "" : normalizeTunnelHostname(trimmed);
		if (normalized === null) {
			setDomainError(t("settingsCore.remote.domainInvalid", { value: trimmed }));
			return;
		}
		setDomainError(null);
		setDomainDraft(normalized);
		if (normalized !== appSettings.remoteTunnelHostname) void setApp({ remoteTunnelHostname: normalized });
	};
	const handleSaveRename = async (): Promise<void> => {
		if (renaming === null) return;
		try {
			await remoteBridge.renameDevice(renaming.id, renaming.label);
			setRenaming(null);
			refreshStatus();
		} catch (cause) {
			reportError(cause);
		}
	};
	const handleRevokeDevice = async (id: string): Promise<void> => {
		if (confirmRevokeId !== id) {
			setConfirmRevokeId(id);
			window.setTimeout(() => setConfirmRevokeId((previous) => (previous === id ? null : previous)), 4000);
			return;
		}
		setConfirmRevokeId(null);
		try {
			await remoteBridge.revokeDevice(id);
			refreshStatus();
		} catch (cause) {
			reportError(cause);
		}
	};
	const handleRevokeAll = async (): Promise<void> => {
		if (!confirmRevokeAll) {
			setConfirmRevokeAll(true);
			window.setTimeout(() => setConfirmRevokeAll(false), 4000);
			return;
		}
		setConfirmRevokeAll(false);
		try {
			await remoteBridge.revokeAllDevices();
			setLocalPairing(null);
			refreshStatus();
		} catch (cause) {
			reportError(cause);
		}
	};

	const viaLabel =
		remoteStatus?.via === "device"
			? t("settingsCore.remote.viaDevice")
			: remoteStatus?.via === "tailscale"
				? t("settingsCore.remote.viaTailscale")
				: remoteStatus?.via === "token"
					? t("settingsCore.remote.viaToken")
					: null;

	const tunnelError = (status: RemoteTunnelStatus): string | null => {
		switch (status.errorCode) {
			case null:
			case "missing_binary":
				return null;
			case "login_required":
				return t("settingsCore.remote.tunnelErrLogin");
			case "server_stopped":
				return t("settingsCore.remote.tunnelErrServer");
			case "timeout":
				return t("settingsCore.remote.tunnelErrTimeout");
			case "disconnected":
				return t("settingsCore.remote.tunnelErrDisconnected");
			case "exited":
				return t("settingsCore.remote.tunnelErrExited", { reason: status.error ?? "" });
			case "setup_failed":
				return t("settingsCore.remote.tunnelErrSetup", { reason: status.error ?? "" });
		}
	};

	const routes: readonly { readonly id: ConnectRoute; readonly label: string }[] = [
		{ id: "lan", label: t("settingsCore.remote.routeLan") },
		{ id: "tailscale", label: t("settingsCore.remote.routeTailscale") },
		...(showInternetRoute ? [{ id: "internet" as const, label: t("settingsCore.remote.routeInternet") }] : []),
	];

	const copyButton = (value: string, label: string, copiedLabel: string): ReactElement => (
		<button type="button" className="linear-btn shrink-0" onClick={() => void copyText(value)}>
			{copied === value ? copiedLabel : label}
		</button>
	);

	const lanPane = (
		<>
			<p className="settings-remote-desc">{t("settingsCore.remote.routeLanHint")}</p>
			{lanOrigins.length === 0 ? <p className="settings-remote-desc">{t("settingsCore.remote.lanMissing")}</p> : null}
			{lanOrigins.length > 1 ? (
				<select
					className="linear-select settings-remote-origin-select"
					aria-label={t("settingsCore.remote.routeAddress")}
					value={lanAddress ?? ""}
					onChange={(event) => setPickedLan(event.currentTarget.value)}
				>
					{lanOrigins.map((item) => (
						<option key={item} value={item}>
							{item}
						</option>
					))}
				</select>
			) : null}
		</>
	);

	const serveError = tailscale?.serveError ?? null;
	const tailscalePane = (
		<>
			{tailscale?.state === "running" ? (
				<>
					<div className="settings-remote-status-line">
						<StatusDot tone={tailscale.servingUrl !== null ? "ok" : serveBusy ? "run" : "off"} />
						<span>{tailscale.servingUrl !== null ? t("settingsCore.remote.tailscaleServing") : t("settingsCore.remote.tailscaleNotServing")}</span>
					</div>
					<p className="settings-remote-desc">
						{tailscale.servingUrl !== null ? t("settingsCore.remote.tailscaleServingHint") : t("settingsCore.remote.tailscaleServeHint")}
					</p>
					{serveError !== null ? (
						<div className="settings-remote-server-error" role="alert">
							<p className="settings-remote-error">{t("settingsCore.remote.tailscaleServeFailed", { reason: serveError.reason })}</p>
							{serveError.enableUrl !== null && !isRemoteClient ? (
								<div className="settings-remote-actions">
									<button type="button" className="linear-btn" onClick={() => void window.autorag.fs.openUrl(serveError.enableUrl ?? "")}>
										{t("settingsCore.remote.tailscaleServeEnable")}
									</button>
								</div>
							) : null}
						</div>
					) : null}
					{isRemoteClient ? null : (
						<div className="settings-remote-actions">
							{tailscale.servingUrl !== null ? (
								<button type="button" className="linear-btn" disabled={serveBusy} onClick={() => void handleTailscaleServe("stop")}>
									{t("settingsCore.remote.tailscaleServeStop")}
								</button>
							) : (
								<button
									type="button"
									className="linear-btn settings-btn-primary"
									disabled={serveBusy || tailscale.servePort === null || tailscale.servePort === undefined}
									onClick={() => void handleTailscaleServe("start")}
								>
									{serveBusy ? t("settingsCore.remote.tailscaleServeStarting") : t("settingsCore.remote.tailscaleServeStart")}
								</button>
							)}
							<button type="button" className="linear-btn" disabled={refreshingNet} onClick={() => void handleRefreshNetwork()}>
								<RefreshCw size={13} aria-hidden="true" />
								<span>{t("settingsCore.remote.tailscaleRefresh")}</span>
							</button>
						</div>
					)}
					{tailscale.servingUrl === null && tailscale.serveCommand !== null && !isRemoteClient ? (
						<details className="settings-remote-domain">
							<summary>{t("settingsCore.remote.tailscaleCommandToggle")}</summary>
							<div className="settings-remote-command">
								<code>{tailscale.serveCommand}</code>
								{copyButton(tailscale.serveCommand, t("settingsCore.remote.copyCommand"), t("settingsCore.remote.commandCopied"))}
							</div>
						</details>
					) : null}
				</>
			) : (
				<>
					<p className="settings-remote-desc">
						{tailscale?.state === "stopped" ? t("settingsCore.remote.tailscaleStopped") : t("settingsCore.remote.tailscaleMissing")}
					</p>
					<div className="settings-remote-actions">
						<button type="button" className="linear-btn" disabled={refreshingNet} onClick={() => void handleRefreshNetwork()}>
							<RefreshCw size={13} aria-hidden="true" />
							<span>{t("settingsCore.remote.tailscaleRefresh")}</span>
						</button>
					</div>
				</>
			)}
		</>
	);

	const internetPane =
		tunnel === undefined ? null : (
			<>
				<div className="settings-remote-status-line">
					<StatusDot tone={tunnel.state === "online" ? "ok" : tunnel.state === "starting" ? "run" : tunnel.state === "error" ? "warn" : "off"} />
					<span>
						{tunnel.mode === "custom"
							? t("settingsCore.remote.tunnelCustomTitle", { hostname: tunnel.hostname ?? "" })
							: t("settingsCore.remote.tunnelQuickTitle")}
					</span>
				</div>
				<p className="settings-remote-desc">
					{!tunnel.available
						? t("settingsCore.remote.tunnelMissingBinary")
						: tunnel.mode === "custom"
							? t("settingsCore.remote.tunnelCustomHint")
							: t("settingsCore.remote.tunnelQuickHint")}
				</p>
				{tunnelError(tunnel) !== null ? <p className="settings-remote-error">{tunnelError(tunnel)}</p> : null}
				{isRemoteClient ? null : (
					<div className="settings-remote-actions">
						{tunnel.state === "online" ? (
							<button type="button" className="linear-btn" disabled={tunnelBusy} onClick={() => void handleTunnel("stop")}>
								{t("settingsCore.remote.tunnelStop")}
							</button>
						) : (
							<button
								type="button"
								className="linear-btn settings-btn-primary"
								disabled={!tunnel.available || tunnelBusy || tunnel.state === "starting" || (tunnel.mode === "custom" && !tunnel.loggedIn)}
								onClick={() => void handleTunnel("start")}
							>
								{tunnelBusy || tunnel.state === "starting" ? t("settingsCore.remote.tunnelStarting") : t("settingsCore.remote.tunnelStart")}
							</button>
						)}
					</div>
				)}
				{isRemoteClient || !tunnel.available ? null : (
					<details className="settings-remote-domain" open={appSettings.remoteTunnelHostname !== ""}>
						<summary>{t("settingsCore.remote.domainToggle")}</summary>
						<p className="settings-remote-sub">{t("settingsCore.remote.domainHint")}</p>
						<div className="settings-remote-field">
							<input
								type="text"
								className="settings-source-desc__input"
								aria-label={t("settingsCore.remote.domainLabel")}
								placeholder="dazzi.example.com"
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
						{tunnel.mode === "custom" ? (
							tunnel.loggedIn ? (
								<p className="settings-remote-sub">{t("settingsCore.remote.domainLoggedIn")}</p>
							) : (
								<div className="settings-remote-actions">
									<button type="button" className="linear-btn" disabled={loggingIn} onClick={() => void handleTunnel("login")}>
										{t("settingsCore.remote.domainLogin")}
									</button>
									<span className="settings-remote-sub">{t("settingsCore.remote.domainLoginHint")}</span>
								</div>
							)
						) : null}
					</details>
				)}
			</>
		);

	const head = <SettingsPageHead title={t("settingsCore.nav.remote")} description={t("settingsCore.remote.description")} />;
	if (!canManageRemote) {
		return (
			<>
				{head}
				<Section>
					<p className="linear-section-desc">{t("settingsCore.remote.unavailable")}</p>
				</Section>
			</>
		);
	}

	return (
		<>
			{head}
			<Section description={t("settingsCore.remote.securityHint")}>
				<Row name={t("settingsCore.remote.access")} hint={t("settingsCore.remote.accessHint")}>
					<Switch checked={appSettings.remoteAccess} onChange={() => void setApp({ remoteAccess: !appSettings.remoteAccess })} ariaLabel={t("settingsCore.remote.access")} />
				</Row>
				{enabled && viaLabel !== null ? <p className="settings-remote-via">{viaLabel}</p> : null}
			</Section>

			{enabled ? (
				<Section title={t("settingsCore.remote.connectTitle")} description={t("settingsCore.remote.connectHint")}>
					<div className="settings-remote-card">
						{!serving && serverError !== null ? (
							<div className="settings-remote-server-error" role="alert">
								<p className="settings-remote-error">
									{serverError.code === "port_in_use"
										? t("settingsCore.remote.portInUse", { port: serverError.port })
										: t("settingsCore.remote.serverFailed", { reason: serverError.message })}
								</p>
								<div className="settings-remote-actions">
									{serverError.code === "port_in_use" && serverError.suggestedPort !== null ? (
										<button
											type="button"
											className="linear-btn settings-btn-primary"
											disabled={applyingPort}
											onClick={() => void applyPort(serverError.suggestedPort ?? 0)}
										>
											{t("settingsCore.remote.useFreePort", { port: serverError.suggestedPort })}
										</button>
									) : null}
									<button type="button" className="linear-btn" disabled={applyingPort} onClick={() => void applyPort(appSettings.remotePort)}>
										{t("settingsCore.remote.retryStart")}
									</button>
								</div>
							</div>
						) : !serving ? (
							<p className="settings-remote-desc">{t("settingsCore.remote.starting")}</p>
						) : (
							<>
								<div className="settings-remote-step">
									<span className="settings-remote-step__label">{t("settingsCore.remote.routeLabel")}</span>
									<div className="settings-remote-tabs" role="tablist" aria-label={t("settingsCore.remote.routeLabel")}>
										{routes.map((item) => (
											<button
												key={item.id}
												type="button"
												role="tab"
												aria-selected={route === item.id}
												className={`settings-remote-tab${route === item.id ? " is-active" : ""}`}
												onClick={() => setPickedRoute(item.id)}
											>
												{item.label}
											</button>
										))}
									</div>
									<div className="settings-remote-pane" data-route={route}>
										{route === "lan" ? lanPane : route === "tailscale" ? tailscalePane : internetPane}
										{routeAddress !== null ? (
											<div className="settings-remote-field">
												<code className="settings-remote-url-line" data-testid="remote-route-address" title={routeAddress}>
													{routeAddress}
												</code>
												{copyButton(routeAddress, t("settingsCore.remote.copyAddress"), t("settingsCore.remote.addressCopied"))}
											</div>
										) : null}
									</div>
								</div>

								<div className="settings-remote-step">
									<span className="settings-remote-step__label">{t("settingsCore.remote.pairTitle")}</span>
									<p className="settings-remote-sub">{t("settingsCore.remote.pairHint")}</p>
									{spacedCode === null ? (
										<div className="settings-remote-actions">
											<button type="button" className="linear-btn settings-btn-primary" onClick={() => void handleStartPairing()}>
												{t("settingsCore.remote.pairStart")}
											</button>
										</div>
									) : (
										<div className="settings-remote-pair-box" role="status">
											{pairLink !== null ? (
												<QrCode value={pairLink} label={t("settingsCore.remote.pairQrLabel", { code: activeCode?.code ?? "" })} size={136} />
											) : null}
											<div className="settings-remote-pair-meta">
												<div className="settings-remote-code" data-testid="remote-pairing-code">
													{spacedCode}
												</div>
												<div className="settings-remote-expiry">
													{countdown ? t("settingsCore.remote.pairExpires", { time: countdown }) : t("settingsCore.remote.pairExpired")}
												</div>
												{pairLink === null ? <p className="settings-remote-sub">{t("settingsCore.remote.pairNoAddress")}</p> : null}
												<div className="settings-remote-actions">
													{pairLink !== null
														? copyButton(pairLink, t("settingsCore.remote.pairLinkCopy"), t("settingsCore.remote.pairLinkCopied"))
														: null}
													<button type="button" className="linear-btn" onClick={() => void handleStartPairing()}>
														<RefreshCw size={13} aria-hidden="true" />
														<span>{t("settingsCore.remote.pairNewCode")}</span>
													</button>
												</div>
											</div>
										</div>
									)}
								</div>
							</>
						)}

						<details className="settings-remote-details">
							<summary>{t("settingsCore.remote.details")}</summary>
							<div className="settings-remote-detail">
								<span className="settings-remote-detail__name">{t("settingsCore.remote.address")}</span>
								<span className="settings-remote-sub">{t("settingsCore.remote.addressHint")}</span>
								<div className="settings-remote-field">
									<input
										type="text"
										className="settings-source-desc__input min-w-0"
										aria-label={t("settingsCore.remote.address")}
										value={browserAddress ?? t("settingsCore.remote.stopped")}
										readOnly
										onClick={(event) => event.currentTarget.select()}
									/>
									{browserAddress !== null ? (
										copyButton(browserAddress, t("settingsCore.remote.copyAddress"), t("settingsCore.remote.addressCopied"))
									) : (
										<button type="button" className="linear-btn shrink-0" disabled>
											{t("settingsCore.remote.copyAddress")}
										</button>
									)}
								</div>
							</div>
							<div className="settings-remote-detail">
								<span className="settings-remote-detail__name">{t("settingsCore.remote.port")}</span>
								<span className="settings-remote-sub">{t("settingsCore.remote.portHint")}</span>
								<div className="settings-remote-field">
									<input
										type="number"
										className="settings-source-desc__input settings-remote-port"
										aria-label={t("settingsCore.remote.port")}
										min={0}
										max={65535}
										step={1}
										required
										value={remotePort}
										onChange={(event) => setRemotePort(event.currentTarget.value)}
										onBlur={(event) => {
											const input = event.currentTarget;
											if (input.reportValidity() && input.valueAsNumber !== appSettings.remotePort) void applyPort(input.valueAsNumber);
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												event.currentTarget.blur();
											}
											if (event.key === "Escape") {
												event.preventDefault();
												setRemotePort(String(appSettings.remotePort));
											}
										}}
									/>
								</div>
							</div>
						</details>
					</div>
				</Section>
			) : null}

			{enabled ? (
				<Section title={t("settingsCore.remote.devicesTitle")}>
					<div className="settings-remote-devices">
						{devices.length > 0 ? (
							<div className="settings-remote-devices__head">
								<button type="button" className="linear-btn settings-remote-revoke-btn" onClick={() => void handleRevokeAll()}>
									{confirmRevokeAll ? t("settingsCore.remote.devicesRevokeAllConfirm") : t("settingsCore.remote.devicesRevokeAll")}
								</button>
							</div>
						) : null}
						{devices.length === 0 ? (
							<p className="settings-remote-empty">{t("settingsCore.remote.devicesEmpty")}</p>
						) : (
							<ul className="settings-remote-device-list">
								{devices.map((device) => (
									<li key={device.id} className="settings-remote-device-row">
										{renaming?.id === device.id ? (
											<form
												className="settings-remote-rename-form"
												onSubmit={(event) => {
													event.preventDefault();
													void handleSaveRename();
												}}
											>
												<input
													type="text"
													className="settings-source-desc__input"
													aria-label={t("settingsCore.remote.deviceNameInput")}
													maxLength={48}
													value={renaming.label}
													onChange={(event) => setRenaming({ id: device.id, label: event.currentTarget.value })}
													autoFocus
												/>
												<button type="submit" className="linear-btn" aria-label={t("settingsCore.remote.deviceSave")}>
													<Check size={13} aria-hidden="true" />
												</button>
												<button type="button" className="linear-btn" aria-label={t("settingsCore.remote.deviceCancel")} onClick={() => setRenaming(null)}>
													<X size={13} aria-hidden="true" />
												</button>
											</form>
										) : (
											<>
												<div className="settings-remote-device-info">
													<div className="settings-remote-device-name">
														<span>{device.label}</span>
														{device.current ? <span className="settings-remote-device-badge">{t("settingsCore.remote.deviceCurrent")}</span> : null}
													</div>
													<div className="settings-remote-device-seen">
														{t("settingsCore.remote.deviceLastSeen", {
															when: formatRelativeSeen(device.lastSeenAt, {
																never: t("settingsCore.remote.deviceNever"),
																justNow: t("settingsCore.remote.deviceJustNow"),
																minutesAgo: (count) => t("settingsCore.remote.deviceMinutesAgo", { count }),
																hoursAgo: (count) => t("settingsCore.remote.deviceHoursAgo", { count }),
															}),
														})}
													</div>
												</div>
												<div className="settings-remote-device-actions">
													<button
														type="button"
														className="linear-btn"
														aria-label={t("settingsCore.remote.deviceRename", { name: device.label })}
														onClick={() => setRenaming({ id: device.id, label: device.label })}
													>
														<Pencil size={12} aria-hidden="true" />
													</button>
													<button type="button" className="linear-btn settings-remote-revoke-btn" onClick={() => void handleRevokeDevice(device.id)}>
														<Trash2 size={12} aria-hidden="true" />
														<span>{confirmRevokeId === device.id ? t("settingsCore.remote.deviceRevokeConfirm") : t("settingsCore.remote.deviceRevoke")}</span>
													</button>
												</div>
											</>
										)}
									</li>
								))}
							</ul>
						)}
					</div>
				</Section>
			) : null}
		</>
	);
}
