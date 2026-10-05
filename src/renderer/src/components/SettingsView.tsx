import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../shared/settings-contract";
import { DatabaseIcon, GearIcon, GroupIcon, PencilIcon, SearchIcon, SparklesIcon } from "./icons";
import { DatasourceSettings } from "./settings/DatasourceSettings";
import { AppsSettings, DeepSettings, LightSettings } from "./settings/ConfigSections";
import { LanguageSettings } from "./settings/LanguageSettings";
import { ModelSettings, type ModelSettingsKind } from "./settings/ModelSettings";
import { Switch } from "./primitives/Switch";
import { settings } from "../settings-runtime";

const autorag = { settings };

export type SettingsCategory = "general" | "llm" | "embedding" | "reranker" | "sources" | "deep" | "light" | "apps";

type CategoryItem = {
	readonly id: SettingsCategory;
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


function GeneralSettings({ appSettings, onAppSettingsChanged, snapshot, onSaved }: { readonly appSettings: AppSettings | null; readonly onAppSettingsChanged: (settings: AppSettings) => void; readonly snapshot: AutoRagConfigSnapshot | null; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	if (appSettings === null || snapshot === null) return <p className="linear-section-desc">설정을 불러오는 중…</p>;
	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		const next = await autorag.settings.set(patch);
		onAppSettingsChanged(next);
	}
	return (
		<>
			{heading("Display & General", "앱 화면과 AutoRAG 일반 언어 설정입니다. workspacePath와 memoryPath는 기본값으로 유지합니다.")}
			<Row name="Appearance" hint="Finder, Settings, Quick Look에 같은 테마를 적용합니다."><select className="linear-select" value={appSettings.appearance} onChange={(event) => void setApp({ appearance: event.target.value as AppSettings["appearance"] })}><option value="light">Light</option><option value="dark">Dark</option></select></Row>
			<Row name="Interface language" hint="앱 메뉴 언어입니다."><select className="linear-select" value={appSettings.language} onChange={(event) => void setApp({ language: event.target.value as AppSettings["language"] })}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">简体中文</option></select></Row>
			<LanguageSettings snapshot={snapshot} path={["languages"]} name="Document languages" hint="OCR·파서가 사용할 지원 언어를 선택합니다." onSaved={onSaved} fallback={["ko", "en"]} />
			<Row name="Launch at login" hint="로그인할 때 백그라운드로 실행합니다."><Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel="Launch at login" /></Row>
			<Row name="Show hidden files" hint="점(.)으로 시작하는 파일을 표시합니다."><Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel="Show hidden files" /></Row>
			<Row name="Deduplication interval" hint="dupey 버전 패밀리 스캔 주기입니다."><select className="linear-select" value={String(appSettings.dupeyScanIntervalMinutes)} onChange={(event) => void setApp({ dupeyScanIntervalMinutes: Number(event.target.value) })}>{DUPEY_INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Row>
			<Row name="Automatically install updates" hint="다음 앱 재시작 시 업데이트를 적용합니다."><Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel="Automatically install updates" /></Row>
			<Row name="Share anonymous diagnostics" hint="익명화된 성능 지표를 공유합니다."><Switch checked={appSettings.telemetry} onChange={() => void setApp({ telemetry: !appSettings.telemetry })} ariaLabel="Share anonymous diagnostics" /></Row>
		</>
	);
}


export function SettingsView({ initialCategory = "general", onSettingsChanged }: { readonly initialCategory?: SettingsCategory; readonly onSettingsChanged?: (settings: AppSettings) => void }): ReactElement {
	const [category, setCategory] = useState<SettingsCategory>(initialCategory);
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<AutoRagConfigSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
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
	const saveSnapshot = useCallback((next: AutoRagConfigSnapshot): void => { setSnapshot(next); setError(next.error); }, []);
	const content = useMemo(() => {
		if (loading || appSettings === null || snapshot === null) return <p className="linear-section-desc">설정을 불러오는 중…</p>;
		if (category === "general") return <GeneralSettings appSettings={appSettings} onAppSettingsChanged={(next) => { setAppSettings(next); onSettingsChanged?.(next); }} snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "llm" || category === "embedding" || category === "reranker") return <ModelSettings kind={category as ModelSettingsKind} snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "sources") return <DatasourceSettings snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "deep") return <DeepSettings snapshot={snapshot} onSaved={saveSnapshot} />;
		if (category === "light") return <LightSettings snapshot={snapshot} onSaved={saveSnapshot} />;
		return <AppsSettings snapshot={snapshot} onSaved={saveSnapshot} />;
	}, [appSettings, category, loading, onSettingsChanged, saveSnapshot, snapshot]);
	return <div className="settings-view settings-panel" role="region" aria-label="Settings"><aside className="settings-sidebar" aria-label="Settings Categories"><div className="settings-sidebar-group-title">Settings</div>{CATEGORIES.map((item) => { const Icon = item.icon; const active = category === item.id; return <button key={item.id} type="button" className={`settings-nav-item${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(item.id)}><span className="settings-nav-icon"><Icon size={16} /></span><span>{item.label}</span></button>; })}</aside><main className="settings-content" aria-label={`${category} settings`}><div className="settings-content-wrap">{error ? <div className="settings-error" role="alert">{error}</div> : null}{content}</div></main></div>;
}

export function SettingsFieldLabel({ children }: { readonly children: ReactNode }): ReactElement { return <span className="linear-row-name">{children}</span>; }

export { PencilIcon };
