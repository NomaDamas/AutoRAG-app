/**
 * Settings → 웹 검색 / 검색 범위 / 문서 읽기 / 중복 파일 정리.
 *
 * Config-backed pages of the prototype IA. Every toggle/select writes a leaf
 * through the serialized `useConfigWriter` (webSearch/dupey/`fetch` keep the
 * upstream `false`/`enabled:true` block semantics), lists write their whole
 * array (arrays are replaced, never merged), and the document languages
 * reuse `LanguageSettings`.
 */

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { Folder, Plus } from "lucide-react";
import { DEFAULT_CODE_FOLDER_NAMES, type AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { LanguageSettings } from "./LanguageSettings";
import { Chips, Note, PromptModal, Row, Section, SettingsPageHead } from "./SettingsKit";
import { asRecord, boolOf, getAt, listOf, stringOf, useConfigWriter } from "./configSupport";
import { Switch } from "../primitives/Switch";

/** Web-search providers offered as the default provider in the web-search page. */
const WEBSEARCH_PROVIDERS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "gemini", label: "Gemini" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "codex", label: "OpenAI" },
	{ id: "xai", label: "xAI" },
	{ id: "perplexity", label: "Perplexity" },
	{ id: "parallel", label: "Parallel" },
	{ id: "searxng", label: "SearXNG" },
	{ id: "startpage", label: "Startpage" },
	{ id: "duckduckgo", label: "DuckDuckGo" },
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

/* =============================================================== Scope == */

export function ScopePage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { run, error } = useConfigWriter(onSaved);
	const [addTarget, setAddTarget] = useState<"searchPaths" | "excludePaths" | null>(null);
	const searchPaths = listOf(getAt(snapshot.config, ["searchPaths"]));
	const excludePaths = listOf(getAt(snapshot.config, ["excludePaths"]));
	const fsearch = getAt(snapshot.config, ["fsearch"]);
	const watch = boolOf(getAt(snapshot.config, ["fsearch", "watch"])) ?? true;
	const appIndexing = asRecord(getAt(snapshot.config, ["appIndexing"])) ?? {};
	const storedCodeFolders = listOf(appIndexing.codeFolderNames);
	const codeFolderNames = (storedCodeFolders.length > 0 ? storedCodeFolders : DEFAULT_CODE_FOLDER_NAMES).filter((name) => !name.startsWith("."));

	function writeList(path: "searchPaths" | "excludePaths", next: readonly string[]): void {
		void run([next.length === 0 ? { path: [path], remove: true } : { path: [path], value: [...next] }]);
	}

	return (
		<>
			<SettingsPageHead title={t("settingsSources.scope.title")} description={t("settingsSources.scope.desc")} />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<Section title={t("settingsSources.scope.foldersTitle")} description={t("settingsSources.scope.foldersDesc")}>
				<Row name={t("settingsSources.scope.folderName")} hint={t("settingsSources.scope.folderHint")} stack>
					<div className="settings-path-list">
						{searchPaths.map((path, index) => (
							<div className="settings-path-line" key={`${path}-${index}`}>
								<Folder size={14} aria-hidden="true" focusable="false" />
								<span title={path}>{path}</span>
								<button type="button" className="linear-btn settings-btn-quiet" onClick={() => writeList("searchPaths", searchPaths.filter((_, i) => i !== index))}>{t("common.delete")}</button>
							</div>
						))}
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => setAddTarget("searchPaths")}>
							<Plus size={13} aria-hidden="true" focusable="false" />{t("settingsSources.scope.addFolder")}
						</button>
					</div>
				</Row>
				{searchPaths.length === 0 ? <Note>{t("settingsSources.scope.emptyFolderNote")}</Note> : null}
			</Section>
			<Section title={t("settingsSources.scope.excludeTitle")} description={t("settingsSources.scope.excludeDesc")}>
				<Note>{t("settingsSources.scope.excludeNote", { folders: codeFolderNames.join(", ") })}</Note>
				<Row name={t("settingsSources.scope.excludeList")} hint={t("settingsSources.scope.excludeListHint")} stack>
					<Chips
						items={excludePaths}
						onRemove={(index) => writeList("excludePaths", excludePaths.filter((_, i) => i !== index))}
						onAdd={() => setAddTarget("excludePaths")}
						addLabel={t("settingsSources.scope.addChip")}
					/>
				</Row>
			</Section>
			<Section title={t("settingsSources.scope.fileScopeTitle")}>
				<Row name={t("settingsSources.scope.autoWatch")} hint={fsearch === false ? t("settingsSources.scope.autoWatchHintOff") : t("settingsSources.scope.autoWatchHintOn")}>
					<Switch
						checked={watch}
						disabled={fsearch === false}
						ariaLabel={t("settingsSources.scope.autoWatch")}
						onChange={() => void run([{ path: ["fsearch", "watch"], value: !watch }])}
					/>
				</Row>
			</Section>
			{addTarget !== null ? (
				<PromptModal
					title={addTarget === "searchPaths" ? t("settingsSources.scope.addFolderTitle") : t("settingsSources.scope.addItemTitle")}
					description={addTarget === "searchPaths" ? t("settingsSources.scope.addFolderDesc") : t("settingsSources.scope.addItemDesc")}
					label={addTarget === "searchPaths" ? t("settingsSources.scope.folderPath") : t("settingsSources.scope.item")}
					placeholder={addTarget === "searchPaths" ? t("settingsSources.scope.addFolderPlaceholder") : t("settingsSources.scope.addItemPlaceholder")}
					confirmLabel={t("settingsSources.scope.confirmAdd")}
					onCancel={() => setAddTarget(null)}
					onSubmit={(value) => {
						writeList(addTarget, [...(addTarget === "searchPaths" ? searchPaths : excludePaths), value]);
						setAddTarget(null);
					}}
				/>
			) : null}
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
			<Section title={t("settingsSources.reading.sectionTitle")} description={t("settingsSources.reading.sectionDesc")}>
				<LanguageSettings snapshot={snapshot} path={["languages"]} name={t("settingsSources.fields.docLanguages")} hint={t("settingsSources.reading.langHint")} onSaved={onSaved} fallback={["ko", "en"]} />
			</Section>
		</>
	);
}

/* ========================================================== Duplicates == */

const DUPEY_INTERVALS: readonly { readonly value: number; readonly label: LocaleKey }[] = [
	{ value: 15, label: "settingsSources.cadence.min15" },
	{ value: 30, label: "settingsSources.cadence.min30" },
	{ value: 60, label: "settingsSources.cadence.hour1" },
	{ value: 180, label: "settingsSources.cadence.hour3" },
	{ value: 360, label: "settingsSources.cadence.hour6" },
	{ value: 720, label: "settingsSources.cadence.hour12" },
	{ value: 1440, label: "settingsSources.cadence.day1" },
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
			<Section title={t("settingsSources.duplicates.section")}>
				<Row name={t("settingsSources.duplicates.exactName")} hint={t("settingsSources.duplicates.exactHint")}>
					<Switch checked={excludeExact} ariaLabel={t("settingsSources.duplicates.exactName")} onChange={() => void run([{ path: ["excludeExactDuplicates"], value: !excludeExact }])} />
				</Row>
				<Row name={t("settingsSources.duplicates.versionsName")} hint={t("settingsSources.duplicates.versionsHint")}>
					<Switch
						checked={dupeyEnabled}
						ariaLabel={t("settingsSources.duplicates.versionsName")}
						onChange={() => {
							if (dupeyEnabled) void run([{ path: ["dupey"], value: { ...dupeyObject, enabled: false } }]);
							else void run([{ path: ["dupey"], value: { ...(asRecord(dupey) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
				<Row name={t("settingsSources.duplicates.intervalName")} hint={t("settingsSources.duplicates.intervalHint")}>
					<select className="linear-select" aria-label={t("settingsSources.duplicates.intervalName")} value={String(dupeyInterval)} onChange={(event) => onDupeyInterval(Number(event.target.value))}>
						{DUPEY_INTERVALS.map((item) => (
							<option key={item.value} value={item.value}>{t(item.label)}</option>
						))}
					</select>
				</Row>
			</Section>
		</>
	);
}
