/**
 * Settings → 일반.
 *
 * App-level preferences write through `window.autorag.settings.set` (the same
 * store the Finder reads), and the document-language list edits the shared
 * AutoRAG config's global `languages` array through `LanguageSettings` (leaf
 * `configPatch` writes, so unknown config keys survive).
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { LanguageSettings } from "./LanguageSettings";
import { Row, Section, SettingsPageHead } from "./SettingsKit";
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
	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		try {
			onAppSettingsChanged(await autorag.settings.set(patch));
		} catch (cause) {
			// A rejected change (the right-click menu could not be written) leaves the stored setting as it was.
			onSettingsError(t("settingsCore.general.osMenuError", { error: cause instanceof Error ? cause.message : String(cause) }));
		}
	}
	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.general")} description={t("settingsCore.general.description")} />
			<Section title={t("settingsCore.general.screenTitle")}>
				<Row name={t("settingsCore.general.appearanceName")} hint={t("settingsCore.general.appearanceHint")}>
					<select className="linear-select" aria-label={t("settingsCore.general.appearanceName")} value={appSettings.appearance} onChange={(event) => void setApp({ appearance: event.target.value as AppSettings["appearance"] })}>
						<option value="light">{t("settingsCore.general.appearanceLight")}</option>
						<option value="dark">{t("settingsCore.general.appearanceDark")}</option>
					</select>
				</Row>
				<Row name={t("settingsCore.general.appLanguage")} hint={t("settingsCore.general.appLanguageHint")}>
					<select className="linear-select" aria-label={t("settingsCore.general.appLanguage")} value={appSettings.language} onChange={(event) => void setApp({ language: event.target.value as AppSettings["language"] })}>
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
			</Section>
			<Section title={t("settingsCore.general.privacyTitle")}>
				<Row name={t("settingsCore.general.telemetry")} hint={t("settingsCore.general.telemetryHint")}>
					<Switch checked={appSettings.telemetry} onChange={() => void setApp({ telemetry: !appSettings.telemetry })} ariaLabel={t("settingsCore.general.telemetry")} />
				</Row>
			</Section>
			<Section title={t("settingsCore.general.docLanguagesTitle")} description={t("settingsCore.general.docLanguagesDesc")}>
				<LanguageSettings snapshot={snapshot} path={["languages"]} name={t("settingsCore.general.docLanguagesTitle")} hint={t("settingsCore.general.docLanguagesHint")} onSaved={onSaved} fallback={["ko", "en"]} />
			</Section>
		</>
	);
}
