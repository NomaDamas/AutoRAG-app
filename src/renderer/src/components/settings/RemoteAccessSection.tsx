/**
 * Settings → General → Remote Access, inspired by Ovis (`devswha/ovis`).
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
import { Row, Section, StatusDot } from "./SettingsKit";
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

export function RemoteAccessSection({
	appSettings,
	setApp,
	onSettingsError,
}: {
	readonly appSettings: AppSettings;
	readonly setApp: (patch: Partial<AppSettings>) => Promise<void>;
	readonly onSettingsError: (message: string) => void;
}): ReactElement | null {
	const { t } = useTranslation();
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
				onSettingsError(t("settingsCore.general.remoteStatusError", { error: cause instanceof Error ? cause.message : String(cause) }));
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

	if (!canManageRemote) return null;

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
			onSettingsError(t("settingsCore.general.remoteCopyError"));
		}
	};
	const reportError = (cause: unknown): void => onSettingsError(cause instanceof Error ? cause.message : String(cause));

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
	const saveDomain = (): void => {
		const trimmed = domainDraft.trim();
		const normalized = trimmed === "" ? "" : normalizeTunnelHostname(trimmed);
		if (normalized === null) {
			setDomainError(t("settingsCore.general.remoteDomainInvalid", { value: trimmed }));
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
			? t("settingsCore.general.remoteViaDevice")
			: remoteStatus?.via === "tailscale"
				? t("settingsCore.general.remoteViaTailscale")
				: remoteStatus?.via === "token"
					? t("settingsCore.general.remoteViaToken")
					: null;

	const tunnelError = (status: RemoteTunnelStatus): string | null => {
		switch (status.errorCode) {
			case null:
			case "missing_binary":
				return null;
			case "login_required":
				return t("settingsCore.general.remoteTunnelErrLogin");
			case "server_stopped":
				return t("settingsCore.general.remoteTunnelErrServer");
			case "timeout":
				return t("settingsCore.general.remoteTunnelErrTimeout");
			case "disconnected":
				return t("settingsCore.general.remoteTunnelErrDisconnected");
			case "exited":
				return t("settingsCore.general.remoteTunnelErrExited", { reason: status.error ?? "" });
			case "setup_failed":
				return t("settingsCore.general.remoteTunnelErrSetup", { reason: status.error ?? "" });
		}
	};

	const routes: readonly { readonly id: ConnectRoute; readonly label: string }[] = [
		{ id: "lan", label: t("settingsCore.general.remoteRouteLan") },
		{ id: "tailscale", label: t("settingsCore.general.remoteRouteTailscale") },
		...(showInternetRoute ? [{ id: "internet" as const, label: t("settingsCore.general.remoteRouteInternet") }] : []),
	];

	const copyButton = (value: string, label: string, copiedLabel: string): ReactElement => (
		<button type="button" className="linear-btn shrink-0" onClick={() => void copyText(value)}>
			{copied === value ? copiedLabel : label}
		</button>
	);

	const lanPane = (
		<>
			<p className="settings-remote-desc">{t("settingsCore.general.remoteRouteLanHint")}</p>
			{lanOrigins.length === 0 ? <p className="settings-remote-desc">{t("settingsCore.general.remoteLanMissing")}</p> : null}
			{lanOrigins.length > 1 ? (
				<select
					className="linear-select settings-remote-origin-select"
					aria-label={t("settingsCore.general.remoteRouteAddress")}
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

	const tailscalePane = (
		<>
			{tailscale?.state === "running" ? (
				tailscale.servingUrl !== null ? (
					<div className="settings-remote-status-line">
						<StatusDot tone="ok" />
						<span>{t("settingsCore.general.remoteTailscaleServing")}</span>
					</div>
				) : tailscale.serveCommand !== null ? (
					<>
						<p className="settings-remote-desc">{t("settingsCore.general.remoteTailscaleCommandDesc")}</p>
						<div className="settings-remote-command">
							<code>{tailscale.serveCommand}</code>
							{copyButton(tailscale.serveCommand, t("settingsCore.general.remoteCopyCommand"), t("settingsCore.general.remoteCommandCopied"))}
						</div>
					</>
				) : null
			) : (
				<p className="settings-remote-desc">
					{tailscale?.state === "stopped" ? t("settingsCore.general.remoteTailscaleStopped") : t("settingsCore.general.remoteTailscaleMissing")}
				</p>
			)}
			<div className="settings-remote-actions">
				<button type="button" className="linear-btn" disabled={refreshingNet} onClick={() => void handleRefreshNetwork()}>
					<RefreshCw size={13} aria-hidden="true" />
					<span>{t("settingsCore.general.remoteTailscaleRefresh")}</span>
				</button>
			</div>
		</>
	);

	const internetPane =
		tunnel === undefined ? null : (
			<>
				<div className="settings-remote-status-line">
					<StatusDot tone={tunnel.state === "online" ? "ok" : tunnel.state === "starting" ? "run" : tunnel.state === "error" ? "warn" : "off"} />
					<span>
						{tunnel.mode === "custom"
							? t("settingsCore.general.remoteTunnelCustomTitle", { hostname: tunnel.hostname ?? "" })
							: t("settingsCore.general.remoteTunnelQuickTitle")}
					</span>
				</div>
				<p className="settings-remote-desc">
					{!tunnel.available
						? t("settingsCore.general.remoteTunnelMissingBinary")
						: tunnel.mode === "custom"
							? t("settingsCore.general.remoteTunnelCustomHint")
							: t("settingsCore.general.remoteTunnelQuickHint")}
				</p>
				{tunnelError(tunnel) !== null ? <p className="settings-remote-error">{tunnelError(tunnel)}</p> : null}
				{isRemoteClient ? null : (
					<div className="settings-remote-actions">
						{tunnel.state === "online" ? (
							<button type="button" className="linear-btn" disabled={tunnelBusy} onClick={() => void handleTunnel("stop")}>
								{t("settingsCore.general.remoteTunnelStop")}
							</button>
						) : (
							<button
								type="button"
								className="linear-btn settings-btn-primary"
								disabled={!tunnel.available || tunnelBusy || tunnel.state === "starting" || (tunnel.mode === "custom" && !tunnel.loggedIn)}
								onClick={() => void handleTunnel("start")}
							>
								{tunnelBusy || tunnel.state === "starting" ? t("settingsCore.general.remoteTunnelStarting") : t("settingsCore.general.remoteTunnelStart")}
							</button>
						)}
					</div>
				)}
				{isRemoteClient || !tunnel.available ? null : (
					<details className="settings-remote-domain" open={appSettings.remoteTunnelHostname !== ""}>
						<summary>{t("settingsCore.general.remoteDomainToggle")}</summary>
						<p className="settings-remote-sub">{t("settingsCore.general.remoteDomainHint")}</p>
						<div className="settings-remote-field">
							<input
								type="text"
								className="settings-source-desc__input"
								aria-label={t("settingsCore.general.remoteDomainLabel")}
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
								<p className="settings-remote-sub">{t("settingsCore.general.remoteDomainLoggedIn")}</p>
							) : (
								<div className="settings-remote-actions">
									<button type="button" className="linear-btn" disabled={loggingIn} onClick={() => void handleTunnel("login")}>
										{t("settingsCore.general.remoteDomainLogin")}
									</button>
									<span className="settings-remote-sub">{t("settingsCore.general.remoteDomainLoginHint")}</span>
								</div>
							)
						) : null}
					</details>
				)}
			</>
		);

	return (
		<Section title={t("settingsCore.general.remoteTitle")} description={t("settingsCore.general.remoteSecurityHint")}>
			<Row name={t("settingsCore.general.remoteAccess")} hint={t("settingsCore.general.remoteAccessHint")}>
				<Switch checked={appSettings.remoteAccess} onChange={() => void setApp({ remoteAccess: !appSettings.remoteAccess })} ariaLabel={t("settingsCore.general.remoteAccess")} />
			</Row>

			{enabled ? (
				<div className="settings-remote-hub">
					{viaLabel !== null ? <p className="settings-remote-via">{viaLabel}</p> : null}
					<div className="settings-remote-card">
						<div className="settings-remote-card__head">
							<span className="settings-remote-card__title">{t("settingsCore.general.remoteConnectTitle")}</span>
							<span className="settings-remote-sub">{t("settingsCore.general.remoteConnectHint")}</span>
						</div>
						{!serving ? (
							<p className="settings-remote-desc">{t("settingsCore.general.remoteStarting")}</p>
						) : (
							<>
								<div className="settings-remote-step">
									<span className="settings-remote-step__label">{t("settingsCore.general.remoteRouteLabel")}</span>
									<div className="settings-remote-tabs" role="tablist" aria-label={t("settingsCore.general.remoteRouteLabel")}>
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
												{copyButton(routeAddress, t("settingsCore.general.remoteCopyAddress"), t("settingsCore.general.remoteAddressCopied"))}
											</div>
										) : null}
									</div>
								</div>

								<div className="settings-remote-step">
									<span className="settings-remote-step__label">{t("settingsCore.general.remotePairTitle")}</span>
									<p className="settings-remote-sub">{t("settingsCore.general.remotePairHint")}</p>
									{spacedCode === null ? (
										<div className="settings-remote-actions">
											<button type="button" className="linear-btn settings-btn-primary" onClick={() => void handleStartPairing()}>
												{t("settingsCore.general.remotePairStart")}
											</button>
										</div>
									) : (
										<div className="settings-remote-pair-box" role="status">
											{pairLink !== null ? (
												<QrCode value={pairLink} label={t("settingsCore.general.remotePairQrLabel", { code: activeCode?.code ?? "" })} size={136} />
											) : null}
											<div className="settings-remote-pair-meta">
												<div className="settings-remote-code" data-testid="remote-pairing-code">
													{spacedCode}
												</div>
												<div className="settings-remote-expiry">
													{countdown ? t("settingsCore.general.remotePairExpires", { time: countdown }) : t("settingsCore.general.remotePairExpired")}
												</div>
												{pairLink === null ? <p className="settings-remote-sub">{t("settingsCore.general.remotePairNoAddress")}</p> : null}
												<div className="settings-remote-actions">
													{pairLink !== null
														? copyButton(pairLink, t("settingsCore.general.remotePairLinkCopy"), t("settingsCore.general.remotePairLinkCopied"))
														: null}
													<button type="button" className="linear-btn" onClick={() => void handleStartPairing()}>
														<RefreshCw size={13} aria-hidden="true" />
														<span>{t("settingsCore.general.remotePairNewCode")}</span>
													</button>
												</div>
											</div>
										</div>
									)}
								</div>
							</>
						)}

						<details className="settings-remote-details">
							<summary>{t("settingsCore.general.remoteDetails")}</summary>
							<div className="settings-remote-detail">
								<span className="settings-remote-detail__name">{t("settingsCore.general.remoteAddress")}</span>
								<span className="settings-remote-sub">{t("settingsCore.general.remoteAddressHint")}</span>
								<div className="settings-remote-field">
									<input
										type="text"
										className="settings-source-desc__input min-w-0"
										aria-label={t("settingsCore.general.remoteAddress")}
										value={browserAddress ?? t("settingsCore.general.remoteStopped")}
										readOnly
										onClick={(event) => event.currentTarget.select()}
									/>
									{browserAddress !== null ? (
										copyButton(browserAddress, t("settingsCore.general.remoteCopyAddress"), t("settingsCore.general.remoteAddressCopied"))
									) : (
										<button type="button" className="linear-btn shrink-0" disabled>
											{t("settingsCore.general.remoteCopyAddress")}
										</button>
									)}
								</div>
							</div>
							<div className="settings-remote-detail">
								<span className="settings-remote-detail__name">{t("settingsCore.general.remotePort")}</span>
								<span className="settings-remote-sub">{t("settingsCore.general.remotePortHint")}</span>
								<div className="settings-remote-field">
									<input
										type="number"
										className="settings-source-desc__input settings-remote-port"
										aria-label={t("settingsCore.general.remotePort")}
										min={0}
										max={65535}
										step={1}
										required
										value={remotePort}
										onChange={(event) => setRemotePort(event.currentTarget.value)}
										onBlur={(event) => {
											const input = event.currentTarget;
											if (input.reportValidity() && input.valueAsNumber !== appSettings.remotePort) void setApp({ remotePort: input.valueAsNumber });
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

					<div className="settings-remote-devices">
						<div className="settings-remote-devices__head">
							<span className="settings-remote-devices__title">{t("settingsCore.general.remoteDevicesTitle")}</span>
							{devices.length > 0 ? (
								<button type="button" className="linear-btn settings-remote-revoke-btn" onClick={() => void handleRevokeAll()}>
									{confirmRevokeAll ? t("settingsCore.general.remoteDevicesRevokeAllConfirm") : t("settingsCore.general.remoteDevicesRevokeAll")}
								</button>
							) : null}
						</div>
						{devices.length === 0 ? (
							<p className="settings-remote-empty">{t("settingsCore.general.remoteDevicesEmpty")}</p>
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
													aria-label={t("settingsCore.general.remoteDeviceNameInput")}
													maxLength={48}
													value={renaming.label}
													onChange={(event) => setRenaming({ id: device.id, label: event.currentTarget.value })}
													autoFocus
												/>
												<button type="submit" className="linear-btn" aria-label={t("settingsCore.general.remoteDeviceSave")}>
													<Check size={13} aria-hidden="true" />
												</button>
												<button type="button" className="linear-btn" aria-label={t("settingsCore.general.remoteDeviceCancel")} onClick={() => setRenaming(null)}>
													<X size={13} aria-hidden="true" />
												</button>
											</form>
										) : (
											<>
												<div className="settings-remote-device-info">
													<div className="settings-remote-device-name">
														<span>{device.label}</span>
														{device.current ? <span className="settings-remote-device-badge">{t("settingsCore.general.remoteDeviceCurrent")}</span> : null}
													</div>
													<div className="settings-remote-device-seen">
														{t("settingsCore.general.remoteDeviceLastSeen", {
															when: formatRelativeSeen(device.lastSeenAt, {
																never: t("settingsCore.general.remoteDeviceNever"),
																justNow: t("settingsCore.general.remoteDeviceJustNow"),
																minutesAgo: (count) => t("settingsCore.general.remoteDeviceMinutesAgo", { count }),
																hoursAgo: (count) => t("settingsCore.general.remoteDeviceHoursAgo", { count }),
															}),
														})}
													</div>
												</div>
												<div className="settings-remote-device-actions">
													<button
														type="button"
														className="linear-btn"
														aria-label={t("settingsCore.general.remoteDeviceRename", { name: device.label })}
														onClick={() => setRenaming({ id: device.id, label: device.label })}
													>
														<Pencil size={12} aria-hidden="true" />
													</button>
													<button type="button" className="linear-btn settings-remote-revoke-btn" onClick={() => void handleRevokeDevice(device.id)}>
														<Trash2 size={12} aria-hidden="true" />
														<span>{confirmRevokeId === device.id ? t("settingsCore.general.remoteDeviceRevokeConfirm") : t("settingsCore.general.remoteDeviceRevoke")}</span>
													</button>
												</div>
											</>
										)}
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			) : null}
		</Section>
	);
}
