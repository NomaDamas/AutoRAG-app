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
import { Copy, CreditCard, FileText, Folder, Globe, Plug, RefreshCw, Search, Settings, Sparkles, User, type LucideIcon } from "lucide-react";
import type { AppSettings, AutoRagConfigSnapshot, DataSourcesSnapshot } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { AccountPage, PlanPage } from "./settings/AccountPlanPages";
import { AiPage } from "./settings/AiPage";
import { AppsPage, IndexingPage, SourceDetailPage } from "./settings/AppsPages";
import { DuplicatesPage, ReadingPage, ScopePage, WebPage } from "./settings/ConfigPages";
import { GeneralPage } from "./settings/GeneralPage";
import { TEMPLATE_BY_ID } from "./settings/datasourceTemplates";
import { settings } from "../settings-runtime";

const autorag = { settings };

export type StaticSettingsCategory = "account" | "plan" | "general" | "ai" | "web" | "indexing" | "scope" | "reading" | "duplicates" | "apps";
/** Legacy ids stay accepted so an old deep link still lands on a page. */
type LegacyCategory = "llm" | "embedding" | "reranker" | "sources" | "deep" | "light";
export type SettingsCategory = StaticSettingsCategory | LegacyCategory | `source:${string}`;

interface PageMeta {
	readonly id: StaticSettingsCategory;
	readonly label: string;
	readonly icon: LucideIcon;
	readonly group: string;
	readonly keywords: string;
}

const PAGES: readonly PageMeta[] = [
	{ id: "account", label: "내 계정", icon: User, group: "계정", keywords: "계정 로그인 이메일 이름 프로필" },
	{ id: "plan", label: "구독 및 사용량", icon: CreditCard, group: "계정", keywords: "요금제 결제 크레딧 사용량 구독 billing" },
	{ id: "general", label: "일반", icon: Settings, group: "기본", keywords: "화면 테마 언어 숨김 파일 로그인 업데이트 통계 문서 언어" },
	{ id: "ai", label: "AI 모델", icon: Sparkles, group: "AI", keywords: "LLM 모델 공급자 서비스 API 키 구독 임베딩 Jev 질문 나누기 정렬" },
	{ id: "web", label: "웹 검색", icon: Globe, group: "AI", keywords: "웹 검색 인터넷 검색 서비스 페이지 읽기" },
	{ id: "indexing", label: "인덱싱", icon: RefreshCw, group: "검색", keywords: "최신화 동기화 증분 색인 갱신 주기 sync" },
	{ id: "scope", label: "검색 범위", icon: Folder, group: "검색", keywords: "검색 범위 폴더 제외 경로 미디어" },
	{ id: "reading", label: "문서 읽기", icon: FileText, group: "검색", keywords: "문서 읽기 OCR 언어 파서" },
	{ id: "duplicates", label: "중복 파일 정리", icon: Copy, group: "검색", keywords: "중복 파일 버전 정리 dupey" },
	{ id: "apps", label: "모든 연결", icon: Plug, group: "연결된 앱", keywords: "연결 앱 데이터소스 메신저 메일 클라우드" },
];

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
			return { alias, type, label: template === undefined ? alias : `${template.label} · ${alias}` };
		});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SettingsView({ initialCategory = "general", onSettingsChanged }: { readonly initialCategory?: SettingsCategory; readonly onSettingsChanged?: (settings: AppSettings) => void }): ReactElement {
	const [category, setCategory] = useState<SettingsCategory>(() => normalizeCategory(initialCategory));
	const [query, setQuery] = useState("");
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [snapshot, setSnapshot] = useState<AutoRagConfigSnapshot | null>(null);
	const [sources, setSources] = useState<DataSourcesSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

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
		return PAGES.filter((page) => `${page.label} ${page.keywords}`.toLowerCase().includes(needle));
	}, [query]);
	const filteredSources = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return entries;
		return entries.filter((entry) => `${entry.label} ${entry.alias} ${entry.type}`.toLowerCase().includes(needle));
	}, [query, entries]);

	const groups = useMemo(() => {
		const order: string[] = [];
		const map = new Map<string, PageMeta[]>();
		for (const page of filteredPages) {
			if (!map.has(page.group)) {
				map.set(page.group, []);
				order.push(page.group);
			}
			map.get(page.group)?.push(page);
		}
		return order.map((group) => ({ group, pages: map.get(group) ?? [] }));
	}, [filteredPages]);

	const content = ((): ReactElement => {
		if (loading || appSettings === null || snapshot === null) return <p className="linear-section-desc">설정을 불러오는 중…</p>;
		const page = normalizeCategory(category);
		if (sourceAlias !== null) return <SourceDetailPage key={sourceAlias} snapshot={snapshot} onSaved={saveSnapshot} alias={sourceAlias} sources={sources} setSources={setSources} />;
		switch (page) {
			case "account":
				return <AccountPage />;
			case "plan":
				return <PlanPage />;
			case "general":
				return <GeneralPage appSettings={appSettings} onAppSettingsChanged={(next) => { setAppSettings(next); onSettingsChanged?.(next); }} snapshot={snapshot} onSaved={saveSnapshot} />;
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
		const row = sources?.sources.find((source) => source.id === entry.alias);
		const tone = row === undefined || !row.enabled ? "" : row.status === "ready" ? " is-ok" : " is-warn";
		return (
			<button key={entry.alias} type="button" className={`settings-nav-item settings-nav-item--source${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(`source:${entry.alias}`)}>
				<span className="settings-nav-label">{entry.label}</span>
				<span className={`settings-dot${tone}`} aria-hidden="true" />
			</button>
		);
	});

	return (
		<div className="settings-view settings-panel" role="region" aria-label="Settings">
			<aside className="settings-sidebar" aria-label="설정 탐색">
				<label className="settings-search">
					<span className="settings-search__icon" aria-hidden="true">
						<Search size={14} />
					</span>
					<input type="search" aria-label="설정 검색" placeholder="설정 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<nav aria-label="설정 메뉴" style={{ display: "contents" }}>
					{groups.map((group) => (
						<div key={group.group}>
							<div className="settings-sidebar-group-title">{group.group}</div>
							{group.pages.map((page) => {
								const Icon = page.icon;
								const active = sourceAlias === null && normalizeCategory(category) === page.id;
								return (
									<button key={page.id} type="button" className={`settings-nav-item${active ? " is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => setCategory(page.id)}>
										<span className="settings-nav-icon" aria-hidden="true">
											<Icon size={16} />
										</span>
										<span>{page.label}</span>
									</button>
								);
							})}
							{group.group === "연결된 앱" ? sourceButtons : null}
						</div>
					))}
					{!groups.some((group) => group.group === "연결된 앱") && filteredSources.length > 0 ? (
						<div>
							<div className="settings-sidebar-group-title">연결된 앱</div>
							{sourceButtons}
						</div>
					) : null}
				</nav>
				{query.trim().length > 0 && groups.length === 0 && filteredSources.length === 0 ? <p className="settings-nav-empty">일치하는 설정이 없습니다.</p> : null}
				<div className="settings-sidebar-footer">설정은 AutoRAG config.json과 앱 설정에 바로 반영됩니다.</div>
			</aside>
			<main className="settings-content" aria-label={`${sourceAlias ?? normalizeCategory(category)} settings`}>
				<div className="settings-content-wrap">
					{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
					{content}
				</div>
			</main>
		</div>
	);
}
