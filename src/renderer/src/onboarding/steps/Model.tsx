/**
 * BYOK model step — connect the services Settings → AI 모델 can connect, then
 * give each role (answer, question splitting, Jev, reranking) its model, and
 * prove every pick answers before moving on (Figma 09e). It runs on the same
 * machinery as that page (Pi login, `providersList`, the shared config), so what
 * is connected and chosen here is exactly what Settings shows afterwards;
 * nothing is kept in a separate store.
 *
 * A pick is saved at once, then checked: the answer and splitting models by a
 * real call, Jev and the reranker by their provider's connection test. While a
 * check runs its menu stays shut; a failed one is marked and keeps the step
 * closed. The three helper roles also offer "auto", which hands the job to the
 * answer model (splitting) or leaves it off (Jev, reranking) and needs no check.
 * The step opens (`draft.model.verified`) once a service is connected and every
 * role has a model that answered or is on auto.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, Plus, Search, X } from "lucide-react";
import { jevBackendFor, shouldAdoptManagedDecomposition, shouldAdoptManagedRoles, withoutAutorag } from "../../../../shared/ai-roles";
import { decompositionConfigUpdates, jevConfigUpdates, modelConfigUpdates, rerankConfigUpdates } from "../../../../shared/model-config";
import type { ModelCheckResult } from "../../../../shared/onboarding-contract";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { useProviderConnect } from "../../components/settings/ProviderConnect";
import { asRecord, errorText, getAt, stringOf } from "../../components/settings/configSupport";
import { jevOptionsFor, providerRoleCleanup, rerankOptionsFor, type RoleOption } from "../../components/settings/roleSupport";
import { FloatingMenu, ModalActions, ModalShell } from "../../components/settings/SettingsKit";
import { cn } from "../../lib/cn";
import type { OnboardingCtx } from "../context";
import { onlyModel } from "../model-choice";
import { Multiline } from "../parts";

const settings = window.autorag.settings;
const onboarding = window.autorag.onboarding;

type RoleId = "answer" | "decomposition" | "jev" | "rerank";

/** The answer model stands alone; the three helpers share one card (Figma 09e). */
const HELPER_ROLES: readonly RoleId[] = ["decomposition", "jev", "rerank"];
const ROLES: readonly RoleId[] = ["answer", ...HELPER_ROLES];

/** What the config says a role uses: nothing yet, the auto choice, or a model. */
type RoleValue =
	| { readonly kind: "unset" }
	| { readonly kind: "auto" }
	| { readonly kind: "model"; readonly provider: string; readonly modelId: string; readonly label: string };

/** Where a role's pick stands: not asked yet, being asked, answered, or refused. */
type Check = { readonly state: "idle" } | { readonly state: "checking" } | { readonly state: "ok" } | { readonly state: "failed"; readonly error: string };

type MenuState = { readonly kind: "connect"; readonly anchor: HTMLElement } | { readonly kind: "role"; readonly role: RoleId; readonly anchor: HTMLElement };

const IDLE: Check = { state: "idle" };
const NO_CHECKS: Readonly<Record<RoleId, Check>> = { answer: IDLE, decomposition: IDLE, jev: IDLE, rerank: IDLE };

const keyOf = (provider: string, modelId: string): string => `${provider}/${modelId}`;

function optionLabel(options: readonly RoleOption[], provider: string, modelId: string, fallback: string): string {
	const hit = options.find((option) => option.provider.id === provider && option.model.id === modelId);
	return hit === undefined ? fallback : hit.model.name || hit.model.id;
}

/** Reads a role's current pick from the shared config; a block the librarian wrote by itself counts as unset. */
function roleValue(role: RoleId, config: AutoRagConfigSnapshot["config"], options: readonly RoleOption[], connected: readonly ProviderSummary[]): RoleValue {
	if (role === "answer") {
		const model = asRecord(getAt(config, ["model"]));
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		if (provider.length === 0 || modelId.length === 0 || !connected.some((candidate) => candidate.id === provider)) return { kind: "unset" };
		return { kind: "model", provider, modelId, label: optionLabel(options, provider, modelId, stringOf(model?.name) || modelId) };
	}
	if (role === "decomposition") {
		const raw = getAt(config, ["queryDecomposition"]);
		if (raw === false) return { kind: "auto" };
		if (shouldAdoptManagedDecomposition(raw)) return { kind: "unset" };
		const model = asRecord(asRecord(raw)?.model);
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		if (provider.length === 0 || modelId.length === 0) return { kind: "unset" };
		return { kind: "model", provider, modelId, label: optionLabel(options, provider, modelId, stringOf(model?.name) || modelId) };
	}
	const raw = getAt(config, [role]);
	if (raw === false) return { kind: "auto" };
	if (shouldAdoptManagedRoles({ [role]: raw })[role]) return { kind: "unset" };
	const block = asRecord(raw);
	const modelId = stringOf(block?.model);
	// Jev names a backend, not a provider: find the connected provider that serves it.
	const provider = role === "jev" ? (connected.find((candidate) => jevBackendFor(candidate.id) === stringOf(block?.backend))?.id ?? "") : stringOf(block?.provider);
	if (provider.length === 0 || modelId.length === 0) return { kind: "unset" };
	return { kind: "model", provider, modelId, label: optionLabel(options, provider, modelId, modelId) };
}

function pickUpdates(role: RoleId, entry: ModelCatalogEntry): AutoRagConfigUpdate[] {
	if (role === "answer") return modelConfigUpdates(entry);
	if (role === "decomposition") return decompositionConfigUpdates(entry);
	return role === "jev" ? jevConfigUpdates(entry) : rerankConfigUpdates(entry);
}

/** "Auto": splitting falls to the answer model; Jev and reranking stay off. */
function autoUpdates(role: Exclude<RoleId, "answer">): AutoRagConfigUpdate[] {
	return [{ path: [role === "decomposition" ? "queryDecomposition" : role], value: false }];
}

export function ModelStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, patch } = ctx;
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [config, setConfig] = useState<AutoRagConfigSnapshot["config"] | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [checks, setChecks] = useState<Readonly<Record<RoleId, Check>>>(NO_CHECKS);
	/** Models that refused a check, per role, so the menu can mark them. */
	const [refused, setRefused] = useState<Readonly<Record<RoleId, ReadonlySet<string>>>>({ answer: new Set(), decomposition: new Set(), jev: new Set(), rerank: new Set() });
	const [disconnecting, setDisconnecting] = useState<ProviderSummary | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	/** Picks already sent to a check, so one config entry is asked once. */
	const attempted = useRef(new Set<string>());
	/** Only the latest check per role may land: a slow answer for a model since replaced is dropped. */
	const runs = useRef<Record<RoleId, number>>({ answer: 0, decomposition: 0, jev: 0, rerank: 0 });
	const autoPicked = useRef(false);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const [list, snapshot] = await Promise.all([settings.providersList(), settings.configGet()]);
			setProviders(list);
			setConfig(snapshot.config);
		} catch (cause) {
			setNotice(errorText(cause));
			setProviders((previous) => previous ?? []);
			setConfig((previous) => previous ?? {});
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);

	const connect = useProviderConnect({ reload, onNotice: setNotice, guided: true });

	const connected = useMemo(() => withoutAutorag((providers ?? []).filter((provider) => provider.authConfigured)), [providers]);
	const available = useMemo(() => withoutAutorag((providers ?? []).filter((provider) => !provider.authConfigured)), [providers]);
	const options = useMemo((): Readonly<Record<RoleId, readonly RoleOption[]>> => {
		const models = connected.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
		return { answer: models, decomposition: models, jev: jevOptionsFor(connected), rerank: rerankOptionsFor(connected) };
	}, [connected]);
	const values = useMemo(
		(): Readonly<Record<RoleId, RoleValue>> | null =>
			config === null
				? null
				: {
						answer: roleValue("answer", config, options.answer, connected),
						decomposition: roleValue("decomposition", config, options.decomposition, connected),
						jev: roleValue("jev", config, options.jev, connected),
						rerank: roleValue("rerank", config, options.rerank, connected),
					},
		[config, options, connected],
	);

	/** Proves a saved pick: a real call for the answer and splitting models, the provider's connection test for Jev and reranking. */
	const verify = useCallback(async (role: RoleId, provider: string, modelId: string): Promise<void> => {
		const run = ++runs.current[role];
		setChecks((previous) => ({ ...previous, [role]: { state: "checking" } }));
		let result: ModelCheckResult;
		try {
			if (role === "answer" || role === "decomposition") result = await onboarding.checkModel(role);
			else result = (await settings.providersTest(provider)).ok ? { ok: true, latencyMs: 0 } : { ok: false, error: "" };
		} catch (cause) {
			result = { ok: false, error: errorText(cause) };
		}
		if (run !== runs.current[role]) return;
		setChecks((previous) => ({ ...previous, [role]: result.ok ? { state: "ok" } : { state: "failed", error: result.error } }));
		setRefused((previous) => {
			const next = new Set(previous[role]);
			if (result.ok) next.delete(keyOf(provider, modelId));
			else next.add(keyOf(provider, modelId));
			return { ...previous, [role]: next };
		});
	}, []);

	const save = useCallback(
		(role: RoleId, updates: readonly AutoRagConfigUpdate[], pick: { readonly provider: string; readonly modelId: string } | null): void => {
			runs.current[role] += 1;
			setChecks((previous) => ({ ...previous, [role]: pick === null ? IDLE : { state: "checking" } }));
			void settings
				.configPatch(updates)
				.then((next) => {
					setConfig(next.config);
					setNotice(null);
					if (pick === null) return;
					attempted.current.add(`${role}:${keyOf(pick.provider, pick.modelId)}`);
					return verify(role, pick.provider, pick.modelId);
				})
				.catch((cause) => {
					setChecks((previous) => ({ ...previous, [role]: IDLE }));
					setNotice(errorText(cause));
				});
		},
		[verify],
	);

	// A pick already in the config (a returning user, or one Settings made) is checked once, like a fresh one.
	// With exactly one model on offer and no answer model yet, that model is chosen for the user.
	useEffect(() => {
		if (values === null) return;
		for (const role of ROLES) {
			const value = values[role];
			if (value.kind !== "model") continue;
			const key = `${role}:${keyOf(value.provider, value.modelId)}`;
			if (attempted.current.has(key)) continue;
			attempted.current.add(key);
			void verify(role, value.provider, value.modelId);
		}
		const only = onlyModel(options.answer);
		if (values.answer.kind === "unset" && only !== null && !autoPicked.current) {
			autoPicked.current = true;
			save("answer", modelConfigUpdates(only), { provider: only.provider, modelId: only.id });
		}
	}, [values, options, verify, save]);

	// The step opens once a service is connected and every role is on auto or has a model that answered.
	const ready =
		values !== null &&
		connected.length > 0 &&
		ROLES.every((role) => values[role].kind === "auto" || (values[role].kind === "model" && checks[role].state === "ok"));
	const answer = values?.answer;
	const drafted = draft.model;
	useEffect(() => {
		if (answer === undefined) return;
		const next = answer.kind === "model" ? { provider: answer.provider, modelId: answer.modelId, verified: ready } : null;
		const same = next === null ? drafted === null : drafted !== null && drafted.provider === next.provider && drafted.modelId === next.modelId && drafted.verified === next.verified;
		if (!same) patch({ model: next });
	}, [answer, ready, drafted, patch]);

	const disconnect = async (provider: ProviderSummary): Promise<void> => {
		// Off the list first, so nothing (the only-model pick) reaches for it while it goes.
		setProviders((previous) => previous?.filter((candidate) => candidate.id !== provider.id) ?? previous);
		try {
			const ops = providerRoleCleanup(config ?? {}, provider.id);
			if (ops.length > 0) setConfig((await settings.configPatch(ops)).config);
			if (provider.kind === "local" || provider.kind === "custom") await settings.providersRemove(provider.id);
			else await settings.providerLogout(provider.id);
			await reload();
		} catch (cause) {
			setNotice(errorText(cause));
		}
	};

	const roleRow = (role: RoleId): ReactElement => {
		const value = values?.[role] ?? { kind: "unset" };
		const check = checks[role];
		const status = value.kind === "model" ? check.state : "idle";
		const open = menu?.kind === "role" && menu.role === role;
		const Arrow = open ? ChevronUp : ChevronDown;
		return (
			<div key={role} className="model-role" data-role-row={role}>
				<div className="model-role-copy">
					<strong>{t(`onboarding.model.role.${role}.name`)}</strong>
					<small>{t(`onboarding.model.role.${role}.desc`)}</small>
				</div>
				<div className="model-role-pick">
					<span className={cn("model-role-status", status)} role="status" aria-label={status === "idle" ? undefined : t(`onboarding.model.status.${status}`)} title={check.state === "failed" ? check.error || t("onboarding.model.status.failed") : undefined}>
						{status === "checking" ? <LoaderCircle size={12} className="spin" aria-hidden="true" focusable="false" /> : null}
						{status === "ok" ? <Check size={12} aria-hidden="true" focusable="false" /> : null}
						{status === "failed" ? "!" : null}
					</span>
					<button
						type="button"
						className={cn("model-role-trigger", status === "failed" && "failed", open && "open")}
						data-role-trigger={role}
						aria-expanded={open}
						disabled={status === "checking"}
						// Its own trigger closes an open menu again.
						onClick={(event) => setMenu(open ? null : { kind: "role", role, anchor: event.currentTarget })}
					>
						<span>{value.kind === "model" ? value.label : value.kind === "auto" ? t("onboarding.model.auto") : t("onboarding.model.pick")}</span>
						<Arrow size={16} aria-hidden="true" focusable="false" />
					</button>
				</div>
			</div>
		);
	};

	return (
		<section className="screen center model-screen">
			<div className="screen-copy">
				<h1>{t("onboarding.model.title")}</h1>
				<p>
					<Multiline text={t("onboarding.model.lead")} />
				</p>
			</div>
			<div className="model-columns">
				<div className="model-column services">
					<p className="model-column-title">{t("onboarding.model.connectedTitle")}</p>
					<div className="model-services">
						{connected.length > 0 ? (
							<div className="model-services-list">
								{connected.map((provider) => (
									<div key={provider.id} className="model-service" data-provider-row={provider.id}>
										<span className="model-service-icon" aria-hidden="true">
											{provider.name.charAt(0).toUpperCase()}
										</span>
										<strong>{provider.name}</strong>
										{provider.authSource === "environment" ? null : (
											<button type="button" className="model-service-remove" aria-label={t("onboarding.model.disconnect", { name: provider.name })} onClick={() => setDisconnecting(provider)}>
												<X size={16} aria-hidden="true" focusable="false" />
											</button>
										)}
									</div>
								))}
							</div>
						) : null}
						<button type="button" className="model-service-add" data-connect-service onClick={(event) => setMenu(menu?.kind === "connect" ? null : { kind: "connect", anchor: event.currentTarget })}>
							<Plus size={14} aria-hidden="true" focusable="false" />
							{t("onboarding.model.connect")}
						</button>
					</div>
				</div>
				<div className="model-column roles">
					<p className="model-column-title">{t("onboarding.model.rolesTitle")}</p>
					<div className="model-role-card">{roleRow("answer")}</div>
					<div className="model-role-card">{HELPER_ROLES.map(roleRow)}</div>
					{notice !== null ? (
						<p className="model-notice" role="alert">
							{notice}
						</p>
					) : null}
				</div>
			</div>
			{/* The menus and dialogs are Settings' own, and their styles hang off `.settings-view`; this box adds no layout of its own. */}
			<div className="settings-view model-overlays">
				{menu !== null ? (
					<FloatingMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
						{menu.kind === "connect" ? (
							<ConnectList
								t={t}
								providers={available}
								onConnect={(provider, authType) => {
									setMenu(null);
									connect.connect(provider, authType);
								}}
								onPickServer={(kind) => {
									setMenu(null);
									connect.openServer(kind, null);
								}}
							/>
						) : (
							<RoleList
								t={t}
								options={options[menu.role]}
								current={values?.[menu.role] ?? { kind: "unset" }}
								refused={refused[menu.role]}
								auto={menu.role !== "answer"}
								onPick={(entry) => {
									const role = menu.role;
									setMenu(null);
									save(role, pickUpdates(role, entry), { provider: entry.provider, modelId: entry.id });
								}}
								onAuto={() => {
									const role = menu.role;
									setMenu(null);
									if (role !== "answer") save(role, autoUpdates(role), null);
								}}
							/>
						)}
					</FloatingMenu>
				) : null}
				{disconnecting !== null ? (
					<ModalShell onClose={() => setDisconnecting(null)}>
						<h2>{t("settingsCore.ai.disconnect.title", { name: disconnecting.name })}</h2>
						<p>{t("settingsCore.ai.disconnect.body")}</p>
						<ModalActions>
							<button type="button" className="linear-btn" onClick={() => setDisconnecting(null)}>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								className="linear-btn is-danger"
								onClick={() => {
									const target = disconnecting;
									setDisconnecting(null);
									void disconnect(target);
								}}
							>
								{t("settingsCore.ai.disconnect.action")}
							</button>
						</ModalActions>
					</ModalShell>
				) : null}
				{connect.modals}
			</div>
		</section>
	);
}

/** The search box that stays put while the list under it scrolls. */
function MenuSearch({ value, placeholder, onChange }: { readonly value: string; readonly placeholder: string; readonly onChange: (value: string) => void }): ReactElement {
	return (
		<label className="onb-menu-search">
			<Search size={16} aria-hidden="true" focusable="false" />
			<input autoFocus value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

/** The "connect a service" menu: subscriptions, API keys and servers on this computer, filtered by the search. */
function ConnectList({
	t,
	providers,
	onConnect,
	onPickServer,
}: {
	readonly t: OnboardingCtx["t"];
	readonly providers: readonly ProviderSummary[];
	readonly onConnect: (provider: ProviderSummary, authType: "oauth" | "api_key") => void;
	readonly onPickServer: (kind: "local" | "custom") => void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const lower = query.trim().toLowerCase();
	const shown = providers.filter((provider) => lower.length === 0 || provider.name.toLowerCase().includes(lower));
	const subscriptions = shown.filter((provider) => provider.kind === "runtime" && (provider.subscription || provider.authKinds.includes("oauth")));
	const apiKeys = shown.filter((provider) => provider.kind === "runtime" && !provider.subscription && provider.authKinds.includes("api_key"));
	const groups: readonly { readonly title: string; readonly items: readonly ProviderSummary[]; readonly auth: "oauth" | "api_key" }[] = [
		{ title: t("settingsCore.ai.subscriptionAccount"), items: subscriptions, auth: "oauth" },
		{ title: t("settingsCore.ai.menu.apiKeys"), items: apiKeys, auth: "api_key" },
	];
	return (
		<div className="onb-menu connect">
			<MenuSearch value={query} placeholder={t("onboarding.model.searchServices")} onChange={setQuery} />
			<div className="onb-menu-list">
				{groups.map((group) =>
					group.items.length === 0 ? null : (
						<div key={group.auth} className="onb-menu-group">
							<p className="onb-menu-group-title">{group.title}</p>
							{group.items.map((provider) => (
								<button key={provider.id} type="button" className="onb-menu-item" onClick={() => onConnect(provider, group.auth)}>
									<span className="onb-menu-icon" aria-hidden="true">
										{provider.name.charAt(0).toUpperCase()}
									</span>
									<span>{provider.name}</span>
								</button>
							))}
						</div>
					),
				)}
				<div className="onb-menu-group">
					<p className="onb-menu-group-title">{t("settingsCore.ai.menu.localMachine")}</p>
					<button type="button" className="onb-menu-item" onClick={() => onPickServer("custom")}>
						<Plus size={14} aria-hidden="true" focusable="false" />
						<span>{t("onboarding.model.addCustom")}</span>
					</button>
					<button type="button" className="onb-menu-item" onClick={() => onPickServer("local")}>
						<Plus size={14} aria-hidden="true" focusable="false" />
						<span>{t("onboarding.model.addLocal")}</span>
					</button>
				</div>
			</div>
		</div>
	);
}

/** A role's model menu: search on top, the models in a scrolling list, and "auto" pinned at the bottom for the helper roles. */
function RoleList({
	t,
	options,
	current,
	refused,
	auto,
	onPick,
	onAuto,
}: {
	readonly t: OnboardingCtx["t"];
	readonly options: readonly RoleOption[];
	readonly current: RoleValue;
	readonly refused: ReadonlySet<string>;
	readonly auto: boolean;
	readonly onPick: (entry: ModelCatalogEntry) => void;
	readonly onAuto: () => void;
}): ReactElement {
	const [query, setQuery] = useState("");
	const lower = query.trim().toLowerCase();
	const shown = options.filter(({ provider, model }) => lower.length === 0 || [model.name, model.id, provider.name].some((text) => text.toLowerCase().includes(lower)));
	return (
		<div className={cn("onb-menu role", auto && "with-auto")}>
			<MenuSearch value={query} placeholder={t("onboarding.model.searchModels")} onChange={setQuery} />
			<div className="onb-menu-list">
				{shown.length === 0 ? <p className="onb-menu-empty">{options.length === 0 ? t("onboarding.model.noModels") : t("onboarding.model.noMatch")}</p> : null}
				{shown.map(({ provider, model }) => {
					const key = keyOf(model.provider, model.id);
					const chosen = current.kind === "model" && keyOf(current.provider, current.modelId) === key;
					const failed = refused.has(key);
					return (
						<button key={key} type="button" className={cn("onb-menu-item", failed && "failed")} data-model-id={key} title={`${provider.name} · ${model.id}`} onClick={() => onPick(model)}>
							<span>{model.name || model.id}</span>
							{failed ? <b className="onb-menu-mark failed">!</b> : chosen ? <Check size={12} className="onb-menu-mark" aria-hidden="true" focusable="false" /> : null}
						</button>
					);
				})}
			</div>
			{auto ? (
				<button type="button" className="onb-menu-item onb-menu-auto" data-role-auto onClick={onAuto}>
					<span>{t("onboarding.model.auto")}</span>
					{current.kind === "auto" ? <Check size={12} className="onb-menu-mark" aria-hidden="true" focusable="false" /> : null}
				</button>
			) : null}
		</div>
	);
}
