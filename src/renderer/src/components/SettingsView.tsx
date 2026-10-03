import { useEffect, useRef, useState, type SyntheticEvent, type ReactElement } from "react";
import type { AppSettings, AssistantEvent, Contact, DataSourceRow, DataSourcesSnapshot } from "../../../shared/settings-contract";
import type { AssistantSurface } from "../../../shared/settings-contract";
import { ArrowUpIcon, DatabaseIcon, GearIcon, PencilIcon, SparklesIcon, UsersIcon } from "./icons";
import { Switch } from "./primitives/Switch";

const autorag = window.autorag;

export type SettingsCategory = "general" | "models" | "sources" | "contacts";

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

function kindTileModifier(kind: string): string {
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

const CATEGORIES: readonly { readonly id: SettingsCategory; readonly label: string; readonly icon: (props: { className?: string }) => ReactElement }[] = [
	{ id: "general", label: "General", icon: GearIcon },
	{ id: "models", label: "Models", icon: SparklesIcon },
	{ id: "sources", label: "Data Sources", icon: DatabaseIcon },
	{ id: "contacts", label: "Contacts", icon: UsersIcon },
];

export function SettingsView({
	initialCategory = "general",
	onSettingsChanged,
}: {
	readonly initialCategory?: SettingsCategory;
	readonly onSettingsChanged?: (settings: AppSettings) => void;
}): ReactElement {
	const [category, setCategory] = useState<SettingsCategory>(initialCategory);
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [contacts, setContacts] = useState<readonly Contact[]>([]);
	const [snapshot, setSnapshot] = useState<DataSourcesSnapshot | null>(null);
	const [sourcesError, setSourcesError] = useState<string | null>(null);
	const [openSource, setOpenSource] = useState<string | null>(null);
	const [contactDraft, setContactDraft] = useState({ id: "", name: "", role: "", description: "" });
	const [chats, setChats] = useState<Record<AssistantSurface, ChatMessage[]>>({
		models: [{ role: "assistant", text: GREETINGS.models }],
		sources: [{ role: "assistant", text: GREETINGS.sources }],
	});
	const [drafts, setDrafts] = useState<Record<AssistantSurface, string>>({ models: "", sources: "" });
	const [busy, setBusy] = useState(false);
	const [updateState, setUpdateState] = useState<"idle" | "checking" | "done">("idle");
	const [historyCleared, setHistoryCleared] = useState(false);
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
		if (category === "sources") void reloadSources();
	}, [category]);

	useEffect(() => {
		const list = chatListRef.current;
		if (list !== null) list.scrollTop = list.scrollHeight;
	}, [chats, category]);

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
	async function addContact(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
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
	const sourcesProblem = sourcesError ?? snapshot?.error ?? null;

	return (
		<div className="settings-view settings-panel" role="region" aria-label="Settings">
			<aside className="settings-sidebar" aria-label="Settings Categories">
				<div className="settings-sidebar__title">Settings</div>
				{CATEGORIES.map((item) => {
					const Icon = item.icon;
					const active = category === item.id;
					return (
						<button
							key={item.id}
							type="button"
							className={`settings-sidebar__item${active ? " is-active" : ""}`}
							aria-current={active ? "true" : undefined}
							onClick={() => setCategory(item.id)}
						>
							<Icon className="settings-sidebar__icon" />
							<span>{item.label}</span>
						</button>
					);
				})}
			</aside>

			<main className="settings-content" aria-label={`${category} settings`}>
				<div className="settings-content__container">
					{category === "general" && settings !== null ? (
						<>
							<div className="settings-content__header">
								<h2 className="settings-content__title">General</h2>
								<span className="settings-content__subtitle">환경 및 동작 설정</span>
							</div>

							<SettingsSection title="인터페이스 및 동작">
								<SettingRow label="Language" description="앱 인터페이스 언어">
									<div className="settings-select">
										<select
											value={settings.language}
											onChange={(event) =>
												void autorag.settings
													.set({ language: event.target.value as AppSettings["language"] })
													.then(setSettings)
											}
										>
											<option value="ko">한국어</option>
											<option value="en">English</option>
											<option value="ja">日本語</option>
											<option value="zh">简体中文</option>
										</select>
									</div>
								</SettingRow>
								<SettingRow label="Launch at login" description="Mac 로그인 시 자동 실행">
									<Switch checked={settings.launchAtLogin} onChange={() => void toggleSetting("launchAtLogin")} />
								</SettingRow>
								<SettingRow label="Show in menu bar" description="메뉴 막대에 아이콘 표시">
									<Switch checked={settings.showInMenuBar} onChange={() => void toggleSetting("showInMenuBar")} />
								</SettingRow>
								<SettingRow label="Show hidden files" description="점(.)으로 시작하는 숨김 파일·폴더를 목록에 흐리게 표시">
									<Switch checked={settings.showHiddenFiles} onChange={() => void toggleSetting("showHiddenFiles")} />
								</SettingRow>
								<SettingRow
									label="중복 문서 스캔 주기"
									description="dupey가 중복·유사 문서 묶음을 다시 계산하는 간격 (앱 시작 시 항상 1회 실행)"
								>
									<div className="settings-select">
										<select
											value={String(settings.dupeyScanIntervalMinutes)}
											onChange={(event) =>
												void autorag.settings
													.set({ dupeyScanIntervalMinutes: Number(event.target.value) })
													.then(setSettings)
											}
										>
											<option value="15">15분</option>
											<option value="30">30분</option>
											<option value="60">1시간</option>
											<option value="180">3시간</option>
											<option value="360">6시간</option>
											<option value="720">12시간</option>
											<option value="1440">24시간</option>
										</select>
									</div>
								</SettingRow>
							</SettingsSection>

							<SettingsSection title="소프트웨어 업데이트">
								<SettingRow
									label="AutoRAG Agent 1.4.2"
									description={updateState === "done" ? "최신 버전입니다 · 방금 확인됨" : "마지막 확인: 오늘 09:00"}
								>
									<button
										type="button"
										className="settings-action-btn"
										disabled={updateState === "checking"}
										onClick={() => {
											setUpdateState("checking");
											window.setTimeout(() => setUpdateState("done"), 600);
										}}
									>
										{updateState === "checking" ? "Checking…" : "Check for Updates"}
									</button>
								</SettingRow>
								<SettingRow label="Automatically install updates" description="백그라운드에서 다운로드 후 재시작 시 자동 적용">
									<Switch checked={settings.autoInstallUpdates} onChange={() => void toggleSetting("autoInstallUpdates")} />
								</SettingRow>
							</SettingsSection>

							<SettingsSection title="개인정보 및 기록">
								<SettingRow label="Clear chat history" description="저장된 모든 AI Search 대화 및 검색 기록을 삭제">
									<button
										type="button"
										className="settings-danger-button settings-action-btn"
										onClick={() => {
											void autorag.settings.clearHistory();
											setHistoryCleared(true);
											window.setTimeout(() => setHistoryCleared(false), 2500);
										}}
									>
										{historyCleared ? "기록 삭제됨 ✓" : "Clear…"}
									</button>
								</SettingRow>
								<SettingRow label="Share anonymous diagnostics" description="제품 개선을 위한 익명 진단 정보 및 통계 공유">
									<Switch checked={settings.telemetry} onChange={() => void toggleSetting("telemetry")} />
								</SettingRow>
							</SettingsSection>
						</>
					) : null}

					{category === "models" ? (
						<>
							<div className="settings-content__header">
								<h2 className="settings-content__title">Models</h2>
								<span className="settings-content__subtitle">AI 검색 및 요약 모델 설정</span>
							</div>

							<SettingsSection title="연결된 AI 모델">
								<div className="settings-model-card">
									<div className="settings-model-card__icon">A</div>
									<div className="settings-model-card__info">
										<div className="settings-model-card__header">
											<strong className="settings-model-card__name">AutoRAG Agent Engine</strong>
											<span className="settings-badge settings-badge--ready">Connected</span>
										</div>
										<span className="settings-model-card__provider">Quick 및 Deep 답변에 공통으로 연결된 고성능 AI 모델입니다.</span>
									</div>
								</div>
							</SettingsSection>

							<SettingsSection title="원클릭 프리셋 구성">
								<div className="settings-preset-grid">
									<button
										type="button"
										className="settings-preset-card"
										onClick={() => void sendAssistant("models", "가장 정확한 모델로 설정해줘")}
									>
										<div className="settings-preset-card__top">
											<span className="settings-preset-card__badge">정확도 우선</span>
											<span className="settings-preset-card__chip">High Accuracy</span>
										</div>
										<p className="settings-preset-card__desc">깊이 있는 분석과 근거 문서 정밀 대조를 최우선으로 실행합니다.</p>
									</button>
									<button
										type="button"
										className="settings-preset-card"
										onClick={() => void sendAssistant("models", "빠른 응답 위주로 설정해줘")}
									>
										<div className="settings-preset-card__top">
											<span className="settings-preset-card__badge">빠른 응답</span>
											<span className="settings-preset-card__chip">Fast Response</span>
										</div>
										<p className="settings-preset-card__desc">지연 시간을 최소화하여 즉각적인 요약과 탐색 답변을 생성합니다.</p>
									</button>
									<button
										type="button"
										className="settings-preset-card"
										onClick={() => void sendAssistant("models", "데이터가 기기 밖으로 안 나가게 로컬 모델로 설정해줘")}
									>
										<div className="settings-preset-card__top">
											<span className="settings-preset-card__badge">로컬 보호</span>
											<span className="settings-preset-card__chip">Local Only</span>
										</div>
										<p className="settings-preset-card__desc">외부 네트워크 전송 없이 안전한 로컬 온디바이스 모델을 사용합니다.</p>
									</button>
								</div>
							</SettingsSection>

							<SettingsSection title="모델 어시스턴트">
								<AssistantPane
									surface="models"
									chats={chats.models}
									draft={drafts.models}
									busy={busy}
									listRef={chatListRef}
									inputRef={null}
									setDraft={(text) => setDrafts((current) => ({ ...current, models: text }))}
									onSend={sendAssistant}
								/>
							</SettingsSection>
						</>
					) : null}

					{category === "sources" ? (
						<>
							<div className="settings-content__header">
								<h2 className="settings-content__title">Data Sources</h2>
								<span className="settings-content__subtitle">연동된 파일 및 앱 데이터 관리</span>
							</div>
							{sourcesProblem === null ? null : (
								<div className="settings-intro__error" role="alert">
									{sourcesProblem}
								</div>
							)}
							<SettingsSection title="연동된 데이터 소스 목록">
								<div className="settings-sources-list">
									{sources.length === 0 ? (
										<p className="settings-sources__empty">연동된 데이터 소스가 없습니다.</p>
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
							</SettingsSection>

							<SettingsSection title="데이터 소스 어시스턴트">
								<AssistantPane
									surface="sources"
									chats={chats.sources}
									draft={drafts.sources}
									busy={busy}
									listRef={chatListRef}
									inputRef={chatInputRef}
									setDraft={(text) => setDrafts((current) => ({ ...current, sources: text }))}
									onSend={sendAssistant}
								/>
							</SettingsSection>
						</>
					) : null}

					{category === "contacts" ? (
						<>
							<div className="settings-content__header">
								<h2 className="settings-content__title">Contacts</h2>
								<span className="settings-content__subtitle">팀원 및 에이전트 연락처</span>
							</div>

							<SettingsSection title="새 연락처 추가">
								<form className="settings-contact-form" onSubmit={(event) => void addContact(event)}>
									<div className="settings-contact-form__grid">
										<input
											placeholder="ID (예: seoyeon)"
											value={contactDraft.id}
											onChange={(event) => setContactDraft({ ...contactDraft, id: event.target.value })}
										/>
										<input
											placeholder="이름 (예: 김서연)"
											value={contactDraft.name}
											onChange={(event) => setContactDraft({ ...contactDraft, name: event.target.value })}
										/>
										<input
											placeholder="직책 / 역할 (예: 마케팅 리드)"
											value={contactDraft.role}
											onChange={(event) => setContactDraft({ ...contactDraft, role: event.target.value })}
										/>
										<input
											placeholder="설명 (예: Q3 예산 집행 총괄)"
											value={contactDraft.description}
											onChange={(event) => setContactDraft({ ...contactDraft, description: event.target.value })}
										/>
									</div>
									<div className="settings-contact-form__actions">
										<button
											type="submit"
											className="settings-action-btn is-primary"
											disabled={Object.values(contactDraft).some((v) => v.trim().length === 0)}
										>
											연락처 추가
										</button>
									</div>
								</form>
							</SettingsSection>

							<SettingsSection title="등록된 연락처">
								{contacts.length === 0 ? (
									<div className="settings-empty-notice">등록된 연락처가 없습니다.</div>
								) : (
									<div className="settings-contacts-list">
										{contacts.map((contact) => (
											<div className="settings-contact-item" key={contact.id}>
												<div className="settings-contact-item__avatar">{contact.name[0] ?? "?"}</div>
												<div className="settings-contact-item__body">
													<div className="settings-contact-item__name">
														<strong>{contact.name}</strong>
														<span className="settings-contact-item__role">{contact.role}</span>
													</div>
													<p className="settings-contact-item__desc">{contact.description}</p>
												</div>
												<button
													type="button"
													className="settings-action-btn settings-danger-button"
													onClick={() =>
														void autorag.settings
															.contactsRemove(contact.id)
															.then(() => setContacts((items) => items.filter((item) => item.id !== contact.id)))
													}
												>
													삭제
												</button>
											</div>
										))}
									</div>
								)}
							</SettingsSection>
						</>
					) : null}
				</div>
			</main>
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
				<span className={`settings-source-tile settings-source-tile--${kindTileModifier(source.type)}`}>
					{source.id[0]?.toUpperCase() ?? "?"}
				</span>
				<div className="settings-source__body" onClick={onDetail}>
					<span className="settings-source__name">{source.id}</span>
					<span className="settings-source__detail">
						{source.type} · {INSTALL_LABELS[source.install.state]} · 에이전트 {AGENT_LABELS[source.agent.state]}
					</span>
				</div>
				<div className="settings-source__track">
					<span className={`settings-status source-status--${source.status}`}>{STATUS_LABELS[source.status]}</span>
					<span className="settings-source__pct">{indexSummary(source.index)}</span>
				</div>
				<button
					type="button"
					className={`settings-source__chevron${open ? " is-open" : ""}`}
					title="Details"
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
		<div className={`settings-chat settings-chat--${surface}`}>
			<div className="settings-chat__messages" ref={listRef ?? undefined}>
				{chats.map((message, index) => (
					<div className={`settings-chat__line settings-chat__line--${message.role}`} key={index}>
						<div className={`settings-chat__bubble settings-chat__bubble--${message.role}`}>{message.text}</div>
					</div>
				))}
			</div>
			<div className="settings-chips">
				{CHIPS[surface].map((chip) => (
					<button type="button" key={chip} disabled={busy} onClick={() => void onSend(surface, chip)}>
						{chip}
					</button>
				))}
			</div>
			<form
				className="settings-chat__composer"
				onSubmit={(event) => {
					event.preventDefault();
					void onSend(surface, draft);
				}}
			>
				<SparklesIcon size={14} className="settings-chat__sparkle" />
				<input
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
					className={draft.trim().length > 0 ? "is-live" : ""}
				>
					<ArrowUpIcon size={16} />
				</button>
			</form>
		</div>
	);
}

function SettingsSection({ title, children }: { readonly title: string; readonly children: ReactElement | ReactElement[] }): ReactElement {
	return (
		<section className="settings-section">
			<h3>{title}</h3>
			<div className="settings-section__card">{children}</div>
		</section>
	);
}

function SettingRow({
	label,
	description,
	children,
}: {
	readonly label: string;
	readonly description: string;
	readonly children: ReactElement;
}): ReactElement {
	return (
		<div className="settings-row">
			<div>
				<span className="settings-row__label">{label}</span>
				<span className="settings-row__desc">{description}</span>
			</div>
			<div className="settings-row__control">{children}</div>
		</div>
	);
}
