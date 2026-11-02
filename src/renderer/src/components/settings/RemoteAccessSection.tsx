/**
 * Settings → General → Remote Access hub, inspired by Ovis (`devswha/ovis`).
 *
 * Preserves the baseline Enable switch, Browser Address field, Copy Address
 * button, and Port field identically when stopped (so existing layouts and
 * visual parity shots do not move a single pixel). When Remote Access is active
 * (or Paired Devices exist), reveals:
 * - Connection method tabs: Pairing Code (+ QR & LAN/Tailscale/Tunnel target picker),
 *   Tailscale (`tailscale serve` HTTPS & direct IP), and Cloudflare Quick Tunnel
 *   (one-click public HTTPS with zero VPN/router setup).
 * - Paired Devices registry: live enrolled browsers, current-device badge,
 *   inline rename, two-step per-device revoke, and Revoke All.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import type {
	RemoteAccessStatus,
	RemotePairedDevice,
	RemotePairingCode,
} from "../../../../shared/remote-contract";
import type { AppSettings } from "../../../../shared/settings-contract";
import { QrCode } from "./QrCode";
import { Note, Row, Section, StatusDot } from "./SettingsKit";
import { Switch } from "../primitives/Switch";

type ConnectTab = "pair" | "tailscale" | "tunnel";

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
	const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
	const [copiedLink, setCopiedLink] = useState<string | null>(null);
	const [copiedCommand, setCopiedCommand] = useState(false);
	const [activeTab, setActiveTab] = useState<ConnectTab>("pair");
	const [localPairing, setLocalPairing] = useState<RemotePairingCode | null>(null);
	const [countdown, setCountdown] = useState<string>("");
	const [selectedTargetOrigin, setSelectedTargetOrigin] = useState<string>("");
	const [refreshingNet, setRefreshingNet] = useState(false);
	const [tunnelBusy, setTunnelBusy] = useState(false);
	const [renaming, setRenaming] = useState<{ readonly id: string; readonly label: string } | null>(null);
	const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
	const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

	useEffect(() => {
		setRemotePort(String(appSettings.remotePort));
	}, [appSettings.remotePort]);

	const refreshStatus = useCallback((): void => {
		if (!canManageRemote) return;
		void remoteBridge.status().then(
			(status) => {
				setRemoteStatus(status);
				if (status.pairing !== undefined) setLocalPairing(status.pairing);
			},
			(cause: unknown) => {
				onSettingsError(
					t("settingsCore.general.remoteStatusError", {
						error: cause instanceof Error ? cause.message : String(cause),
					}),
				);
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
			const mins = Math.floor(ms / 60_000);
			const secs = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
			setCountdown(`${mins}:${secs}`);
		};
		tick();
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [activeCode]);

	const candidateOrigins = useMemo(() => {
		if (remoteStatus?.serving !== true) return [];
		const list: string[] = [];
		const add = (value: string | null | undefined): void => {
			if (!value) return;
			const normalized = value.replace(/\/$/, "");
			if (!list.includes(normalized)) list.push(normalized);
		};
		add(remoteStatus.tunnel?.state === "online" ? remoteStatus.tunnel.url : null);
		add(remoteStatus.tailscale?.servingUrl);
		if (remoteStatus.tailscale?.state === "running" && remoteStatus.tailscale.tailnetIp && remoteStatus.port > 0) {
			add(`http://${remoteStatus.tailscale.tailnetIp}:${remoteStatus.port}`);
		}
		for (const lan of remoteStatus.lanOrigins ?? []) add(lan);
		if (isRemoteClient && typeof window !== "undefined") add(window.location.origin);
		add(remoteStatus.baseOrigin ?? (remoteStatus.origin ? new URL(remoteStatus.origin).origin : null));
		return list;
	}, [isRemoteClient, remoteStatus]);

	const effectiveTargetOrigin =
		selectedTargetOrigin && candidateOrigins.includes(selectedTargetOrigin)
			? selectedTargetOrigin
			: (candidateOrigins[0] ?? "");

	if (!canManageRemote) return null;

	const serving = remoteStatus?.serving === true;
	const remoteAddress = serving ? remoteStatus.origin : null;
	const devices: readonly RemotePairedDevice[] = remoteStatus?.devices ?? [];
	const tailscale = remoteStatus?.tailscale;
	const tunnel = remoteStatus?.tunnel;

	const copyTextValue = async (text: string, onDone: () => void): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			onDone();
		} catch {
			onSettingsError(t("settingsCore.general.remoteCopyError"));
		}
	};

	const handleStartPairing = async (): Promise<void> => {
		if (typeof remoteBridge.startPairing !== "function") return;
		try {
			const code = await remoteBridge.startPairing();
			setLocalPairing(code);
		} catch (cause) {
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const handleRefreshNetwork = async (): Promise<void> => {
		if (typeof remoteBridge.refreshNetwork !== "function") return;
		setRefreshingNet(true);
		try {
			setRemoteStatus(await remoteBridge.refreshNetwork());
		} catch (cause) {
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRefreshingNet(false);
		}
	};

	const handleToggleTunnel = async (start: boolean): Promise<void> => {
		const fn = start ? remoteBridge.startTunnel : remoteBridge.stopTunnel;
		if (typeof fn !== "function") return;
		setTunnelBusy(true);
		try {
			const next = await fn();
			setRemoteStatus(next);
		} catch (cause) {
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setTunnelBusy(false);
		}
	};

	const handleSaveRename = async (): Promise<void> => {
		if (renaming === null || typeof remoteBridge.renameDevice !== "function") return;
		try {
			await remoteBridge.renameDevice(renaming.id, renaming.label);
			setRenaming(null);
			refreshStatus();
		} catch (cause) {
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const handleRevokeDevice = async (id: string): Promise<void> => {
		if (confirmRevokeId !== id) {
			setConfirmRevokeId(id);
			window.setTimeout(() => setConfirmRevokeId((prev) => (prev === id ? null : prev)), 4000);
			return;
		}
		setConfirmRevokeId(null);
		try {
			await remoteBridge.revokeDevice(id);
			refreshStatus();
		} catch (cause) {
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
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
			onSettingsError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const spacedCode = activeCode ? `${activeCode.code.slice(0, 3)} ${activeCode.code.slice(3)}` : null;
	const pairLink = activeCode && effectiveTargetOrigin ? `${effectiveTargetOrigin}/?pair=${activeCode.code}` : null;

	const viaLabel =
		remoteStatus?.via === "device"
			? t("settingsCore.general.remoteViaDevice")
			: remoteStatus?.via === "tailscale"
				? t("settingsCore.general.remoteViaTailscale")
				: remoteStatus?.via === "token"
					? t("settingsCore.general.remoteViaToken")
					: null;

	return (
		<Section title={t("settingsCore.general.remoteTitle")} description={t("settingsCore.general.remoteSecurityHint")}>
			<Row name={t("settingsCore.general.remoteAccess")} hint={t("settingsCore.general.remoteAccessHint")}>
				<Switch
					checked={appSettings.remoteAccess}
					onChange={() => void setApp({ remoteAccess: !appSettings.remoteAccess })}
					ariaLabel={t("settingsCore.general.remoteAccess")}
				/>
			</Row>
			<Row name={t("settingsCore.general.remoteAddress")} stack>
				<input
					type="text"
					className="settings-source-desc__input min-w-0"
					aria-label={t("settingsCore.general.remoteAddress")}
					value={remoteAddress ?? t("settingsCore.general.remoteStopped")}
					readOnly
					onClick={(event) => event.currentTarget.select()}
				/>
				<button
					type="button"
					className="linear-btn shrink-0"
					disabled={remoteAddress === null}
					onClick={() => {
						if (remoteAddress !== null) {
							void copyTextValue(remoteAddress, () => setCopiedAddress(remoteAddress));
						}
					}}
				>
					{remoteAddress !== null && copiedAddress === remoteAddress
						? t("settingsCore.general.remoteAddressCopied")
						: t("settingsCore.general.remoteCopyAddress")}
				</button>
			</Row>
			<Row name={t("settingsCore.general.remotePort")} hint={t("settingsCore.general.remotePortHint")}>
				<input
					type="number"
					className="settings-source-desc__input"
					aria-label={t("settingsCore.general.remotePort")}
					min={0}
					max={65535}
					step={1}
					required
					value={remotePort}
					onChange={(event) => setRemotePort(event.currentTarget.value)}
					onBlur={(event) => {
						const input = event.currentTarget;
						if (input.reportValidity() && input.valueAsNumber !== appSettings.remotePort) {
							void setApp({ remotePort: input.valueAsNumber });
						}
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
			</Row>

			{serving || devices.length > 0 ? (
				<div className="settings-remote-hub">
					{viaLabel !== null ? <p className="settings-remote-via">{viaLabel}</p> : null}

					{serving && typeof remoteBridge.startPairing === "function" ? (
						<div className="settings-remote-card">
							<div className="settings-remote-tabs" role="tablist" aria-label={t("settingsCore.general.remoteRouteGroup")}>
								<button
									type="button"
									role="tab"
									aria-selected={activeTab === "pair"}
									className={`settings-remote-tab${activeTab === "pair" ? " is-active" : ""}`}
									onClick={() => setActiveTab("pair")}
								>
									{t("settingsCore.general.remoteTabPair")}
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={activeTab === "tailscale"}
									className={`settings-remote-tab${activeTab === "tailscale" ? " is-active" : ""}`}
									onClick={() => setActiveTab("tailscale")}
								>
									{t("settingsCore.general.remoteTabTailscale")}
								</button>
								{!isRemoteClient ? (
									<button
										type="button"
										role="tab"
										aria-selected={activeTab === "tunnel"}
										className={`settings-remote-tab${activeTab === "tunnel" ? " is-active" : ""}`}
										onClick={() => setActiveTab("tunnel")}
									>
										{t("settingsCore.general.remoteTabTunnel")}
									</button>
								) : null}
							</div>

							{activeTab === "pair" ? (
								<div className="settings-remote-pane" data-route="pair">
									<p className="settings-remote-desc">{t("settingsCore.general.remotePairDesc")}</p>
									{candidateOrigins.length > 1 ? (
										<div className="settings-remote-origin-row">
											<label className="settings-remote-origin-label" htmlFor="remote-qr-origin">
												{t("settingsCore.general.remotePairBaseAddress")}
											</label>
											<select
												id="remote-qr-origin"
												className="linear-select settings-remote-origin-select"
												value={effectiveTargetOrigin}
												onChange={(e) => setSelectedTargetOrigin(e.currentTarget.value)}
											>
												{candidateOrigins.map((item) => (
													<option key={item} value={item}>
														{item}
													</option>
												))}
											</select>
										</div>
									) : null}
									{spacedCode === null ? (
										<div className="settings-remote-actions">
											<button
												type="button"
												className="linear-btn settings-btn-primary"
												onClick={() => void handleStartPairing()}
											>
												{t("settingsCore.general.remotePairStart")}
											</button>
										</div>
									) : (
										<div className="settings-remote-pair-box" role="status">
											{pairLink !== null ? (
												<QrCode
													value={pairLink}
													label={t("settingsCore.general.remotePairQrLabel", { code: activeCode?.code ?? "" })}
													size={136}
												/>
											) : null}
											<div className="settings-remote-pair-meta">
												<div className="settings-remote-code" data-testid="remote-pairing-code">
													{spacedCode}
												</div>
												<div className="settings-remote-expiry">
													{countdown
														? t("settingsCore.general.remotePairExpires", { time: countdown })
														: t("settingsCore.general.remotePairExpired")}
												</div>
												{pairLink !== null ? (
													<div className="settings-remote-url-line" title={pairLink}>
														{pairLink}
													</div>
												) : null}
												<div className="settings-remote-actions">
													{pairLink !== null ? (
														<button
															type="button"
															className="linear-btn"
															onClick={() => void copyTextValue(pairLink, () => setCopiedLink(pairLink))}
														>
															{copiedLink === pairLink
																? t("settingsCore.general.remotePairLinkCopied")
																: t("settingsCore.general.remotePairLinkCopy")}
														</button>
													) : null}
													<button type="button" className="linear-btn" onClick={() => void handleStartPairing()}>
														<RefreshCw size={13} aria-hidden="true" />
														<span>{t("settingsCore.general.remotePairNewCode")}</span>
													</button>
												</div>
											</div>
										</div>
									)}
								</div>
							) : null}

							{activeTab === "tailscale" ? (
								<div className="settings-remote-pane" data-route="tailscale">
									{tailscale?.state === "running" ? (
										<>
											{tailscale.servingUrl !== null ? (
												<div className="settings-remote-pair-box">
													<QrCode value={tailscale.servingUrl} label={`QR: ${tailscale.servingUrl}`} size={124} />
													<div className="settings-remote-pair-meta">
														<div className="settings-remote-status-line">
															<StatusDot tone="ok" />
															<span>{t("settingsCore.general.remoteTailscaleServing")}</span>
														</div>
														<div className="settings-remote-url-line">{tailscale.servingUrl}</div>
														<div className="settings-remote-actions">
															<button
																type="button"
																className="linear-btn"
																onClick={() =>
																	void copyTextValue(tailscale.servingUrl!, () => setCopiedLink(tailscale.servingUrl))
																}
															>
																{copiedLink === tailscale.servingUrl
																	? t("settingsCore.general.remoteAddressCopied")
																	: t("settingsCore.general.remoteCopyAddress")}
															</button>
														</div>
													</div>
												</div>
											) : tailscale.serveCommand !== null ? (
												<>
													<p className="settings-remote-desc">{t("settingsCore.general.remoteTailscaleCommandDesc")}</p>
													<div className="settings-remote-command">
														<code>{tailscale.serveCommand}</code>
														<button
															type="button"
															className="linear-btn shrink-0"
															onClick={() =>
																void copyTextValue(tailscale.serveCommand!, () => {
																	setCopiedCommand(true);
																	window.setTimeout(() => setCopiedCommand(false), 1600);
																})
															}
														>
															{copiedCommand
																? t("settingsCore.general.remoteCommandCopied")
																: t("settingsCore.general.remoteCopyCommand")}
														</button>
													</div>
												</>
											) : null}
											{tailscale.tailnetIp !== null && remoteStatus.port > 0 ? (
												<p className="settings-remote-sub">
													{t("settingsCore.general.remoteTailscaleDirectIp", {
														url: `http://${tailscale.tailnetIp}:${remoteStatus.port}`,
													})}
												</p>
											) : null}
										</>
									) : tailscale?.state === "stopped" ? (
										<p className="settings-remote-desc">{t("settingsCore.general.remoteTailscaleStopped")}</p>
									) : (
										<p className="settings-remote-desc">{t("settingsCore.general.remoteTailscaleMissing")}</p>
									)}
									<div className="settings-remote-actions">
										<button
											type="button"
											className="linear-btn"
											disabled={refreshingNet}
											onClick={() => void handleRefreshNetwork()}
										>
											<RefreshCw size={13} aria-hidden="true" />
											<span>{t("settingsCore.general.remoteTailscaleRefresh")}</span>
										</button>
									</div>
								</div>
							) : null}

							{activeTab === "tunnel" && !isRemoteClient ? (
								<div className="settings-remote-pane" data-route="tunnel">
									<div className="settings-remote-status-line">
										<StatusDot
											tone={
												tunnel?.state === "online"
													? "ok"
													: tunnel?.state === "starting"
														? "run"
														: tunnel?.state === "error"
															? "warn"
															: "off"
											}
										/>
										<span>{t("settingsCore.general.remoteTunnelTitle")}</span>
									</div>
									<p className="settings-remote-desc">
										{tunnel?.available === false
											? t("settingsCore.general.remoteTunnelMissing")
											: t("settingsCore.general.remoteTunnelDesc")}
									</p>
									{tunnel?.state === "online" && tunnel.url !== null ? (
										<div className="settings-remote-pair-box">
											<QrCode
												value={activeCode ? `${tunnel.url}/?pair=${activeCode.code}` : tunnel.url}
												label={`QR: ${tunnel.url}`}
												size={124}
											/>
											<div className="settings-remote-pair-meta">
												<div className="settings-remote-url-line" data-testid="remote-tunnel-url">
													{tunnel.url}
												</div>
												<div className="settings-remote-actions">
													<button
														type="button"
														className="linear-btn"
														onClick={() => void copyTextValue(tunnel.url!, () => setCopiedLink(tunnel.url))}
													>
														{copiedLink === tunnel.url
															? t("settingsCore.general.remoteAddressCopied")
															: t("settingsCore.general.remoteCopyAddress")}
													</button>
													<button
														type="button"
														className="linear-btn"
														disabled={tunnelBusy}
														onClick={() => void handleToggleTunnel(false)}
													>
														{t("settingsCore.general.remoteTunnelStop")}
													</button>
												</div>
											</div>
										</div>
									) : (
										<>
											{tunnel?.error ? <p className="settings-remote-error">{tunnel.error}</p> : null}
											<div className="settings-remote-actions">
												<button
													type="button"
													className="linear-btn settings-btn-primary"
													disabled={tunnel?.available === false || tunnelBusy || tunnel?.state === "starting"}
													onClick={() => void handleToggleTunnel(true)}
												>
													{tunnelBusy || tunnel?.state === "starting"
														? t("settingsCore.general.remoteTunnelStarting")
														: t("settingsCore.general.remoteTunnelStart")}
												</button>
											</div>
										</>
									)}
								</div>
							) : null}
						</div>
					) : null}

					<div className="settings-remote-devices">
						<div className="settings-remote-devices__head">
							<span className="settings-remote-devices__title">{t("settingsCore.general.remoteDevicesTitle")}</span>
							{devices.length > 0 ? (
								<button
									type="button"
									className="linear-btn settings-remote-revoke-btn"
									onClick={() => void handleRevokeAll()}
								>
									{confirmRevokeAll
										? t("settingsCore.general.remoteDevicesRevokeAllConfirm")
										: t("settingsCore.general.remoteDevicesRevokeAll")}
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
												onSubmit={(e) => {
													e.preventDefault();
													void handleSaveRename();
												}}
											>
												<input
													type="text"
													className="settings-source-desc__input"
													aria-label={t("settingsCore.general.remoteDeviceNameInput")}
													maxLength={48}
													value={renaming.label}
													onChange={(e) => setRenaming({ id: device.id, label: e.currentTarget.value })}
													autoFocus
												/>
												<button
													type="submit"
													className="linear-btn"
													aria-label={t("settingsCore.general.remoteDeviceSave")}
												>
													<Check size={13} aria-hidden="true" />
												</button>
												<button
													type="button"
													className="linear-btn"
													aria-label={t("settingsCore.general.remoteDeviceCancel")}
													onClick={() => setRenaming(null)}
												>
													<X size={13} aria-hidden="true" />
												</button>
											</form>
										) : (
											<>
												<div className="settings-remote-device-info">
													<div className="settings-remote-device-name">
														<span>{device.label}</span>
														{device.current ? (
															<span className="settings-remote-device-badge">
																{t("settingsCore.general.remoteDeviceCurrent")}
															</span>
														) : null}
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
													<button
														type="button"
														className="linear-btn settings-remote-revoke-btn"
														onClick={() => void handleRevokeDevice(device.id)}
													>
														<Trash2 size={12} aria-hidden="true" />
														<span>
															{confirmRevokeId === device.id
																? t("settingsCore.general.remoteDeviceRevokeConfirm")
																: t("settingsCore.general.remoteDeviceRevoke")}
														</span>
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

			<Note>{t("settingsCore.general.remoteLimitations")}</Note>
		</Section>
	);
}
