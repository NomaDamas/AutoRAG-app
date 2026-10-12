/**
 * Settings — prototype-aligned shell (`docs/prototypes/settings`).
 *
 * Two panes: a searchable sidebar whose groups mirror the prototype
 * (계정 / 기본 / AI / 검색 / 연결된 앱, the last listing every configured
 * datasource) and a content pane that renders one page. The shell owns the
 * loaded app settings, config snapshot and datasource snapshot and hands each
 * page the writers it needs, so a write from one page reconciles the others.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../shared/i18n/core";
import { Copy, CreditCard, FileText, Folder, Globe, Plug, RefreshCw, Search, Settings, Sparkles, User, type LucideIcon } from "lucide-react";
import type { AppSettings, AutoRagConfigSnapshot, DataSourcesSnapshot } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { AccountPage, PlanPage } from "./settings/AccountPlanPages";
import { AiPage } from "./settings/AiPage";
import { AppsPage, IndexingPage, SourceDetailPage } from "./settings/AppsPages";
import { DuplicatesPage, ReadingPage, ScopePage, WebPage } from "./settings/ConfigPages";
import { GeneralPage } from "./settings/GeneralPage";
import { TEMPLATE_BY_ID } from "./settings/datasourceTemplates";
import { SourceIcon } from "./settings/SourceIcon";
import { settings } from "../settings-runtime";
import { attachSettingsNavigation } from "../state/settings-navigation";

const autorag = { settings };

export type StaticSettingsCategory = "account" | "plan" | "general" | "ai" | "web" | "indexing" | "scope" | "reading" | "duplicates" | "apps";
/** Legacy ids stay accepted so an old deep link still lands on a page. */
type LegacyCategory = "llm" | "embedding" | "reranker" | "sources" | "deep" | "light";
export type SettingsCategory = StaticSettingsCategory | LegacyCategory | `source:${string}`;

type NavLabelKey =
	| "settingsCore.nav.account"
	| "settingsCore.nav.plan"
	| "settingsCore.nav.general"
	| "settingsCore.nav.ai"
	| "settingsCore.nav.web"
	| "settingsCore.nav.indexing"
	| "settingsCore.nav.scope"
	| "settingsCore.nav.reading"
	| "settingsCore.nav.duplicates"
	| "settingsCore.nav.apps";

type NavGroupKey =
	| "settingsCore.nav.group.account"
	| "settingsCore.nav.group.basic"
	| "settingsCore.nav.group.ai"
	| "settingsCore.nav.group.search"
	| "settingsCore.nav.group.apps";

interface PageMeta {
	readonly id: StaticSettingsCategory;
	readonly labelKey: NavLabelKey;
	readonly icon: LucideIcon;
	readonly groupKey: NavGroupKey;
	/** Search-only synonyms, translated like the label. */
	readonly keywordsKey: LocaleKey;
}

/** Group identity comparison uses this literal key, never translated text. */
const GROUP_APPS: NavGroupKey = "settingsCore.nav.group.apps";

const PAGES = [
	{ id: "account", labelKey: "settingsCore.nav.account", icon: User, groupKey: "settingsCore.nav.group.account", keywordsKey: "settingsCore.nav.keywords.account" },
	{ id: "plan", labelKey: "settingsCore.nav.plan", icon: CreditCard, groupKey: "settingsCore.nav.group.account", keywordsKey: "settingsCore.nav.keywords.plan" },
	{ id: "general", labelKey: "settingsCore.nav.general", icon: Settings, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.general" },
	{ id: "ai", labelKey: "settingsCore.nav.ai", icon: Sparkles, groupKey: "settingsCore.nav.group.ai", keywordsKey: "settingsCore.nav.keywords.ai" },
	{ id: "web", labelKey: "settingsCore.nav.web", icon: Globe, groupKey: "settingsCore.nav.group.ai", keywordsKey: "settingsCore.nav.keywords.web" },
	{ id: "indexing", labelKey: "settingsCore.nav.indexing", icon: RefreshCw, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.indexing" },
	{ id: "scope", labelKey: "settingsCore.nav.scope", icon: Folder, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.scope" },
	{ id: "reading", labelKey: "settingsCore.nav.reading", icon: FileText, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.reading" },
	{ id: "duplicates", labelKey: "settingsCore.nav.duplicates", icon: Copy, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.duplicates" },
	{ id: "apps", labelKey: "settingsCore.nav.apps", icon: Plug, groupKey: GROUP_APPS, keywordsKey: "settingsCore.nav.keywords.apps" },
] as const satisfies readonly PageMeta[];

/** Map a legacy category onto the page that replaced it. */
function normalizeCategory(category: SettingsCategory): SettingsCategory {
	if (category === "llm" || category === "embedding" || category === "reranker") return "ai";
	if (category === "sources" || category === "deep" || category === "light") return "apps";
	return category;
}

function sourceAliasOf(category: SettingsCategory): string | null {
	return category.startsWith("source:") ? category.slice("source:".length) : null;
}

function sourceType(raw: unknown, alias: string): string {
	return isJsonObject(raw) && typeof raw.type === "string" && raw.type.length > 0 ? raw.type : alias;
}

interface SourceEntry {
	readonly alias: string;
	readonly type: string;
	readonly label: string;
}

function datasourceEntries(snapshot: AutoRagConfigSnapshot | null): readonly SourceEntry[] {
	if (snapshot === null || !isJsonObject(snapshot.config.datasources)) return [];
	return Object.keys(snapshot.config.datasources)
		.sort((a, b) => a.localeCompare(b))
		.map((alias) => {
			const type = sourceType((snapshot.config.datasources as Record<string, unknown>)[alias], alias);
			const template = TEMPLATE_BY_ID[type];
			const kind = template?.label ?? type;
			return { alias, type, label: alias === type ? kind : `${kind} · ${alias}` };
		});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SettingsView({ initialCategory = "general", onSettingsChanged }: { readonly initialCategory?: SettingsCategory; readonly onSettingsChanged?: (settings: AppSettings) => void }): ReactElement {
	const { t } = useTranslation();
	const [category, setCategory] = useState<SettingsCategory>(() => normalizeCategory(initialCategory));
	const [query, setQuery] = useState("");
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<AutoRagConfigSnapshot | null>(null);
	const [sources, setSources] = useState<DataSourcesSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	// The sidebar's indexing block asks for a page from outside; honour a request made before this view mounted.
	useEffect(() => {
		const { initial, detach } = attachSettingsNavigation((next) => setCategory(normalizeCategory(next)));
		if (initial !== null) setCategory(normalizeCategory(initial));
		return detach;
	}, []);

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			const [app, config] = await Promise.all([autorag.settings.get(), autorag.settings.configGet()]);
			setAppSettings(app);
			setSnapshot(config);
			setError(config.error);
			try {
				const list = await autorag.settings.sourcesList();
				setSources(list);
				setError((current) => current ?? list.error);
			} catch {
				setSources(null);
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const entries = useMemo(() => datasourceEntries(snapshot), [snapshot]);
	const saveSnapshot = useCallback((next: AutoRagConfigSnapshot): void => {
		setSnapshot(next);
		setError(next.error);
	}, []);

	const sourceAlias = sourceAliasOf(category);
	useEffect(() => {
		if (sourceAlias !== null && snapshot !== null && entries.every((entry) => entry.alias !== sourceAlias)) setCategory("apps");
	}, [sourceAlias, snapshot, entries]);

	const filteredPages = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return PAGES;
		return PAGES.filter((page) => `${t(page.labelKey)} ${t(page.keywordsKey)}`.toLowerCase().includes(needle));
	}, [query, t]);
	const filteredSources = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return entries;
		return entries.filter((entry) => `${entry.label} ${entry.alias} ${entry.type}`.toLowerCase().includes(needle));
	}, [query, entries]);

	const groups = useMemo(() => {
		const order: NavGroupKey[] = [];
		const map = new Map<NavGroupKey, PageMeta[]>();
		for (const page of filteredPages) {
			if (!map.has(page.groupKey)) {
				map.set(page.groupKey, []);
				order.push(page.groupKey);
			}
			map.get(page.groupKey)?.push(page);
		}
		return order.map((groupKey) => ({ groupKey, pages: map.get(groupKey) ?? [] }));
	}, [filteredPages]);

	const content = ((): ReactElement => {
		if (loading || appSettings === null || snapshot === null) return <p className="linear-section-desc">{t("common.loading")}</p>;
		const page = normalizeCategory(category);
		if (sourceAlias !== null) return <SourceDetailPage key={sourceAlias} snapshot={snapshot} onSaved={saveSnapshot} alias={sourceAlias} sources={sources} setSources={setSources} />;
		switch (page) {
			case "account":
				return <AccountPage />;
			case "plan":
				return <PlanPage />;
			case "general":
				return <GeneralPage appSettings={appSettings} onAppSettingsChanged={(next) => { setAppSettings(next); onSettingsChanged?.(next); }} onSettingsError={setError} snapshot={snapshot} onSaved={saveSnapshot} />;
			case "ai":
				return <AiPage snapshot={snapshot} onSaved={saveSnapshot} />;
			case "web":
				return <WebPage snapshot={snapshot} onSaved={saveSnapshot} />;
			case "indexing":
				return <IndexingPage snapshot={snapshot} onSaved={saveSnapshot} sources={sources} setSources={setSources} onOpenSource={(alias) => setCategory(alias.length === 0 ? "scope" : `source:${alias}`)} />;
			case "scope":
				return <ScopePage snapshot={snapshot} onSaved={saveSnapshot} />;
			case "reading":
				return <ReadingPage snapshot={snapshot} onSaved={saveSnapshot} />;
			case "duplicates":
				return (
					<DuplicatesPage
						snapshot={snapshot}
						onSaved={saveSnapshot}
						dupeyInterval={appSettings.dupeyScanIntervalMinutes}
						onDupeyInterval={(minutes) => void autorag.settings.set({ dupeyScanIntervalMinutes: minutes }).then((next) => { setAppSettings(next); onSettingsChanged?.(next); })}
					/>
				);
			default:
				return <AppsPage snapshot={snapshot} onSaved={saveSnapshot} sources={sources} onOpenSource={(alias) => setCategory(`source:${alias}`)} />;
		}
	})();

	const sourceButtons = filteredSources.map((entry) => {
		const active = sourceAlias === entry.alias;
		return (
			<button key={entry.alias} type="button" data-source-alias={entry.alias} className={`settings-nav-item settings-nav-item--source${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(`source:${entry.alias}`)}>
				<SourceIcon small type={entry.type} label={entry.label} />
				<span className="settings-nav-label">{entry.label}</span>
			</button>
		);
	});

	return (
		<div className="settings-view settings-panel" role="region" aria-label={t("settings.title")}>
			<aside className="settings-sidebar" aria-label={t("settingsCore.view.navAria")}>
				<label className="settings-search">
					<span className="settings-search__icon" aria-hidden="true">
						<Search size={14} />
					</span>
					<input type="search" aria-label={t("settingsCore.view.search")} placeholder={t("settingsCore.view.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<nav aria-label={t("settingsCore.view.menuAria")} style={{ display: "contents" }}>
					{groups.map((group) => (
						<div key={group.groupKey}>
							<div className="settings-sidebar-group-title">{t(group.groupKey)}</div>
							{group.pages.map((page) => {
								const Icon = page.icon;
								const active = sourceAlias === null && normalizeCategory(category) === page.id;
								return (
									<button key={page.id} type="button" className={`settings-nav-item${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(page.id)}>
										<span className="settings-nav-icon" aria-hidden="true">
											<Icon size={16} />
										</span>
										<span>{t(page.labelKey)}</span>
									</button>
								);
							})}
							{group.groupKey === GROUP_APPS ? sourceButtons : null}
						</div>
					))}
					{!groups.some((group) => group.groupKey === GROUP_APPS) && filteredSources.length > 0 ? (
						<div>
							<div className="settings-sidebar-group-title">{t(GROUP_APPS)}</div>
							{sourceButtons}
						</div>
					) : null}
				</nav>
				{query.trim().length > 0 && groups.length === 0 && filteredSources.length === 0 ? <p className="settings-nav-empty">{t("settingsCore.view.empty")}</p> : null}
			</aside>
			<main className="settings-content" aria-label={t("settingsCore.view.contentAria", { name: sourceAlias ?? normalizeCategory(category) })}>
				<div className="settings-content-wrap">
					{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
					{content}
				</div>
			</main>
		</div>
	);
}
