/**
 * Connecting an AI provider: the one flow Settings → AI 모델 and the onboarding
 * model step share, so a provider connected in either place is the same Pi
 * credential and shows up in both.
 *
 * Both OAuth and API-key connects use the real Pi `/login` handshake:
 * `providerLoginStart` opens a session, `onProviderLoginEvent` streams
 * prompts/auth_url/device_code/done/error into one generic modal, and
 * `providerLoginRespond`/`providerLoginCancel` drive it. The listener is
 * subscribed before the session starts and buffers by sessionId, so early
 * events are never dropped; a completed API-key login leaves the key in Pi
 * `auth.json`. Only providers that expose a key env var but no interactive login
 * fall back to `credentialsSet` (the secret never enters renderer state).
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { platformKey } from "../../lib/platform-copy";
import type { ProviderLoginEvent, ProviderLoginPrompt, ProviderSummary } from "../../../../shared/settings-contract";
import { AppIcon, ModalActions, ModalShell } from "./SettingsKit";
import { defaultEnvName, errorText } from "./configSupport";

const settings = window.autorag.settings;

/** TypeSafe only exposes a key env var; it has no interactive Pi /login. */
const CREDENTIAL_ONLY_ENV = "TYPESAFE_API_KEY";

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

function openExternal(url: string): void {
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(url);
}

export interface ProviderConnectOptions {
	/** Re-reads the provider list after a connect completed. */
	readonly reload: () => Promise<void>;
	/** Shows a one-line result ("connected", or why it failed) wherever the caller keeps its notices. */
	readonly onNotice: (message: string) => void;
}

export interface ProviderConnect {
	/** Starts the sign-in the provider needs: OAuth, Pi's API-key login, or the plain key form. */
	readonly connect: (provider: ProviderSummary, authType: "oauth" | "api_key") => void;
	/** Opens the form for a local or custom OpenAI-compatible server; `provider` edits an existing one. */
	readonly openServer: (kind: "local" | "custom", provider: ProviderSummary | null) => void;
	/** The open dialog, if any; render it once next to the UI that calls `connect`. */
	readonly modals: ReactElement | null;
}

export function useProviderConnect({ reload, onNotice }: ProviderConnectOptions): ProviderConnect {
	const { t } = useTranslation();
	const [keyModal, setKeyModal] = useState<ProviderSummary | null>(null);
	const [serverModal, setServerModal] = useState<{ readonly kind: "local" | "custom"; readonly provider: ProviderSummary | null } | null>(null);
	const [login, setLogin] = useState<LoginState | null>(null);
	const [loginInput, setLoginInput] = useState("");
	const listenerRef = useRef<(() => void) | null>(null);
	const loginRef = useRef<LoginState | null>(null);
	// The backend streams events as soon as the session starts, so subscribe
	// before `providerLoginStart` and buffer by sessionId until it returns.
	const activeSessionRef = useRef<string | null>(null);
	const bufferedEventsRef = useRef<ProviderLoginEvent[]>([]);
	loginRef.current = login;

	useEffect(
		() => (): void => {
			listenerRef.current?.();
		},
		[],
	);

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

	function endSession(): void {
		activeSessionRef.current = null;
		bufferedEventsRef.current = [];
		listenerRef.current?.();
		listenerRef.current = null;
	}

	function startLogin(provider: ProviderSummary, authType: "oauth" | "api_key"): void {
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
				endSession();
				const message = errorText(cause);
				// Some Pi providers expose a key env var but no interactive /login;
				// those keep the direct credential-store path.
				if (authType === "api_key" && /interactive API-key login/iu.test(message)) setKeyModal(provider);
				else onNotice(message);
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
					endSession();
					onNotice(t("settingsCore.ai.login.completed", { name: current.providerName }));
					void reload();
					return null;
				case "error":
					endSession();
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
		endSession();
		setLogin(null);
		setLoginInput("");
	}

	const done = (message: string): void => {
		onNotice(message);
		void reload();
	};

	const modals =
		keyModal !== null || serverModal !== null || login !== null ? (
			<>
				{keyModal !== null ? <ApiKeyModal provider={keyModal} onClose={() => setKeyModal(null)} onDone={(message) => { setKeyModal(null); done(message); }} /> : null}
				{serverModal !== null ? <ServerModal kind={serverModal.kind} provider={serverModal.provider} onClose={() => setServerModal(null)} onDone={(message) => { setServerModal(null); done(message); }} /> : null}
				{login !== null ? <LoginModal state={login} input={loginInput} onInput={setLoginInput} onRespond={respond} onCancel={cancelLogin} /> : null}
			</>
		) : null;

	return {
		connect: (provider, authType) => {
			if (authType === "api_key" && (provider.apiKeyEnv === CREDENTIAL_ONLY_ENV || provider.id === "typesafe")) setKeyModal(provider);
			else startLogin(provider, authType);
		},
		openServer: (kind, provider) => setServerModal({ kind, provider }),
		modals,
	};
}

export function ConnectMenu({
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
			<p>{kind === "local" ? t(platformKey("settingsCore.ai.server.bodyLocal")) : t("settingsCore.ai.server.bodyCustom")}</p>
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
