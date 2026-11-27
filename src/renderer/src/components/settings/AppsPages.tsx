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
import { EmbeddingDaemonSection } from "./ToolVersions";
import { useTranslation } from "react-i18next";
import { ChevronRight, ExternalLink, Minus, Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
	AutoRagConfigSnapshot,
	ConfigRefreshResult,
	DataSourceRow,
	DataSourcesSnapshot,
	JsonObject,
	JsonValue,
	RefreshScheduleStatus,
	ScheduledRunPauseReason,
	ScheduledRunRecord,
} from "../../../../shared/settings-contract";
import { isCalendarDatasourceType } from "../../../../shared/calendar-platform";
import { newDatasourceEntry } from "../../../../shared/datasource-defaults";
import { datasourceSupported } from "../../../../shared/messenger-platform";
import { t, type LocaleKey } from "../../../../shared/i18n/core";
import { excludePath, includePath } from "../../../../shared/index-scope-edit";
import { readScheduleSettings, scheduleUpdates, type ScheduleSettings } from "../../../../shared/refresh-schedule-settings";
import { hostPlatform } from "../../lib/shortcuts";
import { ConnectorFieldInput, sourceTitle, TEMPLATE_BY_ID, templateLabel, type FieldSpec } from "./datasourceTemplates";
import { ModalShell, ModalActions, Note, PlainRow, PromptModal, Row, Section, SettingsPageHead, StatusDot } from "./SettingsKit";
import { SelectField } from "./SelectField";
import { SourceIcon } from "./SourceIcon";
import { asRecord, getAt, listOf, listUpdate, stringOf, useConfigWriter } from "./configSupport";
import { FullDiskAccessDialog } from "../primitives/FullDiskAccessDialog";
import { Switch } from "../primitives/Switch";
import { useIndexActivity } from "../../hooks/useIndexActivity";
import { activityItem } from "../../state/index-activity";
import { IndexStatusBanner } from "./IndexStatusBanner";
import { IndexMapPanel } from "./index-map/IndexMapPanel";
import { ExclusionsSection, FileNameWatchRow, SearchFoldersSection, useScopeEditor } from "./IndexScope";
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";

import { REFRESH_INTERVALS } from "../../../../shared/settings-options";

const settings = window.autorag.settings;

const GALLERY_GROUPS: readonly { readonly title: LocaleKey; readonly ids: readonly string[] }[] = [
	{ title: "settingsSources.apps.groups.messengers", ids: ["slack", "kakao", "discord", "telegram", "whatsapp", "lark"] },
	{ title: "settingsSources.apps.groups.docsNotes", ids: ["notion", "obsidian", "clawgallery"] },
	{ title: "settingsSources.apps.groups.aiSessions", ids: ["wombat"] },
	{ title: "settingsSources.apps.groups.mail", ids: ["mailcrawl"] },
	{ title: "settingsSources.apps.groups.cloudDev", ids: ["cloud-drive", "github", "github-gist"] },
	{ title: "settingsSources.apps.groups.newsOther", ids: ["rss", "hister", "calendar", "spotlight"] },
];

function sourceAliases(snapshot: AutoRagConfigSnapshot): readonly { readonly alias: string; readonly type: string }[] {
	const datasources = asRecord(snapshot.config.datasources);
	if (datasources === null) return [];
	return Object.entries(datasources).map(([alias, raw]) => {
		const record = asRecord(raw);
		return { alias, type: record !== null ? stringOf(record.type) || alias : alias };
	});
}

/** A dot tone for a datasource row: syncing, blocked, paused, or healthy. */
function sourceTone(row: DataSourceRow): "ok" | "warn" | "run" | "off" {
	if (row.status === "syncing") return "run";
	if (!row.enabled || row.status === "paused") return "off";
	if (row.index.state === "indexed" || row.index.state === "live") return "ok";
	return "warn";
}

const UNIT_LABEL: Readonly<Record<NonNullable<DataSourceRow["index"]["unit"]>, LocaleKey>> = {
	message: "settingsSources.units.message",
	document: "settingsSources.units.document",
	image: "settingsSources.units.image",
	session: "settingsSources.units.session",
};

/** The local-folder row's meta line: what the last refresh actually parsed. */
function localMeta(local: DataSourcesSnapshot["local"] | null, folderCount: number): string {
	const folders = t("settingsSources.meta.folders", { count: folderCount });
	if (local === null || local.documentCount === null) return folders;
	if (local.documentCount === 0) return `${t("settingsSources.meta.noDocsYet")} · ${folders}`;
	return `${t("settingsSources.meta.chunkCount", { noun: t("settingsSources.units.document"), count: local.documentCount.toLocaleString() })} · ${folders}`;
}

function sourceMeta(row: DataSourceRow): string {
	if (!row.enabled) return t("settingsSources.common.off");
	if (row.status === "syncing") return t("settingsSources.common.syncing");
	const { state, chunkCount, unit } = row.index;
	const noun = unit === null ? t("settingsSources.common.itemNoun") : t(UNIT_LABEL[unit]);
	// Content the backend already holds outranks "the desktop app is missing".
	if (state === "indexed" && chunkCount !== null) return t("settingsSources.meta.chunkCount", { noun, count: chunkCount.toLocaleString() });
	if (row.install.app.required && row.install.app.installed === false) return t("settingsSources.meta.appNeeds", { name: row.install.app.name });
	if (state === "empty") return t("settingsSources.meta.importedNone", { noun });
	if (state === "live") return t("settingsSources.meta.liveQuery");
	if (row.install.state === "unsupported" && !datasourceSupported(row.type, hostPlatform())) return t("settingsSources.meta.notOnThisComputer");
	if (row.install.state === "unsupported") return row.install.detail;
	if (row.install.state === "missing") return row.install.detail;
	return t("settingsSources.meta.notFetchedYet");
}

/** When the background job may refresh: only on AC power, and/or only inside a daily time window. Stored as `refresh.schedule`. */
function ScheduleConditions({ config, onApply }: { readonly config: JsonObject; readonly onApply: (settings: ScheduleSettings) => Promise<void> }): ReactElement {
	const settings = readScheduleSettings(config);
	const [problem, setProblem] = useState<string | null>(null);
	async function change(patch: Partial<ScheduleSettings>): Promise<void> {
		setProblem(null);
		try {
			await onApply({ ...settings, ...patch });
		} catch {
			setProblem(t("settingsSources.indexing.scheduleWindowSame"));
		}
	}
	// The redesigned row style (as on 일반): a 14px bold title, then plain rows with no rule between them.
	return (
		<section className="scope-section" data-index-scope="schedule">
			<h3 className="scope-section-title">{t("settingsSources.indexing.scheduleTitle")}</h3>
			<div className="settings-plain plain-section-rows">
				<PlainRow name={t("settingsSources.indexing.scheduleAcOnlyName")} hint={t("settingsSources.indexing.scheduleAcOnlyHint")}>
					<Switch checked={settings.acOnly} onChange={() => void change({ acOnly: !settings.acOnly })} ariaLabel={t("settingsSources.indexing.scheduleAcOnlyName")} />
				</PlainRow>
				<PlainRow name={t("settingsSources.indexing.scheduleWindowName")} hint={t("settingsSources.indexing.scheduleWindowHint")}>
					<Switch checked={settings.windowEnabled} onChange={() => void change({ windowEnabled: !settings.windowEnabled })} ariaLabel={t("settingsSources.indexing.scheduleWindowName")} />
				</PlainRow>
				{settings.windowEnabled ? (
					<PlainRow name={`${t("settingsSources.indexing.scheduleWindowStart")} – ${t("settingsSources.indexing.scheduleWindowEnd")}`} hint="">
						<input type="time" className="settings-select-compact" aria-label={t("settingsSources.indexing.scheduleWindowStart")} value={settings.start} onChange={(event) => event.target.value !== "" && void change({ start: event.target.value })} />
						<input type="time" className="settings-select-compact" aria-label={t("settingsSources.indexing.scheduleWindowEnd")} value={settings.end} onChange={(event) => event.target.value !== "" && void change({ end: event.target.value })} />
					</PlainRow>
				) : null}
			</div>
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
		</section>
	);
}

/* ============================================================== Indexing == */

export function IndexingPage({
	snapshot,
	onSaved,
	sources,
	sourcesPending,
	setSources,
	onOpenSource,
	onOpenApps,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly sources: DataSourcesSnapshot | null;
	/** The first datasource scan has not answered yet: `sources` is unknown, not empty. */
	readonly sourcesPending: boolean;
	readonly setSources: (next: DataSourcesSnapshot) => void;
	readonly onOpenSource: (alias: string) => void;
	/** 앱 연결: the page where apps are connected (Settings → 모든 연결). */
	readonly onOpenApps?: () => void;
}): ReactElement {
	useTranslation();
	const { run, saving, error } = useConfigWriter(onSaved);
	const editor = useScopeEditor({ snapshot, run, saving });
	const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
	const [localError, setLocalError] = useState<string | null>(null);
	const [refreshResult, setRefreshResult] = useState<ConfigRefreshResult | null>(null);
	const rows = sources?.sources ?? [];
	const searchPaths = listOf(getAt(snapshot.config, ["searchPaths"]));
	const excludePaths = listOf(getAt(snapshot.config, ["excludePaths"]));
	const localCount = searchPaths.length;
	const local = sources?.local ?? null;
	const [schedule, setSchedule] = useState<RefreshScheduleStatus | null>(null);
	const activity = useIndexActivity();
	const localState = activityItem(activity, "local")?.state ?? null;
	const localRunning = pendingKeys.has("local") || localState === "running" || localState === "queued";
	const rowActivityState = (row: DataSourceRow): "running" | "queued" | null => {
		const item = activityItem(activity, `source:${row.id}`);
		if (row.status === "syncing" || item?.state === "running") return "running";
		if (pendingKeys.has(`source:${row.id}`) || item?.state === "queued") return "queued";
		return null;
	};
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
		const unsubscribe = settings.onRefreshScheduleChanged?.((status) => {
			if (live) setSchedule(status);
		});
		return () => {
			live = false;
			unsubscribe?.();
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

	function markPending(key: string, active: boolean): void {
		setPendingKeys((prev) => {
			if (prev.has(key) === active) return prev;
			const next = new Set(prev);
			if (active) next.add(key);
			else next.delete(key);
			return next;
		});
	}

	async function refreshIndex(): Promise<void> {
		markPending("local", true);
		setLocalError(null);
		try {
			const result = await settings.configRefresh();
			setRefreshResult(result);
			if (!result.ok && result.error !== null) setLocalError(result.error);
			setSources(await settings.sourcesList());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			markPending("local", false);
		}
	}

	async function syncOne(id: string): Promise<void> {
		const key = `source:${id}`;
		markPending(key, true);
		setLocalError(null);
		try {
			const result = await settings.sourcesSync(id);
			if (!result.ok && result.error !== null) setLocalError(result.error);
			setSources(await settings.sourcesList());
		} catch (cause) {
			setLocalError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			markPending(key, false);
		}
	}

	/** 모두 지금 최신화: the local folders and every app that is on and idle. */
	async function syncAll(): Promise<void> {
		setLocalError(null);
		const targets = rows.filter((row) => row.enabled && rowActivityState(row) === null);
		await Promise.all([...(localRunning ? [] : [refreshIndex()]), ...targets.map((row) => syncOne(row.id))]);
	}
	const nothingToSync = localRunning && rows.every((row) => !row.enabled || rowActivityState(row) !== null);

	const problem = editor.problem ?? localError ?? error;
	return (
		<div className="indexing-page">
			<SettingsPageHead title={t("settingsSources.indexing.title")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{/* Figma 532:9970: 검색할 폴더 → 진행 상황 → 제외한 항목, then 최신으로 유지 and 파일 이름 바로 반영 under a rule. */}
			<div className="scope-page indexing-sections">
				<IndexMapPanel
					searchPaths={searchPaths}
					excludePaths={excludePaths}
					busy={saving}
					onExclude={(path) => void run([listUpdate("excludePaths", excludePath(excludePaths, path))])}
					onInclude={(path) => void run([listUpdate("excludePaths", includePath(excludePaths, path))])}
					header={(scope) => <SearchFoldersSection editor={editor} scope={scope} />}
					progressHead={(scope) => (
						<div className="index-map-head">
							<h3 className="scope-section-title">{t("settingsSources.indexing.progress")}</h3>
							<IndexStatusBanner
								snapshot={activity}
								totals={scope.totals}
								paused={schedule?.wanted === true ? schedule.paused : null}
								lastRunAt={latestOf(activity.finishedAt, schedule?.local?.at ?? null)}
							/>
						</div>
					)}
				/>
				<ExclusionsSection editor={editor} snapshot={snapshot} />
				<hr className="scope-divider" />
				<section className="scope-section" data-index-scope="refresh">
					<div className="scope-section-head">
						<div className="scope-section-text">
							<h3 className="scope-section-title">{t("settingsSources.indexing.keepTitle")}</h3>
							<p className="scope-section-desc">{t("settingsSources.indexing.keepDesc")}</p>
						</div>
						<button type="button" className={cn("scope-primary-btn scope-secondary-btn", buttonClass({ size: "md" }))} data-action="sync-all" disabled={nothingToSync} onClick={() => void syncAll()}>
							{t("settingsSources.indexing.syncAll")}
						</button>
					</div>
					<div className="settings-list">
						<div className="settings-list-row settings-sync-row">
							<div className="settings-sync-name">
								<SourceIcon small type="local" label={t("settingsSources.indexing.localFolder")} />
								<span className="settings-list-body">
									<span className="settings-list-title">{t("settingsSources.indexing.localFolder")}</span>
									<span className="settings-list-meta" title={schedule?.local?.error ?? undefined}>
										{[localMeta(local, localCount), lastAutoText(schedule?.local, now)].filter((part) => part !== null).join(" · ")}
									</span>
								</span>
							</div>
							<span className="settings-status">
								<StatusDot tone={localRunning ? "run" : local !== null && (local.documentCount ?? 0) > 0 ? "ok" : "warn"} />
								{localRunning ? t("settingsSources.indexing.localUpdating") : t("settingsSources.common.inUse")}
							</span>
							<SelectField
								className="settings-select-compact"
								aria-label={t("settingsSources.indexing.localIntervalAria")}
								value={String(localInterval)}
								options={[{ value: "0", label: t("settingsSources.common.manual") }, ...REFRESH_INTERVALS.map((option) => ({ value: String(option.ms), label: t(option.label) }))]}
								onValueChange={(value) => void changeInterval(["appIndexing", "refreshIntervalMs"], Number(value))}
							/>
							<button
								type="button"
								className="settings-icon-btn"
								aria-label={t("settingsSources.indexing.refreshLocalAria")}
								title={t("settingsSources.indexing.refreshTitle")}
								disabled={localRunning}
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
											{[
												rowActivityState(row) === "running"
													? t("settingsSources.common.syncing")
													: rowActivityState(row) === "queued"
														? t("indexActivity.queued")
														: sourceMeta(row),
												lastAutoText(schedule?.sources[row.id], now),
											]
												.filter((part) => part !== null)
												.join(" · ")}
										</span>
									</span>
								</button>
								<span className="settings-status">
									<StatusDot tone={rowActivityState(row) === "running" ? "run" : rowActivityState(row) === "queued" ? "off" : sourceTone(row)} />
									{rowActivityState(row) === "running"
										? t("settingsSources.common.syncing")
										: rowActivityState(row) === "queued"
											? t("indexActivity.queued")
											: row.enabled
												? t("settingsSources.common.inUse")
												: t("settingsSources.common.off")}
								</span>
								{row.index.state === "live" ? (
									<span className="settings-sync-live">{t("settingsSources.indexing.liveLabel")}</span>
								) : TEMPLATE_BY_ID[row.type]?.polling !== false ? (
									<SelectField
										className="settings-select-compact"
										aria-label={t("settingsSources.indexing.rowIntervalAria", { id: row.id })}
										value={String(intervalOf(row, snapshot))}
										options={[{ value: "0", label: t("settingsSources.common.manual") }, ...REFRESH_INTERVALS.map((option) => ({ value: String(option.ms), label: t(option.label) }))]}
										onValueChange={(value) => void changeInterval(["datasources", row.id, "pollingIntervalMs"], Number(value))}
									/>
								) : null}
								{/* A source asked at search time has nothing to read ahead of it. */}
								{row.index.state === "live" ? null : (
									<button
										type="button"
										className="settings-icon-btn"
										aria-label={t("settingsSources.indexing.rowRefreshAria", { id: row.id })}
										title={t("settingsSources.indexing.rowRefreshTitle")}
										disabled={!row.enabled || rowActivityState(row) !== null}
										onClick={() => void syncOne(row.id)}
									>
										<RefreshCw size={16} aria-hidden="true" focusable="false" />
									</button>
								)}
							</div>
						))}
					<button type="button" className="settings-list-row settings-sync-row settings-sync-add" data-action="connect-app" onClick={() => onOpenApps?.()}>
							<Plus size={15} aria-hidden="true" focusable="false" />
							<span className="settings-list-title">{t("settingsSources.indexing.connectApp")}</span>
							<span className="settings-list-meta">{t("settingsSources.indexing.connectAppHint")}</span>
						</button>
					</div>

					{sourcesPending && rows.length === 0 ? <Note>{t("settingsSources.common.checking")}</Note> : null}
					<ScheduleNote status={schedule} />
					{refreshResult !== null ? (
						<Note>
							{t("settingsSources.indexing.scanned", { scanned: refreshResult.scanned, written: refreshResult.written, deleted: refreshResult.deleted, skipped: refreshResult.skipped })}
							{refreshResult.diagnostics.length > 0 ? t("settingsSources.indexing.diagnostics", { count: refreshResult.diagnostics.length }) : ""}
						</Note>
					) : null}
				</section>
				<hr className="scope-divider" />
				<ScheduleConditions config={snapshot.config} onApply={(next) => run(scheduleUpdates(next))} />
				<hr className="scope-divider" />
				<FileNameWatchRow snapshot={snapshot} run={run} />
				{/* Once on Settings → 정보: the embedding server search and indexing depend on. */}
				<EmbeddingDaemonSection />
			</div>
			{editor.prompt}
		</div>
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
	if (minutes < 1) return t("settingsSources.common.justNow");
	if (minutes < 60) return t("settingsSources.common.minutesAgo", { count: minutes });
	if (minutes < 24 * 60) return t("settingsSources.common.hoursAgo", { count: Math.round(minutes / 60) });
	return t("settingsSources.common.daysAgo", { count: Math.round(minutes / (24 * 60)) });
}

/** The later of two ISO times, either of which may be missing. */
function latestOf(a: string | null, b: string | null): string | null {
	if (a === null) return b;
	if (b === null) return a;
	return Date.parse(a) >= Date.parse(b) ? a : b;
}

function lastAutoText(record: ScheduledRunRecord | null | undefined, now: number): string | null {
	if (record === null || record === undefined) return null;
	return record.ok ? t("settingsSources.common.autoOk", { ago: agoText(record.at, now) }) : t("settingsSources.common.autoFail", { ago: agoText(record.at, now) });
}

/**
 * One line about the background job, shown only when it matters: a problem
 * (unsupported, install failed, another job also refreshes AutoRAG) or the
 * cadence while something is scheduled. Silent when everything is manual.
 */
const PAUSE_KEYS = {
	battery: "settingsSources.indexing.schedulePausedBattery",
	"outside-window": "settingsSources.indexing.schedulePausedWindow",
	"outside-day": "settingsSources.indexing.schedulePausedDay",
} as const satisfies Record<ScheduledRunPauseReason, LocaleKey>;

function ScheduleNote({ status }: { readonly status: RefreshScheduleStatus | null }): ReactElement | null {
	useTranslation();
	if (status === null) return null;
	if (!status.supported) {
		return status.wanted ? <Note>{t("settingsSources.indexing.scheduleUnsupported")}</Note> : null;
	}
	const parts: ReactElement[] = [];
	if (status.error !== null) parts.push(<Note key="error">{t("settingsSources.indexing.scheduleRegisterFailed", { error: status.error })}</Note>);
	if (status.wanted && !status.installed && status.error === null) {
		parts.push(<Note key="missing">{t("settingsSources.indexing.scheduleNotRegistered")}</Note>);
	}
	// Two jobs only double-process the folders when this app's job is also active.
	if (status.conflicts.length > 0 && (status.wanted || status.installed)) {
		parts.push(
			<Note key="conflicts">
				{t("settingsSources.indexing.scheduleConflicts", { list: status.conflicts.join(" · ") })}
			</Note>,
		);
	}
	if (status.installed && status.wanted && status.intervalMs !== null) {
		const minutes = Math.round(status.intervalMs / 60_000);
		parts.push(
			<Note key="active">
				{t("settingsSources.indexing.scheduleActive", { minutes })}
				{status.lastTickAt !== null ? ` ${t("settingsSources.indexing.scheduleLastCheck", { ago: agoText(status.lastTickAt, Date.now()) })}` : ` ${t("settingsSources.indexing.scheduleNever")}`}
			</Note>,
		);
	}
	// The job recorded that `refresh.schedule` held due work back; the status already drops it once the schedule is gone.
	if (status.wanted && status.paused !== null) {
		parts.push(
			<Note key="paused">
				{t(PAUSE_KEYS[status.paused.reason], { ago: agoText(status.paused.at, Date.now()) })}
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
	sourcesPending,
	onOpenSource,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly sources: DataSourcesSnapshot | null;
	/** The first datasource scan has not answered yet: `sources` is unknown, not empty. */
	readonly sourcesPending: boolean;
	readonly onOpenSource: (alias: string) => void;
}): ReactElement {
	useTranslation();
	const [addTemplate, setAddTemplate] = useState<string | null>(null);
	const [addError, setAddError] = useState<string | null>(null);
	/** The connection 연결해제 asked about; it goes only after the confirmation. */
	const [disconnecting, setDisconnecting] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const rows = sources?.sources ?? [];

	async function disconnect(alias: string): Promise<void> {
		setBusy(true);
		setAddError(null);
		try {
			onSaved(await settings.configRemove(["datasources", alias]));
			setDisconnecting(null);
		} catch (cause) {
			setAddError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function addConnection(templateId: string, alias: string): Promise<void> {
		setAddError(null);
		try {
			const entry = newDatasourceEntry(templateId, alias);
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
			<SettingsPageHead title={t("settingsSources.apps.title")} description={t("settingsSources.apps.desc")} />
			{addError !== null ? <div className="settings-error" role="alert">{addError}</div> : null}
			<div className="settings-apps">
			<Section title={t("settingsSources.apps.myConnections")}>
				{rows.length === 0 ? <p className="settings-apps-empty">{sourcesPending ? t("settingsSources.common.checking") : t("settingsSources.apps.empty")}</p> : null}
				<div className="settings-list settings-apps-mine">
					{rows.map((row) => (
						// The name opens the connection's own page; 연결해제 removes it after a confirmation (Figma 387:4551).
						<div className="settings-list-row" key={row.id}>
							<button type="button" className="settings-apps-open" onClick={() => onOpenSource(row.id)}>
								<SourceIcon type={row.type} label={templateLabel(row.type)} />
								<span className="settings-list-body">
									<span className="settings-list-title">{sourceTitle(row)}</span>
									<span className="settings-list-meta">{sourceMeta(row)}</span>
								</span>
							</button>
							<button type="button" className={cn("linear-btn settings-apps-btn", buttonClass({ size: "md" }))} disabled={busy} onClick={() => setDisconnecting(row.id)}>
								<Minus size={14} aria-hidden="true" focusable="false" />{t("settingsSources.apps.disconnect")}
							</button>
						</div>
					))}
				</div>
			</Section>
			{/* Figma 403:6999: a rule closes 내 연결 before 앱 연결하기. */}
			<hr className="settings-apps-divider" />
			<Section title={t("settingsSources.apps.connectApps")}>
				{GALLERY_GROUPS.map((group) => (
					<div key={group.title}>
						<div className="settings-apps-group">{t(group.title)}</div>
						<div className="settings-list">
							{group.ids.map((templateId) => {
								const template = TEMPLATE_BY_ID[templateId];
								if (template === undefined) return null;
								// KakaoTalk is read through a macOS-only program (lazykatok): it is not offered at all elsewhere.
								if (templateId === "kakao" && !datasourceSupported(templateId, hostPlatform())) return null;
								// Calendar reads EventKit, WhatsApp reads the Mac app's database and Spotlight runs mdfind, so each can only be connected on a Mac; each names its own reason.
								const macOnlyKey = templateId === "calendar" ? "settingsSources.apps.macOnlyCalendar" : templateId === "spotlight" ? "settingsSources.apps.macOnlySpotlight" : templateId === "whatsapp" ? "settingsSources.apps.macOnlyWhatsapp" : null;
								const available = macOnlyKey === null || datasourceSupported(templateId, hostPlatform());
								return (
									<div className="settings-list-row" key={templateId}>
										<SourceIcon type={templateId} label={template.label} />
										<span className="settings-list-body">
											<span className="settings-list-title">{template.label}</span>
											<span className="settings-list-meta">{available || macOnlyKey === null ? t(template.summary) : t(macOnlyKey)}</span>
										</span>
										<button type="button" className={cn("linear-btn settings-apps-btn", buttonClass({ size: "md" }))} disabled={!available} onClick={() => setAddTemplate(templateId)}>
											<Plus size={14} aria-hidden="true" focusable="false" />{t("settingsSources.apps.connect")}
										</button>
									</div>
								);
							})}
						</div>
					</div>
				))}
			</Section>
			</div>
			{disconnecting !== null ? (
				<ModalShell className="settings-alert" onClose={() => setDisconnecting(null)}>
					<h2>{t("settingsSources.sourceDetail.confirmTitle")}</h2>
					<p>{t("settingsSources.sourceDetail.confirmBody", { alias: disconnecting })}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setDisconnecting(null)}>{t("common.cancel")}</button>
						<button type="button" className="linear-btn is-danger is-danger-solid" disabled={busy} onClick={() => void disconnect(disconnecting)}>{t("settingsSources.apps.disconnect")}</button>
					</ModalActions>
				</ModalShell>
			) : null}
			{addTemplate !== null ? (
				<PromptModal
					title={t("settingsSources.apps.promptTitle", { name: templateLabel(addTemplate) })}
					description={t("settingsSources.apps.promptDesc")}
					label={t("settingsSources.apps.promptLabel")}
					placeholder={addTemplate}
					confirmLabel={t("settingsSources.apps.promptConfirm")}
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
	sourcesPending,
	setSources,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly alias: string;
	readonly sources: DataSourcesSnapshot | null;
	/** The first datasource scan has not answered yet: `sources` is unknown, not empty. */
	readonly sourcesPending: boolean;
	readonly setSources: (next: DataSourcesSnapshot) => void;
}): ReactElement {
	useTranslation();
	const { run, error } = useConfigWriter(onSaved);
	const [busy, setBusy] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [fdaNeeded, setFdaNeeded] = useState(false);
	const [fdaDialogOpen, setFdaDialogOpen] = useState(false);
	const activity = useIndexActivity();
	const liveSourceState = activityItem(activity, `source:${alias}`)?.state ?? null;
	const sourceSyncActive = busy || liveSourceState === "running" || liveSourceState === "queued";
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
	const downloadUrl = appRequirement?.required ? appDownloadUrl(type, hostPlatform()) : undefined;
	const mailPaths = connector !== null ? listOf(connector.paths) : [];
	const usesProtectedStore =
		hostPlatform() === "darwin" &&
		(type === "kakao" || (type === "mailcrawl" && mailPaths.some((item) => item.includes("/Library/Mail"))));

	useEffect(() => {
		if (!usesProtectedStore) {
			setFdaNeeded(false);
			return;
		}
		let live = true;
		const check = (): void => {
			void window.autorag?.onboarding
				?.permissions()
				.then((status) => {
					if (live) setFdaNeeded(status.fullDiskAccess === false);
				})
				.catch(() => undefined);
		};
		check();
		window.addEventListener("focus", check);
		return () => {
			live = false;
			window.removeEventListener("focus", check);
		};
	}, [usesProtectedStore]);
	return (
		<div className="settings-source is-open" data-source-id={alias}>
			<SettingsPageHead title={sourceTitle({ id: alias, type })} description={template !== undefined ? t(template.summary) : t("settingsSources.sourceDetail.fallbackSummary")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{row?.install.state === "unsupported" && isCalendarDatasourceType(type) ? <Note>{t("settingsSources.sourceDetail.macOnlyNote")}</Note> : null}
			{row?.install.state === "unsupported" && type === "kakao" ? <Note>{t("settingsSources.sourceDetail.kakaoOnlyNote")}</Note> : null}
			{row?.install.state === "unsupported" && type === "whatsapp" ? <Note>{t("settingsSources.sourceDetail.whatsappOnlyNote")}</Note> : null}
			{row?.install.state === "unsupported" && type === "spotlight" ? <Note>{t("settingsSources.sourceDetail.spotlightOnlyNote")}</Note> : null}
			<Section title={t("settingsSources.sourceDetail.statusSection")}>
				<Row name={t("settingsSources.sourceDetail.enabledName")} hint={t("settingsSources.sourceDetail.enabledHint")}>
					<Switch
						checked={enabled}
						disabled={busy}
						ariaLabel={t("settingsSources.sourceDetail.enabledName")}
						onChange={() => {
							const turningOn = !enabled;
							void run([{ path: ["datasources", alias, "enabled"], value: turningOn }]).then(() => {
								void refresh();
								if (turningOn && fdaNeeded) setFdaDialogOpen(true);
							});
						}}
					/>
				</Row>
				{usesProtectedStore && fdaNeeded ? (
					<Row name={t("fullDiskAccess.rowName")} hint={t("fullDiskAccess.leadSource")}>
						<button type="button" className="linear-btn" data-action="source-grant-fda" onClick={() => setFdaDialogOpen(true)}>
							{t("fullDiskAccess.open")}
						</button>
					</Row>
				) : null}
				{appRequirement !== null && appRequirement.required ? (
					<Row
						name={t("settingsSources.sourceDetail.appRow", { name: appRequirement.name })}
						hint={
							hostPlatform() === "darwin"
								? appRequirement.installed === false
									? t("settingsSources.sourceDetail.appHintMissing", { name: appRequirement.name })
									: t("settingsSources.sourceDetail.appHintInstalled", { name: appRequirement.name })
								: appRequirement.installed === false
									? t("settingsSources.sourceDetail.appHintMissingPc", { name: appRequirement.name })
									: t("settingsSources.sourceDetail.appHintInstalledPc", { name: appRequirement.name })
						}
					>
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
								{t("settingsSources.sourceDetail.appDownload", { name: appRequirement.name })}
								<ExternalLink size={13} aria-hidden="true" focusable="false" />
							</button>
						) : null}
						<span className="settings-status">
							<StatusDot tone={appRequirement.installed === false ? "warn" : appRequirement.installed === null ? "off" : "ok"} />
							{appRequirement.installed === false
								? t("settingsSources.sourceDetail.appNeeded")
								: appRequirement.installed === null
									? t("settingsSources.sourceDetail.appUnknown")
									: t("settingsSources.sourceDetail.appInstalled")}
						</span>
					</Row>
				) : null}
				<Row name={t("settingsSources.sourceDetail.refreshName")} hint={row !== null && row.index.indexedAt !== null ? t("settingsSources.sourceDetail.refreshLast", { date: new Date(row.index.indexedAt).toLocaleString() }) : t("settingsSources.sourceDetail.refreshNever")}>
					<span className="settings-status">
						<StatusDot tone={liveSourceState === "running" ? "run" : liveSourceState === "queued" ? "off" : row === null ? "off" : sourceTone(row)} />
						{liveSourceState === "running"
							? t("settingsSources.common.syncing")
							: liveSourceState === "queued"
								? t("indexActivity.queued")
								: row === null
									? (sourcesPending ? t("settingsSources.common.checking") : t("settingsSources.sourceDetail.stateNone"))
									: sourceMeta(row)}
					</span>
					<button type="button" className="linear-btn settings-btn-quiet" disabled={sourceSyncActive || row === null} onClick={() => void syncNow()}>{t("settingsSources.indexing.rowRefreshTitle")}</button>
				</Row>
				{template?.polling !== false ? (
					<Row name={t("settingsSources.sourceDetail.intervalName")} hint={t("settingsSources.sourceDetail.intervalHint")}>
						<SelectField
							className="linear-select"
							aria-label={t("settingsSources.sourceDetail.intervalName")}
							value={String(polling)}
							options={[{ value: "0", label: t("settingsSources.common.manual") }, ...REFRESH_INTERVALS.map((option) => ({ value: String(option.ms), label: t(option.label) }))]}
							onValueChange={(value) => void changeInterval(["datasources", alias, "pollingIntervalMs"], Number(value))}
						/>
					</Row>
				) : null}
			</Section>
			<Section title={t("settingsSources.sourceDetail.generalSection")}>
				<Row name={t("settingsSources.sourceDetail.descName")} hint={t("settingsSources.sourceDetail.descHint")} stack>
					<textarea
						className="linear-textarea"
						aria-label={t("settingsSources.sourceDetail.descAria")}
						rows={2}
						value={description}
						onChange={(event) => void run([{ path: ["datasources", alias, "description"], value: event.target.value }])}
					/>
				</Row>
			</Section>
			{template !== undefined && template.groups.length > 0 ? (
				<Section title={t("settingsSources.sourceDetail.templateSection", { label: template.label })}>
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
			<Section title={t("settingsSources.sourceDetail.removeSection")}>
				<Row name={t("settingsSources.sourceDetail.removeSection")} hint={t("settingsSources.sourceDetail.removeHint")}>
					<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
						<Trash2 size={14} aria-hidden="true" focusable="false" />{t("settingsSources.sourceDetail.removeSection")}
					</button>
				</Row>
			</Section>
			{confirmDelete ? (
				<ModalShell className="settings-alert" onClose={() => setConfirmDelete(false)}>
					<h2>{t("settingsSources.sourceDetail.confirmTitle")}</h2>
					<p>{t("settingsSources.sourceDetail.confirmBody", { alias })}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
						<button type="button" className="linear-btn is-danger is-danger-solid" disabled={busy} onClick={() => void removeConnection()}>{t("settingsSources.sourceDetail.removeSection")}</button>
					</ModalActions>
				</ModalShell>
			) : null}
			{fdaDialogOpen ? (
				<FullDiskAccessDialog
					reason="source"
					onClose={() => setFdaDialogOpen(false)}
					onConfirmed={() => {
						setFdaDialogOpen(false);
						setFdaNeeded(false);
						void refresh();
					}}
				/>
			) : null}
		</div>
	);
}

function ConnectorFieldRow({ field, value, onChange }: { readonly field: FieldSpec; readonly value: unknown; readonly onChange: (value: unknown) => void }): ReactElement {
	useTranslation();
	const label = t(field.label);
	const hint = field.hint === undefined ? "" : t(field.hint);
	if (field.kind === "boolean") {
		const checked = typeof value === "boolean" ? value : field.defaultValue === true;
		return (
			<Row name={label} hint={hint}>
				<Switch checked={checked} ariaLabel={label} onChange={() => onChange(!checked)} />
			</Row>
		);
	}
	const stack = field.kind === "stringList" || field.kind === "pathList" || field.kind === "env" || field.kind === "feeds";
	return (
		<Row name={label} hint={hint} stack={stack}>
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

/** The same pages for Windows where the Mac one is a different link (`slack.com/downloads/windows`). */
const WINDOWS_APP_URLS: Readonly<Record<string, string>> = {
	telegram: "https://desktop.telegram.org/",
	whatsapp: "https://www.whatsapp.com/download",
	slack: "https://slack.com/downloads/windows",
};

function appDownloadUrl(type: string, platform: string): string | undefined {
	return (platform === "win32" ? WINDOWS_APP_URLS[type] : undefined) ?? TEMPLATE_APP_URLS[type];
}
