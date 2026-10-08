import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { DatabaseIcon, GearIcon, GroupIcon, PencilIcon, SearchIcon, SparklesIcon } from "./icons";
import { DatasourceSettings, DATASOURCE_TEMPLATES } from "./settings/DatasourceSettings";
import { AppsSettings, DeepSettings, LightSettings } from "./settings/ConfigSections";
import { LanguageSettings } from "./settings/LanguageSettings";
import { ModelSettings, type ModelSettingsKind } from "./settings/ModelSettings";
import { Switch } from "./primitives/Switch";
import { hostPlatform } from "../lib/shortcuts";
import { settings } from "../settings-runtime";

const autorag = { settings };

type StaticSettingsCategory = "general" | "llm" | "embedding" | "reranker" | "sources" | "deep" | "light" | "apps";
export type SettingsCategory = StaticSettingsCategory | `source:${string}`;

type CategoryItem = {
	readonly id: StaticSettingsCategory;
	readonly label: string;
	readonly icon: (props: { size?: number }) => ReactElement;
};

const CATEGORIES: readonly CategoryItem[] = [
	{ id: "general", label: "General", icon: GearIcon },
	{ id: "llm", label: "LLM Models", icon: SparklesIcon },
	{ id: "embedding", label: "Embedding Models", icon: SparklesIcon },
	{ id: "reranker", label: "Reranker Models", icon: SearchIcon },
	{ id: "sources", label: "Data Sources", icon: DatabaseIcon },
	{ id: "deep", label: "Deep Indexing", icon: GroupIcon },
	{ id: "light", label: "Light Indexing", icon: SearchIcon },
	{ id: "apps", label: "Other Apps", icon: GearIcon },
];

const DATASOURCE_NAV_ORDER = ["discord", "kakao", "cloud-drive", "mailcrawl", "slack", "spotlight"] as const;
const DATASOURCE_TEMPLATE_LABELS = new Map(DATASOURCE_TEMPLATES.map((template) => [template.id, template.label]));

function sourceType(alias: string, raw: unknown): string {
	return isJsonObject(raw) && typeof raw.type === "string" && raw.type.length > 0 ? raw.type : alias;
}

function sourceLabel(alias: string, type: string): string {
	const normalized = `${alias} ${type}`.toLowerCase();
	if (normalized.includes("icloud")) return alias === type ? "iCloud Drive" : `iCloud Drive · ${alias}`;
	const label = DATASOURCE_TEMPLATE_LABELS.get(type) ?? type;
	return alias === type ? label : `${label} · ${alias}`;
}

function sourceCategory(alias: string): SettingsCategory {
	return `source:${alias}`;
}

function sourceAlias(category: SettingsCategory): string | null {
	return category.startsWith("source:") ? category.slice("source:".length) : null;
}

function datasourceEntries(snapshot: AutoRagConfigSnapshot | null): readonly { readonly alias: string; readonly type: string; readonly label: string }[] {
	if (snapshot === null || !isJsonObject(snapshot.config.datasources)) return [];
	return Object.entries(snapshot.config.datasources)
		.map(([alias, raw]) => {
			const type = sourceType(alias, raw);
			return { alias, type, label: sourceLabel(alias, type) };
		})
		.sort((a, b) => {
			const order = (type: string): number => {
				const index = DATASOURCE_NAV_ORDER.indexOf(type as (typeof DATASOURCE_NAV_ORDER)[number]);
				return index < 0 ? DATASOURCE_NAV_ORDER.length : index;
			};
			return order(a.type) - order(b.type) || a.label.localeCompare(b.label);
		});
}

const DUPEY_INTERVALS: readonly { readonly value: number; readonly label: string }[] = [
	{ value: 15, label: "15분" },
	{ value: 30, label: "30분" },
	{ value: 60, label: "1시간" },
	{ value: 180, label: "3시간" },
	{ value: 360, label: "6시간" },
	{ value: 720, label: "12시간" },
	{ value: 1440, label: "24시간" },
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function heading(title: string, description: string): ReactElement {
	return (
		<div className="linear-header">
			<h2 className="linear-title">{title}</h2>
			<p className="linear-desc">{description}</p>
		</div>
	);
}

function Row({ name, hint, children }: { readonly name: string; readonly hint: string; readonly children: ReactNode }): ReactElement {
	return (
		<div className="linear-row">
			<div className="linear-row-label">
				<span className="linear-row-name">{name}</span>
				<small>{hint}</small>
			</div>
			<div className="linear-control">{children}</div>
		</div>
	);
}


function GeneralSettings({ appSettings, onAppSettingsChanged, onSettingsError, snapshot, onSaved }: { readonly appSettings: AppSettings | null; readonly onAppSettingsChanged: (settings: AppSettings) => void; readonly onSettingsError: (message: string) => void; readonly snapshot: AutoRagConfigSnapshot | null; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	if (appSettings === null || snapshot === null) return <p className="linear-section-desc">{t("settings.loading", "설정을 불러오는 중…")}</p>;
	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		try {
			const next = await autorag.settings.set(patch);
			onAppSettingsChanged(next);
		} catch (cause) {
			// A rejected change (the right-click menu could not be written) leaves the stored setting as it was.
			onSettingsError(`${t("settings.general.osMenuIntegrationError", "Could not set up the right-click menu")}: ${errorMessage(cause)}`);
		}
	}
	return (
		<>
			{heading(t("settings.general.title", "Display & General"), t("settings.general.desc", "앱 화면과 AutoRAG 일반 언어 설정입니다. workspacePath와 memoryPath는 기본값으로 유지합니다."))}
			<Row name={t("settings.general.appearance", "Appearance")} hint={t("settings.general.appearanceHint", "Finder, Settings, Quick Look에 같은 테마를 적용합니다.")}><select className="linear-select" aria-label="Appearance" value={appSettings.appearance} onChange={(event) => void setApp({ appearance: event.target.value as AppSettings["appearance"] })}><option value="light">Light</option><option value="dark">Dark</option></select></Row>
			<Row name={t("settings.general.language", "Interface language")} hint={t("settings.general.languageHint", "앱 메뉴 언어입니다.")}><select className="linear-select" aria-label="Interface language" value={appSettings.language} onChange={(event) => void setApp({ language: event.target.value as AppSettings["language"] })}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">简体中文</option></select></Row>
			<LanguageSettings snapshot={snapshot} path={["languages"]} name={t("settings.general.docLanguages", "Document languages")} hint={t("settings.general.docLanguagesHint", "OCR·파서가 사용할 지원 언어를 선택합니다.")} onSaved={onSaved} fallback={["ko", "en"]} />
			<Row name={t("settings.general.launchAtLogin", "Launch at login")} hint={t("settings.general.launchAtLoginHint", "로그인할 때 백그라운드로 실행합니다.")}><Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel="Launch at login" /></Row>
			<Row name={t("settings.general.showHiddenFiles", "Show hidden files")} hint={t("settings.general.showHiddenFilesHint", "점(.)으로 시작하는 파일을 표시합니다.")}><Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel="Show hidden files" /></Row>
			{hostPlatform() === "darwin" || hostPlatform() === "win32" ? (
				<Row name={t("settings.general.osMenuIntegration", "Add to the file right-click menu")} hint={t("settings.general.osMenuIntegrationHint", "Right-click a file in Finder or Explorer to get 'Ask AutoRAG' and 'Show in AutoRAG'.")}><Switch checked={appSettings.osMenuIntegration} onChange={() => void setApp({ osMenuIntegration: !appSettings.osMenuIntegration })} ariaLabel="Add to the file right-click menu" /></Row>
			) : null}
			<Row name={t("settings.general.dedupInterval", "Deduplication interval")} hint={t("settings.general.dedupIntervalHint", "dupey 버전 패밀리 스캔 주기입니다.")}><select className="linear-select" aria-label="Deduplication interval" value={String(appSettings.dupeyScanIntervalMinutes)} onChange={(event) => void setApp({ dupeyScanIntervalMinutes: Number(event.target.value) })}>{DUPEY_INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Row>
			<Row name={t("settings.general.autoUpdates", "Automatically install updates")} hint={t("settings.general.autoUpdatesHint", "다음 앱 재시작 시 업데이트를 적용합니다.")}><Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel="Automatically install updates" /></Row>
			<Row name={t("settings.general.telemetry", "Share anonymous diagnostics")} hint={t("settings.general.telemetryHint", "익명화된 성능 지표를 공유합니다.")}><Switch checked={appSettings.telemetry} onChange={() => void setApp({ telemetry: !appSettings.telemetry })} ariaLabel="Share anonymous diagnostics" /></Row>
		</>
	);
}


export function SettingsView({ initialCategory = "general", onSettingsChanged }: { readonly initialCategory?: SettingsCategory; readonly onSettingsChanged?: (settings: AppSettings) => void }): ReactElement {
	const { t } = useTranslation();
	const [category, setCategory] = useState<SettingsCategory>(initialCategory);
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<AutoRagConfigSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const sources = useMemo(() => datasourceEntries(snapshot), [snapshot]);
	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const [app, config] = await Promise.all([autorag.settings.get(), autorag.settings.configGet()]);
			setAppSettings(app);
			setSnapshot(config);
			setError(config.error);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => { void load(); }, [load]);
	useEffect(() => {
		const alias = sourceAlias(category);
		if (snapshot !== null && alias !== null && sources.every((source) => source.alias !== alias)) setCategory("sources");
	}, [category, snapshot, sources]);
	const saveSnapshot = useCallback((next: AutoRagConfigSnapshot): void => {
		setSnapshot(next);
		setError(next.error);
	}, []);
	const source = sourceAlias(category);
	const content = useMemo(() => {
		if (loading || appSettings === null || snapshot === null) return <p className="linear-section-desc">{t("settings.loading", "설정을 불러오는 중…")}</p>;
		if (category === "general") return <GeneralSettings appSettings={appSettings} onAppSettingsChanged={(next) => { setAppSettings(next); onSettingsChanged?.(next); }} onSettingsError={setError} snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "llm" || category === "embedding" || category === "reranker") return <ModelSettings kind={category as ModelSettingsKind} snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "sources") return <DatasourceSettings key="sources" snapshot={snapshot} onSaved={saveSnapshot} overviewOnly />;
		if (source !== null) return <DatasourceSettings key={source} snapshot={snapshot} onSaved={saveSnapshot} initialAlias={source} singleConnection />;
		if (category === "deep") return <DeepSettings snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "light") return <LightSettings snapshot={snapshot} onSaved={saveSnapshot} />;
		return <AppsSettings snapshot={snapshot} onSaved={saveSnapshot} />;
	}, [appSettings, category, loading, onSettingsChanged, saveSnapshot, snapshot, source]);
	return (
		<div className="settings-view settings-panel" role="region" aria-label="Settings">
			<aside className="settings-sidebar" aria-label="Settings Categories">
				<div className="settings-sidebar-group-title">{t("settings.title", "Settings")}</div>
				{CATEGORIES.map((item) => {
					const Icon = item.icon;
					const active = category === item.id;
					const label = t(`settings.categories.${item.id}`, item.label);
					return (
						<button key={item.id} type="button" className={`settings-nav-item${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(item.id)}>
							<span className="settings-nav-icon"><Icon size={16} /></span>
							<span>{label}</span>
							{label !== item.label ? <span className="sr-only" aria-hidden="true">{item.label}</span> : null}
						</button>
					);
				})}
				<div className="settings-sidebar-group-title settings-sidebar-group-title--datasources">
					<span>{t("settings.categories.sources", "Data Sources")}</span>
					<button type="button" className="settings-sidebar-add" aria-label="Add data source" title="Add data source" onClick={() => setCategory("sources")}>+</button>
				</div>
				{sources.map((item) => {
					const active = category === sourceCategory(item.alias);
					return <button key={item.alias} type="button" className={`settings-nav-item settings-nav-item--source${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(sourceCategory(item.alias))}><span className="settings-nav-source-dot" aria-hidden="true" /><span>{item.label}</span></button>;
				})}
			</aside>
			<main className="settings-content" aria-label={`${source === null ? category : `${source} datasource`} settings`}>
				<div className="settings-content-wrap">{error ? <div className="settings-error" role="alert">{error}</div> : null}{content}</div>
			</main>
		</div>
	);
}

export function SettingsFieldLabel({ children }: { readonly children: ReactNode }): ReactElement { return <span className="linear-row-name">{children}</span>; }

export { PencilIcon };
