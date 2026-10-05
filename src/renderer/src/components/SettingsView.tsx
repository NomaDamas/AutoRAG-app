import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { AppSettings, ConfiguredModelSnapshot, DataSourceRow, DataSourcesSnapshot } from "../../../shared/settings-contract";
import { DatabaseIcon, GearIcon, PencilIcon, SparklesIcon } from "./icons";
import { Switch } from "./primitives/Switch";

const autorag = window.autorag;

export type SettingsCategory = "general" | "models" | "sources";

const CATEGORIES: readonly { readonly id: SettingsCategory; readonly label: string; readonly icon: (props: { size?: number }) => ReactElement }[] = [
	{ id: "general", label: "General", icon: GearIcon },
	{ id: "models", label: "Models", icon: SparklesIcon },
	{ id: "sources", label: "Data Sources", icon: DatabaseIcon },
];

/** Interval choices persisted to `AppSettings.dupeyScanIntervalMinutes`. */
const DUPEY_INTERVALS: readonly { readonly value: number; readonly label: string }[] = [
	{ value: 15, label: "15분" },
	{ value: 30, label: "30분" },
	{ value: 60, label: "1시간" },
	{ value: 180, label: "3시간" },
	{ value: 360, label: "6시간" },
	{ value: 720, label: "12시간" },
	{ value: 1440, label: "24시간" },
];

const STATUS_LABELS: Record<DataSourceRow["status"], string> = {
	ready: "Ready",
	syncing: "Syncing",
	paused: "Paused",
	attention: "Needs attention",
};

const INSTALL_LABELS: Record<DataSourceRow["install"]["state"], string> = {
	installed: "설치됨",
	missing: "미설치",
	builtin: "내장",
	"credential-missing": "인증 필요",
	unsupported: "지원 안 함",
};

const AGENT_LABELS: Record<DataSourceRow["agent"]["state"], string> = {
	connected: "연동됨",
	blocked: "접근 차단",
	disabled: "꺼짐",
	unsupported: "지원 안 함",
};

const INDEX_LABELS: Record<DataSourceRow["index"]["state"], string> = {
	indexed: "인덱싱됨",
	empty: "비어 있음",
	"not-indexed": "인덱스 없음",
	external: "CLI 자체 인덱스",
};

const RESOLUTION_LABELS: Record<string, string> = {
	config: "config",
	flags: "flags",
	env: "env",
	local_runtime: "local runtime",
	catalog: "catalog",
	configured_alias: "configured alias",
	mixed: "mixed",
};

const AUTH_LABELS: Record<string, string> = {
	env: "환경변수",
	local_runtime: "local runtime",
	pi_auth: "pi auth",
	catalog: "카탈로그",
	none: "없음",
	unknown: "알 수 없음",
};

function formatIndexedAt(iso: string | null): string {
	return iso === null ? "" : new Date(iso).toLocaleString();
}

function indexSummary(index: DataSourceRow["index"]): string {
	if (index.state === "indexed" && index.chunkCount !== null) return `${index.chunkCount.toLocaleString()} chunks`;
	return INDEX_LABELS[index.state];
}

export function SettingsView({
	initialCategory = "general",
	onSettingsChanged,
}: {
	readonly initialCategory?: SettingsCategory;
	readonly onSettingsChanged?: (settings: AppSettings) => void;
}): ReactElement {
	const [category, setCategory] = useState<SettingsCategory>(initialCategory);
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<DataSourcesSnapshot | null>(null);
	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [model, setModel] = useState<ConfiguredModelSnapshot | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [openSource, setOpenSource] = useState<string | null>(null);
	const [updateState, setUpdateState] = useState<"idle" | "checking" | "done">("idle");
	const [historyCleared, setHistoryCleared] = useState(false);

	const reloadSources = useCallback(async (): Promise<void> => {
		try {
			setSnapshot(await autorag.settings.sourcesList());
			setSourcesError(null);
		} catch (error) {
			setSourcesError(error instanceof Error ? error.message : String(error));
		}
	}, []);

	const reloadModel = useCallback(async (): Promise<void> => {
		try {
			setModel(await autorag.settings.modelsResolve());
			setModelError(null);
		} catch (error) {
			setModelError(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		void autorag.settings.get().then(setSettings);
	}, []);

	useEffect(() => {
		if (category === "sources") void reloadSources();
	}, [category, reloadSources]);

	useEffect(() => {
		if (category === "models") void reloadModel();
	}, [category, reloadModel]);

	async function toggleSetting(key: keyof AppSettings): Promise<void> {
		if (settings === null || typeof settings[key] !== "boolean") return;
		const next = await autorag.settings.set({ [key]: !settings[key] });
		setSettings(next);
		onSettingsChanged?.(next);
	}

	async function setAppearance(appearance: AppSettings["appearance"]): Promise<void> {
		const next = await autorag.settings.set({ appearance });
		setSettings(next);
		onSettingsChanged?.(next);
	}

	async function setLanguage(language: AppSettings["language"]): Promise<void> {
		const next = await autorag.settings.set({ language });
		setSettings(next);
		onSettingsChanged?.(next);
	}

	async function setDupeyInterval(minutes: number): Promise<void> {
		const next = await autorag.settings.set({ dupeyScanIntervalMinutes: minutes });
		setSettings(next);
		onSettingsChanged?.(next);
	}

	async function toggleSource(source: DataSourceRow): Promise<void> {
		try {
			setSnapshot(await autorag.settings.sourcesSetEnabled(source.id, !source.enabled));
			setSourcesError(null);
		} catch (error) {
			setSourcesError(error instanceof Error ? error.message : String(error));
		}
	}

	async function saveSourceDescription(source: DataSourceRow, description: string): Promise<boolean> {
		try {
			setSnapshot(await autorag.settings.sourcesSetDescription(source.id, description));
			setSourcesError(null);
			return true;
		} catch (error) {
			setSourcesError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	const sources = snapshot?.sources ?? [];
	const sourcesProblem = sourcesError ?? snapshot?.error ?? null;

	return (
		<div className="settings-view settings-panel" role="region" aria-label="Settings">
			<aside className="settings-sidebar" aria-label="Settings Categories">
				<div className="settings-sidebar-group-title">Settings</div>
				{CATEGORIES.map((item) => {
					const Icon = item.icon;
					const active = category === item.id;
					return (
						<button
							key={item.id}
							type="button"
							className={`settings-nav-item${active ? " is-active" : ""}`}
							aria-current={active ? "true" : undefined}
							onClick={() => setCategory(item.id)}
						>
							<span className="settings-nav-icon">
								<Icon size={16} />
							</span>
							<span>{item.label}</span>
						</button>
					);
				})}
			</aside>

			<main className="settings-content" aria-label={`${category} settings`}>
				<div className="settings-content-wrap">
					{category === "general" && settings !== null ? (
						<>
							<div className="linear-header">
								<h2 className="linear-title">Display &amp; General</h2>
								<p className="linear-desc">Customize interface preferences and system startup behavior.</p>
							</div>

							<LinearRow name="Appearance" hint="Use one light or dark appearance across Finder, Settings, and Quick Look.">
								<select
									className="linear-select"
									aria-label="Appearance"
									value={settings.appearance}
									onChange={(event) => void setAppearance(event.target.value as AppSettings["appearance"])}
								>
									<option value="light">Light</option>
									<option value="dark">Dark</option>
								</select>
							</LinearRow>
							<LinearRow name="Interface language" hint="Choose your preferred language for menus, labels, and citations.">
								<select
									className="linear-select"
									aria-label="Interface language"
									value={settings.language}
									onChange={(event) => void setLanguage(event.target.value as AppSettings["language"])}
								>
									<option value="ko">한국어 (Korean)</option>
									<option value="en">English</option>
									<option value="ja">日本語 (Japanese)</option>
									<option value="zh">简体中文</option>
								</select>
							</LinearRow>
							<LinearRow name="Launch at login" hint="Automatically launch AutoRAG Finder silently in the background when logging in.">
								<Switch checked={settings.launchAtLogin} onChange={() => void toggleSetting("launchAtLogin")} ariaLabel="Launch at login" />
							</LinearRow>
							<LinearRow name="Show in menu bar" hint="Keep the AutoRAG status icon in the macOS menu bar.">
								<Switch checked={settings.showInMenuBar} onChange={() => void toggleSetting("showInMenuBar")} ariaLabel="Show in menu bar" />
							</LinearRow>
							<LinearRow name="Show hidden files" hint="Display files and directories starting with a period (.) in all browsing views.">
								<Switch checked={settings.showHiddenFiles} onChange={() => void toggleSetting("showHiddenFiles")} ariaLabel="Show hidden files" />
							</LinearRow>
							<LinearRow name="Deduplication interval" hint="Frequency at which dupey clusters similar and duplicate office documents.">
								<select
									className="linear-select"
									aria-label="Deduplication interval"
									value={String(settings.dupeyScanIntervalMinutes)}
									onChange={(event) => void setDupeyInterval(Number(event.target.value))}
								>
									{DUPEY_INTERVALS.map((interval) => (
										<option key={interval.value} value={interval.value}>
											{interval.label}
										</option>
									))}
								</select>
							</LinearRow>

							<div className="linear-section-title">Software Updates</div>
							<LinearRow
								name="AutoRAG Agent 1.4.2"
								hint={updateState === "done" ? "You are running the latest production build · Last checked moments ago." : "Check for new AutoRAG Agent builds and apply them."}
							>
								<button
									type="button"
									className="linear-btn"
									disabled={updateState === "checking"}
									onClick={() => {
										setUpdateState("checking");
										window.setTimeout(() => setUpdateState("done"), 600);
									}}
								>
									{updateState === "checking" ? "Checking…" : "Check for Updates"}
								</button>
							</LinearRow>
							<LinearRow name="Automatically install updates" hint="Silently download new versions and apply them during the next app relaunch.">
								<Switch checked={settings.autoInstallUpdates} onChange={() => void toggleSetting("autoInstallUpdates")} ariaLabel="Automatically install updates" />
							</LinearRow>

							<div className="linear-section-title">Privacy &amp; Data</div>
							<LinearRow name="Clear chat history" hint="Permanently delete all previous conversational sessions, queries, and citations.">
								<button
									type="button"
									className="linear-btn is-danger"
									onClick={() => {
										void autorag.settings.clearHistory();
										setHistoryCleared(true);
										window.setTimeout(() => setHistoryCleared(false), 2500);
									}}
								>
									{historyCleared ? "Cleared ✓" : "Clear…"}
								</button>
							</LinearRow>
							<LinearRow name="Share anonymous diagnostics" hint="Help improve AutoRAG indexing speed and accuracy with anonymized metrics.">
								<Switch checked={settings.telemetry} onChange={() => void toggleSetting("telemetry")} ariaLabel="Share anonymous diagnostics" />
							</LinearRow>
						</>
					) : null}

					{category === "models" ? (
						<>
							<div className="linear-header">
								<h2 className="linear-title">LLM Models Configuration</h2>
								<p className="linear-desc">The provider and model the AutoRAG agent resolves from the shared AutoRAG config.</p>
							</div>

							<div className="linear-section-title">Setup Providers</div>
							<div className="provider-list">
								<ModelCard snapshot={model} error={modelError} />
							</div>

							{modelError !== null ? (
								<div className="settings-error" role="alert">
									{modelError}
								</div>
							) : null}

							{model?.model !== null && model?.model !== undefined ? (
								<>
									<div className="linear-section-title">Model Details</div>
									<LinearRow name="Provider" hint="Resolved provider namespace.">
										<span className="linear-value">{model.model.provider}</span>
									</LinearRow>
									<LinearRow name="Model ID" hint="The id the agent sends to the provider.">
										<span className="linear-value">{model.model.modelId}</span>
									</LinearRow>
									<LinearRow name="Display name" hint="Human-readable label for this model.">
										<span className="linear-value">{model.model.displayName}</span>
									</LinearRow>
									<LinearRow name="API" hint="Wire protocol the librarian uses for this model.">
										<span className="linear-value">{model.model.api}</span>
									</LinearRow>
									<LinearRow name="Base URL" hint="Endpoint the librarian resolves for this provider.">
										<span className="linear-value">{model.model.baseUrl ?? "—"}</span>
									</LinearRow>
									<LinearRow name="Resolution source" hint="Where the librarian read this model identity from.">
										<span className="linear-value">{RESOLUTION_LABELS[model.model.resolutionSource] ?? model.model.resolutionSource}</span>
									</LinearRow>
									<LinearRow name="API key" hint="Credential source the agent authenticates with.">
										<span className="linear-value">
											{[AUTH_LABELS[model.model.auth.source] ?? model.model.auth.source, model.model.auth.envName]
												.filter((part): part is string => part !== null && part !== undefined && part.length > 0)
												.join(" · ")}
										</span>
									</LinearRow>
									<LinearRow name="Config file" hint="The shared AutoRAG config this identity was read from.">
										<span className="linear-value">{model.configPath}</span>
									</LinearRow>
								</>
							) : null}
						</>
					) : null}

					{category === "sources" ? (
						<>
							<div className="linear-header">
								<h2 className="linear-title">Data Sources</h2>
								<p className="linear-desc">Sources the AutoRAG agent can index and query, read from the shared AutoRAG config.</p>
							</div>
							{sourcesProblem === null ? null : (
								<div className="settings-error" role="alert">
									{sourcesProblem}
								</div>
							)}

							<div className="linear-section-title">Available Integrations</div>
							<div className="provider-list">
								{sources.length === 0 ? (
									<p className="linear-section-desc">연동된 데이터 소스가 없습니다.</p>
								) : (
									sources.map((source) => (
										<SourceRow
											key={source.id}
											source={source}
											open={openSource === source.id}
											onToggle={() => void toggleSource(source)}
											onDetail={() => setOpenSource((current) => (current === source.id ? null : source.id))}
											onSaveDescription={(description) => saveSourceDescription(source, description)}
										/>
									))
								)}
							</div>
						</>
					) : null}
				</div>
			</main>
		</div>
	);
}

function ModelCard({ snapshot, error }: { readonly snapshot: ConfiguredModelSnapshot | null; readonly error: string | null }): ReactElement {
	const model = snapshot?.model ?? null;
	const connected = model !== null && model.auth.present;
	const letter = model?.provider[0]?.toUpperCase() ?? "?";
	const detail =
		error !== null
			? error
			: model !== null
				? `${model.displayName} · ${model.modelId}`
				: "No model resolved from the shared AutoRAG config.";
	return (
		<div className="provider-row settings-model-card">
			<div className="provider-icon">{letter}</div>
			<div className="provider-body">
				<div className="provider-name settings-model-card__name">{model?.provider ?? "No model"}</div>
				<div className="provider-models settings-model-card__provider">{detail}</div>
			</div>
			<span className={`provider-status ${connected ? "is-connected" : "is-disconnected"}`}>{connected ? "Connected" : "Not connected"}</span>
		</div>
	);
}

function SourceRow({
	source,
	open,
	onToggle,
	onDetail,
	onSaveDescription,
}: {
	readonly source: DataSourceRow;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly onDetail: () => void;
	readonly onSaveDescription: (description: string) => Promise<boolean>;
}): ReactElement {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(source.description);
	const [saving, setSaving] = useState(false);

	function startEditing(): void {
		setDraft(source.description);
		setEditing(true);
	}

	async function save(): Promise<void> {
		if (saving) return;
		setSaving(true);
		const saved = await onSaveDescription(draft);
		setSaving(false);
		if (saved) setEditing(false);
	}

	return (
		<div className={`settings-source${open ? " is-open" : ""}`} data-source-id={source.id}>
			<div className={`settings-source__row${source.enabled ? "" : " is-disabled"}`}>
				<span className="provider-icon">{source.id[0]?.toUpperCase() ?? "?"}</span>
				<div className="settings-source__body" onClick={onDetail}>
					<span className="settings-source__name">
						{source.id}
						<span className="provider-tag">{source.type}</span>
					</span>
					<span className="settings-source__detail">
						{INSTALL_LABELS[source.install.state]} · 에이전트 {AGENT_LABELS[source.agent.state]}
					</span>
				</div>
				<div className="settings-source__track">
					<span className={`provider-status settings-status source-status--${source.status}`}>{STATUS_LABELS[source.status]}</span>
					<span className="settings-source__pct">{indexSummary(source.index)}</span>
				</div>
				<button
					type="button"
					className={`settings-source__chevron${open ? " is-open" : ""}`}
					title="Details"
					aria-label={`${source.id} details`}
					onClick={onDetail}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M6 9l6 6 6-6" />
					</svg>
				</button>
				<Switch checked={source.enabled} onChange={onToggle} ariaLabel={`${source.id} 사용`} />
			</div>
			{open ? (
				<div className="settings-source-desc">
					<dl className="settings-source-facts">
						<SourceFact fact="install" label="설치" state={source.install.state} value={INSTALL_LABELS[source.install.state]} detail={source.install.detail} />
						<SourceFact
							fact="agent"
							label="에이전트 연동"
							state={source.agent.state}
							value={AGENT_LABELS[source.agent.state]}
							detail={[source.agent.detail, source.agent.tags.length > 0 ? `tags: ${source.agent.tags.join(", ")}` : null].filter(Boolean).join(" · ")}
						/>
						<SourceFact
							fact="index"
							label="인덱스"
							state={source.index.state}
							value={INDEX_LABELS[source.index.state]}
							detail={[source.index.detail, formatIndexedAt(source.index.indexedAt)].filter(Boolean).join(" · ")}
						/>
					</dl>
					<div className="settings-source-desc__header">
						<span>Description</span>
						{editing ? null : (
							<button type="button" className="settings-source-desc__edit" aria-label={`${source.id} 설명 편집`} title="설명 편집" onClick={startEditing}>
								<PencilIcon />
							</button>
						)}
					</div>
					{editing ? (
						<form
							className="settings-source-desc__form"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<textarea
								className="settings-source-desc__input"
								aria-label={`${source.id} 설명`}
								value={draft}
								rows={3}
								autoFocus
								disabled={saving}
								placeholder="에이전트가 이 데이터소스를 언제 쓰면 좋은지 적어 주세요"
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										setEditing(false);
									}
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										void save();
									}
								}}
							/>
							<div className="settings-source-desc__actions">
								<button type="button" disabled={saving} onClick={() => setEditing(false)}>
									취소
								</button>
								<button type="submit" className="is-primary" disabled={saving || draft.trim() === source.description.trim()}>
									{saving ? "저장 중…" : "저장"}
								</button>
							</div>
						</form>
					) : (
						<p>{source.description}</p>
					)}
				</div>
			) : null}
		</div>
	);
}

function SourceFact({ fact, label, state, value, detail }: { readonly fact: string; readonly label: string; readonly state: string; readonly value: string; readonly detail: string }): ReactElement {
	return (
		<div className="settings-source-fact" data-fact={fact} data-state={state}>
			<dt>{label}</dt>
			<dd>
				<strong>{value}</strong>
				<span>{detail}</span>
			</dd>
		</div>
	);
}

function LinearRow({ name, hint, children }: { readonly name: string; readonly hint: string; readonly children: ReactElement }): ReactElement {
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
