import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { AppSettings, AssistantEvent, ConfiguredModelSnapshot, Contact, DataSourceRow, DataSourcesSnapshot } from "../../../shared/settings-contract";
import type { SettingsBridge, AssistantSurface } from "../../../shared/settings-contract";
import { ArrowUpIcon, CloseIcon, PencilIcon, SparklesIcon } from "./icons";
import { Switch } from "./primitives/Switch";
import { iconButtonClass } from "./primitives/icon-button";
import { cn } from "../lib/cn";

interface AutoragHost {
	readonly autorag: { readonly settings: SettingsBridge };
}

// window.autorag is injected by the Electron preload; the renderer has no
// runtime schema for it, so this is the boundary cast.
const host = window as unknown as AutoragHost;
const autorag = host.autorag;

type SettingsTab = "general" | "models" | "sources" | "contacts";

/** Reference greeting copy (proto cfgMsgs / srcMsgs initial assistant messages, verbatim). */
const GREETINGS: Record<AssistantSurface, string> = {
	models: "모델 설정을 도와드릴게요. 원하는 방식을 말씀해 주세요. Quick과 Deep 답변은 같은 모델을 사용합니다.",
	sources: "데이터 소스를 연결하거나, 에이전트가 읽는 소스 설명을 다듬어 드릴게요.",
};

const CHIPS: Record<AssistantSurface, readonly string[]> = {
	models: ["가장 정확한 모델로", "빠른 응답 위주로", "데이터가 기기 밖으로 안 나가게"],
	sources: ["연결 가능한 데이터소스들 나열", "데이터소스 설명 손보기", "Discord 다시 연결"],
};

const PLACEHOLDERS: Record<AssistantSurface, string> = {
	models: "예: 회사 데이터는 밖으로 안 나가게 해줘",
	sources: "예: Outlook 연결해줘, Slack 설명 손봐줘",
};

interface ChatMessage {
	readonly role: "user" | "assistant";
	readonly text: string;
}

/** Source-kind tile colors reuse the v6 file/datasource tile tokens (DESIGN.md §2.9). */
const TILE_TONE = {
	slack: { bg: "bg-tile-slack", fg: "text-on-tile" },
	discord: { bg: "bg-tile-discord", fg: "text-on-tile" },
	telegram: { bg: "bg-tile-telegram", fg: "text-on-tile" },
	mail: { bg: "bg-tile-mail", fg: "text-on-tile" },
	notion: { bg: "bg-tile-notion", fg: "text-tile-notion-fg" },
	generic: { bg: "bg-tile-fallback", fg: "text-on-tile" },
} as const;

function kindTileModifier(kind: string): keyof typeof TILE_TONE {
	switch (kind) {
		case "slack":
		case "slacrawl":
			return "slack";
		case "discrawl":
		case "discord":
			return "discord";
		case "telecrawl":
		case "telegram":
			return "telegram";
		case "mailcrawl":
		case "mail-export":
		case "gmail":
			return "mail";
		case "notcrawl":
		case "notion":
			return "notion";
		default:
			return "generic";
	}
}

const STATUS_LABELS: Record<DataSourceRow["status"], string> = {
	ready: "Ready",
	syncing: "Syncing",
	paused: "Paused",
	attention: "Needs attention",
};

/** Status pill colours (tokens §2.7); mirrors `.source-status--*`. */
const STATUS_TONE: Record<DataSourceRow["status"], string> = {
	ready: "bg-ok-bg text-ok-text",
	syncing: "bg-warn-bg-strong text-warn-text",
	paused: "bg-input text-ink-muted",
	attention: "bg-error-orange-bg-strong text-error-orange-text",
};

/** Outcome states whose fact value is rendered in the ok / error-orange ink. */
const OK_FACT_STATES: Record<string, true> = { installed: true, builtin: true, connected: true, indexed: true };
const ERROR_FACT_STATES: Record<string, true> = { missing: true, "credential-missing": true, blocked: true, unsupported: true };

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

function formatIndexedAt(iso: string | null): string {
	return iso === null ? "" : new Date(iso).toLocaleString();
}

function indexSummary(index: DataSourceRow["index"]): string {
	if (index.state === "indexed" && index.chunkCount !== null) return `${index.chunkCount.toLocaleString()} chunks`;
	return INDEX_LABELS[index.state];
}

export function SettingsPanel({
	initialTab = "general",
	onClose,
	onSettingsChanged,
}: {
	readonly initialTab?: SettingsTab;
	readonly onClose: () => void;
	readonly onSettingsChanged?: (settings: AppSettings) => void;
}): ReactElement {
	const [tab, setTab] = useState<SettingsTab>(initialTab);
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [contacts, setContacts] = useState<readonly Contact[]>([]);
	const [snapshot, setSnapshot] = useState<DataSourcesSnapshot | null>(null);
	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [modelSnapshot, setModelSnapshot] = useState<ConfiguredModelSnapshot | null>(null);
	const [modelError, setModelError] = useState<string | null>(null);
	const [openSource, setOpenSource] = useState<string | null>(null);
	const [contactDraft, setContactDraft] = useState({ id: "", name: "", role: "", description: "" });
	const [chats, setChats] = useState<Record<AssistantSurface, ChatMessage[]>>({
		models: [{ role: "assistant", text: GREETINGS.models }],
		sources: [{ role: "assistant", text: GREETINGS.sources }],
	});
	const [drafts, setDrafts] = useState<Record<AssistantSurface, string>>({ models: "", sources: "" });
	const [busy, setBusy] = useState(false);
	const [updateState, setUpdateState] = useState<"idle" | "checking" | "done">("idle");
	const chatListRef = useRef<HTMLDivElement | null>(null);
	const chatInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		void Promise.all([
			autorag.settings.get().then(setSettings),
			autorag.settings.contactsList().then(setContacts),
		]);
		const unsubscribe = autorag.settings.onEvent?.((event: AssistantEvent) => {
			if (event.type === "text") {
				setChats((current) => {
					const thread = current[event.surface];
					const last = thread[thread.length - 1];
					const nextThread =
						last !== undefined && last.role === "assistant"
							? [...thread.slice(0, -1), { role: "assistant" as const, text: last.text + event.delta }]
							: [...thread, { role: "assistant" as const, text: event.delta }];
					return { ...current, [event.surface]: nextThread };
				});
			}
			if (event.type === "done" || event.type === "error") setBusy(false);
			if (event.type === "error") {
				setChats((current) => ({
					...current,
					[event.surface]: [...current[event.surface], { role: "assistant" as const, text: event.message }],
				}));
			}
		});
		return unsubscribe;
	}, []);

	useEffect(() => {
		if (tab === "sources") void reloadSources();
		if (tab === "models") void reloadModel();
	}, [tab]);

	useEffect(() => {
		const list = chatListRef.current;
		if (list !== null) list.scrollTop = list.scrollHeight;
	}, [chats, tab]);

	async function sendAssistant(surface: AssistantSurface, raw: string): Promise<void> {
		const text = raw.trim();
		if (text.length === 0 || busy) return;
		setBusy(true);
		setChats((current) => ({ ...current, [surface]: [...current[surface], { role: "user", text }] }));
		setDrafts((current) => ({ ...current, [surface]: "" }));
		await autorag.settings.assistantSend(surface, text);
	}

	async function toggleSetting(key: keyof AppSettings): Promise<void> {
		if (settings === null || typeof settings[key] !== "boolean") return;
		const next = await autorag.settings.set({ [key]: !settings[key] });
		setSettings(next);
		onSettingsChanged?.(next);
	}

	async function addContact(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (Object.values(contactDraft).some((value) => value.trim().length === 0)) return;
		const result = await autorag.settings.contactsAdd(contactDraft);
		if (result.ok) {
			setContacts((items) => [...items, contactDraft]);
			setContactDraft({ id: "", name: "", role: "", description: "" });
		}
	}

	async function reloadSources(): Promise<void> {
		try {
			setSnapshot(await autorag.settings.sourcesList());
			setSourcesError(null);
		} catch (error) {
			setSourcesError(error instanceof Error ? error.message : String(error));
		}
	}

	async function reloadModel(): Promise<void> {
		try {
			setModelSnapshot(await autorag.settings.modelsResolve());
			setModelError(null);
		} catch (error) {
			setModelError(error instanceof Error ? error.message : String(error));
		}
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
	const connectedCount = sources.filter((s) => s.agent.state === "connected").length;
	const syncingCount = sources.filter((s) => s.status === "syncing").length;
	const attentionCount = sources.filter((s) => s.status === "attention").length;
	const sourcesSummary = [
		`${sources.length} ${sources.length === 1 ? "source" : "sources"}`,
		`${connectedCount} connected to the agent`,
		syncingCount > 0 ? `${syncingCount} syncing` : null,
		attentionCount > 0 ? `${attentionCount} needs attention` : null,
	].filter(Boolean).join(" · ");
	const sourcesProblem = sourcesError ?? snapshot?.error ?? null;
	const model = modelSnapshot?.model ?? null;
	const modelProblem = modelError ?? modelSnapshot?.error ?? null;
	const modelStatus = modelSnapshot === null ? "불러오는 중…" : "설정된 모델이 없습니다";

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop dismiss mirrors the prototype
		<div className={cn("settings-backdrop", "absolute inset-0 z-20 grid place-items-center bg-scrim-modal backdrop-blur-[8px]")} role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: clicks inside the panel must not close it */}
			<section className={cn("settings-panel", "flex flex-col w-[min(760px,calc(100%_-_48px))] h-[min(580px,calc(100%_-_48px))] overflow-hidden border border-border rounded-14 bg-window shadow-window")} onClick={(event) => event.stopPropagation()}>
				<header className={cn("settings-panel__header", "flex items-center h-56 flex-none gap-12 py-0 pr-16 pl-20 border-b border-border")}>
					<strong className={cn("settings-panel__title", "text-title font-semibold")}>Settings</strong>
					<nav className={cn("settings-panel__tabs", "flex items-center gap-4 ml-8 p-3 border-0 rounded-10 bg-input")} aria-label="Settings sections">
						{(["general", "models", "sources"] as const).map((item) => (
							<button
								type="button"
								className={cn("h-28 px-12 border-0 rounded-7 text-meta font-medium cursor-pointer", tab === item ? "is-active bg-window text-ink" : "bg-transparent text-ink-muted")}
								key={item}
								onClick={() => setTab(item)}
							>
								{item === "sources" ? "Data Sources" : item[0]?.toUpperCase() + item.slice(1)}
							</button>
						))}
					</nav>
					<div className={cn("settings-panel__spacer", "flex-1")} />
					<button type="button" className={cn("icon-button", iconButtonClass())} aria-label="Close Settings" title="Close" onClick={onClose}><CloseIcon /></button>
				</header>
				<div className={cn("settings-panel__body", "flex flex-col gap-20 flex-1 min-h-0 overflow-auto p-20")}>
					{tab === "general" && settings !== null ? (
						<>
							<SettingsSection title="일반">
								<SettingRow label="Language" description="앱 인터페이스 언어">
									<div className={cn("settings-select", "relative after:absolute after:top-1/2 after:right-10 after:content-['⌄'] after:text-ink-muted after:pointer-events-none after:translate-y-[-55%]")}><select className={cn("h-32 pr-26 pl-10 border border-border rounded-6 bg-window text-ink text-body min-w-140 appearance-none")} value={settings.language} onChange={(event) => void autorag.settings.set({ language: event.target.value as AppSettings["language"] }).then(setSettings)}>
										<option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">简体中文</option>
									</select></div>
								</SettingRow>
								{/* WIP: launch-at-login persists but the app does not call app.setLoginItemSettings yet. */}
								<SettingRow label="Launch at login" description="Mac 로그인 시 자동 실행">
									<Switch checked={settings.launchAtLogin} onChange={() => void toggleSetting("launchAtLogin")} />
								</SettingRow>
								{/* WIP: menu-bar tray visibility is persisted but no Tray is managed in main yet. */}
								<SettingRow label="Show in menu bar" description="메뉴 막대에 아이콘 표시">
									<Switch checked={settings.showInMenuBar} onChange={() => void toggleSetting("showInMenuBar")} />
								</SettingRow>
								<SettingRow label="Show hidden files" description="점(.)으로 시작하는 숨김 파일·폴더를 목록에 흐리게 표시">
									<Switch checked={settings.showHiddenFiles} onChange={() => void toggleSetting("showHiddenFiles")} />
								</SettingRow>
								<SettingRow label="중복 문서 스캔 주기" description="dupey가 중복·유사 문서 묶음을 다시 계산하는 간격 (앱 시작 시 항상 1회 실행)">
									<div className={cn("settings-select", "relative after:absolute after:top-1/2 after:right-10 after:content-['⌄'] after:text-ink-muted after:pointer-events-none after:translate-y-[-55%]")}><select className={cn("h-32 pr-26 pl-10 border border-border rounded-6 bg-window text-ink text-body min-w-140 appearance-none")} value={String(settings.dupeyScanIntervalMinutes)} onChange={(event) => void autorag.settings.set({ dupeyScanIntervalMinutes: Number(event.target.value) }).then(setSettings)}>
										<option value="15">15분</option><option value="30">30분</option><option value="60">1시간</option><option value="180">3시간</option><option value="360">6시간</option><option value="720">12시간</option><option value="1440">24시간</option>
									</select></div>
								</SettingRow>
							</SettingsSection>
							{/* WIP: there is no real updater; the check below is simulated UI only. */}
							<SettingsSection title="소프트웨어 업데이트">
								<SettingRow
									label="AutoRAG Agent 1.4.2"
									description={updateState === "done" ? "최신 버전입니다 · 방금 확인" : "마지막 확인: 오늘 09:00"}
								>
									<button type="button" className={cn("h-32 flex-none px-12 border border-border rounded-6 bg-window text-ink text-meta font-medium whitespace-nowrap hover:bg-chrome")} onClick={() => { setUpdateState("checking"); window.setTimeout(() => setUpdateState("done"), 500); }}>{updateState === "checking" ? "Checking…" : "Check for Updates"}</button>
								</SettingRow>
								{/* WIP: auto-install persists; no update download/apply pipeline exists yet. */}
								<SettingRow label="Automatically install updates" description="백그라운드에서 다운로드 후 재시작 시 적용">
									<Switch checked={settings.autoInstallUpdates} onChange={() => void toggleSetting("autoInstallUpdates")} />
								</SettingRow>
							</SettingsSection>
							<SettingsSection title="개인정보">
								{/* WIP: settings-bridge clearHistory is a stub; the chat store is not cleared yet. */}
								<SettingRow label="Clear chat history" description="저장된 모든 AI Search 대화를 삭제">
									<button type="button" className={cn("settings-danger-button", "h-32 flex-none px-12 border border-border rounded-6 bg-window text-meta font-medium whitespace-nowrap", "text-accent-text hover:bg-accent-history-current")} onClick={() => void autorag.settings.clearHistory()}>Clear…</button>
								</SettingRow>
								{/* WIP: telemetry persists but no diagnostics pipeline reads it. */}
								<SettingRow label="Share anonymous diagnostics" description="제품 개선을 위한 익명 진단 정보 공유">
									<Switch checked={settings.telemetry} onChange={() => void toggleSetting("telemetry")} />
								</SettingRow>
							</SettingsSection>
						</>
					) : null}
					{tab === "contacts" ? (
						<>
							<form className={cn("settings-card settings-contact-form", "p-12 border border-border rounded-8")} onSubmit={(event) => void addContact(event)}>
								<input placeholder="id" value={contactDraft.id} onChange={(event) => setContactDraft({ ...contactDraft, id: event.target.value })} />
								<input placeholder="name" value={contactDraft.name} onChange={(event) => setContactDraft({ ...contactDraft, name: event.target.value })} />
								<input placeholder="role" value={contactDraft.role} onChange={(event) => setContactDraft({ ...contactDraft, role: event.target.value })} />
								<input placeholder="description" value={contactDraft.description} onChange={(event) => setContactDraft({ ...contactDraft, description: event.target.value })} />
								<button type="submit" className={cn("h-30 flex-none px-10 border border-border rounded-6 bg-window text-ink-body text-meta")}>Add contact</button>
							</form>
							{contacts.length === 0 ? <p>No contacts yet.</p> : contacts.map((contact) => (
								<article className={cn("settings-card", "p-12 border border-border rounded-8")} key={contact.id}>
									<strong>{contact.name}</strong><span className={cn("block mt-4 mx-0 mb-0 text-ink-muted")}>{contact.role}</span><p className={cn("block mt-4 mx-0 mb-0 text-ink-muted")}>{contact.description}</p>
									<button type="button" className={cn("h-30 flex-none px-10 border border-border rounded-6 bg-window text-ink-body text-meta")} onClick={() => void autorag.settings.contactsRemove(contact.id).then(() => setContacts((items) => items.filter((item) => item.id !== contact.id)))}>Remove</button>
								</article>
							))}
						</>
					) : null}
					{tab === "sources" ? (
						<div className={cn("settings-stack", "flex flex-1 flex-col gap-12 min-h-0")}>
							<div className={cn("settings-intro settings-intro--sources", "flex flex-none flex-row items-start gap-12")}>
								<div className={cn("settings-intro__text", "flex flex-auto flex-col gap-2 min-w-0")}>
									<strong className={cn("settings-intro__title", "text-ink text-body font-semibold")}>Connected sources</strong>
									<span className={cn("settings-intro__desc", "text-ink-muted text-meta")}>{sourcesSummary}</span>
									{snapshot === null ? null : (
										<span className={cn("settings-intro__desc settings-intro__config", "text-ink-muted text-meta overflow-hidden text-ellipsis whitespace-nowrap")} title="CLI, TUI, serve와 앱의 모든 AutoRAG 에이전트가 같은 설정 파일을 읽습니다">
											AutoRAG config · <code className={cn("font-mono")}>{snapshot.configPath}</code>{snapshot.configExists ? "" : " (없음)"}
										</span>
									)}
									{sourcesProblem === null ? null : <span className={cn("settings-intro__error", "text-error-orange-text text-meta")} role="alert">{sourcesProblem}</span>}
								</div>
								<button type="button" className={cn("settings-intro__refresh", "h-26 flex-none px-10 border border-border rounded-6 bg-window text-ink-body text-meta hover:border-accent hover:text-ink")} onClick={() => void reloadSources()}>새로고침</button>
							</div>
							<div className={cn("settings-sources", "flex flex-auto flex-col min-h-220 overflow-auto border border-border rounded-10")}>
								{sources.length === 0 ? <p className={cn("settings-sources__empty", "m-0 py-12 px-14 text-ink-muted text-sm")}>No configured data sources.</p> : sources.map((source) => (
									<SourceRow
										key={source.id}
										source={source}
										open={openSource === source.id}
										onToggle={() => void toggleSource(source)}
										onDetail={() => setOpenSource((current) => (current === source.id ? null : source.id))}
										onSaveDescription={(description) => saveSourceDescription(source, description)}
									/>
								))}
							</div>
							<AssistantPane surface="sources" chats={chats.sources} draft={drafts.sources} busy={busy} listRef={chatListRef} inputRef={chatInputRef} setDraft={(text) => setDrafts((current) => ({ ...current, sources: text }))} onSend={sendAssistant} />

						</div>
					) : null}
					{tab === "models" ? (
						<div className={cn("settings-stack", "flex flex-1 flex-col gap-12 min-h-0")}>
							<div className={cn("settings-model-card", "flex items-center gap-12 p-14 border border-border rounded-10 flex-none")}>
								<div className={cn("flex flex-1 flex-col gap-2 min-w-0")}>
									<strong className={cn("settings-model-card__name", "text-ink text-body font-semibold")}>{model === null ? "AutoRAG Agent" : model.displayName}</strong>
									<span className={cn("settings-model-card__provider", "text-ink-muted text-meta")}>
										{model === null ? modelStatus : `${model.provider} · ${model.api}`}
									</span>
								</div>
							</div>
							{modelProblem === null ? null : <span className={cn("settings-intro__error", "text-error-orange-text text-meta")} role="alert">{modelProblem}</span>}
							<AssistantPane surface="models" chats={chats.models} draft={drafts.models} busy={busy} listRef={chatListRef} inputRef={null} setDraft={(text) => setDrafts((current) => ({ ...current, models: text }))} onSend={sendAssistant} />
						</div>
					) : null}
				</div>
			</section>
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

	const tileKind = kindTileModifier(source.type);
	const tileTone = TILE_TONE[tileKind];

	return (
		<div className={cn("settings-source", "flex flex-none flex-col border-b border-divider", open ? "is-open bg-subtle" : "bg-window")} data-source-id={source.id}>
			<div className={cn("settings-source__row", "grid grid-cols-(--grid-source-row) gap-12 items-center py-10 px-14", !source.enabled && "is-disabled")}>
				<span className={cn(`settings-source-tile settings-source-tile--${tileKind}`, "flex items-center justify-center size-icon-sm rounded-7 text-meta font-bold", tileTone.bg, tileTone.fg, !source.enabled && "opacity-60")}>{source.id[0]?.toUpperCase() ?? "?"}</span>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: row body mirrors the prototype's clickable detail target */}
				<div className={cn("settings-source__body", "flex flex-col gap-2 min-w-0 cursor-pointer", !source.enabled && "opacity-60")} onClick={onDetail}>
					<span className={cn("settings-source__name", "text-ink text-body")}>{source.id}</span>
					<span className={cn("settings-source__detail", "overflow-hidden text-ink-muted text-meta text-ellipsis whitespace-nowrap")}>
						{source.type} · {INSTALL_LABELS[source.install.state]} · 에이전트 {AGENT_LABELS[source.agent.state]}
					</span>
				</div>
				<div className={cn("settings-source__track", "flex flex-col gap-6", !source.enabled && "opacity-60")}>
					<span className={cn(`settings-status source-status--${source.status}`, "py-1 px-6 rounded-6 text-badge font-semibold self-start", STATUS_TONE[source.status])}>{STATUS_LABELS[source.status]}</span>
					<span className={cn("settings-source__pct", "text-ink-muted text-meta")}>{indexSummary(source.index)}</span>
				</div>
				<button type="button" className={cn("settings-source__chevron", "flex items-center justify-center size-icon-sm border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer hover:bg-input hover:text-ink", open && "is-open")} title="Details" onClick={onDetail}>
					<svg className={cn("transition-[transform] duration-(--dur-color) ease-[ease]", open && "rotate-180")} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
				</button>
				<Switch checked={source.enabled} onChange={onToggle} ariaLabel={`${source.id} 사용`} />
			</div>
			{open ? (
				<div className={cn("settings-source-desc", "flex flex-col gap-8 mt-0 mr-14 mb-12 ml-54 py-12 px-14 border border-border rounded-8 bg-window")}>
					<dl className={cn("settings-source-facts", "flex flex-col gap-6 m-0")}>
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
					<div className={cn("settings-source-desc__header", "flex items-center gap-8")}>
						<span className={cn("text-ink-body text-meta font-semibold")}>Description</span>
						{editing ? null : (
							<button type="button" className={cn("settings-source-desc__edit", "flex items-center justify-center size-22 flex-none p-0 border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer hover:bg-input hover:text-ink")} aria-label={`${source.id} 설명 편집`} title="설명 편집" onClick={startEditing}>
								<PencilIcon />
							</button>
						)}
					</div>
					{editing ? (
						<form
							className={cn("settings-source-desc__form", "flex flex-col gap-8")}
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<textarea
								className={cn("settings-source-desc__input", "w-full min-h-64 box-border py-8 px-10 border border-border rounded-6 bg-window text-ink text-sm leading-read resize-y focus:border-accent focus:outline-none")}
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
							<div className={cn("settings-source-desc__actions", "flex justify-end gap-8")}>
								<button type="button" className={cn("h-26 px-12 border border-border rounded-6 bg-window text-ink-body text-meta cursor-pointer disabled:opacity-50 disabled:cursor-default")} disabled={saving} onClick={() => setEditing(false)}>취소</button>
								<button type="submit" className={cn("is-primary", "h-26 px-12 border rounded-6 text-meta cursor-pointer disabled:opacity-50 disabled:cursor-default", "border-accent bg-accent text-on-accent")} disabled={saving || draft.trim() === source.description.trim()}>
									{saving ? "저장 중…" : "저장"}
								</button>
							</div>
						</form>
					) : (
						<p className={cn("m-0 text-ink text-sm leading-read whitespace-pre-wrap")}>{source.description}</p>
					)}
				</div>
			) : null}
		</div>
	);
}

function SourceFact({ fact, label, state, value, detail }: { readonly fact: string; readonly label: string; readonly state: string; readonly value: string; readonly detail: string }): ReactElement {
	return (
		<div className={cn("settings-source-fact", "grid grid-cols-[96px_1fr] gap-8 text-meta")} data-fact={fact} data-state={state}>
			<dt className={cn("text-ink-muted")}>{label}</dt>
			<dd className={cn("flex flex-wrap gap-6 min-w-0 m-0 text-ink-body")}><strong className={cn("font-semibold", OK_FACT_STATES[state] === true && "text-ok-text", ERROR_FACT_STATES[state] === true && "text-error-orange-text")}>{value}</strong><span className={cn("[overflow-wrap:anywhere] text-ink-muted")}>{detail}</span></dd>
		</div>
	);
}

function AssistantPane({
	surface,
	chats,
	draft,
	busy,
	listRef,
	inputRef,
	setDraft,
	onSend,
}: {
	readonly surface: AssistantSurface;
	readonly chats: readonly ChatMessage[];
	readonly draft: string;
	readonly busy: boolean;
	readonly listRef: React.RefObject<HTMLDivElement | null> | null;
	readonly inputRef: React.RefObject<HTMLInputElement | null> | null;
	readonly setDraft: (text: string) => void;
	readonly onSend: (surface: AssistantSurface, text: string) => Promise<void>;
}): ReactElement {
	return (
		<div className={cn("settings-chat", `settings-chat--${surface}`, "flex flex-col min-h-0 overflow-hidden border border-border rounded-10 bg-subtle", surface === "models" ? "flex-1 min-h-220" : "flex-none h-240")}>
			<div className={cn("settings-chat__messages", "flex flex-1 flex-col gap-10 min-h-0 overflow-auto p-14")} ref={listRef ?? undefined}>
				{chats.map((message, index) => (
					<div className={cn("settings-chat__line", `settings-chat__line--${message.role}`, "flex", message.role === "user" && "justify-end")} key={index}>
						<div className={cn("settings-chat__bubble", `settings-chat__bubble--${message.role}`, "flex-none max-w-[80%] pt-8 pr-14 pb-8 pl-12 border border-border rounded-10 text-ink text-body leading-body w-fit break-keep", message.role === "user" ? "bg-input" : "bg-window")}>{message.text}</div>
					</div>
				))}
			</div>
			<div className={cn("settings-chips", "flex flex-none flex-wrap gap-6 px-14 pt-0 pb-10")}>
				{CHIPS[surface].map((chip) => (
					<button type="button" className={cn("h-28 flex-none px-10 border border-border rounded-14 bg-window text-ink-body text-meta whitespace-nowrap hover:border-accent hover:text-ink")} key={chip} disabled={busy} onClick={() => void onSend(surface, chip)}>{chip}</button>
				))}
			</div>
			<form
				className={cn("settings-chat__composer", "flex flex-none items-center gap-8 py-8 pr-8 pl-14 border-t border-border bg-window")}
				onSubmit={(event) => {
					event.preventDefault();
					void onSend(surface, draft);
				}}
			>
				<SparklesIcon size={14} className={cn("settings-chat__sparkle", "flex-none text-accent")} />
				<input
					className={cn("flex-1 min-w-0 h-32 border-none outline-none bg-transparent text-ink text-body")}
					ref={inputRef ?? undefined}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={PLACEHOLDERS[surface]}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
						event.preventDefault();
						void onSend(surface, draft);
					}}
				/>
				<button
					type="submit"
					title="Send"
					disabled={busy || draft.trim().length === 0}
					className={cn("flex items-center justify-center size-32 flex-none border-none rounded-8 text-ink disabled:cursor-default", draft.trim().length > 0 ? "is-live bg-accent" : "bg-border-strong")}
				>
					<ArrowUpIcon size={16} />
				</button>
			</form>
		</div>
	);
}

function SettingsSection({ title, children }: { readonly title: string; readonly children: ReactElement | ReactElement[] }): ReactElement {
	return <section className={cn("settings-section", "flex flex-col gap-8")}><h3 className={cn("m-0 text-ink-muted text-meta font-semibold")}>{title}</h3><div className={cn("settings-section__card", "overflow-hidden border border-border rounded-10")}>{children}</div></section>;
}

function SettingRow({ label, description, children }: { readonly label: string; readonly description: string; readonly children: ReactElement }): ReactElement {
	return (
		<div className={cn("settings-row", "flex items-center gap-12 min-h-56 py-10 px-14 border-b border-divider last:border-b-0")}>
			<div className={cn("flex flex-1 flex-col gap-2 min-w-0")}>
				<span className={cn("settings-row__label", "text-ink text-body font-regular")}>{label}</span>
				<span className={cn("settings-row__desc", "text-ink-muted text-meta")}>{description}</span>
			</div>
			<div className={cn("settings-row__control", "flex items-center flex-none gap-8")}>{children}</div>
		</div>
	);
}
