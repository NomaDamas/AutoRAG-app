/**
 * Settings → 일반.
 *
 * App-level preferences write through `window.autorag.settings.set` (the same
 * store the Finder reads). The document languages live on 문서 읽기 and remote
 * access on its own page (`RemoteAccessPage`).
 */

import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AppUpdateSnapshot } from "../../../../shared/update-contract";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { isAppLanguage } from "../../../../shared/language-contract";
import { QuickSearchSettingsSection } from "./QuickSearchSettings";
import { PlainDivider, PlainRow, PlainSection, SettingsPageHead } from "./SettingsKit";
import { SelectField } from "./SelectField";
import { Switch } from "../primitives/Switch";
import { hostPlatform } from "../../lib/shortcuts";

/** Each interface language in its own name, so it can be found whatever language the app is in. */
const APP_LANGUAGE_OPTIONS = [
	{ value: "ko", label: "한국어" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "zh", label: "简体中文" },
] as const;

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
	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		try {
			onAppSettingsChanged(await autorag.settings.set(patch));
		} catch (cause) {
			// A rejected change (the right-click menu could not be written) leaves the stored setting as it was.
			onSettingsError(t("settingsCore.general.osMenuError", { error: cause instanceof Error ? cause.message : String(cause) }));
		}
	}
	const quickSearch = typeof autorag.quickSearch?.status === "function";
	const osMenu = hostPlatform() === "darwin" || hostPlatform() === "win32";
	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.general")} description={t("settingsCore.general.description")} />
			{/* Figma 416:12228: 화면, 파일, 빠른 검색, 시작 및 업데이트, 개인정보; each a titled group of plain rows, ruled apart. */}
			<div className="plain-sections">
				<PlainSection title={t("settingsCore.general.screenTitle")} alignTop>
					<PlainRow name={t("settingsCore.general.appearanceName")} hint={t("settingsCore.general.appearanceHint")}>
						<SelectField className="linear-select settings-plain-select" aria-label={t("settingsCore.general.appearanceName")} value={appSettings.appearance} options={[{ value: "light", label: t("settingsCore.general.appearanceLight") }, { value: "dark", label: t("settingsCore.general.appearanceDark") }]} onValueChange={(appearance) => {
							if (appearance === "light" || appearance === "dark") void setApp({ appearance });
						}} />
					</PlainRow>
					<PlainRow name={t("settingsCore.general.appLanguage")} hint={t("settingsCore.general.appLanguageHint")}>
						<SelectField className="linear-select settings-plain-select" aria-label={t("settingsCore.general.appLanguage")} value={appSettings.language} options={APP_LANGUAGE_OPTIONS} onValueChange={(language) => {
							if (isAppLanguage(language)) void setApp({ language });
						}} />
					</PlainRow>
				</PlainSection>
				<PlainDivider />
				<PlainSection title={t("settingsCore.general.finderTitle")}>
					<PlainRow name={t("settingsCore.general.showHiddenFiles")} hint={t("settingsCore.general.showHiddenFilesHint")}>
						<Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel={t("settingsCore.general.showHiddenFiles")} />
					</PlainRow>
				</PlainSection>
				{quickSearch ? (
					<>
						<PlainDivider />
						<QuickSearchSettingsSection settings={appSettings.quickSearch} setApp={setApp} />
					</>
				) : null}
				<PlainDivider />
				<PlainSection title={t("settingsCore.general.launchTitle")}>
					<PlainRow name={t("settingsCore.general.launchAtLogin")} hint={t("settingsCore.general.launchAtLoginHint")}>
						<Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel={t("settingsCore.general.launchAtLogin")} />
					</PlainRow>
					{osMenu ? (
						<PlainRow name={t("settingsCore.general.osMenu")} hint={t("settingsCore.general.osMenuHint")}>
							<Switch checked={appSettings.osMenuIntegration} onChange={() => void setApp({ osMenuIntegration: !appSettings.osMenuIntegration })} ariaLabel={t("settingsCore.general.osMenu")} />
						</PlainRow>
					) : null}
					<PlainRow name={t("settingsCore.general.autoUpdates")} hint={t("settingsCore.general.autoUpdatesHint")}>
						<Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel={t("settingsCore.general.autoUpdates")} />
					</PlainRow>
					<AppUpdateRow />
				</PlainSection>
				<PlainDivider />
				<PlainSection title={t("settingsCore.general.privacyTitle")}>
					<PlainRow name={t("settingsCore.general.errorReporting")} hint={t("settingsCore.general.errorReportingHint")}>
						<Switch checked={appSettings.errorReporting} onChange={() => void setApp({ errorReporting: !appSettings.errorReporting })} ariaLabel={t("settingsCore.general.errorReporting")} />
					</PlainRow>
					<PlainRow name={t("settingsCore.general.usageAnalytics")} hint={t("settingsCore.general.usageAnalyticsHint")}>
						<Switch checked={appSettings.usageAnalytics} onChange={() => void setApp({ usageAnalytics: !appSettings.usageAnalytics })} ariaLabel={t("settingsCore.general.usageAnalytics")} />
					</PlainRow>
				</PlainSection>
			</div>
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
		<PlainRow name={t("settingsCore.general.appUpdate")} hint={hint}>
			{action}
		</PlainRow>
	);
}
