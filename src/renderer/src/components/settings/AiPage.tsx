/**
 * Settings → AI 모델.
 *
 * The real provider list comes from `providersList` (Pi runtime providers plus
 * loopback/custom servers the user added). Connecting a provider is the shared
 * flow in `ProviderConnect` (also used by the onboarding model step). Role
 * pickers only offer providers/models the catalog actually returned and write
 * the model-role config leaves through `configPatch`/`configSet`/`configRemove`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Ellipsis, ExternalLink, Plus, Search } from "lucide-react";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	ModelCatalogEntry,
	ProviderSummary,
} from "../../../../shared/settings-contract";
import { ProviderIcon } from "./ProviderIcon";
import { FloatingMenu, ModalActions, ModalShell, Note, Row, SettingsPageHead } from "./SettingsKit";
import { asRecord, errorText, getAt, stringOf, useConfigWriter } from "./configSupport";
import { ConnectMenu, useProviderConnect } from "./ProviderConnect";
import { RolePicker } from "./ModelPicker";
import { jevLabel, jevOptionsFor, providerRoleCleanup, rerankLabel, rerankOptionsFor, roleSelectionFor } from "./roleSupport";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { JEV_SLLM_BACKEND, jevBackendFor, shouldAdoptManagedDecomposition } from "../../../../shared/ai-roles";
import { decompositionConfigUpdates, jevConfigUpdates, jevSllmConfigUpdates, modelConfigUpdates, rerankConfigUpdates } from "../../../../shared/model-config";
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

/** Rerank can be disabled; Jev is required by the shared AutoRAG config. */
const RERANK_OFF_SPECIALS = [{ value: "off", labelKey: "settingsCore.ai.off" }] as const;
/** The decision model is Jev or the small chat model; it cannot be switched off. */
const JEV_SLLM_SPECIALS = [{ value: JEV_SLLM_BACKEND, labelKey: "settingsCore.ai.jevSllm" }] as const;

interface MenuState {
	readonly kind: "connect" | "provider" | "picker" | "thinking";
	readonly anchor: HTMLElement;
	readonly arg?: string;
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

export function AiPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { run, error } = useConfigWriter(onSaved);
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [disconnect, setDisconnect] = useState<ProviderSummary | null>(null);
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
	const connect = useProviderConnect({ reload, onNotice: setNotice });

	const connected = useMemo(() => (providers ?? []).filter((provider) => provider.authConfigured), [providers]);
	const available = useMemo(() => (providers ?? []).filter((provider) => !provider.authConfigured), [providers]);
	const catalogModels = useMemo(() => connected.flatMap((provider) => provider.models.map((model) => ({ provider, model }))), [connected]);
	// Jev/rerank are not general LLM roles: offer only the backends/providers
	// that actually serve them, with the model ids each accepts. The AutoRAG
	// plan comes first because `connected` is already ordered that way.
	const jevOptions = useMemo(() => jevOptionsFor(connected), [connected]);
	const rerankOptions = useMemo(() => rerankOptionsFor(connected), [connected]);

	function closeMenu(): void {
		setMenu(null);
	}

	function writeModel(entry: ModelCatalogEntry): void {
		void run(modelConfigUpdates(entry));
	}

	function writeDecomposition(entry: ModelCatalogEntry): void {
		void run(decompositionConfigUpdates(entry));
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
				if (status.state !== "signedIn") setNotice(t("settingsCore.ai.disconnected", { name: provider.name }));
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
		const ops = providerRoleCleanup(snapshot.config, provider.id);
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
		if (role === "jev") return JEV_SLLM_SPECIALS.map((special) => ({ value: special.value, label: t(special.labelKey) }));
		if (role === "rerank") return RERANK_OFF_SPECIALS.map((special) => ({ value: special.value, label: t(special.labelKey) }));
		return [];
	}

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.ai")} description={t("settingsCore.ai.description")} />
			{problem !== null ? <div className="settings-error" role="alert">{problem}</div> : null}
			{notice !== null ? <Note>{notice}</Note> : null}
			{/* Figma 403:10518: 연결된 서비스 is a bordered list closed by its own "+ 서비스 연결" row; a rule; then the roles on a stage card. */}
			<section className="ai-section">
				<div className="ai-section-head">
					<h2 className="ai-section-title">{t("settingsCore.ai.servicesTitle")}</h2>
					<p className="ai-section-desc">{t("settingsCore.ai.servicesDesc")}</p>
				</div>
				<div className="ai-services">
					{connected.map((provider) => {
						const used = rolesUsingProvider(snapshot, provider.id, t);
						const meta = `${provider.subscription ? t("settingsCore.ai.subscriptionAccount") : t(KIND_LABEL_KEY[provider.kind])}${provider.baseUrl === null ? "" : ` · ${provider.baseUrl}`}${used.length > 0 ? ` · ${t("settingsCore.ai.usedFor", { roles: used.join(", ") })}` : ""}`;
						return (
							<div className="ai-service-row" key={provider.id} title={meta}>
								<ProviderIcon provider={provider} />
								<span className="ai-service-name">{provider.name}</span>
								<button
									type="button"
									className="settings-icon-btn ai-service-more"
									title={t("settingsCore.ai.providerMenu", { name: provider.name })}
									aria-label={t("settingsCore.ai.providerMenu", { name: provider.name })}
									onClick={(event) => setMenu(menu?.kind === "provider" && menu.arg === provider.id ? null : { kind: "provider", anchor: event.currentTarget, arg: provider.id })}
								>
									<Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" focusable="false" />
								</button>
							</div>
						);
					})}
					<button type="button" className="ai-service-row ai-service-add" onClick={(event) => setMenu({ kind: "connect", anchor: event.currentTarget })}>
						<Plus size={16} strokeWidth={1.5} aria-hidden="true" focusable="false" />
						<span>{t("settingsCore.ai.connectService")}</span>
					</button>
				</div>
			</section>
			<hr className="ai-divider" />
			<section className="ai-section">
				<div className="ai-section-head">
					<h2 className="ai-section-title">{t("settingsCore.ai.rolesTitle")}</h2>
					<p className="ai-section-desc">{t("settingsCore.ai.rolesDesc")}</p>
				</div>
				<div className="ai-roles">
					<RoleRow role="answer" label={t("settingsCore.ai.answerModel")} hint={t("settingsCore.ai.answerHint")} current={answerLabel(snapshot, t)} unset={answerUnset(snapshot)} broken={roleBroken("answer", snapshot.config, connected)} provider={selectedProvider("answer", snapshot.config, connected)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "answer" })} thinking={{ onOpen: (anchor) => setMenu({ kind: "thinking", anchor }) }} />
					<RoleRow role="decomposition" label={t("settingsCore.ai.role.decomposition")} hint={t("settingsCore.ai.decompositionHint")} current={decompositionLabel(snapshot, t)} broken={roleBroken("decomposition", snapshot.config, connected)} provider={selectedProvider("decomposition", snapshot.config, connected)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "decomposition" })} />
					<RoleRow role="jev" label={t("settingsCore.ai.jevModel")} hint={t("settingsCore.ai.jevHint")} current={jevLabel(snapshot.config, t)} broken={roleBroken("jev", snapshot.config, connected)} provider={selectedProvider("jev", snapshot.config, connected)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "jev" })} />
					<RoleRow role="rerank" label={t("settingsCore.ai.rerankModel")} hint={t("settingsCore.ai.rerankHint")} current={rerankLabel(snapshot.config, t)} broken={roleBroken("rerank", snapshot.config, connected)} provider={selectedProvider("rerank", snapshot.config, connected)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "rerank" })} />
					<EmbeddingPicker name={t("settingsCore.ai.embeddingModel")} hint={t("settingsCore.ai.embeddingHint")} />
				</div>
			</section>
			{menu !== null ? (
				<FloatingMenu anchor={menu.anchor} compact={menu.kind === "thinking"} onClose={closeMenu}>
					{menu.kind === "connect" ? (
						<ConnectMenu
							providers={withoutAutorag(available)}
							onSignInToAutorag={available.some((provider) => providerConnectRoute(provider.id) === "account") ? () => { closeMenu(); void signInToAutorag(); } : undefined}
							onConnect={(provider, authType) => {
								closeMenu();
								connect.connect(provider, authType);
							}}
							onPickServer={(kind) => { closeMenu(); connect.openServer(kind, null); }}
							onPickServerExisting={(provider) => { closeMenu(); connect.openServer(provider.kind === "local" ? "local" : "custom", provider); }}
						/>
					) : null}
					{menu.kind === "provider" ? <ProviderMenu provider={(providers ?? []).find((item) => item.id === menu.arg) ?? null} onEdit={(provider) => { closeMenu(); connect.openServer(provider.kind === "local" ? "local" : "custom", provider); }} onTest={(provider) => { closeMenu(); void test(provider); }} onDiscover={(provider) => { closeMenu(); void discover(provider); }} onLogout={(provider) => { closeMenu(); setDisconnect(provider); }} /> : null}
					{menu.kind === "picker" ? (
						<RolePicker
							role={menu.arg ?? "answer"}
							models={menu.arg === "jev" ? jevOptions : menu.arg === "rerank" ? rerankOptions : catalogModels}
							specials={specialsFor(menu.arg ?? "answer")}
							selected={roleSelectionFor(menu.arg ?? "answer", snapshot.config, connected)}
							onPick={(entry) => {
								closeMenu();
								if (menu.arg === "decomposition") writeDecomposition(entry);
								else if (menu.arg === "jev") void run(jevConfigUpdates(entry));
								else if (menu.arg === "rerank") void run(rerankConfigUpdates(entry));
								else writeModel(entry);
							}}
							onSpecial={(special) => {
								closeMenu();
								if (menu.arg === "decomposition" && special === "same") void run([{ path: ["queryDecomposition"], value: false }]);
								else if (menu.arg === "decomposition" && special === "default") void run([{ path: ["queryDecomposition"], remove: true }]);
								else if (menu.arg === "jev" && special === JEV_SLLM_BACKEND) void run(jevSllmConfigUpdates());
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
			{connect.modals}
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

function thinkingValue(snapshot: AutoRagConfigSnapshot): string {
	return stringOf(getAt(snapshot.config, ["thinking", "final"]));
}

/** The answer model has no default: until one is picked the picker shows 모델 선택 in the muted ink. */
function answerUnset(snapshot: AutoRagConfigSnapshot): boolean {
	const model = asRecord(getAt(snapshot.config, ["model"]));
	return stringOf(model?.name).length === 0 && stringOf(model?.id).length === 0;
}

/** A role set to a model of a service that is no longer connected (Figma 403:10518: a red picker and a "!"). */
function roleBroken(role: string, config: AutoRagConfigSnapshot["config"], connected: readonly ProviderSummary[]): boolean {
	// The librarian writes its OpenRouter decomposition default into every fresh config; that is the default, not a broken pick.
	if (role === "decomposition" && shouldAdoptManagedDecomposition(getAt(config, ["queryDecomposition"]))) return false;
	const sel = roleSelectionFor(role, config, connected);
	return sel?.kind === "model" && !connected.some((item) => item.id === sel.provider);
}

function selectedProvider(role: string, config: AutoRagConfigSnapshot["config"], connected: readonly ProviderSummary[]): ProviderSummary | null {
	const sel = roleSelectionFor(role, config, connected);
	if (sel?.kind !== "model") return null;
	return connected.find((item) => item.id === sel.provider) ?? null;
}

/* --------------------------------------------------------------- pieces -- */

function RoleRow({
	role,
	label,
	hint,
	current,
	unset = false,
	broken = false,
	provider,
	onOpen,
	thinking,
}: {
	readonly role: string;
	readonly label: string;
	readonly hint: string;
	readonly current: string;
	readonly unset?: boolean;
	readonly broken?: boolean;
	readonly provider?: ProviderSummary | null;
	readonly onOpen: (anchor: HTMLElement) => void;
	readonly thinking?: { readonly onOpen: (anchor: HTMLElement) => void };
}): ReactElement {
	const { t } = useTranslation();
	return (
		<Row name={label} hint={hint}>
			<span className={`settings-split${thinking === undefined ? " is-solo" : ""}`}>
				{broken ? (
					<span className="ai-role-alert" role="img" aria-label={t("settingsCore.ai.roleBroken")} title={t("settingsCore.ai.roleBroken")}>
						!
					</span>
				) : null}
				{/* Left of the picker, so every role's picker keeps the same right edge. */}
				{thinking !== undefined ? (
					<button type="button" className="settings-icon-btn" aria-label={t("settingsCore.ai.thinkingDepthFor", { label })} title={t("settingsCore.ai.thinkingDepth")} onClick={(event) => thinking.onOpen(event.currentTarget)}>
						<Ellipsis size={16} aria-hidden="true" focusable="false" />
					</button>
				) : null}
				<button type="button" className={`settings-trigger${broken ? " is-broken" : ""}`} aria-label={t("settingsCore.ai.selectRole", { label })} data-role={role} onClick={(event) => onOpen(event.currentTarget)}>
					{provider ? <ProviderIcon small provider={provider} /> : null}
					<span className={`settings-trigger-label${unset ? " is-muted" : ""}`}>{unset ? t("settingsCore.ai.pickModel") : current}</span>
					<ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" focusable="false" />
				</button>
			</span>
		</Row>
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
