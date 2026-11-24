/**
 * Settings → 웹 검색 / 문서 읽기 / 중복 파일 정리 (검색 범위는 `ScopePage`).
 *
 * Config-backed pages of the prototype IA. Every toggle/select writes a leaf
 * through the serialized `useConfigWriter` (webSearch/dupey/`fetch` keep the
 * upstream `false`/`enabled:true` block semantics), lists write their whole
 * array (arrays are replaced, never merged), and the document languages
 * reuse `LanguageSettings`.
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import type { AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { DUPEY_SCAN_INTERVALS, WEBSEARCH_PROVIDERS } from "../../../../shared/settings-options";
import { LanguageSettings } from "./LanguageSettings";
import { PlainRow, SettingsPageHead } from "./SettingsKit";
import { SelectField } from "./SelectField";
import { asRecord, boolOf, getAt, stringOf, useConfigWriter } from "./configSupport";
import { Switch } from "../primitives/Switch";

/* ================================================================== Web == */

export function WebPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { run, error } = useConfigWriter(onSaved);
	const web = getAt(snapshot.config, ["webSearch"]);
	const webObject = asRecord(web) ?? {};
	const webEnabled = web === undefined ? true : web !== false && boolOf(webObject.enabled) !== false;
	const provider = stringOf(webObject.provider);
	const rawFetch = webObject.fetch;
	const fetchObject = asRecord(rawFetch) ?? {};
	const fetchEnabled = rawFetch === undefined ? true : rawFetch !== false && boolOf(fetchObject.enabled) !== false;

	return (
		<>
			<SettingsPageHead title={t("settingsSources.web.title")} description={t("settingsSources.web.desc")} />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			{/* Figma 412:11269: three plain 64px rows under the head. */}
			<div className="settings-plain">
				<PlainRow name={t("settingsSources.web.useSection")} hint={t("settingsSources.web.useHint")}>
					<Switch
						checked={webEnabled}
						ariaLabel={t("settingsSources.web.useSection")}
						onChange={() => {
							if (webEnabled) void run([{ path: ["webSearch"], value: { ...webObject, enabled: false } }]);
							else void run([{ path: ["webSearch"], value: { ...(asRecord(web) ?? {}), enabled: true } }]);
						}}
					/>
				</PlainRow>
				<PlainRow name={t("settingsSources.web.providerName")} hint={webEnabled ? t("settingsSources.web.providerHintOn") : t("settingsSources.web.providerHintOff")}>
					<SelectField
						className="linear-select settings-plain-select"
						aria-label={t("settingsSources.web.providerName")}
						disabled={!webEnabled}
						value={provider}
						options={[{ value: "", label: t("settingsSources.web.auto") }, ...WEBSEARCH_PROVIDERS.map((item) => ({ value: item.id, label: item.label }))]}
						onValueChange={(value) => void run([value.length === 0 ? { path: ["webSearch", "provider"], remove: true } : { path: ["webSearch", "provider"], value }])}
					/>
				</PlainRow>
				<PlainRow name={t("settingsSources.web.fetchName")} hint={webEnabled ? t("settingsSources.web.fetchHintOn") : t("settingsSources.web.fetchHintOff")}>
					<Switch
						checked={webEnabled && fetchEnabled}
						disabled={!webEnabled}
						ariaLabel={t("settingsSources.web.fetchName")}
						onChange={() => {
							if (fetchEnabled) void run([{ path: ["webSearch", "fetch"], value: { ...fetchObject, enabled: false } }]);
							else void run([{ path: ["webSearch", "fetch"], value: { ...(asRecord(rawFetch) ?? {}), enabled: true } }]);
						}}
					/>
				</PlainRow>
			</div>
		</>
	);
}

/* ========================================================== Duplicates == */


export function DuplicatesPage({
	snapshot,
	onSaved,
	dupeyInterval,
	onDupeyInterval,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly dupeyInterval: number;
	readonly onDupeyInterval: (minutes: number) => void;
}): ReactElement {
	const { t } = useTranslation();
	const { run, error } = useConfigWriter(onSaved);
	const excludeExact = boolOf(getAt(snapshot.config, ["excludeExactDuplicates"])) ?? true;
	const dupey = getAt(snapshot.config, ["dupey"]);
	const dupeyObject = asRecord(dupey) ?? {};
	const dupeyEnabled = dupey === undefined ? true : dupey !== false && boolOf(dupeyObject.enabled) !== false;
	return (
		<>
			<SettingsPageHead title={t("settingsSources.duplicates.title")} description={t("settingsSources.duplicates.desc")} />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			{/* Figma 403:8746: three plain rows, no section heading and no rules between them. */}
			<div className="settings-plain">
				<PlainRow name={t("settingsSources.duplicates.exactName")} hint={t("settingsSources.duplicates.exactHint")}>
					<Switch checked={excludeExact} ariaLabel={t("settingsSources.duplicates.exactName")} onChange={() => void run([{ path: ["excludeExactDuplicates"], value: !excludeExact }])} />
				</PlainRow>
				<PlainRow name={t("settingsSources.duplicates.versionsName")} hint={t("settingsSources.duplicates.versionsHint")}>
					<Switch
						checked={dupeyEnabled}
						ariaLabel={t("settingsSources.duplicates.versionsName")}
						onChange={() => {
							if (dupeyEnabled) void run([{ path: ["dupey"], value: { ...dupeyObject, enabled: false } }]);
							else void run([{ path: ["dupey"], value: { ...(asRecord(dupey) ?? {}), enabled: true } }]);
						}}
					/>
				</PlainRow>
				<PlainRow name={t("settingsSources.duplicates.intervalName")} hint={t("settingsSources.duplicates.intervalHint")}>
					<SelectField
						className="linear-select settings-plain-select"
						aria-label={t("settingsSources.duplicates.intervalName")}
						value={String(dupeyInterval)}
						options={DUPEY_SCAN_INTERVALS.map((item) => ({ value: String(item.value), label: t(item.label) }))}
						onValueChange={(value) => onDupeyInterval(Number(value))}
					/>
				</PlainRow>
			</div>
		</>
	);
}
