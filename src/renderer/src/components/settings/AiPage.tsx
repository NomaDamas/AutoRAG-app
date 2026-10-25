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
import { AppIcon, FloatingMenu, ModalActions, ModalShell, Note, Row, Section, SettingsPageHead } from "./SettingsKit";
import { asRecord, errorText, getAt, stringOf, useConfigWriter } from "./configSupport";
import { ConnectMenu, useProviderConnect } from "./ProviderConnect";
import { RolePicker } from "./ModelPicker";
import { jevLabel, jevOptionsFor, rerankLabel, rerankOptionsFor } from "./roleSupport";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { jevBackendFor } from "../../../../shared/ai-roles";
import { isAllowedAgentApi, jevConfigUpdates, modelConfigUpdates, rerankConfigUpdates } from "../../../../shared/model-config";
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
				<RoleRow role="jev" label={t("settingsCore.ai.jevModel")} hint={t("settingsCore.ai.jevHint")} current={jevLabel(snapshot.config, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "jev" })} />
				<RoleRow role="rerank" label={t("settingsCore.ai.rerankModel")} hint={t("settingsCore.ai.rerankHint")} current={rerankLabel(snapshot.config, t)} onOpen={(anchor) => setMenu({ kind: "picker", anchor, arg: "rerank" })} />
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
