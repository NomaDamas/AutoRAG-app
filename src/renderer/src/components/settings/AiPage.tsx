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
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
import { jevBackendFor, jevModelsFor, rerankModelsFor } from "../../../../shared/ai-roles";
import { providerConnectRoute, withoutAutorag } from "../../../../shared/account-contract";

const settings = window.autorag.settings;

const KIND_LABEL_KEY = {
	runtime: "settingsCore.ai.kind.runtime",
	local: "settingsCore.ai.kind.local",
	custom: "settingsCore.ai.kind.custom",
} as const satisfies Readonly<Record<ProviderSummary["kind"], string>>;

const THINKING_LEVELS = [
	{ value: "off", labelKey: "settingsCore.ai.thinking.off" },
	{ value: "low", labelKey: "settingsCore.ai.thinking.low" },
	{ value: "medium", labelKey: "settingsCore.ai.thinking.medium" },
	{ value: "high", labelKey: "settingsCore.ai.thinking.high" },
	{ value: "max", labelKey: "settingsCore.ai.thinking.max" },
] as const;

/** Decomposition specials: `false` means "let the answer model do it"; absence uses the documented default. */
const DECOMPOSITION_SPECIALS = [
	{ value: "same", labelKey: "settingsCore.ai.sameAsAnswer" },
	{ value: "default", labelKey: "settingsCore.ai.decompDefault" },
] as const;

/** Jev and rerank disable by writing `false` to their block. */
const OFF_SPECIALS = [{ value: "off", labelKey: "settingsCore.ai.off" }] as const;

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
function rolesUsingProvider(snapshot: AutoRagConfigSnapshot, providerId: string, t: TFunction): readonly string[] {
	const out: string[] = [];
	const model = asRecord(getAt(snapshot.config, ["model"]));
	if (stringOf(model?.provider) === providerId) out.push(t("settingsCore.ai.role.answer"));
	const decomposition = asRecord(getAt(snapshot.config, ["queryDecomposition", "model"]));
	if (stringOf(decomposition?.provider) === providerId) out.push(t("settingsCore.ai.role.decomposition"));
	const rerank = asRecord(getAt(snapshot.config, ["rerank"]));
	if (stringOf(rerank?.provider) === providerId) out.push(t("settingsCore.ai.role.rerank"));
	const jev = asRecord(getAt(snapshot.config, ["jev"]));
	const jevBackend = jevBackendFor(providerId);
	if (jevBackend !== undefined && stringOf(jev?.backend) === jevBackend) out.push(t("settingsCore.ai.role.jev"));
	return out;
}

function openExternal(url: string): void {
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(url);
}

export function AiPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
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
	// that actually serve them, with the model ids each accepts. The AutoRAG
	// plan comes first because `connected` is already ordered that way.
	const jevOptions = useMemo(
		() => connected.flatMap((provider) => jevModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) }))),
		[connected],
	);
	const rerankOptions = useMemo(
		() => connected.flatMap((provider) => rerankModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) }))),
		[connected],
	);

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
				setLogin({ sessionId: started.sessionId, providerName: provider.name, prompt: null, message: t("settingsCore.ai.login.starting"), authUrl: null, instructions: null, deviceCode: null, error: null, busy: false });
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
					return { ...current, authUrl: event.url, instructions: event.instructions ?? null, message: t("settingsCore.ai.login.completeInBrowser") };
				case "device_code":
					openExternal(event.verificationUri);
					return { ...current, deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri }, message: t("settingsCore.ai.login.enterCode") };
				case "done":
					activeSessionRef.current = null;
					bufferedEventsRef.current = [];
					listenerRef.current?.();
					listenerRef.current = null;
					setNotice(t("settingsCore.ai.login.completed", { name: current.providerName }));
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
		const backend = jevBackendFor(entry.provider);
		void run([{ path: ["jev"], value: { model: entry.id, ...(backend === undefined ? {} : { backend }) } }]);
	}

	function writeRerank(entry: ModelCatalogEntry): void {
		void run([{ path: ["rerank"], value: { enabled: true, provider: entry.provider, model: entry.id } }]);
	}

	/** Sign in to the AutoRAG plan through the account service (browser PKCE, encrypted key, adopted defaults). */
	async function signInToAutorag(): Promise<void> {
		setNotice(t("settingsCore.ai.login.signInBrowser"));
		try {
			const status = await window.autorag.account.signIn();
			setNotice(status.state === "signedIn" ? t("settingsCore.ai.login.signedIn") : (status.error ?? t("settingsCore.ai.login.notSignedIn")));
			await reload();
		} catch (cause) {
			setNotice(errorText(cause));
		}
	}

	/**
	 * Disconnect a provider: clear any role that pointed at it (answer/decomposition
	 * fall back to their defaults by removing the field; rerank/jev disable), then
	 * remove/logout the provider. An environment-sourced credential is not ours to
	 * delete — that is reported as info, never as a success.
	 */
	async function disconnectProvider(provider: ProviderSummary): Promise<void> {
		// The AutoRAG plan is signed in through the account service, so its key,
		// cached account and adopted defaults are removed there, not by Pi's logout.
		if (providerConnectRoute(provider.id) === "account") {
			try {
				const status = await window.autorag.account.signOut();
				setNotice(status.state === "signedIn" ? t("settingsCore.ai.disconnect.envLocked") : t("settingsCore.ai.disconnected", { name: provider.name }));
				await reload();
			} catch (cause) {
				setNotice(errorText(cause));
			}
			return;
		}
		if (provider.authSource === "environment") {
			setNotice(t("settingsCore.ai.envKeyCannotRemove", { name: provider.name }));
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
		if (stringOf(jev?.backend) === jevBackendFor(provider.id)) ops.push({ path: ["jev"], value: false });
		try {
			if (ops.length > 0) await run(ops);
			if (provider.kind === "local" || provider.kind === "custom") await settings.providersRemove(provider.id);
			else await settings.providerLogout(provider.id);
			setNotice(t("settingsCore.ai.disconnected", { name: provider.name }));
			await reload();
		} catch (cause) {
			setNotice(errorText(cause));
		}
	}

	async function test(provider: ProviderSummary): Promise<void> {
		setNotice(t("settingsCore.ai.testing", { name: provider.name }));
		try {
			const result = await settings.providersTest(provider.id);
			setNotice(`${provider.name}: ${result.ok ? t("settingsCore.ai.testOk") : t("settingsCore.ai.testFail")}`);
		} catch {
			setNotice(`${provider.name}: ${t("settingsCore.ai.testFail")}`);
		}
	}

	async function discover(provider: ProviderSummary): Promise<void> {
		if (provider.baseUrl === null) return;
		try {
			const result = await settings.providersDiscover({ id: provider.id, kind: provider.kind === "local" ? "local" : "custom", label: provider.name, baseUrl: provider.baseUrl });
			setNotice(result.ok ? t("settingsCore.ai.discoverFound", { name: provider.name, count: result.models.length, protocol: result.protocol ?? "" }) : t("settingsCore.ai.discoverFailed", { name: provider.name, error: result.error ?? t("settingsCore.ai.discoverFailWord") }));
		} catch (cause) {
			setNotice(errorText(cause));
		}
	}

	const problem = error;

	function specialsFor(role: string): readonly { readonly value: string; readonly label: string }[] {
		if (role === "decomposition") return DECOMPOSITION_SPECIALS.map((special) => ({ value: special.value, label: t(special.labelKey) }));
		if (role === "jev" || role === "rerank") return OFF_SPECIALS.map((special) => ({ value: special.value, label: t(special.labelKey) }));
		return [];
	}

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.ai")} description={t("settingsCore.ai.description")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{notice !== null ? <Note>{notice}</Note> : null}
			<Section title={t("settingsCore.ai.servicesTitle")} description={t("settingsCore.ai.servicesDesc")}>
				<div className="settings-list">
					{connected.map((provider) => {
						const used = rolesUsingProvider(snapshot, provider.id, t);
						const meta = `${provider.subscription ? t("settingsCore.ai.subscriptionAccount") : t(KIND_LABEL_KEY[provider.kind])}${provider.baseUrl === null ? "" : ` · ${provider.baseUrl}`}${used.length > 0 ? ` · ${t("settingsCore.ai.usedFor", { roles: used.join(", ") })}` : ""}`;
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
									aria-label={t("settingsCore.ai.providerMenu", { name: provider.name })}
									onClick={(event) => setMenu(menu?.kind === "provider" && menu.arg === provider.id ? null : { kind: "provider", anchor: event.currentTarget, arg: provider.id })}
								>
									<Ellipsis size={16} aria-hidden="true" focusable="false" />
								</button>
							</div>
						);
					})}
					{connected.length === 0 ? <Note>{t("settingsCore.ai.noServices")}</Note> : null}
					<button type="button" className="settings-list-row settings-add-row" onClick={(event) => setMenu({ kind: "connect", anchor: event.currentTarget })}>
						<Plus size={14} aria-hidden="true" focusable="false" />
						<span>{t("settingsCore.ai.connectService")}</span>
					</button>
				</div>
			</Section>
			<Section title={t("settingsCore.ai.rolesTitle")} description={t("settingsCore.ai.rolesDesc")}>
				<p className="settings-subsection-title">{t("settingsCore.ai.role.answer")}</p>
				<RoleRow role="answer" label={t("settingsCore.ai.answerModel")} hint={t("settingsCore.ai.answerHint")} current={answerLabel(snapshot, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "answer" })} thinking={{ onOpen: (anchor) => setMenu({ kind: "thinking", anchor }) }} />
				<p className="settings-subsection-title">{t("settingsCore.ai.subSearchAssistant")}</p>
				<RoleRow role="decomposition" label={t("settingsCore.ai.role.decomposition")} hint={t("settingsCore.ai.decompositionHint")} current={decompositionLabel(snapshot, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "decomposition" })} />
				<RoleRow role="jev" label={t("settingsCore.ai.jevModel")} hint={t("settingsCore.ai.jevHint")} current={jevLabel(snapshot, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "jev" })} />
				<RoleRow role="rerank" label={t("settingsCore.ai.rerankModel")} hint={t("settingsCore.ai.rerankHint")} current={rerankLabel(snapshot, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "rerank" })} />
				<p className="settings-subsection-title">{t("settingsCore.ai.subDocUnderstanding")}</p>
				<EmbeddingPicker />
			</Section>
			{menu !== null ? (
				<FloatingMenu anchor={menu.anchor} compact={menu.kind === "thinking"} onClose={closeMenu}>
					{menu.kind === "connect" ? (
						<ConnectMenu
							providers={withoutAutorag(available)}
							onSignInToAutorag={available.some((provider) => providerConnectRoute(provider.id) === "account") ? () => { closeMenu(); void signInToAutorag(); } : undefined}
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
							specials={specialsFor(menu.arg ?? "answer")}
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
							<p className="settings-menu-group">{t("settingsCore.ai.thinkingDepth")}</p>
							{THINKING_LEVELS.map((level) => (
								<button key={level.value} type="button" className="settings-menu-item" onClick={() => { closeMenu(); void settings.configSet(["thinking", "final"], level.value).then(onSaved).catch((cause) => setNotice(errorText(cause))); }}>
									<span>{t(level.labelKey)}</span>
									{level.value === "off" ? <small>{t("settingsCore.ai.thinking.offNote")}</small> : level.value === "high" ? <small>{t("settingsCore.ai.thinking.highNote")}</small> : level.value === "max" ? <small>{t("settingsCore.ai.thinking.maxNote")}</small> : null}
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
					<h2>{t("settingsCore.ai.disconnect.title", { name: disconnect.name })}</h2>
					<p>{t("settingsCore.ai.disconnect.body")}</p>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setDisconnect(null)}>{t("common.cancel")}</button>
						<button type="button" className="linear-btn is-danger" onClick={() => { const target = disconnect; setDisconnect(null); void disconnectProvider(target); }}>{t("settingsCore.ai.disconnect.action")}</button>
					</ModalActions>
				</ModalShell>
			) : null}
			{login !== null ? <LoginModal state={login} input={loginInput} onInput={setLoginInput} onRespond={respond} onCancel={cancelLogin} /> : null}
		</>
	);
}

/* --------------------------------------------------------------- labels -- */

function answerLabel(snapshot: AutoRagConfigSnapshot, t: TFunction): string {
	const model = asRecord(getAt(snapshot.config, ["model"]));
	const name = stringOf(model?.name);
	const id = stringOf(model?.id);
	return name.length > 0 ? name : id.length > 0 ? id : t("settingsCore.common.notSet");
}

function decompositionLabel(snapshot: AutoRagConfigSnapshot, t: TFunction): string {
	const raw = getAt(snapshot.config, ["queryDecomposition"]);
	// `false` means "let the answer model do it"; absent means the documented default model.
	if (raw === false) return t("settingsCore.ai.sameAsAnswer");
	if (raw === undefined) return t("settingsCore.ai.defaultModel");
	const model = asRecord(asRecord(raw)?.model);
	return stringOf(model?.name) || stringOf(model?.id) || t("settingsCore.ai.defaultModel");
}

function jevLabel(snapshot: AutoRagConfigSnapshot, t: TFunction): string {
	const raw = getAt(snapshot.config, ["jev"]);
	if (raw === false) return t("settingsCore.ai.off");
	if (raw === undefined) return t("settingsCore.ai.auto");
	return stringOf(asRecord(raw)?.model) || t("settingsCore.ai.auto");
}

function rerankLabel(snapshot: AutoRagConfigSnapshot, t: TFunction): string {
	const raw = getAt(snapshot.config, ["rerank"]);
	if (raw === false) return t("settingsCore.ai.off");
	if (raw === undefined || raw === true) return t("settingsCore.ai.defaultValue");
	return stringOf(asRecord(raw)?.model) || t("settingsCore.ai.defaultValue");
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
	const { t } = useTranslation();
	return (
		<Row name={label} hint={hint}>
			<span className={`settings-split${thinking === undefined ? " is-solo" : ""}`}>
				<button type="button" className="settings-trigger" aria-label={t("settingsCore.ai.selectRole", { label })} data-role={role} onClick={(event) => onOpen(event.currentTarget)}>
					<span className="settings-trigger-label">{current}</span>
					<ChevronDown size={14} aria-hidden="true" focusable="false" />
				</button>
				{thinking !== undefined ? (
					<button type="button" className="settings-icon-btn" aria-label={t("settingsCore.ai.thinkingDepthFor", { label })} title={t("settingsCore.ai.thinkingDepth")} onClick={(event) => thinking.onOpen(event.currentTarget)}>
						<Ellipsis size={16} aria-hidden="true" focusable="false" />
					</button>
				) : null}
			</span>
		</Row>
	);
}

function ConnectMenu({
	providers,
	onSignInToAutorag,
	onConnect,
	onPickServer,
	onPickServerExisting,
}: {
	readonly providers: readonly ProviderSummary[];
	/** Present while the AutoRAG plan is not signed in; it opens the account sign-in, not Pi's login. */
	readonly onSignInToAutorag: (() => void) | undefined;
	readonly onConnect: (provider: ProviderSummary, authType: "oauth" | "api_key") => void;
	readonly onPickServer: (kind: "local" | "custom") => void;
	readonly onPickServerExisting: (provider: ProviderSummary) => void;
}): ReactElement {
	const { t } = useTranslation();
	const subscriptions = providers.filter((provider) => provider.kind === "runtime" && (provider.subscription || provider.authKinds.includes("oauth")));
	const apiKeys = providers.filter((provider) => provider.kind === "runtime" && !provider.subscription && provider.authKinds.includes("api_key"));
	const servers = providers.filter((provider) => provider.kind === "local" || provider.kind === "custom");
	return (
		<>
			{onSignInToAutorag !== undefined ? (
				<>
					<p className="settings-menu-group">{t("settingsCore.ai.menu.dazziPlan")}</p>
					<button type="button" className="settings-menu-item" onClick={onSignInToAutorag}>
						<AppIcon small label="Dazzi" />
						<span>{t("settingsCore.ai.menu.signInDazzi")}</span>
					</button>
				</>
			) : null}
			{subscriptions.length > 0 ? (
				<>
					<p className="settings-menu-group">{t("settingsCore.ai.subscriptionAccount")}</p>
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
					<p className="settings-menu-group">{t("settingsCore.ai.menu.apiKeys")}</p>
					{apiKeys.map((provider) => (
						<button key={provider.id} type="button" className="settings-menu-item" onClick={() => onConnect(provider, "api_key")}>
							<AppIcon small label={provider.name} />
							<span>{provider.name}</span>
						</button>
					))}
				</>
			) : null}
			<p className="settings-menu-group">{t("settingsCore.ai.menu.localMachine")}</p>
			{servers.map((provider) => (
				<button key={provider.id} type="button" className="settings-menu-item" onClick={() => onPickServerExisting(provider)}>
					<AppIcon small label={provider.name} />
					<span>{provider.name}</span>
				</button>
			))}
			<div className="settings-menu-sep" />
			<button type="button" className="settings-menu-item" onClick={() => onPickServer("custom")}>
				<Plus size={14} aria-hidden="true" focusable="false" />
				<span>{t("settingsCore.ai.menu.addCustom")}</span>
			</button>
			<button type="button" className="settings-menu-item" onClick={() => onPickServer("local")}>
				<Plus size={14} aria-hidden="true" focusable="false" />
				<span>{t("settingsCore.ai.menu.addLocalServer")}</span>
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
	const { t } = useTranslation();
	if (provider === null) return <p className="settings-menu-empty">{t("settingsCore.ai.providerNotFound")}</p>;
	const editable = provider.kind === "local" || provider.kind === "custom";
	return (
		<>
			{editable ? (
				<button type="button" className="settings-menu-item" onClick={() => onEdit(provider)}>
					<ExternalLink size={14} aria-hidden="true" focusable="false" />
					<span>{t("settingsCore.ai.provider.edit")}</span>
				</button>
			) : null}
			<button type="button" className="settings-menu-item" onClick={() => onTest(provider)}>
				<Check size={14} aria-hidden="true" focusable="false" />
				<span>{t("settingsCore.ai.provider.test")}</span>
			</button>
			{editable && provider.baseUrl !== null ? (
				<button type="button" className="settings-menu-item" onClick={() => onDiscover(provider)}>
					<Search size={14} aria-hidden="true" focusable="false" />
					<span>{t("settingsCore.ai.provider.discover")}</span>
				</button>
			) : null}
			<div className="settings-menu-sep" />
			<button type="button" className="settings-menu-item is-danger" onClick={() => onLogout(provider)}>
				<ExternalLink size={14} aria-hidden="true" focusable="false" />
				<span>{t("settingsCore.ai.disconnect.action")}</span>
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
	const { t } = useTranslation();
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
				<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settingsCore.ai.searchModels")} />
			</label>
			{byProvider.size === 0 ? (
				<p className="settings-menu-empty">{role === "jev" || role === "rerank" ? t("settingsCore.ai.emptyRoleModels") : t("settingsCore.ai.emptyModels")}</p>
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
	const { t } = useTranslation();
	const envName = provider.apiKeyEnv ?? defaultEnvName(provider.id);
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<ModalShell onClose={onClose}>
			<h2>{t("settingsCore.ai.connect.title", { name: provider.name })}</h2>
			<p>{t("settingsCore.ai.connect.body", { name: provider.name })}</p>
			<label>
				{t("settingsCore.ai.connect.apiKeyLabel", { env: envName })}
				<input type="password" autoFocus value={secret} placeholder={t("settingsCore.ai.connect.keyPlaceholder")} onChange={(event) => setSecret(event.target.value)} />
			</label>
			{error !== null ? <p className="settings-modal-error">{error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
				<button
					type="button"
					className="linear-btn settings-btn-primary"
					disabled={busy || secret.trim().length === 0}
					onClick={() => {
						setBusy(true);
						setError(null);
						void settings
							.credentialsSet(envName, secret.trim())
							.then(() => onDone(t("settingsCore.ai.connect.saved", { name: provider.name })))
							.catch((cause) => { setError(errorText(cause)); setBusy(false); });
					}}
				>
					{t("settingsCore.ai.connect.action")}
				</button>
			</ModalActions>
		</ModalShell>
	);
}

function ServerModal({ kind, provider, onClose, onDone }: { readonly kind: "local" | "custom"; readonly provider: ProviderSummary | null; readonly onClose: () => void; readonly onDone: (message: string) => void }): ReactElement {
	const { t } = useTranslation();
	const [label, setLabel] = useState(provider?.name ?? (kind === "local" ? t("settingsCore.ai.server.defaultLocal") : t("settingsCore.ai.server.defaultCustom")));
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? (kind === "local" ? "http://127.0.0.1:11434" : ""));
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<ModalShell onClose={onClose}>
			<h2>{provider === null ? (kind === "local" ? t("settingsCore.ai.server.titleLocal") : t("settingsCore.ai.server.titleCustom")) : t("settingsCore.ai.server.titleEdit")}</h2>
			<p>{kind === "local" ? t("settingsCore.ai.server.bodyLocal") : t("settingsCore.ai.server.bodyCustom")}</p>
			<label>{t("settingsCore.ai.server.name")}<input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} /></label>
			<label>{t("settingsCore.ai.server.baseUrl")}<input value={baseUrl} placeholder="https://…/v1" onChange={(event) => setBaseUrl(event.target.value)} /></label>
			<label>{t("settingsCore.ai.server.apiKeyOptional")}<input type="password" value={apiKey} placeholder={t("settingsCore.ai.server.optionalPlaceholder")} onChange={(event) => setApiKey(event.target.value)} /></label>
			{error !== null ? <p className="settings-modal-error">{error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
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
							.then(() => onDone(t("settingsCore.ai.server.saved", { name: label.trim() })))
							.catch((cause) => { setError(errorText(cause)); setBusy(false); });
					}}
				>
					{provider === null ? t("settingsCore.ai.connect.action") : t("common.save")}
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
	const { t } = useTranslation();
	const prompt = state.prompt;
	return (
		<ModalShell onClose={onCancel}>
			<h2>{t("settingsCore.ai.connect.title", { name: state.providerName })}</h2>
			{state.message !== null ? <p>{state.message}</p> : null}
			{state.authUrl !== null ? (
				<>
					<p>{t("settingsCore.ai.loginModal.openManually")}</p>
					<span className="settings-code">{state.authUrl}</span>
					{state.instructions !== null ? <p>{state.instructions}</p> : null}
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => openExternal(state.authUrl ?? "")}>{t("settingsCore.ai.loginModal.openBrowser")}</button>
					</ModalActions>
				</>
			) : null}
			{state.deviceCode !== null ? (
				<>
					<p>{t("settingsCore.ai.loginModal.enterCode")}</p>
					<span className="settings-code">{state.deviceCode.userCode}</span>
					<span className="settings-code">{state.deviceCode.verificationUri}</span>
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => openExternal(state.deviceCode?.verificationUri ?? "")}>{t("settingsCore.ai.loginModal.openBrowser")}</button>
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
						<button type="button" className="linear-btn settings-btn-primary" disabled={state.busy || input.trim().length === 0} onClick={() => onRespond(input)}>{t("settingsCore.ai.loginModal.submit")}</button>
					</ModalActions>
				</label>
			) : null}
			{state.error !== null ? <p className="settings-modal-error">{state.error}</p> : null}
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onCancel}>{t("common.cancel")}</button>
			</ModalActions>
		</ModalShell>
	);
}
