/**
 * Settings → 일반.
 *
 * App-level preferences write through `window.autorag.settings.set` (the same
 * store the Finder reads), and the document-language list edits the shared
 * AutoRAG config's global `languages` array through `LanguageSettings` (leaf
 * `configPatch` writes, so unknown config keys survive). Remote access uses
 * that same settings path: the status bridge observes the server, never starts it.
 */

import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AppUpdateSnapshot } from "../../../../shared/update-contract";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import type { RemoteAccessStatus } from "../../../../shared/remote-contract";
import { isAppLanguage } from "../../../../shared/language-contract";
import { LanguageSettings } from "./LanguageSettings";
import { Note, Row, Section, SettingsPageHead } from "./SettingsKit";
import { Switch } from "../primitives/Switch";
import { hostPlatform } from "../../lib/shortcuts";

const autorag = window.autorag;

export function GeneralPage({
	appSettings,
	onAppSettingsChanged,
	onSettingsError,
	snapshot,
	onSaved,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly onSettingsError: (message: string) => void;
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (snapshot: AutoRagConfigSnapshot) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [remoteStatus, setRemoteStatus] = useState<RemoteAccessStatus | null>(null);
	const [remotePort, setRemotePort] = useState(String(appSettings.remotePort));
	const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
	const canManageRemote = typeof autorag.remote?.status === "function";
	useEffect(() => setRemotePort(String(appSettings.remotePort)), [appSettings.remotePort]);
	useEffect(() => {
		if (!canManageRemote) return;
		let live = true;
		setRemoteStatus(null);
		const refreshStatus = (): void => {
			void autorag.remote.status().then(
				(status) => {
					if (live) setRemoteStatus(status);
				},
				(cause: unknown) => {
					if (live) onSettingsError(t("settingsCore.general.remoteStatusError", { error: cause instanceof Error ? cause.message : String(cause) }));
				},
			);
		};
		refreshStatus();
		window.addEventListener("focus", refreshStatus);
		return () => {
			live = false;
			window.removeEventListener("focus", refreshStatus);
		};
	}, [appSettings.remoteAccess, appSettings.remotePort, canManageRemote, onSettingsError, t]);
	const remoteAddress = remoteStatus?.serving === true ? remoteStatus.origin : null;

	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		try {
			onAppSettingsChanged(await autorag.settings.set(patch));
		} catch (cause) {
			// A rejected change (the right-click menu could not be written) leaves the stored setting as it was.
			onSettingsError(t(patch.remoteAccess !== undefined || patch.remotePort !== undefined ? "settingsCore.general.remoteSettingsError" : "settingsCore.general.osMenuError", { error: cause instanceof Error ? cause.message : String(cause) }));
		}
	}
	async function copyRemoteAddress(): Promise<void> {
		if (remoteAddress === null) return;
		try {
			await navigator.clipboard.writeText(remoteAddress);
			setCopiedAddress(remoteAddress);
		} catch {
			onSettingsError(t("settingsCore.general.remoteCopyError"));
		}
	}
	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.general")} description={t("settingsCore.general.description")} />
			<Section title={t("settingsCore.general.screenTitle")}>
				<Row name={t("settingsCore.general.appearanceName")} hint={t("settingsCore.general.appearanceHint")}>
					<select className="linear-select" aria-label={t("settingsCore.general.appearanceName")} value={appSettings.appearance} onChange={(event) => {
						const appearance = event.currentTarget.value;
						if (appearance === "light" || appearance === "dark") void setApp({ appearance });
					}}>
						<option value="light">{t("settingsCore.general.appearanceLight")}</option>
						<option value="dark">{t("settingsCore.general.appearanceDark")}</option>
					</select>
				</Row>
				<Row name={t("settingsCore.general.appLanguage")} hint={t("settingsCore.general.appLanguageHint")}>
					<select className="linear-select" aria-label={t("settingsCore.general.appLanguage")} value={appSettings.language} onChange={(event) => {
						const language = event.currentTarget.value;
						if (isAppLanguage(language)) void setApp({ language });
					}}>
						<option value="ko">한국어</option>
						<option value="en">English</option>
						<option value="ja">日本語</option>
						<option value="zh">简体中文</option>
					</select>
				</Row>
			</Section>
			<Section title={t("settingsCore.general.finderTitle")} description={t("settingsCore.general.finderDesc")}>
				<Row name={t("settingsCore.general.showHiddenFiles")} hint={t("settingsCore.general.showHiddenFilesHint")}>
					<Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel={t("settingsCore.general.showHiddenFiles")} />
				</Row>
			</Section>
			{canManageRemote ? <Section title={t("settingsCore.general.remoteTitle")} description={t("settingsCore.general.remoteSecurityHint")}>
				<Row name={t("settingsCore.general.remoteAccess")} hint={t("settingsCore.general.remoteAccessHint")}>
					<Switch checked={appSettings.remoteAccess} onChange={() => void setApp({ remoteAccess: !appSettings.remoteAccess })} ariaLabel={t("settingsCore.general.remoteAccess")} />
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
					<button type="button" className="linear-btn shrink-0" disabled={remoteAddress === null} onClick={() => void copyRemoteAddress()}>
						{remoteAddress !== null && copiedAddress === remoteAddress ? t("settingsCore.general.remoteAddressCopied") : t("settingsCore.general.remoteCopyAddress")}
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
				</Row>
				<Note>{t("settingsCore.general.remoteLimitations")}</Note>
			</Section> : null}
			<Section title={t("settingsCore.general.launchTitle")}>
				<Row name={t("settingsCore.general.launchAtLogin")} hint={t("settingsCore.general.launchAtLoginHint")}>
					<Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel={t("settingsCore.general.launchAtLogin")} />
				</Row>
				{hostPlatform() === "darwin" || hostPlatform() === "win32" ? (
					<Row name={t("settingsCore.general.osMenu")} hint={t("settingsCore.general.osMenuHint")}>
						<Switch checked={appSettings.osMenuIntegration} onChange={() => void setApp({ osMenuIntegration: !appSettings.osMenuIntegration })} ariaLabel={t("settingsCore.general.osMenu")} />
					</Row>
				) : null}
				<Row name={t("settingsCore.general.autoUpdates")} hint={t("settingsCore.general.autoUpdatesHint")}>
					<Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel={t("settingsCore.general.autoUpdates")} />
				</Row>
				<AppUpdateRow />
			</Section>
			<Section title={t("settingsCore.general.privacyTitle")}>
				<Row name={t("settingsCore.general.errorReporting")} hint={t("settingsCore.general.errorReportingHint")}>
					<Switch checked={appSettings.errorReporting} onChange={() => void setApp({ errorReporting: !appSettings.errorReporting })} ariaLabel={t("settingsCore.general.errorReporting")} />
				</Row>
				<Row name={t("settingsCore.general.usageAnalytics")} hint={t("settingsCore.general.usageAnalyticsHint")}>
					<Switch checked={appSettings.usageAnalytics} onChange={() => void setApp({ usageAnalytics: !appSettings.usageAnalytics })} ariaLabel={t("settingsCore.general.usageAnalytics")} />
				</Row>
			</Section>
			<Section title={t("settingsCore.general.docLanguagesTitle")} description={t("settingsCore.general.docLanguagesDesc")}>
				<LanguageSettings snapshot={snapshot} path={["languages"]} name={t("settingsCore.general.docLanguagesTitle")} hint={t("settingsCore.general.docLanguagesHint")} onSaved={onSaved} fallback={["ko", "en"]} />
			</Section>
		</>
	);
}

/** "앱 업데이트": the running version, what the updater is doing, and the one action that fits. */
function AppUpdateRow(): ReactElement | null {
	const { t } = useTranslation();
	const bridge = autorag.appUpdate;
	const [update, setUpdate] = useState<AppUpdateSnapshot | null>(null);
	useEffect(() => {
		let live = true;
		void bridge.get().then((snapshot) => {
			if (live) setUpdate(snapshot);
		});
		const unsubscribe = bridge.onChange(setUpdate);
		return () => {
			live = false;
			unsubscribe();
		};
	}, [bridge]);
	if (update === null) return null;
	const { state, currentVersion } = update;
	let hint: string;
	switch (state.kind) {
		case "unsupported":
			hint = t("settingsCore.general.appUpdateUnsupported", { version: currentVersion });
			break;
		case "checking":
			hint = t("settingsCore.general.appUpdateChecking");
			break;
		case "available":
			hint = t(update.mode === "notify" ? "settingsCore.general.appUpdateAvailableManual" : "settingsCore.general.appUpdateAvailable", { version: state.version });
			break;
		case "downloading":
			hint = t("settingsCore.general.appUpdateDownloading", { version: state.version, percent: state.percent });
			break;
		case "ready":
			hint = t("settingsCore.general.appUpdateReady", { version: state.version });
			break;
		case "error":
			hint = t("settingsCore.general.appUpdateError", { message: state.message });
			break;
		case "idle":
			hint = t(state.checkedAt === null ? "settingsCore.general.appUpdateCurrent" : "settingsCore.general.appUpdateLatest", { version: currentVersion });
			break;
	}
	const action =
		state.kind === "ready" ? (
			<button type="button" className="linear-btn settings-btn-primary" onClick={() => void bridge.install()}>
				{t("settingsCore.general.appUpdateRestart")}
			</button>
		) : state.kind === "available" ? (
			<button type="button" className="linear-btn settings-btn-primary" onClick={() => void bridge.download()}>
				{t(update.mode === "notify" ? "settingsCore.general.appUpdateDownloadInstaller" : "settingsCore.general.appUpdateDownload")}
			</button>
		) : state.kind === "unsupported" ? null : (
			<button type="button" className="linear-btn" disabled={state.kind === "checking" || state.kind === "downloading"} onClick={() => void bridge.check()}>
				{t("settingsCore.general.appUpdateCheck")}
			</button>
		);
	return (
		<Row name={t("settingsCore.general.appUpdate")} hint={hint}>
			{action}
		</Row>
	);
}
