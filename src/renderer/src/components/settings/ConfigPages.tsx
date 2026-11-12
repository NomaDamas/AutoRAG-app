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
import { LanguageSettings } from "./LanguageSettings";
import { PlainRow, Row, Section, SettingsPageHead } from "./SettingsKit";
import { asRecord, boolOf, getAt, stringOf, useConfigWriter } from "./configSupport";
import { Switch } from "../primitives/Switch";

/** Web-search providers offered as the default provider in the web-search page. */
const WEBSEARCH_PROVIDERS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "parallel", label: "Parallel" },
	{ id: "duckduckgo", label: "DuckDuckGo" },
	{ id: "gemini", label: "Gemini" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "codex", label: "OpenAI" },
	{ id: "xai", label: "xAI" },
	{ id: "perplexity", label: "Perplexity" },
	{ id: "searxng", label: "SearXNG" },
	{ id: "startpage", label: "Startpage" },
	{ id: "ecosia", label: "Ecosia" },
	{ id: "google", label: "Google" },
	{ id: "mojeek", label: "Mojeek" },
	{ id: "public", label: "Public Web" },
];

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
			<Section title={t("settingsSources.web.useSection")}>
				<Row name={t("settingsSources.web.useSection")} hint={t("settingsSources.web.useHint")}>
					<Switch
						checked={webEnabled}
						ariaLabel={t("settingsSources.web.useSection")}
						onChange={() => {
							if (webEnabled) void run([{ path: ["webSearch"], value: { ...webObject, enabled: false } }]);
							else void run([{ path: ["webSearch"], value: { ...(asRecord(web) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
				<Row name={t("settingsSources.web.providerName")} hint={webEnabled ? t("settingsSources.web.providerHintOn") : t("settingsSources.web.providerHintOff")}>
					<select
						className="linear-select"
						aria-label={t("settingsSources.web.providerName")}
						disabled={!webEnabled}
						value={provider}
						onChange={(event) => {
							const value = event.target.value;
							void run([value.length === 0 ? { path: ["webSearch", "provider"], remove: true } : { path: ["webSearch", "provider"], value }]);
						}}
					>
						<option value="">{t("settingsSources.web.auto")}</option>
						{WEBSEARCH_PROVIDERS.map((item) => (
							<option key={item.id} value={item.id}>{item.label}</option>
						))}
					</select>
				</Row>
				<Row name={t("settingsSources.web.fetchName")} hint={webEnabled ? t("settingsSources.web.fetchHintOn") : t("settingsSources.web.fetchHintOff")}>
					<Switch
						checked={webEnabled && fetchEnabled}
						disabled={!webEnabled}
						ariaLabel={t("settingsSources.web.fetchName")}
						onChange={() => {
							if (fetchEnabled) void run([{ path: ["webSearch", "fetch"], value: { ...fetchObject, enabled: false } }]);
							else void run([{ path: ["webSearch", "fetch"], value: { ...(asRecord(rawFetch) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
			</Section>
		</>
	);
}

/* ============================================================= Reading == */

export function ReadingPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { error } = useConfigWriter(onSaved);
	return (
		<>
			<SettingsPageHead title={t("settingsSources.reading.title")} description={t("settingsSources.reading.desc")} />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<div className="settings-plain">
				<LanguageSettings snapshot={snapshot} path={["languages"]} name={t("settingsSources.fields.docLanguages")} hint={t("settingsSources.reading.langHint")} onSaved={onSaved} fallback={["ko", "en"]} />
			</div>
		</>
	);
}

/* ========================================================== Duplicates == */


const DUPEY_INTERVALS: readonly { readonly value: number; readonly label: LocaleKey }[] = [
	{ value: 15, label: "settingsSources.duplicates.intervals.min15" },
	{ value: 30, label: "settingsSources.duplicates.intervals.min30" },
	{ value: 60, label: "settingsSources.duplicates.intervals.hour1" },
	{ value: 180, label: "settingsSources.duplicates.intervals.hour3" },
	{ value: 360, label: "settingsSources.duplicates.intervals.hour6" },
	{ value: 720, label: "settingsSources.duplicates.intervals.hour12" },
	{ value: 1440, label: "settingsSources.duplicates.intervals.day1" },
];

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
					<select className="linear-select settings-plain-select" aria-label={t("settingsSources.duplicates.intervalName")} value={String(dupeyInterval)} onChange={(event) => onDupeyInterval(Number(event.target.value))}>
						{DUPEY_INTERVALS.map((item) => (
							<option key={item.value} value={item.value}>{t(item.label)}</option>
						))}
					</select>
				</PlainRow>
			</div>
		</>
	);
}
