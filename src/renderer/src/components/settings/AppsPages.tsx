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
import { useTranslation } from "react-i18next";
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
import { calendarSupported, isCalendarDatasourceType } from "../../../../shared/calendar-platform";
import { datasourceSupported } from "../../../../shared/messenger-platform";
import { t, type LocaleKey } from "../../../../shared/i18n/core";
import { hostPlatform } from "../../lib/shortcuts";
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
const INTERVAL_OPTIONS: readonly { readonly ms: number; readonly label: LocaleKey }[] = [
	{ ms: 5 * 60_000, label: "settingsSources.cadence.min5" },
	{ ms: 15 * 60_000, label: "settingsSources.cadence.min15" },
	{ ms: 30 * 60_000, label: "settingsSources.cadence.min30" },
	{ ms: 60 * 60_000, label: "settingsSources.cadence.hour1" },
	{ ms: 6 * 60 * 60_000, label: "settingsSources.cadence.hour6" },
	{ ms: 24 * 60 * 60_000, label: "settingsSources.cadence.day1" },
];

const GALLERY_GROUPS: readonly { readonly title: LocaleKey; readonly ids: readonly string[] }[] = [
	{ title: "settingsSources.apps.groups.messengers", ids: ["slack", "kakao", "discord", "telegram", "whatsapp", "lark"] },
	{ title: "settingsSources.apps.groups.docsNotes", ids: ["notion", "obsidian", "clawgallery"] },
	{ title: "settingsSources.apps.groups.mail", ids: ["mailcrawl"] },
	{ title: "settingsSources.apps.groups.cloudDev", ids: ["cloud-drive", "github", "github-gist"] },
	{ title: "settingsSources.apps.groups.newsOther", ids: ["rss", "hister", "calendar", "spotlight"] },
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

const UNIT_LABEL: Readonly<Record<NonNullable<DataSourceRow["index"]["unit"]>, LocaleKey>> = {
	message: "settingsSources.units.message",
	document: "settingsSources.units.document",
	image: "settingsSources.units.image",
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
	if (row.install.state === "unsupported" && isCalendarDatasourceType(row.type)) return row.install.detail;
	if (row.install.state === "missing") return row.install.detail;
	return t("settingsSources.meta.notFetchedYet");
}

/* ============================================================== Indexing == */

export function IndexingPage({
	snapshot,
	onSaved,
	sources,
	sourcesPending,
	setSources,
	onOpenSource,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly sources: DataSourcesSnapshot | null;
	/** The first datasource scan has not answered yet: `sources` is unknown, not empty. */
	readonly sourcesPending: boolean;
	readonly setSources: (next: DataSourcesSnapshot) => void;
	readonly onOpenSource: (alias: string) => void;
}): ReactElement {
	useTranslation();
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
			<SettingsPageHead title={t("settingsSources.indexing.title")} description={t("settingsSources.indexing.desc")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			<Section title={t("settingsSources.indexing.progress")}>
				<IndexActivityCard snapshot={activity} />
			</Section>
			<Section title={t("settingsSources.indexing.refreshStatus")}>
				<div className="settings-list">
					<div className="settings-list-row settings-sync-row">
						<button type="button" className="settings-sync-name" onClick={() => onOpenSource("")}>
							<SourceIcon small type="local" label={t("settingsSources.indexing.localFolder")} />
							<span className="settings-list-body">
								<span className="settings-list-title">{t("settingsSources.indexing.localFolder")}</span>
								<span className="settings-list-meta" title={schedule?.local?.error ?? undefined}>
									{[localMeta(local, localCount), lastAutoText(schedule?.local, now)].filter((part) => part !== null).join(" · ")}
								</span>
							</span>
						</button>
						<span className="settings-status">
							<StatusDot tone={localRunning ? "run" : local !== null && (local.documentCount ?? 0) > 0 ? "ok" : "warn"} />
							{localRunning ? t("settingsSources.indexing.localUpdating") : t("settingsSources.common.inUse")}
						</span>
						<select
							className="settings-select-compact"
							aria-label={t("settingsSources.indexing.localIntervalAria")}
							value={String(localInterval)}
							onChange={(event) => void changeInterval(["appIndexing", "refreshIntervalMs"], Number(event.target.value))}
						>
							<option value="0">{t("settingsSources.common.manual")}</option>
							{INTERVAL_OPTIONS.map((option) => (
								<option key={option.ms} value={option.ms}>{t(option.label)}</option>
							))}
						</select>
						<button
							type="button"
							className="settings-icon-btn"
							aria-label={t("settingsSources.indexing.refreshLocalAria")}
							title={t("settingsSources.indexing.refreshTitle")}
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
										{[syncingOf(row) ? t("settingsSources.common.syncing") : sourceMeta(row), lastAutoText(schedule?.sources[row.id], now)].filter((part) => part !== null).join(" · ")}
									</span>
								</span>
							</button>
							<span className="settings-status">
								<StatusDot tone={syncingOf(row) ? "run" : sourceTone(row)} />
								{syncingOf(row) ? t("settingsSources.common.syncing") : row.enabled ? t("settingsSources.common.inUse") : t("settingsSources.common.off")}
							</span>
							{TEMPLATE_BY_ID[row.type]?.polling !== false ? (
								<select
									className="settings-select-compact"
									aria-label={t("settingsSources.indexing.rowIntervalAria", { id: row.id })}
									value={String(intervalOf(row, snapshot))}
									onChange={(event) => void changeInterval(["datasources", row.id, "pollingIntervalMs"], Number(event.target.value))}
								>
									<option value="0">{t("settingsSources.common.manual")}</option>
									{INTERVAL_OPTIONS.map((option) => (
										<option key={option.ms} value={option.ms}>{t(option.label)}</option>
									))}
								</select>
							) : null}
							<button
								type="button"
								className="settings-icon-btn"
								aria-label={t("settingsSources.indexing.rowRefreshAria", { id: row.id })}
								title={t("settingsSources.indexing.rowRefreshTitle")}
								disabled={busy !== null || !row.enabled}
								onClick={() => void syncOne(row.id)}
							>
								<RefreshCw size={16} aria-hidden="true" focusable="false" />
							</button>
						</div>
					))}
				</div>
				{rows.length === 0 ? <Note>{sourcesPending ? t("settingsSources.common.checking") : t("settingsSources.indexing.empty")}</Note> : null}
				<ScheduleNote status={schedule} />
				<div className="settings-sync-footer">
					<span className="settings-list-meta">{t("settingsSources.indexing.footer")}</span>
					<button type="button" className="linear-btn" disabled={busy !== null || rows.length === 0} onClick={() => void syncAll()}>{t("settingsSources.indexing.syncAll")}</button>
				</div>
				<Row name={t("settingsSources.indexing.localRefreshName")} hint={t("settingsSources.indexing.localRefreshHint")}>
					<button type="button" className="linear-btn" disabled={busy !== null} onClick={() => void refreshIndex()}>{t("settingsSources.indexing.localRefreshButton")}</button>
				</Row>
				{refreshResult !== null ? (
					<Note>
						{t("settingsSources.indexing.scanned", { scanned: refreshResult.scanned, written: refreshResult.written, deleted: refreshResult.deleted, skipped: refreshResult.skipped })}
						{refreshResult.diagnostics.length > 0 ? t("settingsSources.indexing.diagnostics", { count: refreshResult.diagnostics.length }) : ""}
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
	if (minutes < 1) return t("settingsSources.common.justNow");
	if (minutes < 60) return t("settingsSources.common.minutesAgo", { count: minutes });
	if (minutes < 24 * 60) return t("settingsSources.common.hoursAgo", { count: Math.round(minutes / 60) });
	return t("settingsSources.common.daysAgo", { count: Math.round(minutes / (24 * 60)) });
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
			<SettingsPageHead title={t("settingsSources.apps.title")} description={t("settingsSources.apps.desc")} />
			{addError !== null ? <div className="settings-error" role="alert">{addError}</div> : null}
			<Section title={t("settingsSources.apps.myConnections")}>
				{rows.length === 0 ? <Note>{sourcesPending ? t("settingsSources.common.checking") : t("settingsSources.apps.empty")}</Note> : null}
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
			<Section title={t("settingsSources.apps.connectApps")} description={t("settingsSources.apps.connectAppsDesc")}>
				{GALLERY_GROUPS.map((group) => (
					<div key={group.title}>
						<div className="linear-section-title" style={{ marginTop: 18, fontSize: 13 }}>{t(group.title)}</div>
						<div className="settings-list">
							{group.ids.map((templateId) => {
								const template = TEMPLATE_BY_ID[templateId];
								if (template === undefined) return null;
								// KakaoTalk is read through a macOS-only program (lazykatok): it is not offered at all elsewhere.
								if (!datasourceSupported(templateId, hostPlatform())) return null;
								// Calendar reads EventKit and Spotlight runs mdfind, so both can only be connected on a Mac.
								const available = (templateId !== "calendar" && templateId !== "spotlight") || calendarSupported(hostPlatform());
								return (
									<div className="settings-list-row" key={templateId}>
										<SourceIcon type={templateId} label={template.label} />
										<span className="settings-list-body">
											<span className="settings-list-title">{template.label}</span>
											<span className="settings-list-meta">{available ? t(template.summary) : t("settingsSources.apps.macOnly")}</span>
										</span>
										{connectedTypes.has(templateId) ? <span className="settings-badge">{t("settingsSources.apps.connected")}</span> : null}
										<button type="button" className="linear-btn" disabled={!available} onClick={() => setAddTemplate(templateId)}>
											<Plus size={13} aria-hidden="true" focusable="false" />{t("settingsSources.apps.connect")}
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

	return (
		<div className="settings-source is-open" data-source-id={alias}>
			<SettingsPageHead title={sourceTitle({ id: alias, type })} description={template !== undefined ? t(template.summary) : t("settingsSources.sourceDetail.fallbackSummary")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{row?.install.state === "unsupported" && isCalendarDatasourceType(type) ? <Note>{t("settingsSources.sourceDetail.macOnlyNote")}</Note> : null}
			{row?.install.state === "unsupported" && type === "kakao" ? <Note>{t("settingsSources.sourceDetail.kakaoOnlyNote")}</Note> : null}
			<Section title={t("settingsSources.sourceDetail.statusSection")}>
				<Row name={t("settingsSources.sourceDetail.enabledName")} hint={t("settingsSources.sourceDetail.enabledHint")}>
					<Switch
						checked={enabled}
						disabled={busy}
						ariaLabel={t("settingsSources.sourceDetail.enabledName")}
						onChange={() => {
							void run([{ path: ["datasources", alias, "enabled"], value: !enabled }]).then(() => refresh());
						}}
					/>
				</Row>
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
						<StatusDot tone={row === null ? "off" : sourceTone(row)} />
						{row === null ? (sourcesPending ? t("settingsSources.common.checking") : t("settingsSources.sourceDetail.stateNone")) : sourceMeta(row)}
					</span>
					<button type="button" className="linear-btn settings-btn-quiet" disabled={busy || row === null} onClick={() => void syncNow()}>{t("settingsSources.indexing.rowRefreshTitle")}</button>
				</Row>
				{template?.polling !== false ? (
					<Row name={t("settingsSources.sourceDetail.intervalName")} hint={t("settingsSources.sourceDetail.intervalHint")}>
						<select
							className="linear-select"
							aria-label={t("settingsSources.sourceDetail.intervalName")}
							value={String(polling)}
							onChange={(event) => void changeInterval(["datasources", alias, "pollingIntervalMs"], Number(event.target.value))}
						>
							<option value="0">{t("settingsSources.common.manual")}</option>
							{INTERVAL_OPTIONS.map((option) => (
								<option key={option.ms} value={option.ms}>{t(option.label)}</option>
							))}
						</select>
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
				<ModalShell onClose={() => setConfirmDelete(false)}>
					<h2>{t("settingsSources.sourceDetail.confirmTitle")}</h2>
					<p>{t("settingsSources.sourceDetail.confirmBody", { alias })}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
						<button type="button" className="linear-btn is-danger" disabled={busy} onClick={() => void removeConnection()}>{t("settingsSources.sourceDetail.removeSection")}</button>
					</ModalActions>
				</ModalShell>
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
