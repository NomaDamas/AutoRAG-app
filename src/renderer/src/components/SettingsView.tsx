/**
 * Settings — prototype-aligned shell (`docs/prototypes/settings`).
 *
 * Two panes: a searchable sidebar whose groups mirror the prototype
 * (계정 / 기본 / AI / 검색 / 연결된 앱, the last listing every configured
 * datasource) and a content pane that renders one page. The shell owns the
 * loaded app settings, config snapshot and datasource snapshot and hands each
 * page the writers it needs, so a write from one page reconciles the others.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { LocaleKey } from "../../../shared/i18n/core";
import { Copy, CreditCard, FileText, Folder, Globe, Keyboard, MonitorSmartphone, MousePointerClick, PanelLeft, Plug, RefreshCw, Server, Settings, Sparkles, User, type LucideIcon } from "lucide-react";
import type { AppSettings, AutoRagConfigSnapshot, DataSourcesSnapshot } from "../../../shared/settings-contract";
import type { AppCustomizerSurface } from "../../../shared/app-customizer-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { AccountPage, PlanPage } from "./settings/AccountPlanPages";
import { AiPage } from "./settings/AiPage";
import { AppsPage, IndexingPage, SourceDetailPage } from "./settings/AppsPages";
import { DuplicatesPage, ReadingPage, WebPage } from "./settings/ConfigPages";
import { ScopePage } from "./settings/ScopePage";
import { GeneralPage } from "./settings/GeneralPage";
import { AppCustomizerPanel } from "./settings/AppCustomizerPanel";
import { SettingsAssistantContext, type SettingsAssistantDock } from "./settings/SettingsAssistantDock";
import { McpPage } from "./settings/McpPage";
import { SidebarPage } from "./settings/SidebarPage";
import { RemoteAccessPage } from "./settings/RemoteAccessPage";
import { ContextMenuPage } from "./settings/ContextMenuPage";
import { ShortcutsPage } from "./settings/ShortcutsPage";
import { TEMPLATE_BY_ID } from "./settings/datasourceTemplates";
import { SourceIcon } from "./settings/SourceIcon";
import { settings } from "../settings-runtime";
import { attachSettingsNavigation } from "../state/settings-navigation";
import { cn } from "../lib/cn";
import { useFormattedShortcut } from "../hooks/useShortcutSettings";
import { ChevronLeftIcon, PanelRightIcon, SearchIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";
import { Keycap } from "./primitives/Keycap";

const autorag = { settings };

export type StaticSettingsCategory = "account" | "plan" | "general" | "sidebar" | "contextMenu" | "shortcuts" | "remote" | "ai" | "web" | "mcp" | "indexing" | "scope" | "reading" | "duplicates" | "apps";
/** Legacy ids stay accepted so an old deep link still lands on a page. */
type LegacyCategory = "llm" | "embedding" | "reranker" | "sources" | "deep" | "light";
export type SettingsCategory = StaticSettingsCategory | LegacyCategory | `source:${string}`;

type NavLabelKey =
	| "settingsCore.nav.account"
	| "settingsCore.nav.plan"
	| "settingsCore.nav.general"
	| "settingsCore.nav.sidebar"
	| "settingsCore.nav.contextMenu"
	| "settingsCore.nav.shortcuts"
	| "settingsCore.nav.remote"
	| "settingsCore.nav.ai"
	| "settingsCore.nav.web"
	| "settingsCore.nav.indexing"
	| "settingsCore.nav.scope"
	| "settingsCore.nav.reading"
	| "settingsCore.nav.duplicates"
	| "settingsCore.nav.mcp"
	| "settingsCore.nav.apps";

type NavGroupKey =
	| "settingsCore.nav.group.account"
	| "settingsCore.nav.group.basic"
	| "settingsCore.nav.group.ai"
	| "settingsCore.nav.group.search"
	| "settingsCore.nav.group.apps";

export interface PageMeta {
	readonly id: StaticSettingsCategory;
	readonly labelKey: NavLabelKey;
	readonly icon: LucideIcon;
	readonly groupKey: NavGroupKey;
	/** Search-only synonyms, translated like the label. */
	readonly keywordsKey: LocaleKey;
}

/** Group identity comparison uses this literal key, never translated text. */
export const GROUP_APPS: NavGroupKey = "settingsCore.nav.group.apps";

export const PAGES = [
	{ id: "account", labelKey: "settingsCore.nav.account", icon: User, groupKey: "settingsCore.nav.group.account", keywordsKey: "settingsCore.nav.keywords.account" },
	{ id: "plan", labelKey: "settingsCore.nav.plan", icon: CreditCard, groupKey: "settingsCore.nav.group.account", keywordsKey: "settingsCore.nav.keywords.plan" },
	{ id: "general", labelKey: "settingsCore.nav.general", icon: Settings, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.general" },
	{ id: "sidebar", labelKey: "settingsCore.nav.sidebar", icon: PanelLeft, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.sidebar" },
	{ id: "contextMenu", labelKey: "settingsCore.nav.contextMenu", icon: MousePointerClick, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.contextMenu" },
	{ id: "shortcuts", labelKey: "settingsCore.nav.shortcuts", icon: Keyboard, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.shortcuts" },
	{ id: "remote", labelKey: "settingsCore.nav.remote", icon: MonitorSmartphone, groupKey: "settingsCore.nav.group.basic", keywordsKey: "settingsCore.nav.keywords.remote" },
	{ id: "ai", labelKey: "settingsCore.nav.ai", icon: Sparkles, groupKey: "settingsCore.nav.group.ai", keywordsKey: "settingsCore.nav.keywords.ai" },
	{ id: "web", labelKey: "settingsCore.nav.web", icon: Globe, groupKey: "settingsCore.nav.group.ai", keywordsKey: "settingsCore.nav.keywords.web" },
	{ id: "indexing", labelKey: "settingsCore.nav.indexing", icon: RefreshCw, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.indexing" },
	{ id: "scope", labelKey: "settingsCore.nav.scope", icon: Folder, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.scope" },
	{ id: "reading", labelKey: "settingsCore.nav.reading", icon: FileText, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.reading" },
	{ id: "duplicates", labelKey: "settingsCore.nav.duplicates", icon: Copy, groupKey: "settingsCore.nav.group.search", keywordsKey: "settingsCore.nav.keywords.duplicates" },
	{ id: "mcp", labelKey: "settingsCore.nav.mcp", icon: Server, groupKey: "settingsCore.nav.group.ai", keywordsKey: "settingsCore.nav.keywords.mcp" },
	{ id: "apps", labelKey: "settingsCore.nav.apps", icon: Plug, groupKey: GROUP_APPS, keywordsKey: "settingsCore.nav.keywords.apps" },
] as const satisfies readonly PageMeta[];

/** Map a legacy category onto the page that replaced it. */
export function normalizeCategory(category: SettingsCategory): SettingsCategory {
	if (category === "llm" || category === "embedding" || category === "reranker") return "ai";
	if (category === "sources" || category === "deep" || category === "light") return "apps";
	return category;
}

export function sourceAliasOf(category: SettingsCategory): string | null {
	return category.startsWith("source:") ? category.slice("source:".length) : null;
}

function sourceType(raw: unknown, alias: string): string {
	return isJsonObject(raw) && typeof raw.type === "string" && raw.type.length > 0 ? raw.type : alias;
}

export interface SourceEntry {
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

/** Settings pages whose AI customization assistant fills the window's right sidebar. */
function customizerSurfaceOf(page: SettingsCategory): AppCustomizerSurface | null {
	return page === "sidebar" || page === "contextMenu" || page === "shortcuts" ? page : null;
}

/**
 * What every settings page reads and writes: the app settings, the config
 * snapshot, and the datasource scan. One owner per settings surface, so a write
 * from one page reconciles the others. The desktop pane and the phone shell's
 * settings stack each hold one.
 */
export interface SettingsData {
	readonly appSettings: AppSettings | null;
	readonly snapshot: AutoRagConfigSnapshot | null;
	readonly sources: DataSourcesSnapshot | null;
	readonly sourcesReady: boolean;
	readonly loading: boolean;
	readonly error: string | null;
	/** Configured datasources, sorted by alias. */
	readonly entries: readonly SourceEntry[];
	readonly setError: (error: string | null) => void;
	readonly setSources: (sources: DataSourcesSnapshot) => void;
	readonly saveSnapshot: (next: AutoRagConfigSnapshot) => void;
	readonly changeAppSettings: (next: AppSettings) => void;
}

export function useSettingsData(onSettingsChanged?: (settings: AppSettings) => void): SettingsData {
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<AutoRagConfigSnapshot | null>(null);
	const [sources, setSources] = useState<DataSourcesSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	/** False until the first datasource scan has answered (or failed): the pages say "checking" instead of "none". */
	const [sourcesReady, setSourcesReady] = useState(false);
	const scanSeq = useRef(0);
	const changedRef = useRef(onSettingsChanged);
	changedRef.current = onSettingsChanged;

	/**
	 * Ask for the datasource state. It runs a status command per backend CLI, so it is the slow call (hundreds of
	 * milliseconds, more with many connections); nothing the first screen shows depends on it. Only the newest scan's
	 * answer is kept, so a slow earlier scan can never overwrite a later one. Resolves to that answer, else null.
	 */
	const scan = useCallback((): Promise<DataSourcesSnapshot | null> => {
		const id = ++scanSeq.current;
		return autorag.settings.sourcesList().then(
			(list) => {
				if (id !== scanSeq.current) return null;
				setSources(list);
				setSourcesReady(true);
				return list;
			},
			() => {
				if (id === scanSeq.current) setSourcesReady(true);
				return null;
			},
		);
	}, []);

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		// Started before the cheap reads, not after them: the page opens on those and the scan fills in behind it.
		const scanning = scan();
		try {
			const [app, config] = await Promise.all([autorag.settings.get(), autorag.settings.configGet()]);
			setAppSettings(app);
			setSnapshot(config);
			setError(config.error);
			setLoading(false);
			const list = await scanning;
			if (list !== null) setError((current) => current ?? list.error);
		} catch (cause) {
			setError(errorMessage(cause));
			setLoading(false);
		}
	}, [scan]);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		return autorag.settings.onChanged?.((next) => {
			setAppSettings(next);
			changedRef.current?.(next);
		});
	}, []);

	const entries = useMemo(() => datasourceEntries(snapshot), [snapshot]);
	const saveSnapshot = useCallback((next: AutoRagConfigSnapshot): void => {
		setSnapshot(next);
		setError(next.error);
		void scan();
	}, [scan]);
	const changeAppSettings = useCallback((next: AppSettings): void => {
		setAppSettings(next);
		changedRef.current?.(next);
	}, []);

	return { appSettings, snapshot, sources, sourcesReady, loading, error, entries, setError, setSources, saveSnapshot, changeAppSettings };
}

/** One settings page's body for `category`; `onNavigate` follows a page's own link to another page. */
export function SettingsPageContent({
	data,
	category,
	onNavigate,
	customizerOpen = true,
	onOpenCustomizer = () => undefined,
}: {
	readonly data: SettingsData;
	readonly category: SettingsCategory;
	readonly onNavigate: (category: SettingsCategory) => void;
	readonly customizerOpen?: boolean;
	readonly onOpenCustomizer?: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const { appSettings, snapshot, sources, sourcesReady, saveSnapshot, setSources, setError, changeAppSettings } = data;
	if (data.loading || appSettings === null || snapshot === null) return <p className="linear-section-desc">{t("common.loading")}</p>;
	const page = normalizeCategory(category);
	const sourceAlias = sourceAliasOf(page);
	if (sourceAlias !== null) return <SourceDetailPage key={sourceAlias} snapshot={snapshot} onSaved={saveSnapshot} alias={sourceAlias} sources={sources} sourcesPending={!sourcesReady} setSources={setSources} />;
	switch (page) {
		case "account":
			return <AccountPage />;
		case "plan":
			return <PlanPage />;
		case "general":
			return <GeneralPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} snapshot={snapshot} onSaved={saveSnapshot} />;
		case "sidebar":
			return <SidebarPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} customizerOpen={customizerOpen} onOpenCustomizer={onOpenCustomizer} />;
		case "contextMenu":
			return <ContextMenuPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} customizerOpen={customizerOpen} onOpenCustomizer={onOpenCustomizer} />;
		case "shortcuts":
			return <ShortcutsPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} customizerOpen={customizerOpen} onOpenCustomizer={onOpenCustomizer} />;
		case "remote":
			return <RemoteAccessPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} />;
		case "ai":
			return <AiPage snapshot={snapshot} onSaved={saveSnapshot} />;
		case "web":
			return <WebPage snapshot={snapshot} onSaved={saveSnapshot} />;
		case "indexing":
			return <IndexingPage snapshot={snapshot} onSaved={saveSnapshot} sources={sources} sourcesPending={!sourcesReady} setSources={setSources} onOpenSource={(alias) => onNavigate(alias.length === 0 ? "scope" : `source:${alias}`)} />;
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
					onDupeyInterval={(minutes) => void autorag.settings.set({ dupeyScanIntervalMinutes: minutes }).then(changeAppSettings)}
				/>
			);
		case "mcp":
			return <McpPage appSettings={appSettings} onAppSettingsChanged={changeAppSettings} onSettingsError={setError} />;
		default:
			return <AppsPage snapshot={snapshot} onSaved={saveSnapshot} sources={sources} sourcesPending={!sourcesReady} onOpenSource={(alias) => onNavigate(`source:${alias}`)} />;
	}
}

/**
 * Settings takes over the window: this view is the left sidebar (a back button, the title, search and the pages) and the
 * content beside it, with no tab strip or view/sort toolbar above. The right sidebar stays the window's.
 */
export function SettingsView({
	initialCategory = "general",
	onSettingsChanged,
	navWidth,
	onBack,
	inspectorHidden,
	onShowInspector,
	searchRef,
}: {
	readonly initialCategory?: SettingsCategory;
	readonly onSettingsChanged?: (settings: AppSettings) => void;
	/** The width of the window's left column, which Settings' own sidebar fills. */
	readonly navWidth: number;
	/** The back button: leave Settings for where the person was. */
	readonly onBack: () => void;
	/** The window's right sidebar is hidden: the content's top-right offers to bring it back. */
	readonly inspectorHidden: boolean;
	readonly onShowInspector: () => void;
	/** The window's focus-search shortcut lands here while Settings is open (the Finder's search box is hidden). */
	readonly searchRef?: RefObject<HTMLInputElement | null>;
}): ReactElement {
	const { t } = useTranslation();
	const [category, setCategory] = useState<SettingsCategory>(() => normalizeCategory(initialCategory));
	const [query, setQuery] = useState("");
	const data = useSettingsData(onSettingsChanged);
	const { snapshot, entries, error, changeAppSettings } = data;
	/** Bumped when the user opens the assistant from a page's hero: the composer takes focus then, never on a plain visit. */
	const [customizerFocus, setCustomizerFocus] = useState(0);
	/** Assistants stay mounted once shown, so a conversation and a running turn survive switching sections. */
	const [mountedSurfaces, setMountedSurfaces] = useState<readonly AppCustomizerSurface[]>([]);
	/** The right sidebar hosts this node while a customizable section is open; the assistants render into it. */
	const [dockNode] = useState(() => {
		const node = document.createElement("div");
		node.className = "customizer-dock__node";
		return node;
	});
	const assistant = useContext(SettingsAssistantContext);
	const publishDock = assistant?.publish;
	const showAssistant = assistant?.show;
	const openCustomizer = useCallback((): void => {
		showAssistant?.();
		setCustomizerFocus((count) => count + 1);
	}, [showAssistant]);
	const openAiSettings = useCallback((): void => setCategory("ai"), []);

	// The sidebar's indexing block asks for a page from outside; honour a request made before this view mounted.
	useEffect(() => {
		const { initial, detach } = attachSettingsNavigation((next) => setCategory(normalizeCategory(next)));
		if (initial !== null) setCategory(normalizeCategory(initial));
		return detach;
	}, []);

	// Usage analytics: which page is open. A `source:<alias>` page counts as `source`, so a user-chosen alias is never sent.
	useEffect(() => {
		const page = normalizeCategory(category);
		const id = sourceAliasOf(page) === null ? PAGES.find((meta) => meta.id === page)?.id : "source";
		if (id !== undefined) window.autorag?.analytics?.track("settings_page_viewed", { page: id });
	}, [category]);

	const sourceAlias = sourceAliasOf(category);
	useEffect(() => {
		if (sourceAlias !== null && snapshot !== null && entries.every((entry) => entry.alias !== sourceAlias)) setCategory("apps");
	}, [sourceAlias, snapshot, entries]);
	const activeSurface = sourceAlias === null && assistant !== null ? customizerSurfaceOf(normalizeCategory(category)) : null;
	/** Without a right sidebar to host it (no window shell) there is no assistant, so the page hero never offers it. */
	const customizerShown = assistant === null || assistant.shown;
	useEffect(() => {
		if (activeSurface !== null) setMountedSurfaces((current) => (current.includes(activeSurface) ? current : [...current, activeSurface]));
	}, [activeSurface]);
	const dock = useMemo<SettingsAssistantDock | null>(() => (activeSurface === null ? null : { surface: activeSurface, node: dockNode }), [activeSurface, dockNode]);
	useEffect(() => {
		publishDock?.(dock);
		return () => publishDock?.(null);
	}, [publishDock, dock]);

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

	const content = (
		<SettingsPageContent
			data={data}
			category={category}
			onNavigate={setCategory}
			customizerOpen={customizerShown}
			onOpenCustomizer={openCustomizer}
		/>
	);

	const sourceButtons = filteredSources.map((entry) => {
		const active = sourceAlias === entry.alias;
		return (
			<button key={entry.alias} type="button" data-source-alias={entry.alias} className={`settings-nav-item settings-nav-item--source${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(`source:${entry.alias}`)}>
				<SourceIcon small type={entry.type} label={entry.label} />
				<span className="settings-nav-label">{entry.label}</span>
			</button>
		);
	});

	const [searchFocused, setSearchFocused] = useState(false);
	const focusSearchShortcut = useFormattedShortcut("focusSearch");

	return (
		<div className="settings-view settings-panel" role="region" aria-label={t("settings.title")}>
			<aside className="settings-sidebar" style={{ width: navWidth }} aria-label={t("settingsCore.view.navAria")}>
				{/* Level with the Finder sidebar's head: room for the traffic lights, and the window drags from it. */}
				<div className="settings-sidebar-head" aria-hidden="true" />
				<div className="settings-sidebar-backrow">
					<button type="button" className="settings-nav-item settings-sidebar-back" onClick={onBack}>
						<span className="settings-nav-icon" aria-hidden="true">
							<ChevronLeftIcon size={14} />
						</span>
						<span>{t("toolbar.back")}</span>
					</button>
				</div>
				<div className="sidebar-search flex-none px-10 pt-2 pb-8">
					<label className="side-search settings-search flex items-center gap-7 h-30 pl-9 pr-6 border border-transparent rounded-8 bg-hover text-ink-muted transition-[background,border-color,box-shadow,color] duration-(--dur-color) ease-[ease] hover:bg-hover-strong focus-within:bg-window focus-within:border-accent focus-within:text-accent-hover focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
						<SearchIcon className="flex-none" />
						<input
							ref={searchRef}
							className="flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-meta"
							type="text"
							value={query}
							placeholder={t("sidebarSearch.placeholder")}
							aria-label={t("settingsCore.view.search")}
							onChange={(event) => setQuery(event.target.value)}
							onFocus={() => setSearchFocused(true)}
							onBlur={() => setSearchFocused(false)}
						/>
						{query !== "" ? (
							<button
								type="button"
								className="flex-none flex items-center justify-center size-16 p-0 border-0 rounded-full bg-border-strong text-on-accent text-[9px] leading-none cursor-default hover:bg-ink-muted"
								title={t("sidebarSearch.clearSearch")}
								aria-label={t("sidebarSearch.clearSearch")}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => setQuery("")}
							>
								✕
							</button>
						) : !searchFocused ? (
							<Keycap label={focusSearchShortcut} />
						) : null}
					</label>
				</div>
				<div className="settings-sidebar-scroll">
					<nav aria-label={t("settingsCore.view.menuAria")} style={{ display: "contents" }}>
						{groups.map((group) => (
							<div key={group.groupKey} className="settings-nav-group">
								<div className="settings-sidebar-group-title">{t(group.groupKey)}</div>
								{group.pages.map((page) => {
									const Icon = page.icon;
									const active = sourceAlias === null && normalizeCategory(category) === page.id;
									return (
										<button key={page.id} type="button" className={`settings-nav-item${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(page.id)}>
											<span className="settings-nav-icon" aria-hidden="true">
												<Icon size={14} strokeWidth={1.8} />
											</span>
											<span>{t(page.labelKey)}</span>
										</button>
									);
								})}
								{group.groupKey === GROUP_APPS ? sourceButtons : null}
							</div>
						))}
						{!groups.some((group) => group.groupKey === GROUP_APPS) && filteredSources.length > 0 ? (
							<div className="settings-nav-group">
								<div className="settings-sidebar-group-title">{t(GROUP_APPS)}</div>
								{sourceButtons}
							</div>
						) : null}
					</nav>
					{query.trim().length > 0 && groups.length === 0 && filteredSources.length === 0 ? <p className="settings-nav-empty">{t("settingsCore.view.empty")}</p> : null}
				</div>
			</aside>
			<div className="settings-main">
				<div className="settings-main-head">
					{inspectorHidden ? (
						<button type="button" className={cn(iconButtonClass({ size: "size-toolbar-icon", tone: "text-ink-body" }), "settings-main-inspector")} title={t("toolbar.showInspector")} aria-label={t("toolbar.showInspector")} onClick={onShowInspector}>
							<PanelRightIcon size={18} />
						</button>
					) : null}
				</div>
				<main className="settings-content" aria-label={t("settingsCore.view.contentAria", { name: sourceAlias ?? normalizeCategory(category) })}>
					<div className="settings-content-wrap">
						{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
						{content}
					</div>
				</main>
			</div>
			{createPortal(
				mountedSurfaces.map((surface) => (
					<AppCustomizerPanel
						key={surface}
						surface={surface}
						hidden={surface !== activeSurface}
						focusRequest={surface === activeSurface ? customizerFocus : 0}
						onSettingsUpdated={changeAppSettings}
						onOpenAiSettings={openAiSettings}
					/>
				)),
				dockNode,
			)}
		</div>
	);
}
