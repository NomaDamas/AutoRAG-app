/**
 * Settings → 인덱싱 / 연결된 앱 / 개별 데이터소스.
 *
 * Read live datasource state from `sourcesList` (install / agent / index), and
 * write through the real bridge: `sourcesSetEnabled`, `sourcesSetDescription`,
 * `sourcesSync` and `configPatch`/`configSet`/`configRemove`
 * for the config leaves. Connector fields come from each template's own field
 * schema (shared with `datasourceTemplates`), so a template only ever shows the
 * options its factory reads.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronRight, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
	AutoRagConfigSnapshot,
	ConfigRefreshResult,
	DataSourceRow,
	DataSourcesSnapshot,
	JsonValue,
	RefreshScheduleStatus,
	ScheduledRunRecord,
} from "../../../../shared/settings-contract";
import { ConnectorFieldInput, TEMPLATE_BY_ID, type FieldSpec } from "./datasourceTemplates";
import { ModalShell, ModalActions, Note, PromptModal, Row, Section, SettingsPageHead, StatusDot } from "./SettingsKit";
import { SourceIcon } from "./SourceIcon";
import { asRecord, getAt, listOf, stringOf, useConfigWriter } from "./configSupport";
import { Switch } from "../primitives/Switch";
import { useIndexActivity } from "../../hooks/useIndexActivity";
import { activityItem } from "../../state/index-activity";
import { IndexActivityCard } from "./IndexActivityCard";

const settings = window.autorag.settings;

/** Refresh cadences the config stores in milliseconds. */
const INTERVAL_OPTIONS: readonly { readonly ms: number; readonly label: string }[] = [
	{ ms: 5 * 60_000, label: "5분" },
	{ ms: 15 * 60_000, label: "15분" },
	{ ms: 30 * 60_000, label: "30분" },
	{ ms: 60 * 60_000, label: "1시간" },
	{ ms: 6 * 60 * 60_000, label: "6시간" },
	{ ms: 24 * 60 * 60_000, label: "하루" },
];

const GALLERY_GROUPS: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
	{ title: "메신저", ids: ["slack", "kakao", "discord", "telegram", "whatsapp", "lark"] },
	{ title: "문서·노트", ids: ["notion", "obsidian", "clawgallery"] },
	{ title: "메일", ids: ["mailcrawl", "mail-export"] },
	{ title: "클라우드·개발", ids: ["cloud-drive", "github", "github-gist"] },
	{ title: "뉴스·기타", ids: ["rss", "spotlight"] },
];

function templateLabel(type: string): string {
	return TEMPLATE_BY_ID[type]?.label ?? type;
}

function sourceAliases(snapshot: AutoRagConfigSnapshot): readonly { readonly alias: string; readonly type: string }[] {
	const datasources = asRecord(snapshot.config.datasources);
	if (datasources === null) return [];
	return Object.entries(datasources).map(([alias, raw]) => {
		const record = asRecord(raw);
		return { alias, type: record !== null ? stringOf(record.type) || alias : alias };
	});
}

/** The connection's kind ("Slack"); the alias only joins it when it tells two connections of one kind apart. */
function sourceTitle(row: Pick<DataSourceRow, "id" | "type">): string {
	const label = templateLabel(row.type);
	return row.id === row.type ? label : `${label} · ${row.id}`;
}

/** A dot tone for a datasource row: syncing, blocked, paused, or healthy. */
function sourceTone(row: DataSourceRow): "ok" | "warn" | "run" | "off" {
	if (row.status === "syncing") return "run";
	if (!row.enabled || row.status === "paused") return "off";
	if (row.index.state === "indexed" || row.index.state === "live") return "ok";
	return "warn";
}

const UNIT_LABEL: Readonly<Record<NonNullable<DataSourceRow["index"]["unit"]>, string>> = {
	message: "메시지",
	document: "문서",
	image: "이미지",
};

/** The local-folder row's meta line: what the last refresh actually parsed. */
function localMeta(local: DataSourcesSnapshot["local"] | null, folderCount: number): string {
	const folders = `폴더 ${folderCount}개`;
	if (local === null || local.documentCount === null) return folders;
	if (local.documentCount === 0) return `아직 읽은 문서 없음 · ${folders}`;
	return `문서 ${local.documentCount.toLocaleString()}개 · ${folders}`;
}

function sourceMeta(row: DataSourceRow): string {
	if (!row.enabled) return "꺼짐";
	if (row.status === "syncing") return "최신화 중…";
	const { state, chunkCount, unit } = row.index;
	const noun = unit === null ? "항목" : UNIT_LABEL[unit];
	// Content the backend already holds outranks "the desktop app is missing".
	if (state === "indexed" && chunkCount !== null) return `${noun} ${chunkCount.toLocaleString()}개`;
	if (row.install.app.required && row.install.app.installed === false) return `${row.install.app.name} 컴퓨터 앱 필요`;
	if (state === "empty") return `가져온 ${noun} 없음`;
	if (state === "live") return "검색할 때 바로 조회";
	if (row.install.state === "missing") return row.install.detail;
	return "아직 내용을 가져오지 않았습니다";
}

/* ============================================================== Indexing == */

export function IndexingPage({
	snapshot,
	onSaved,
	sources,
	setSources,
	onOpenSource,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly sources: DataSourcesSnapshot | null;
	readonly setSources: (next: DataSourcesSnapshot) => void;
	readonly onOpenSource: (alias: string) => void;
}): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const [busy, setBusy] = useState<string | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);
	const [refreshResult, setRefreshResult] = useState<ConfigRefreshResult | null>(null);
	const rows = sources?.sources ?? [];
	const localCount = listOf(getAt(snapshot.config, ["searchPaths"])).length;
	const local = sources?.local ?? null;
	const [schedule, setSchedule] = useState<RefreshScheduleStatus | null>(null);
	const activity = useIndexActivity();
	const localRunning = busy === "refresh" || activityItem(activity, "local")?.state === "running";
	const syncingOf = (row: DataSourceRow): boolean => row.status === "syncing" || activityItem(activity, `source:${row.id}`)?.state === "running";
	// A run that ends, whoever started it, changes counts and timestamps: re-read them once.
	const wasRunning = useRef(false);
	useEffect(() => {
		const running = activity.state === "running";
		if (wasRunning.current && !running) void settings.sourcesList().then(setSources, () => undefined);
		wasRunning.current = running;
	}, [activity.state, setSources]);
	const now = Date.now();
	const localInterval = ((): number => {
		const value = asRecord(getAt(snapshot.config, ["appIndexing"]))?.refreshIntervalMs;
		return typeof value === "number" ? value : 0;
	})();

	useEffect(() => {
		let live = true;
		void settings
			.refreshScheduleGet()
			.then((status) => {
				if (live) setSchedule(status);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [sources]);

	/** Write one cadence, then make the OS job match the config and show what it now looks like. */
	async function changeInterval(path: readonly string[], ms: number): Promise<void> {
		await run([{ path, value: ms }]);
		try {
			setSchedule(await settings.refreshScheduleApply());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function refreshIndex(): Promise<void> {
		setBusy("refresh");
		setLocalError(null);
		try {
			const result = await settings.configRefresh();
			setRefreshResult(result);
			if (!result.ok && result.error !== null) setLocalError(result.error);
			setSources(await settings.sourcesList());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}

	async function syncOne(id: string): Promise<void> {
		setBusy(id);
		setLocalError(null);
		try {
			const result = await settings.sourcesSync(id);
			if (!result.ok && result.error !== null) setLocalError(result.error);
			setSources(await settings.sourcesList());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}

	async function syncAll(): Promise<void> {
		setBusy("all");
		setLocalError(null);
		try {
			for (const row of rows) {
				if (!row.enabled) continue;
				await settings.sourcesSync(row.id);
			}
			setSources(await settings.sourcesList());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}

	const problem = localError ?? error;
	return (
		<>
			<SettingsPageHead title="인덱싱" description="검색할 폴더와 연결된 앱의 내용이 최신인지 확인하고, 바뀐 부분만 다시 가져옵니다." />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			<Section title="진행 상황">
				<IndexActivityCard snapshot={activity} />
			</Section>
			<Section title="최신화 상태">
				<div className="settings-list">
					<div className="settings-list-row settings-sync-row">
						<button type="button" className="settings-sync-name" onClick={() => onOpenSource("")}>
							<SourceIcon small type="local" label="로컬 폴더" />
							<span className="settings-list-body">
								<span className="settings-list-title">로컬 폴더</span>
								<span className="settings-list-meta" title={schedule?.local?.error ?? undefined}>
									{[localMeta(local, localCount), lastAutoText(schedule?.local, now)].filter((part) => part !== null).join(" · ")}
								</span>
							</span>
						</button>
						<span className="settings-status">
							<StatusDot tone={localRunning ? "run" : local !== null && (local.documentCount ?? 0) > 0 ? "ok" : "warn"} />
							{localRunning ? "새로 고치는 중…" : "사용 중"}
						</span>
						<select
							className="settings-select-compact"
							aria-label="로컬 폴더 최신화 주기"
							value={String(localInterval)}
							onChange={(event) => void changeInterval(["appIndexing", "refreshIntervalMs"], Number(event.target.value))}
						>
							<option value="0">직접</option>
							{INTERVAL_OPTIONS.map((option) => (
								<option key={option.ms} value={option.ms}>{option.label}</option>
							))}
						</select>
						<button
							type="button"
							className="settings-icon-btn"
							aria-label="로컬 폴더 지금 새로 고침"
							title="지금 새로 고침"
							disabled={busy !== null}
							onClick={() => void refreshIndex()}
						>
							<RefreshCw size={16} aria-hidden="true" focusable="false" />
						</button>
					</div>
					{rows.map((row) => (
						<div className="settings-list-row settings-sync-row" key={row.id}>
							<button type="button" className="settings-sync-name" onClick={() => onOpenSource(row.id)}>
								<SourceIcon small type={row.type} label={templateLabel(row.type)} />
								<span className="settings-list-body">
									<span className="settings-list-title">{sourceTitle(row)}</span>
									<span className="settings-list-meta" title={schedule?.sources[row.id]?.error ?? undefined}>
										{[syncingOf(row) ? "최신화 중…" : sourceMeta(row), lastAutoText(schedule?.sources[row.id], now)].filter((part) => part !== null).join(" · ")}
									</span>
								</span>
							</button>
							<span className="settings-status">
								<StatusDot tone={syncingOf(row) ? "run" : sourceTone(row)} />
								{syncingOf(row) ? "최신화 중…" : row.enabled ? "사용 중" : "꺼짐"}
							</span>
							<select
								className="settings-select-compact"
								aria-label={`${row.id} 최신화 주기`}
								value={String(intervalOf(row, snapshot))}
								onChange={(event) => void changeInterval(["datasources", row.id, "pollingIntervalMs"], Number(event.target.value))}
							>
								<option value="0">직접</option>
								{INTERVAL_OPTIONS.map((option) => (
									<option key={option.ms} value={option.ms}>{option.label}</option>
								))}
							</select>
							<button
								type="button"
								className="settings-icon-btn"
								aria-label={`${row.id} 지금 최신화`}
								title="지금 최신화"
								disabled={busy !== null || !row.enabled}
								onClick={() => void syncOne(row.id)}
							>
								<RefreshCw size={16} aria-hidden="true" focusable="false" />
							</button>
						</div>
					))}
				</div>
				{rows.length === 0 ? <Note>연결된 데이터소스가 없습니다. 연결된 앱에서 앱을 추가하세요.</Note> : null}
				<ScheduleNote status={schedule} />
				<div className="settings-sync-footer">
					<span className="settings-list-meta">바뀐 파일과 메시지만 다시 읽습니다. 처음 연결한 앱은 전체를 가져옵니다.</span>
					<button type="button" className="linear-btn" disabled={busy !== null || rows.length === 0} onClick={() => void syncAll()}>모두 지금 최신화</button>
				</div>
				<Row name="로컬 폴더 새로 고침" hint="검색 폴더의 문서를 다시 읽어 검색 색인을 갱신합니다. 바뀐 문서만 처리합니다.">
					<button type="button" className="linear-btn" disabled={busy !== null} onClick={() => void refreshIndex()}>지금 새로 고침</button>
				</Row>
				{refreshResult !== null ? (
					<Note>
						스캔 {refreshResult.scanned} · 기록 {refreshResult.written} · 삭제 {refreshResult.deleted} · 건너뜀 {refreshResult.skipped}
						{refreshResult.diagnostics.length > 0 ? ` · 진단 ${refreshResult.diagnostics.length}건` : ""}
					</Note>
				) : null}
			</Section>
		</>
	);
}

/** The polling interval stored for a datasource; 0 = manual (the app schedules nothing). */
function intervalOf(row: DataSourceRow, snapshot: AutoRagConfigSnapshot): number {
	const stored = asRecord(asRecord(snapshot.config.datasources)?.[row.id]);
	const value = stored?.pollingIntervalMs;
	return typeof value === "number" ? value : 0;
}

/** "방금 / 5분 전 / 3시간 전 / 2일 전" for the last automatic run. */
function agoText(iso: string, now: number): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return "";
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "방금";
	if (minutes < 60) return `${minutes}분 전`;
	if (minutes < 24 * 60) return `${Math.round(minutes / 60)}시간 전`;
	return `${Math.round(minutes / (24 * 60))}일 전`;
}

function lastAutoText(record: ScheduledRunRecord | null | undefined, now: number): string | null {
	if (record === null || record === undefined) return null;
	return `자동 ${agoText(record.at, now)} ${record.ok ? "성공" : "실패"}`;
}

/**
 * One line about the background job, shown only when it matters: a problem
 * (unsupported, install failed, another job also refreshes AutoRAG) or the
 * cadence while something is scheduled. Silent when everything is manual.
 */
function ScheduleNote({ status }: { readonly status: RefreshScheduleStatus | null }): ReactElement | null {
	if (status === null) return null;
	if (!status.supported) {
		return status.wanted ? <Note>이 컴퓨터에서는 앱이 닫혀 있을 때의 자동 새로 고침을 지원하지 않습니다.</Note> : null;
	}
	const parts: ReactElement[] = [];
	if (status.error !== null) parts.push(<Note key="error">자동 새로 고침을 등록하지 못했습니다: {status.error}</Note>);
	if (status.wanted && !status.installed && status.error === null) {
		parts.push(<Note key="missing">자동 새로 고침이 아직 등록되지 않았습니다. 주기를 다시 선택하면 등록합니다.</Note>);
	}
	// Two jobs only double-process the folders when this app's job is also active.
	if (status.conflicts.length > 0 && (status.wanted || status.installed)) {
		parts.push(
			<Note key="conflicts">
				이 컴퓨터에는 AutoRAG를 따로 새로 고치는 예약 작업이 이미 있습니다({status.conflicts.join(" · ")}). 같은 폴더를 두 번 처리하지 않도록 한쪽만 쓰는 것을 권장합니다.
			</Note>,
		);
	}
	if (status.installed && status.wanted && status.intervalMs !== null) {
		const minutes = Math.round(status.intervalMs / 60_000);
		parts.push(
			<Note key="active">
				앱이 꺼져 있어도 {minutes}분마다 확인해, 주기가 된 항목만 새로 고칩니다.
				{status.lastTickAt !== null ? ` 마지막 확인 ${agoText(status.lastTickAt, Date.now())}.` : " 아직 실행된 적이 없습니다."}
			</Note>,
		);
	}
	return parts.length === 0 ? null : <>{parts}</>;
}

/* ================================================================== Apps == */

export function AppsPage({
	snapshot,
	onSaved,
	sources,
	onOpenSource,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly sources: DataSourcesSnapshot | null;
	readonly onOpenSource: (alias: string) => void;
}): ReactElement {
	const [addTemplate, setAddTemplate] = useState<string | null>(null);
	const [addError, setAddError] = useState<string | null>(null);
	const rows = sources?.sources ?? [];
	const connectedTypes = new Set(sourceAliases(snapshot).map((entry) => entry.type));

	async function addConnection(templateId: string, alias: string): Promise<void> {
		setAddError(null);
		try {
			const entry: Record<string, JsonValue> = templateId === alias ? {} : { type: templateId };
			onSaved(await settings.configSet(["datasources", alias], entry));
			setAddTemplate(null);
			onOpenSource(alias);
		} catch (cause) {
			setAddError(cause instanceof Error ? cause.message : String(cause));
			setAddTemplate(null);
		}
	}

	return (
		<>
			<SettingsPageHead title="연결된 앱" description="메신저, 메일, 클라우드의 자료를 Dazzi에서 함께 검색합니다." />
			{addError !== null ? <div className="settings-error" role="alert">{addError}</div> : null}
			<Section title="내 연결">
				{rows.length === 0 ? <Note>연결된 앱이 없습니다. 아래에서 추가하세요.</Note> : null}
				<div className="settings-list">
					{rows.map((row) => (
						<button type="button" className="settings-list-row" key={row.id} onClick={() => onOpenSource(row.id)}>
							<SourceIcon type={row.type} label={templateLabel(row.type)} />
							<span className="settings-list-body">
								<span className="settings-list-title">{sourceTitle(row)}</span>
								<span className="settings-list-meta">{sourceMeta(row)}</span>
							</span>
							<StatusDot tone={sourceTone(row)} />
							<ChevronRight size={16} className="settings-list-chevron" aria-hidden="true" focusable="false" />
						</button>
					))}
				</div>
			</Section>
			<Section title="앱 연결하기" description="추가할 앱을 선택하세요.">
				{GALLERY_GROUPS.map((group) => (
					<div key={group.title}>
						<div className="linear-section-title" style={{ marginTop: 18, fontSize: 13 }}>{group.title}</div>
						<div className="settings-list">
							{group.ids.map((templateId) => {
								const template = TEMPLATE_BY_ID[templateId];
								if (template === undefined) return null;
								return (
									<div className="settings-list-row" key={templateId}>
										<SourceIcon type={templateId} label={template.label} />
										<span className="settings-list-body">
											<span className="settings-list-title">{template.label}</span>
											<span className="settings-list-meta">{template.summary}</span>
										</span>
										{connectedTypes.has(templateId) ? <span className="settings-badge">연결됨</span> : null}
										<button type="button" className="linear-btn" onClick={() => setAddTemplate(templateId)}>
											<Plus size={13} aria-hidden="true" focusable="false" />연결
										</button>
									</div>
								);
							})}
						</div>
					</div>
				))}
			</Section>
			{addTemplate !== null ? (
				<PromptModal
					title={`${templateLabel(addTemplate)} 연결`}
					description="연결 id를 정하고 추가합니다. 비워두면 템플릿 이름을 사용합니다."
					label="연결 id"
					placeholder={addTemplate}
					confirmLabel="연결 추가"
					onCancel={() => { setAddTemplate(null); setAddError(null); }}
					onSubmit={(value) => void addConnection(addTemplate, value)}
				/>
			) : null}
		</>
	);
}

/* ======================================================== Source detail == */

export function SourceDetailPage({
	snapshot,
	onSaved,
	alias,
	sources,
	setSources,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly alias: string;
	readonly sources: DataSourcesSnapshot | null;
	readonly setSources: (next: DataSourcesSnapshot) => void;
}): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const [busy, setBusy] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const entry = asRecord(asRecord(snapshot.config.datasources)?.[alias]);
	const type = entry !== null ? stringOf(entry.type) || alias : alias;
	const template = TEMPLATE_BY_ID[type];
	const connector = entry !== null ? asRecord(entry.connector) : null;
	const row = sources?.sources.find((item) => item.id === alias) ?? null;
	const enabled = entry !== null ? entry.enabled !== false : true;
	const description = entry !== null ? stringOf(entry.description) : "";
	const pollingRaw = entry === null ? undefined : entry.pollingIntervalMs;
	const polling = typeof pollingRaw === "number" ? pollingRaw : 0;

	async function changeInterval(path: readonly string[], ms: number): Promise<void> {
		await run([{ path, value: ms }]);
		try {
			await settings.refreshScheduleApply();
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	const problem = localError ?? error;

	async function refresh(): Promise<void> {
		try {
			setSources(await settings.sourcesList());
		} catch {
			/* keep the last snapshot */
		}
	}

	async function syncNow(): Promise<void> {
		setBusy(true);
		setLocalError(null);
		try {
			const result = await settings.sourcesSync(alias);
			if (!result.ok && result.error !== null) setLocalError(result.error);
			await refresh();
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function removeConnection(): Promise<void> {
		setBusy(true);
		try {
			onSaved(await settings.configRemove(["datasources", alias]));
			setConfirmDelete(false);
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const appRequirement = row?.install.app ?? null;
	const downloadUrl = appRequirement?.required ? TEMPLATE_APP_URLS[type] : undefined;

	return (
		<div className="settings-source is-open" data-source-id={alias}>
			<SettingsPageHead title={sourceTitle({ id: alias, type })} description={template?.summary ?? "이 연결의 설정을 관리합니다."} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			<Section title="연결 상태">
				<Row name="사용 여부" hint="끄면 이 연결을 검색에서 잠시 제외합니다.">
					<Switch
						checked={enabled}
						disabled={busy}
						ariaLabel="사용 여부"
						onChange={() => {
							void run([{ path: ["datasources", alias, "enabled"], value: !enabled }]).then(() => refresh());
						}}
					/>
				</Row>
				{appRequirement !== null && appRequirement.required ? (
					<Row name={`${appRequirement.name} 컴퓨터 앱`} hint={appRequirement.installed === false ? `${appRequirement.name} 내용을 가져오려면 이 Mac에 ${appRequirement.name} 앱이 있어야 합니다.` : `이 Mac의 ${appRequirement.name} 앱에서 내용을 가져옵니다.`}>
						{appRequirement.installed === false ? (
							<button
								type="button"
								className="linear-btn"
								disabled={downloadUrl === undefined}
								onClick={() => {
									const open = window.autorag?.fs?.openUrl;
									if (downloadUrl !== undefined && typeof open === "function") void open(downloadUrl);
								}}
							>
								{appRequirement.name} 다운로드
								<ExternalLink size={13} aria-hidden="true" focusable="false" />
							</button>
						) : null}
						<span className="settings-status">
							<StatusDot tone={appRequirement.installed === false ? "warn" : "ok"} />
							{appRequirement.installed === false ? "필요" : "설치됨"}
						</span>
					</Row>
				) : null}
				<Row name="최신화" hint={row !== null && row.index.indexedAt !== null ? `마지막 최신화 ${new Date(row.index.indexedAt).toLocaleString()}` : "아직 내용을 가져오지 않았습니다."}>
					<span className="settings-status">
						<StatusDot tone={row === null ? "off" : sourceTone(row)} />
						{row === null ? "상태 없음" : sourceMeta(row)}
					</span>
					<button type="button" className="linear-btn settings-btn-quiet" disabled={busy || row === null} onClick={() => void syncNow()}>지금 최신화</button>
				</Row>
				<Row name="최신화 주기" hint="이 앱이 닫혀 있어도 컴퓨터가 정해진 간격으로 새 내용을 가져옵니다. 직접으로 두면 직접 누를 때만 가져옵니다.">
					<select
						className="linear-select"
						aria-label="최신화 주기"
						value={String(polling)}
						onChange={(event) => void changeInterval(["datasources", alias, "pollingIntervalMs"], Number(event.target.value))}
					>
						<option value="0">직접</option>
						{INTERVAL_OPTIONS.map((option) => (
							<option key={option.ms} value={option.ms}>{option.label}</option>
						))}
					</select>
				</Row>
			</Section>
			<Section title="기본 설정">
				<Row name="AI에게 알려줄 설명" hint="이 연결을 언제 참고하면 좋은지 적어주세요." stack>
					<textarea
						className="linear-textarea"
						aria-label="설명"
						rows={2}
						value={description}
						onChange={(event) => void run([{ path: ["datasources", alias, "description"], value: event.target.value }])}
					/>
				</Row>
			</Section>
			{template !== undefined && template.groups.length > 0 ? (
				<Section title={`${template.label} 설정`}>
					{template.groups.map((group) => (
						<div key={group.title}>
							{group.fields.map((field) => (
								<ConnectorFieldRow
									key={field.key}
									field={field}
									value={connector === null ? undefined : getAt(connector, field.key.split("."))}
									onChange={(value) => {
										const path = ["datasources", alias, "connector", ...field.key.split(".")];
										void run([value === undefined ? { path, remove: true } : { path, value: value as JsonValue }]);
									}}
								/>
							))}
						</div>
					))}
				</Section>
			) : null}
			<Section title="연결 해제">
				<Row name="연결 해제" hint="Dazzi 검색에서만 제거되며 원본 앱의 데이터는 지워지지 않습니다.">
					<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
						<Trash2 size={14} aria-hidden="true" focusable="false" />연결 해제
					</button>
				</Row>
			</Section>
			{confirmDelete ? (
				<ModalShell onClose={() => setConfirmDelete(false)}>
					<h2>연결을 해제할까요?</h2>
					<p>'{alias}' 연결이 Dazzi 검색에서 제거됩니다. 원본 앱의 데이터는 지워지지 않습니다.</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setConfirmDelete(false)}>취소</button>
						<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => void removeConnection()}>연결 해제</button>
					</ModalActions>
				</ModalShell>
			) : null}
		</div>
	);
}

function ConnectorFieldRow({ field, value, onChange }: { readonly field: FieldSpec; readonly value: unknown; readonly onChange: (value: unknown) => void }): ReactElement {
	if (field.kind === "boolean") {
		const checked = typeof value === "boolean" ? value : field.defaultValue === true;
		return (
			<Row name={field.label} hint={field.hint ?? ""}>
				<Switch checked={checked} ariaLabel={field.label} onChange={() => onChange(!checked)} />
			</Row>
		);
	}
	const stack = field.kind === "stringList" || field.kind === "pathList" || field.kind === "env" || field.kind === "feeds";
	return (
		<Row name={field.label} hint={field.hint ?? ""} stack={stack}>
			<ConnectorFieldInput field={field} value={value} onChange={onChange} />
		</Row>
	);
}

/** Official download pages the app links to when a connector needs a desktop app. */
const TEMPLATE_APP_URLS: Readonly<Record<string, string>> = {
	telegram: "https://macos.telegram.org/",
	whatsapp: "https://www.whatsapp.com/download/mac",
	slack: "https://slack.com/downloads/mac",
	discord: "https://discord.com/download",
	notion: "https://www.notion.com/desktop",
	lark: "https://www.larksuite.com/download",
	kakao: "https://apps.apple.com/kr/app/kakaotalk/id869223134",
	obsidian: "https://obsidian.md/download",
};
