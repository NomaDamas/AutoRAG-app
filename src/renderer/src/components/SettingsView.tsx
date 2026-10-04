import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type {
	AppSettings,
	AutoRagConfigSnapshot,
	JsonObject,
	JsonValue,
} from "../../../shared/settings-contract";
import { DatabaseIcon, GearIcon, GroupIcon, PencilIcon, SearchIcon, SparklesIcon } from "./icons";
import { DatasourceSettings } from "./settings/DatasourceSettings";
import { ModelSettings, type ModelSettingsKind } from "./settings/ModelSettings";
import { Switch } from "./primitives/Switch";

const autorag = window.autorag;

export type SettingsCategory = "general" | "llm" | "embedding" | "reranker" | "sources" | "deep" | "light" | "apps";
type ConfigPath = readonly string[];

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

function recordAt(root: JsonObject, path: ConfigPath): JsonValue | undefined {
	let current: JsonValue = root;
	for (const part of path) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as JsonObject)[part] as JsonValue;
	}
	return current;
}

function textValue(value: JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function boolValue(value: JsonValue | undefined, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function listValue(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

function TextInput({ value, onChange, label, placeholder, width = 260 }: { readonly value: string; readonly onChange: (value: string) => void; readonly label: string; readonly placeholder?: string; readonly width?: number }): ReactElement {
	return <input className="settings-source-desc__input" style={{ width }} aria-label={label} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

function NumberInput({ value, onChange, label, placeholder }: { readonly value: number | null; readonly onChange: (value: number | null) => void; readonly label: string; readonly placeholder?: string }): ReactElement {
	return (
		<input
			className="settings-source-desc__input"
			style={{ width: 160 }}
			type="number"
			min={1}
			aria-label={label}
			value={value ?? ""}
			placeholder={placeholder}
			onChange={(event) => {
				const next = event.target.value.trim();
				onChange(next.length === 0 ? null : Number(next));
			}}
		/>
	);
}

function Section({ title, description, children }: { readonly title: string; readonly description?: string; readonly children: ReactNode }): ReactElement {
	return (
		<>
			<div className="linear-section-title">{title}</div>
			{description ? <p className="linear-section-desc">{description}</p> : null}
			{children}
		</>
	);
}

function ListEditor({ snapshot, path, name, hint, placeholder, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly path: ConfigPath; readonly name: string; readonly hint: string; readonly placeholder: string; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const initial = listValue(recordAt(snapshot.config, path));
	const [draft, setDraft] = useState(initial.join("\n"));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const signature = JSON.stringify(initial);
	useEffect(() => setDraft(initial.join("\n")), [signature]);
	async function save(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const values = draft.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
			const next = await autorag.settings.configSet(path, values);
			onSaved(next);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack">
				<textarea className="linear-textarea" aria-label={name} rows={3} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
				<div className="settings-field-actions">
					<button type="button" className="linear-btn" disabled={saving} onClick={() => void save()}>{saving ? "저장 중…" : "저장"}</button>
					{error ? <span className="settings-inline-error">{error}</span> : null}
				</div>
			</div>
		</Row>
	);
}

function JsonBlockEditor({ snapshot, path, name, hint, defaultValue, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly path: ConfigPath; readonly name: string; readonly hint: string; readonly defaultValue: JsonValue; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const current = recordAt(snapshot.config, path) ?? defaultValue;
	const [draft, setDraft] = useState(JSON.stringify(current, null, 2));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const signature = JSON.stringify(current);
	useEffect(() => setDraft(JSON.stringify(current, null, 2)), [signature]);
	async function save(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const parsed: unknown = JSON.parse(draft);
			if (parsed === undefined || typeof parsed === "function") throw new Error("JSON 값이 올바르지 않습니다.");
			const next = await autorag.settings.configSet(path, parsed as JsonValue);
			onSaved(next);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}
	async function reset(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const next = await autorag.settings.configRemove(path);
			onSaved(next);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}
	return (
		<Row name={name} hint={hint}>
			<div className="settings-field-stack settings-field-stack--wide">
				<textarea className="linear-textarea settings-json-editor" aria-label={name} rows={7} value={draft} onChange={(event) => setDraft(event.target.value)} />
				<div className="settings-field-actions">
					<button type="button" className="linear-btn" disabled={saving} onClick={() => void save()}>{saving ? "저장 중…" : "저장"}</button>
					<button type="button" className="linear-btn" disabled={saving} onClick={() => void reset()}>기본값 사용</button>
					{error ? <span className="settings-inline-error">{error}</span> : null}
				</div>
			</div>
		</Row>
	);
}

function ToggleConfig({ snapshot, path, name, hint, fallback = false, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly path: ConfigPath; readonly name: string; readonly hint: string; readonly fallback?: boolean; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const current = boolValue(recordAt(snapshot.config, path), fallback);
	const [saving, setSaving] = useState(false);
	async function toggle(): Promise<void> {
		setSaving(true);
		try {
			const next = await autorag.settings.configSet(path, !current);
			onSaved(next);
		} finally {
			setSaving(false);
		}
	}
	return <Row name={name} hint={hint}><Switch checked={current} disabled={saving} onChange={() => void toggle()} ariaLabel={name} /></Row>;
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
			<ListEditor snapshot={snapshot} path={["languages"]} name="Document languages" hint="OCR·파서가 사용할 언어 태그입니다. 예: ko, en" placeholder="ko\nen" onSaved={onSaved} />
			<Row name="Launch at login" hint="로그인할 때 백그라운드로 실행합니다."><Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel="Launch at login" /></Row>
			<Row name="Show in menu bar" hint="macOS 메뉴 막대 아이콘을 표시합니다."><Switch checked={appSettings.showInMenuBar} onChange={() => void setApp({ showInMenuBar: !appSettings.showInMenuBar })} ariaLabel="Show in menu bar" /></Row>
			<Row name="Show hidden files" hint="점(.)으로 시작하는 파일을 표시합니다."><Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel="Show hidden files" /></Row>
			<Row name="Deduplication interval" hint="dupey 버전 패밀리 스캔 주기입니다."><select className="linear-select" value={String(appSettings.dupeyScanIntervalMinutes)} onChange={(event) => void setApp({ dupeyScanIntervalMinutes: Number(event.target.value) })}>{DUPEY_INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Row>
			<Row name="Automatically install updates" hint="다음 앱 재시작 시 업데이트를 적용합니다."><Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel="Automatically install updates" /></Row>
			<Row name="Share anonymous diagnostics" hint="익명화된 성능 지표를 공유합니다."><Switch checked={appSettings.telemetry} onChange={() => void setApp({ telemetry: !appSettings.telemetry })} ariaLabel="Share anonymous diagnostics" /></Row>
		</>
	);
}

function DeepSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	return <><>{heading("Deep Indexing", "파일 내용과 발견 인덱스를 위한 MinSync·Jikji 설정입니다.")}</><Section title="Search paths" description="workspacePath는 수정하지 않고, 실제 검색·인덱싱 루트만 관리합니다."><ListEditor snapshot={snapshot} path={["searchPaths"]} name="Search paths" hint="한 줄에 하나의 폴더를 지정합니다." placeholder="/Users/me/Documents" onSaved={onSaved} /></Section><Section title="MinSync" description="v2.7 기본 임베딩은 로컬 AutoRAG gateway가 관리합니다."><ToggleConfig snapshot={snapshot} path={["minSync", "enabled"]} name="Enable MinSync" hint="증분·벡터 인덱싱을 사용합니다." fallback onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["minSync"]} name="MinSync advanced" hint="autoInstall, maxChunkSize, installer 등 실제 v2.7 필드입니다." defaultValue={{ enabled: true, autoInstall: true }} onSaved={onSaved} /></Section><Section title="Jikji"><JsonBlockEditor snapshot={snapshot} path={["jikji"]} name="Jikji settings" hint="hidden/sensitive/media/index limits와 exclude를 설정합니다." defaultValue={{}} onSaved={onSaved} /></Section><Section title="Retrieval limits"><JsonBlockEditor snapshot={snapshot} path={["limits"]} name="Retrieval limits" hint="mergedEvidenceCeiling, topK, prefetch 등 v2.7 제한값입니다." defaultValue={{}} onSaved={onSaved} /></Section></>;
}

function LightSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const platform = typeof navigator !== "undefined" && /Mac|Linux/u.test(navigator.platform) ? "fsearch" : "everything";
	return <><>{heading("Light Indexing", "파일명 탐색과 인덱스 제외 정책입니다.")}</><Section title="Platform file search"><JsonBlockEditor snapshot={snapshot} path={["fsearch"]} name="FSearch (macOS/Linux)" hint="macOS/Linux에서 fsearch-cli를 사용합니다. Windows는 everything 블록을 설정합니다." defaultValue={{ enabled: true, watch: true }} onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["everything"]} name="Everything (Windows)" hint="Windows Everything 검색 설정입니다." defaultValue={{ enabled: true }} onSaved={onSaved} /><p className="linear-section-desc">현재 플랫폼 기본 대상: {platform}</p></Section><Section title="Excluded folders" description="제외 설정은 실제 excludePaths에 저장됩니다. 아래 빠른 항목도 같은 배열을 수정합니다."><ListEditor snapshot={snapshot} path={["excludePaths"]} name="Excluded folders and files" hint="한 줄에 하나씩 입력합니다." placeholder="node_modules\n.git\ndist" onSaved={onSaved} /></Section><Section title="Automatic code-folder exclusions" description="검색 루트 안의 동일한 폴더명을 자동으로 제외합니다. parsed/MinSync/Jikji에 적용되며 FSearch/Everything에는 전달되지 않습니다."><ToggleConfig snapshot={snapshot} path={["appIndexing", "excludeCodeFolders"]} name="Exclude code and dependency folders" hint="기본값: 켜짐" fallback onSaved={onSaved} /><ListEditor snapshot={snapshot} path={["appIndexing", "codeFolderNames"]} name="Folder names" hint="한 줄에 하나씩. 예: .git, node_modules, dist" placeholder="node_modules\n.git" onSaved={onSaved} /></Section><Section title="Code-folder quick exclusions"><QuickExclusion snapshot={snapshot} label="node_modules" onSaved={onSaved} /><QuickExclusion snapshot={snapshot} label=".git" onSaved={onSaved} /><QuickExclusion snapshot={snapshot} label="dist" onSaved={onSaved} /><QuickExclusion snapshot={snapshot} label="build" onSaved={onSaved} /><QuickExclusion snapshot={snapshot} label="coverage" onSaved={onSaved} /></Section></>;
}

function QuickExclusion({ snapshot, label, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly label: string; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const values = listValue(recordAt(snapshot.config, ["excludePaths"]));
	const checked = values.includes(label);
	async function toggle(): Promise<void> {
		const next = checked ? values.filter((item) => item !== label) : [...values, label];
		onSaved(next.length === 0 ? await autorag.settings.configRemove(["excludePaths"]) : await autorag.settings.configSet(["excludePaths"], next));
	}
	return <Row name={label} hint="프로젝트 아래의 동일한 폴더명/경로를 제외합니다."><Switch checked={checked} onChange={() => void toggle()} ariaLabel={`${label} 자동 제외`} /></Row>;
}

function AppsSettings({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	return <><>{heading("Other Apps", "웹 검색, 중복 제거, 파서, P2P와 접근 정책입니다.")}</><ToggleConfig snapshot={snapshot} path={["excludeExactDuplicates"]} name="Exclude exact duplicates" hint="동일 콘텐츠 중복을 최신 파일 중심으로 줄입니다." fallback onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["webSearch"]} name="Web search" hint="provider/order/exclude/fetch를 설정합니다." defaultValue={{}} onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["dupey"]} name="Dupey" hint="enabled, binaryPath, timeoutMs를 설정합니다." defaultValue={{ enabled: true }} onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["parserOptions"]} name="Parser and OCR" hint="OCR languages/timeout/maxBytes와 Kordoc 옵션입니다." defaultValue={{}} onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["datasourceAccess"]} name="Datasource access" hint="allowedTags와 allowedScopes는 default-deny 보안 경계입니다." defaultValue={{ allowedTags: [], allowedScopes: [] }} onSaved={onSaved} /><JsonBlockEditor snapshot={snapshot} path={["p2p"]} name="Peer-to-peer" hint="기본 비활성. trusted network 설정을 직접 관리합니다." defaultValue={{ enabled: false }} onSaved={onSaved} /></>;
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
