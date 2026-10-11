/**
 * Settings → AI 모델.
 *
 * The real provider list comes from `providersList` (Pi runtime providers plus
 * loopback/custom servers the user added). Both OAuth and API-key connects use
 * the real Pi `/login` handshake: `providerLoginStart` opens a session,
 * `onProviderLoginEvent` streams prompts/auth_url/device_code/done/error into a
 * single generic modal, and `providerLoginRespond`/`providerLoginCancel` drive
 * it. The listener is subscribed before the session starts and buffers by
 * sessionId, so early events are never dropped; a completed API-key login leaves
 * the key in Pi `auth.json`. Only providers that expose a key env var but no
 * interactive login fall back to `credentialsSet` (the secret never enters
 * renderer state). Role pickers only offer providers/models the catalog actually
 * returned and write the model-role config leaves through
 * `configPatch`/`configSet`/`configRemove`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Check, ChevronDown, Ellipsis, ExternalLink, Plus, Search } from "lucide-react";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	ModelCatalogEntry,
	ProviderLoginEvent,
	ProviderLoginPrompt,
	ProviderSummary,
} from "../../../../shared/settings-contract";
import { AppIcon, FloatingMenu, ModalActions, ModalShell, Note, Row, Section, SettingsPageHead } from "./SettingsKit";
import { asRecord, defaultEnvName, errorText, getAt, isAllowedAgentApi, stringOf, useConfigWriter } from "./configSupport";
import { EmbeddingPicker } from "./EmbeddingPicker";

const settings = window.autorag.settings;

const KIND_LABEL: Readonly<Record<ProviderSummary["kind"], string>> = {
	runtime: "런타임 공급자",
	local: "내 컴퓨터 서버",
	custom: "직접 추가한 서버",
};

const THINKING_LEVELS: readonly { readonly value: string; readonly label: string; readonly note?: string }[] = [
	{ value: "off", label: "생각 안 함", note: "가장 빠름" },
	{ value: "low", label: "낮음" },
	{ value: "medium", label: "보통" },
	{ value: "high", label: "높음", note: "정확도 우선" },
	{ value: "max", label: "최대", note: "가장 느림" },
];

/**
 * Jev backend a Pi provider id maps to. `jev-use` resolves typesafe /
 * openrouter / vercel backends; the Vercel AI Gateway provider id is
 * `vercel-ai-gateway`, not `vercel`.
 */
const JEV_BACKEND_BY_PROVIDER: Readonly<Record<string, "typesafe" | "openrouter" | "vercel">> = {
	typesafe: "typesafe",
	openrouter: "openrouter",
	"vercel-ai-gateway": "vercel",
};

/** The Jev model ids each backend accepts (jev is not a general LLM role). */
const JEV_MODELS_BY_BACKEND: Readonly<Record<"typesafe" | "openrouter" | "vercel", readonly { readonly id: string; readonly label: string }[]>> = {
	typesafe: [{ id: "jev-latest", label: "Jev (최신)" }],
	openrouter: [
		{ id: "typesafe/jev-1.13", label: "Jev 1.13" },
		{ id: "typesafe/jev-latest", label: "Jev (최신)" },
	],
	vercel: [{ id: "typesafe/jev-latest", label: "Jev (최신)" }],
};

/** OpenRouter rerank model ids the config accepts (rerank is not a general LLM role). */
const RERANK_MODELS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "voyageai/rerank-3-lite", label: "Voyage Rerank 3 Lite" },
	{ id: "voyageai/rerank-3", label: "Voyage Rerank 3" },
	{ id: "cohere/rerank-v3.5", label: "Cohere Rerank 3.5" },
	{ id: "cohere/rerank-4-fast", label: "Cohere Rerank 4 Fast" },
];

/** Backend that serves the rerank role (v2.7 supports OpenRouter only). */
const RERANK_PROVIDER_ID = "openrouter";

/** Decomposition specials: `false` means "let the answer model do it"; absence uses the documented default. */
const DECOMPOSITION_SPECIALS: readonly { readonly value: string; readonly label: string }[] = [
	{ value: "same", label: "답변 모델과 같게" },
	{ value: "default", label: "기본값 (OpenRouter Qwen3.7 Flash)" },
];

/** Jev and rerank disable by writing `false` to their block. */
const OFF_SPECIALS: readonly { readonly value: string; readonly label: string }[] = [{ value: "off", label: "사용 안 함" }];

/** TypeSafe only exposes a key env var; it has no interactive Pi /login. */
const CREDENTIAL_ONLY_ENV = "TYPESAFE_API_KEY";

/** Build a catalog entry for a static Jev/rerank model so pickers reuse one shape. */
function staticCatalogEntry(provider: ProviderSummary, id: string, name: string): ModelCatalogEntry {
	return { provider: provider.id, id, name, api: "", available: true, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv ?? null };
}

interface MenuState {
	readonly kind: "connect" | "provider" | "picker" | "thinking";
	readonly anchor: HTMLElement;
	readonly arg?: string;
}

interface LoginState {
	readonly sessionId: string;
	readonly providerName: string;
	readonly prompt: ProviderLoginPrompt | null;
	readonly message: string | null;
	readonly authUrl: string | null;
	readonly instructions: string | null;
	readonly deviceCode: { readonly userCode: string; readonly verificationUri: string } | null;
	readonly error: string | null;
	readonly busy: boolean;
}

/** Roles currently served by a provider, from the shared config. */
function rolesUsingProvider(snapshot: AutoRagConfigSnapshot, providerId: string): readonly string[] {
	const out: string[] = [];
	const model = asRecord(getAt(snapshot.config, ["model"]));
	if (stringOf(model?.provider) === providerId) out.push("답변");
	const decomposition = asRecord(getAt(snapshot.config, ["queryDecomposition", "model"]));
	if (stringOf(decomposition?.provider) === providerId) out.push("질문 나누기");
	const rerank = asRecord(getAt(snapshot.config, ["rerank"]));
	if (stringOf(rerank?.provider) === providerId) out.push("정렬");
	return out;
}

function openExternal(url: string): void {
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(url);
}

export function AiPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [keyModal, setKeyModal] = useState<ProviderSummary | null>(null);
	const [serverModal, setServerModal] = useState<{ readonly kind: "local" | "custom"; readonly provider: ProviderSummary | null } | null>(null);
	const [disconnect, setDisconnect] = useState<ProviderSummary | null>(null);
	const [login, setLogin] = useState<LoginState | null>(null);
	const [loginInput, setLoginInput] = useState("");
	const listenerRef = useRef<(() => void) | null>(null);
	const loginRef = useRef<LoginState | null>(null);
	// The backend streams events as soon as the session starts, so subscribe
	// before `providerLoginStart` and buffer by sessionId until it returns.
	const activeSessionRef = useRef<string | null>(null);
	const bufferedEventsRef = useRef<ProviderLoginEvent[]>([]);
	loginRef.current = login;

	const reload = useCallback(async (): Promise<void> => {
		try {
			setProviders(await settings.providersList());
		} catch (cause) {
			setNotice(errorText(cause));
			setProviders([]);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	useEffect(
		() => (): void => {
			listenerRef.current?.();
		},
		[],
	);

	const connected = useMemo(() => (providers ?? []).filter((provider) => provider.authConfigured), [providers]);
	const available = useMemo(() => (providers ?? []).filter((provider) => !provider.authConfigured), [providers]);
	const catalogModels = useMemo(() => connected.flatMap((provider) => provider.models.map((model) => ({ provider, model }))), [connected]);
	// Jev/rerank are not general LLM roles: offer only the backends/providers
	// that actually serve them, with the model ids each accepts.
	const jevOptions = useMemo(
		() =>
			connected.flatMap((provider) => {
				const backend = JEV_BACKEND_BY_PROVIDER[provider.id];
				if (backend === undefined) return [];
				return JEV_MODELS_BY_BACKEND[backend].map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) }));
			}),
		[connected],
	);
	const rerankOptions = useMemo(() => {
		const provider = connected.find((item) => item.id === RERANK_PROVIDER_ID);
		return provider === undefined ? [] : RERANK_MODELS.map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) }));
	}, [connected]);

	function closeMenu(): void {
		setMenu(null);
	}

	/** One long-lived listener: buffered until a session id exists, then matched by id. */
	function ensureListener(): void {
		if (listenerRef.current !== null) return;
		listenerRef.current = settings.onProviderLoginEvent((event) => {
			const active = activeSessionRef.current;
			if (active === null) {
				bufferedEventsRef.current.push(event);
				return;
			}
			if (event.sessionId !== active) return;
			applyLoginEvent(event, active);
		});
	}

	function startLogin(provider: ProviderSummary, authType: "oauth" | "api_key"): void {
		setNotice(null);
		bufferedEventsRef.current = [];
		activeSessionRef.current = null;
		// Subscribe before starting so prompt/auth_url/device_code emitted before
		// `providerLoginStart` resolves are buffered instead of lost.
		ensureListener();
		void (async () => {
			try {
				const started = await settings.providerLoginStart(provider.id, authType);
				activeSessionRef.current = started.sessionId;
				setLogin({ sessionId: started.sessionId, providerName: provider.name, prompt: null, message: "연결을 시작합니다…", authUrl: null, instructions: null, deviceCode: null, error: null, busy: false });
				const pending = bufferedEventsRef.current;
				bufferedEventsRef.current = [];
				for (const event of pending) {
					if (event.sessionId === started.sessionId) applyLoginEvent(event, started.sessionId);
				}
			} catch (cause) {
				activeSessionRef.current = null;
				bufferedEventsRef.current = [];
				listenerRef.current?.();
				listenerRef.current = null;
				const message = errorText(cause);
				// Some Pi providers expose a key env var but no interactive /login;
				// those keep the direct credential-store path.
				if (authType === "api_key" && /interactive API-key login/iu.test(message)) setKeyModal(provider);
				else setNotice(message);
			}
		})();
	}

	function applyLoginEvent(event: ProviderLoginEvent, sessionId: string): void {
		setLogin((current) => {
			if (current === null || current.sessionId !== sessionId) return current;
			switch (event.type) {
				case "prompt":
					return { ...current, prompt: event.prompt, busy: false, message: null };
				case "info":
				case "progress":
					return { ...current, message: event.message };
				case "auth_url":
					openExternal(event.url);
					return { ...current, authUrl: event.url, instructions: event.instructions ?? null, message: "브라우저에서 로그인을 완료하세요." };
				case "device_code":
					openExternal(event.verificationUri);
					return { ...current, deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri }, message: "브라우저에서 코드를 입력하세요." };
				case "done":
					activeSessionRef.current = null;
					bufferedEventsRef.current = [];
					listenerRef.current?.();
					listenerRef.current = null;
					setNotice(`${current.providerName} 연결을 완료했습니다.`);
					void reload();
					return null;
				case "error":
					activeSessionRef.current = null;
					bufferedEventsRef.current = [];
					listenerRef.current?.();
					listenerRef.current = null;
					return { ...current, error: event.message, busy: false, prompt: null };
			}
		});
	}

	function respond(value: string): void {
		const current = loginRef.current;
		if (current === null || value.trim().length === 0) return;
		setLogin({ ...current, busy: true, error: null });
		void settings
			.providerLoginRespond(current.sessionId, value)
			.then(() => setLogin((state) => (state === null ? null : { ...state, prompt: null, busy: true })))
			.catch((cause) => setLogin((state) => (state === null ? null : { ...state, error: errorText(cause), busy: false })));
		setLoginInput("");
	}

	function cancelLogin(): void {
		const current = loginRef.current;
		if (current !== null) void settings.providerLoginCancel(current.sessionId).catch(() => undefined);
		activeSessionRef.current = null;
		bufferedEventsRef.current = [];
		listenerRef.current?.();
		listenerRef.current = null;
		setLogin(null);
		setLoginInput("");
	}

	function writeModel(entry: ModelCatalogEntry): void {
		const name = entry.name.trim();
		const baseUrl = (entry.baseUrl ?? "").trim();
		const env = (entry.apiKeyEnv ?? "").trim();
		const updates: AutoRagConfigUpdate[] = [
			{ path: ["model", "provider"], value: entry.provider },
			{ path: ["model", "id"], value: entry.id },
			name.length > 0 ? { path: ["model", "name"], value: name } : { path: ["model", "name"], remove: true },
			entry.api.length > 0 && isAllowedAgentApi(entry.api) ? { path: ["model", "api"], value: entry.api } : { path: ["model", "api"], remove: true },
			baseUrl.length > 0 ? { path: ["model", "baseUrl"], value: baseUrl } : { path: ["model", "baseUrl"], remove: true },
			env.length > 0 ? { path: ["model", "apiKeyEnv"], value: env } : { path: ["model", "apiKeyEnv"], remove: true },
		];
		void run(updates);
	}

	function writeDecomposition(entry: ModelCatalogEntry): void {
		const model: Record<string, string> = { provider: entry.provider, id: entry.id };
		const name = entry.name.trim();
		const baseUrl = (entry.baseUrl ?? "").trim();
		const env = (entry.apiKeyEnv ?? "").trim();
		if (name.length > 0) model.name = name;
		if (entry.api.length > 0 && isAllowedAgentApi(entry.api)) model.api = entry.api;
		if (baseUrl.length > 0) model.baseUrl = baseUrl;
		if (env.length > 0) model.apiKeyEnv = env;
		void run([{ path: ["queryDecomposition"], value: { model } }]);
	}

	function writeJev(entry: ModelCatalogEntry): void {
		const backend = JEV_BACKEND_BY_PROVIDER[entry.provider];
		void run([{ path: ["jev"], value: { model: entry.id, ...(backend === undefined ? {} : { backend }) } }]);
	}

	function writeRerank(entry: ModelCatalogEntry): void {
		void run([{ path: ["rerank"], value: { enabled: true, provider: entry.provider, model: entry.id } }]);
	}

	/**
	 * Disconnect a provider: clear any role that pointed at it (answer/decomposition
	 * fall back to their defaults by removing the field; rerank/jev disable), then
	 * remove/logout the provider. An environment-sourced credential is not ours to
	 * delete — that is reported as info, never as a success.
	 */
	async function disconnectProvider(provider: ProviderSummary): Promise<void> {
		if (provider.authSource === "environment") {
			setNotice(`${provider.name} 키가 운영체제 환경 변수에서 제공되어 앱에서 해제할 수 없습니다. 해당 환경 변수를 직접 제거하세요.`);
			return;
		}
		const model = asRecord(getAt(snapshot.config, ["model"]));
		const decomposition = asRecord(getAt(snapshot.config, ["queryDecomposition", "model"]));
		const rerank = asRecord(getAt(snapshot.config, ["rerank"]));
		const jev = asRecord(getAt(snapshot.config, ["jev"]));
		const ops: AutoRagConfigUpdate[] = [];
		if (stringOf(model?.provider) === provider.id) ops.push({ path: ["model"], remove: true });
		if (stringOf(decomposition?.provider) === provider.id) ops.push({ path: ["queryDecomposition"], remove: true });
		if (stringOf(rerank?.provider) === provider.id) ops.push({ path: ["rerank"], value: false });
		if (stringOf(jev?.backend) === JEV_BACKEND_BY_PROVIDER[provider.id]) ops.push({ path: ["jev"], value: false });
		try {
			if (ops.length > 0) await run(ops);
			if (provider.kind === "local" || provider.kind === "custom") await settings.providersRemove(provider.id);
			else await settings.providerLogout(provider.id);
			setNotice(`${provider.name} 연결을 해제했습니다.`);
			await reload();
		} catch (cause) {
			setNotice(errorText(cause));
		}
	}

	async function test(provider: ProviderSummary): Promise<void> {
		setNotice(`${provider.name}: 확인 중…`);
		try {
			const result = await settings.providersTest(provider.id);
			setNotice(`${provider.name}: ${result.ok ? "연결 성공" : "연결 실패"}`);
		} catch {
			setNotice(`${provider.name}: 연결 실패`);
		}
	}

	async function discover(provider: ProviderSummary): Promise<void> {
		if (provider.baseUrl === null) return;
		try {
			const result = await settings.providersDiscover({ id: provider.id, kind: provider.kind === "local" ? "local" : "custom", label: provider.name, baseUrl: provider.baseUrl });
			setNotice(result.ok ? `${provider.name}: ${result.models.length}개 모델 발견 (${result.protocol ?? ""})` : `${provider.name}: ${result.error ?? "발견 실패"}`);
		} catch (cause) {
			setNotice(errorText(cause));
		}
	}

	const problem = error;
	return (
		<>
			<SettingsPageHead title="AI 모델" description="AI 서비스를 연결하고, 역할마다 쓸 모델을 고릅니다." />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{notice !== null ? <Note>{notice}</Note> : null}
			<Section title="연결된 서비스" description="연결한 서비스의 모델을 아래 역할에서 고를 수 있습니다.">
				<div className="settings-list">
					{connected.map((provider) => {
						const used = rolesUsingProvider(snapshot, provider.id);
						const meta = `${provider.subscription ? "구독 계정" : KIND_LABEL[provider.kind]}${provider.baseUrl === null ? "" : ` · ${provider.baseUrl}`}${used.length > 0 ? ` · ${used.join(", ")}에 사용 중` : ""}`;
						return (
							<div className="settings-list-row" key={provider.id}>
								<AppIcon label={provider.name} />
								<span className="settings-list-body">
									<span className="settings-list-title">{provider.name}</span>
									<span className="settings-list-meta">{meta}</span>
								</span>
								<button
									type="button"
									className="settings-icon-btn"
									aria-label={`${provider.name} 메뉴`}
									onClick={(event) => setMenu(menu?.kind === "provider" && menu.arg === provider.id ? null : { kind: "provider", anchor: event.currentTarget, arg: provider.id })}
								>
									<Ellipsis size={16} aria-hidden="true" focusable="false" />
								</button>
							</div>
						);
					})}
					{connected.length === 0 ? <Note>아직 연결된 서비스가 없습니다. 아래에서 연결하세요.</Note> : null}
					<button type="button" className="settings-list-row settings-add-row" onClick={(event) => setMenu({ kind: "connect", anchor: event.currentTarget })}>
						<Plus size={14} aria-hidden="true" focusable="false" />
						<span>서비스 연결</span>
					</button>
				</div>
			</Section>
			<Section title="역할별 모델" description="Dazzi는 일을 역할별로 나눠 처리합니다. 역할마다 맞는 모델을 고르세요.">
				<p className="settings-subsection-title">답변</p>
				<RoleRow role="answer" label="답변 모델" hint="질문에 답하고 문서를 요약합니다." current={answerLabel(snapshot)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "answer" })} thinking={{ onOpen: (anchor) => setMenu({ kind: "thinking", anchor }) }} />
				<p className="settings-subsection-title">검색 보조</p>
				<RoleRow role="decomposition" label="질문 나누기" hint="긴 질문을 검색어 여러 개로 나눕니다. 빠르고 저렴한 모델이 잘 맞습니다." current={decompositionLabel(snapshot)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "decomposition" })} />
				<RoleRow role="jev" label="판단 모델 (Jev)" hint="바로 답할지, 내 자료를 검색할지 판단합니다." current={jevLabel(snapshot)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "jev" })} />
				<RoleRow role="rerank" label="검색 결과 정렬" hint="관련 높은 결과를 위로 올립니다. 답변이 조금 느려질 수 있습니다." current={rerankLabel(snapshot)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "rerank" })} />
				<p className="settings-subsection-title">문서 이해</p>
				<EmbeddingPicker />
			</Section>
			{menu !== null ? (
				<FloatingMenu anchor={menu.anchor} compact={menu.kind === "thinking"} onClose={closeMenu}>
					{menu.kind === "connect" ? (
						<ConnectMenu
							providers={available}
							onConnect={(provider, authType) => {
								closeMenu();
								if (authType === "api_key" && (provider.apiKeyEnv === CREDENTIAL_ONLY_ENV || provider.id === "typesafe")) setKeyModal(provider);
								else startLogin(provider, authType);
							}}
							onPickServer={(kind) => { closeMenu(); setServerModal({ kind, provider: null }); }}
							onPickServerExisting={(provider) => { closeMenu(); setServerModal({ kind: provider.kind === "local" ? "local" : "custom", provider }); }}
						/>
					) : null}
					{menu.kind === "provider" ? <ProviderMenu provider={(providers ?? []).find((item) => item.id === menu.arg) ?? null} onEdit={(provider) => { closeMenu(); setServerModal({ kind: provider.kind === "local" ? "local" : "custom", provider }); }} onTest={(provider) => { closeMenu(); void test(provider); }} onDiscover={(provider) => { closeMenu(); void discover(provider); }} onLogout={(provider) => { closeMenu(); setDisconnect(provider); }} /> : null}
					{menu.kind === "picker" ? (
						<RolePicker
							role={menu.arg ?? "answer"}
							models={menu.arg === "jev" ? jevOptions : menu.arg === "rerank" ? rerankOptions : catalogModels}
							specials={menu.arg === "decomposition" ? DECOMPOSITION_SPECIALS : menu.arg === "jev" || menu.arg === "rerank" ? OFF_SPECIALS : []}
							onPick={(entry) => {
								closeMenu();
								if (menu.arg === "decomposition") writeDecomposition(entry);
								else if (menu.arg === "jev") writeJev(entry);
								else if (menu.arg === "rerank") writeRerank(entry);
								else writeModel(entry);
							}}
							onSpecial={(special) => {
								closeMenu();
								if (menu.arg === "decomposition" && special === "same") void run([{ path: ["queryDecomposition"], value: false }]);
								else if (menu.arg === "decomposition" && special === "default") void run([{ path: ["queryDecomposition"], remove: true }]);
								else if (menu.arg === "jev" && special === "off") void run([{ path: ["jev"], value: false }]);
								else if (menu.arg === "rerank" && special === "off") void run([{ path: ["rerank"], value: false }]);
							}}
						/>
					) : null}
					{menu.kind === "thinking" ? (
						<div className="settings-list">
							<p className="settings-menu-group">생각 깊이</p>
							{THINKING_LEVELS.map((level) => (
								<button key={level.value} type="button" className="settings-menu-item" onClick={() => { closeMenu(); void settings.configSet(["thinking", "final"], level.value).then(onSaved).catch((cause) => setNotice(errorText(cause))); }}>
									<span>{level.label}</span>
									{level.note !== undefined ? <small>{level.note}</small> : null}
									{thinkingValue(snapshot) === level.value ? <Check size={14} aria-hidden="true" focusable="false" /> : null}
								</button>
							))}
						</div>
					) : null}
				</FloatingMenu>
			) : null}
			{keyModal !== null ? <ApiKeyModal provider={keyModal} onClose={() => setKeyModal(null)} onDone={(message) => { setKeyModal(null); setNotice(message); void reload(); }} /> : null}
			{serverModal !== null ? <ServerModal kind={serverModal.kind} provider={serverModal.provider} onClose={() => setServerModal(null)} onDone={(message) => { setServerModal(null); setNotice(message); void reload(); }} /> : null}
			{disconnect !== null ? (
				<ModalShell onClose={() => setDisconnect(null)}>
					<h2>{disconnect.name} 연결을 해제할까요?</h2>
					<p>저장된 자격 증명을 지우고 목록에서 제거합니다. 이 서비스를 쓰던 역할은 새 모델을 골라야 할 수 있습니다.</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setDisconnect(null)}>취소</button>
						<button type="button" className="linear-btn is-danger" onClick={() => { const target = disconnect; setDisconnect(null); void disconnectProvider(target); }}>연결 해제</button>
					</ModalActions>
				</ModalShell>
			) : null}
			{login !== null ? <LoginModal state={login} input={loginInput} onInput={setLoginInput} onRespond={respond} onCancel={cancelLogin} /> : null}
		</>
	);
}

/* --------------------------------------------------------------- labels -- */

function answerLabel(snapshot: AutoRagConfigSnapshot): string {
	const model = asRecord(getAt(snapshot.config, ["model"]));
	const name = stringOf(model?.name);
	const id = stringOf(model?.id);
	return name.length > 0 ? name : id.length > 0 ? id : "설정 안 됨";
}

function decompositionLabel(snapshot: AutoRagConfigSnapshot): string {
	const raw = getAt(snapshot.config, ["queryDecomposition"]);
	// `false` means "let the answer model do it"; absent means the documented default model.
	if (raw === false) return "답변 모델과 같게";
	if (raw === undefined) return "기본값 (Qwen3.7 Flash)";
	const model = asRecord(asRecord(raw)?.model);
	return stringOf(model?.name) || stringOf(model?.id) || "기본값 (Qwen3.7 Flash)";
}

function jevLabel(snapshot: AutoRagConfigSnapshot): string {
	const raw = getAt(snapshot.config, ["jev"]);
	if (raw === false) return "사용 안 함";
	if (raw === undefined) return "자동";
	return stringOf(asRecord(raw)?.model) || "자동";
}

function rerankLabel(snapshot: AutoRagConfigSnapshot): string {
	const raw = getAt(snapshot.config, ["rerank"]);
	if (raw === false) return "사용 안 함";
	if (raw === undefined || raw === true) return "기본값";
	return stringOf(asRecord(raw)?.model) || "기본값";
}

function thinkingValue(snapshot: AutoRagConfigSnapshot): string {
	return stringOf(getAt(snapshot.config, ["thinking", "final"]));
}

/* --------------------------------------------------------------- pieces -- */

function RoleRow({
	role,
	label,
	hint,
	current,
	onOpen,
	thinking,
}: {
	readonly role: string;
	readonly label: string;
	readonly hint: string;
	readonly current: string;
	readonly onOpen: (anchor: HTMLElement) => void;
	readonly thinking?: { readonly onOpen: (anchor: HTMLElement) => void };
}): ReactElement {
	return (
		<Row name={label} hint={hint}>
			<span className={`settings-split${thinking === undefined ? " is-solo" : ""}`}>
				<button type="button" className="settings-trigger" aria-label={`${label} 선택`} data-role={role} onClick={(event) => onOpen(event.currentTarget)}>
					<span className="settings-trigger-label">{current}</span>
					<ChevronDown size={14} aria-hidden="true" focusable="false" />
				</button>
				{thinking !== undefined ? (
					<button type="button" className="settings-icon-btn" aria-label={`${label} 생각 깊이`} title="생각 깊이" onClick={(event) => thinking.onOpen(event.currentTarget)}>
						<Ellipsis size={16} aria-hidden="true" focusable="false" />
					</button>
				) : null}
			</span>
		</Row>
	);
}

function ConnectMenu({
	providers,
	onConnect,
	onPickServer,
	onPickServerExisting,
}: {
	readonly providers: readonly ProviderSummary[];
	readonly onConnect: (provider: ProviderSummary, authType: "oauth" | "api_key") => void;
	readonly onPickServer: (kind: "local" | "custom") => void;
	readonly onPickServerExisting: (provider: ProviderSummary) => void;
}): ReactElement {
	const subscriptions = providers.filter((provider) => provider.kind === "runtime" && (provider.subscription || provider.authKinds.includes("oauth")));
	const apiKeys = providers.filter((provider) => provider.kind === "runtime" && !provider.subscription && provider.authKinds.includes("api_key"));
	const servers = providers.filter((provider) => provider.kind === "local" || provider.kind === "custom");
	return (
		<>
			{subscriptions.length > 0 ? (
				<>
					<p className="settings-menu-group">구독 계정</p>
					{subscriptions.map((provider) => (
						<button key={provider.id} type="button" className="settings-menu-item" onClick={() => onConnect(provider, "oauth")}>
							<AppIcon small label={provider.name} />
							<span>{provider.name}</span>
						</button>
					))}
				</>
			) : null}
			{apiKeys.length > 0 ? (
				<>
					<p className="settings-menu-group">API 키</p>
					{apiKeys.map((provider) => (
						<button key={provider.id} type="button" className="settings-menu-item" onClick={() => onConnect(provider, "api_key")}>
							<AppIcon small label={provider.name} />
							<span>{provider.name}</span>
						</button>
					))}
				</>
			) : null}
			<p className="settings-menu-group">내 컴퓨터</p>
			{servers.map((provider) => (
				<button key={provider.id} type="button" className="settings-menu-item" onClick={() => onPickServerExisting(provider)}>
					<AppIcon small label={provider.name} />
					<span>{provider.name}</span>
				</button>
			))}
			<div className="settings-menu-sep" />
			<button type="button" className="settings-menu-item" onClick={() => onPickServer("custom")}>
				<Plus size={14} aria-hidden="true" focusable="false" />
				<span>직접 추가 (OpenAI 호환)</span>
			</button>
			<button type="button" className="settings-menu-item" onClick={() => onPickServer("local")}>
				<Plus size={14} aria-hidden="true" focusable="false" />
				<span>내 컴퓨터 서버 추가</span>
			</button>
		</>
	);
}

function ProviderMenu({
	provider,
	onEdit,
	onTest,
	onDiscover,
	onLogout,
}: {
	readonly provider: ProviderSummary | null;
	readonly onEdit: (provider: ProviderSummary) => void;
	readonly onTest: (provider: ProviderSummary) => void;
	readonly onDiscover: (provider: ProviderSummary) => void;
	readonly onLogout: (provider: ProviderSummary) => void;
}): ReactElement {
	if (provider === null) return <p className="settings-menu-empty">공급자를 찾을 수 없습니다.</p>;
	const editable = provider.kind === "local" || provider.kind === "custom";
	return (
		<>
			{editable ? (
				<button type="button" className="settings-menu-item" onClick={() => onEdit(provider)}>
					<ExternalLink size={14} aria-hidden="true" focusable="false" />
					<span>연결 정보 수정</span>
				</button>
			) : null}
			<button type="button" className="settings-menu-item" onClick={() => onTest(provider)}>
				<Check size={14} aria-hidden="true" focusable="false" />
				<span>연결 확인</span>
			</button>
			{editable && provider.baseUrl !== null ? (
				<button type="button" className="settings-menu-item" onClick={() => onDiscover(provider)}>
					<Search size={14} aria-hidden="true" focusable="false" />
					<span>모델 다시 검색</span>
				</button>
			) : null}
			<div className="settings-menu-sep" />
			<button type="button" className="settings-menu-item is-danger" onClick={() => onLogout(provider)}>
				<ExternalLink size={14} aria-hidden="true" focusable="false" />
				<span>연결 해제</span>
			</button>
		</>
	);
}

function RolePicker({
	role,
	models,
	specials,
	onPick,
	onSpecial,
}: {
	readonly role: string;
	readonly models: readonly { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }[];
	readonly specials: readonly { readonly value: string; readonly label: string }[];
	readonly onPick: (entry: ModelCatalogEntry) => void;
	readonly onSpecial: (special: string) => void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const lower = query.trim().toLowerCase();
	const match = (text: string): boolean => lower.length === 0 || text.toLowerCase().includes(lower);
	const byProvider = new Map<string, { readonly provider: ProviderSummary; readonly models: ModelCatalogEntry[] }>();
	for (const entry of models) {
		if (!match(entry.model.name) && !match(entry.model.id) && !match(entry.provider.name)) continue;
		const bucket = byProvider.get(entry.provider.id) ?? { provider: entry.provider, models: [] };
		bucket.models.push(entry.model);
		byProvider.set(entry.provider.id, bucket);
	}
	return (
		<>
			{specials.length > 0 ? (
				<div className="settings-list">
					{specials.map((special) => (
						<button key={special.value} type="button" className="settings-menu-item" onClick={() => onSpecial(special.value)}>
							<span>{special.label}</span>
						</button>
					))}
					<div className="settings-menu-sep" />
				</div>
			) : null}
			<label className="settings-menu-search">
				<Search size={14} aria-hidden="true" focusable="false" />
				<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="모델 검색" />
			</label>
			{byProvider.size === 0 ? (
				<p className="settings-menu-empty">{role === "jev" || role === "rerank" ? "이 역할에 쓸 수 있는 지원 모델이 없습니다. 해당 서비스를 먼저 연결하세요." : "연결된 서비스에서 사용할 수 있는 모델이 없습니다."}</p>
			) : (
				[...byProvider.values()].map((bucket) => (
					<div key={bucket.provider.id}>
						<p className="settings-menu-group">{bucket.provider.name}</p>
						{bucket.models.map((model) => (
							<button key={`${model.provider}/${model.id}`} type="button" className="settings-menu-item" onClick={() => onPick(model)}>
								<span>{model.name || model.id}</span>
								<small>{model.id}</small>
							</button>
						))}
					</div>
				))
			)}
		</>
	);
}

function ApiKeyModal({ provider, onClose, onDone }: { readonly provider: ProviderSummary; readonly onClose: () => void; readonly onDone: (message: string) => void }): ReactElement {
	const envName = provider.apiKeyEnv ?? defaultEnvName(provider.id);
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<ModalShell onClose={onClose}>
			<h2>{provider.name} 연결</h2>
			<p>{provider.name}에서 발급한 API 키를 붙여 넣으세요. 키는 암호화해 보관하며 다시 표시하지 않습니다.</p>
			<label>
				API 키 ({envName})
				<input type="password" autoFocus value={secret} placeholder="키 붙여 넣기" onChange={(event) => setSecret(event.target.value)} />
			</label>
			{error !== null ? <p className="settings-modal-error">{error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>취소</button>
				<button
					type="button"
					className="linear-btn settings-btn-primary"
					disabled={busy || secret.trim().length === 0}
					onClick={() => {
						setBusy(true);
						setError(null);
						void settings
							.credentialsSet(envName, secret.trim())
							.then(() => onDone(`${provider.name} 키를 저장했습니다.`))
							.catch((cause) => { setError(errorText(cause)); setBusy(false); });
					}}
				>
					연결
				</button>
			</ModalActions>
		</ModalShell>
	);
}

function ServerModal({ kind, provider, onClose, onDone }: { readonly kind: "local" | "custom"; readonly provider: ProviderSummary | null; readonly onClose: () => void; readonly onDone: (message: string) => void }): ReactElement {
	const [label, setLabel] = useState(provider?.name ?? (kind === "local" ? "내 컴퓨터 서버" : "사내 게이트웨이"));
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? (kind === "local" ? "http://127.0.0.1:11434" : ""));
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<ModalShell onClose={onClose}>
			<h2>{provider === null ? (kind === "local" ? "내 컴퓨터 서버 연결" : "OpenAI 호환 서비스 추가") : "연결 정보 수정"}</h2>
			<p>{kind === "local" ? "Ollama, LM Studio처럼 이 Mac에서 실행 중인 서버만 연결할 수 있습니다." : "회사 게이트웨이나 OpenAI 호환 서버를 연결합니다. 키는 암호화해 보관합니다."}</p>
			<label>이름<input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} /></label>
			<label>서버 주소<input value={baseUrl} placeholder="https://…/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
			<label>API 키 (선택)<input type="password" value={apiKey} placeholder="선택 사항" onChange={(event) => setApiKey(event.target.value)} /></label>
			{error !== null ? <p className="settings-modal-error">{error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>취소</button>
				<button
					type="button"
					className="linear-btn settings-btn-primary"
					disabled={busy || label.trim().length === 0 || baseUrl.trim().length === 0}
					onClick={() => {
						setBusy(true);
						setError(null);
						const input = { ...(provider === null ? {} : { id: provider.id }), kind, label: label.trim(), baseUrl: baseUrl.trim(), ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}) };
						void settings
							.providersUpsert(input)
							.then(() => onDone(`${label.trim()}을(를) 저장했습니다.`))
							.catch((cause) => { setError(errorText(cause)); setBusy(false); });
					}}
				>
					{provider === null ? "연결" : "저장"}
				</button>
			</ModalActions>
		</ModalShell>
	);
}

function LoginModal({
	state,
	input,
	onInput,
	onRespond,
	onCancel,
}: {
	readonly state: LoginState;
	readonly input: string;
	readonly onInput: (value: string) => void;
	readonly onRespond: (value: string) => void;
	readonly onCancel: () => void;
}): ReactElement {
	const prompt = state.prompt;
	return (
		<ModalShell onClose={onCancel}>
			<h2>{state.providerName} 연결</h2>
			{state.message !== null ? <p>{state.message}</p> : null}
			{state.authUrl !== null ? (
				<>
					<p>브라우저가 열리지 않으면 아래 주소를 직접 여세요.</p>
					<span className="settings-code">{state.authUrl}</span>
					{state.instructions !== null ? <p>{state.instructions}</p> : null}
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => openExternal(state.authUrl ?? "")}>브라우저 열기</button>
					</ModalActions>
				</>
			) : null}
			{state.deviceCode !== null ? (
				<>
					<p>아래 코드를 브라우저에 입력하세요.</p>
					<span className="settings-code">{state.deviceCode.userCode}</span>
					<span className="settings-code">{state.deviceCode.verificationUri}</span>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => openExternal(state.deviceCode?.verificationUri ?? "")}>브라우저 열기</button>
					</ModalActions>
				</>
			) : null}
			{prompt !== null && prompt.type === "select" ? (
				<div className="settings-list" style={{ marginTop: 12 }}>
					<p className="settings-menu-group">{prompt.message}</p>
					{prompt.options.map((option) => (
						<button key={option.id} type="button" className="settings-menu-item" disabled={state.busy} onClick={() => onRespond(option.id)}>
							<span>{option.label}</span>
							{option.description !== undefined ? <small>{option.description}</small> : null}
						</button>
					))}
				</div>
			) : null}
			{prompt !== null && prompt.type !== "select" ? (
				<label>
					{prompt.message}
					<input
						autoFocus
						type={prompt.type === "secret" ? "password" : "text"}
						value={input}
						placeholder={prompt.placeholder ?? ""}
						onChange={(event) => onInput(event.target.value)}
						onKeyDown={(event) => { if (event.key === "Enter") onRespond(input); }}
					/>
					<ModalActions>
						<button type="button" className="linear-btn settings-btn-primary" disabled={state.busy || input.trim().length === 0} onClick={() => onRespond(input)}>제출</button>
					</ModalActions>
				</label>
			) : null}
			{state.error !== null ? <p className="settings-modal-error">{state.error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onCancel}>취소</button>
			</ModalActions>
		</ModalShell>
	);
}
