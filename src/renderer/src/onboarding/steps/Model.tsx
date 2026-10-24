/**
 * BYOK model step — connect any provider Settings → AI 모델 can connect, then
 * pick the answer model. It runs on the same machinery as that page (Pi login,
 * `providersList`, the shared config), so what is connected and chosen here is
 * exactly what Settings shows afterwards; nothing is kept in a separate store.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { withoutAutorag } from "../../../../shared/account-contract";
import { modelConfigUpdates } from "../../../../shared/model-config";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { RolePicker } from "../../components/settings/ModelPicker";
import { ConnectMenu, useProviderConnect } from "../../components/settings/ProviderConnect";
import { errorText } from "../../components/settings/configSupport";
import { FloatingMenu } from "../../components/settings/SettingsKit";
import type { OnboardingCtx } from "../context";
import { onlyModel, reconcileModelChoice } from "../model-choice";
import { Eyebrow, SplitScreen } from "../parts";

const settings = window.autorag.settings;

interface MenuState {
	readonly kind: "connect" | "picker";
	readonly anchor: HTMLElement;
}

export function ModelStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, patch } = ctx;
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [config, setConfig] = useState<AutoRagConfigSnapshot["config"] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	/** A save is in flight: the sync below must not start a second one for the same state. */
	const saving = useRef(false);
	/** The models picked for the user already; each is tried once, so a save that did not stick cannot loop. */
	const autoPicked = useRef(new Set<string>());

	const reload = useCallback(async (): Promise<void> => {
		try {
			const [list, snapshot] = await Promise.all([settings.providersList(), settings.configGet()]);
			setProviders(list);
			setConfig(snapshot.config);
		} catch (cause) {
			setNotice(errorText(cause));
			setProviders((previous) => previous ?? []);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);

	const connect = useProviderConnect({ reload, onNotice: setNotice });

	const connected = useMemo(() => withoutAutorag((providers ?? []).filter((provider) => provider.authConfigured)), [providers]);
	const available = useMemo(() => (providers ?? []).filter((provider) => !provider.authConfigured), [providers]);
	const models = useMemo(() => connected.flatMap((provider) => provider.models.map((model) => ({ provider, model }))), [connected]);

	const choose = useCallback(
		(entry: ModelCatalogEntry): void => {
			saving.current = true;
			void settings
				.configPatch(modelConfigUpdates(entry))
				.then((next) => {
					setConfig(next.config);
					patch({ model: { provider: entry.provider, modelId: entry.id, verified: true } });
				})
				.catch((cause) => setNotice(errorText(cause)))
				.finally(() => {
					saving.current = false;
				});
		},
		[patch],
	);

	// The config is the authority for the model: adopt what it holds, drop a draft choice it no longer
	// backs, and pick the model for the user when exactly one is on offer.
	const drafted = draft.model;
	useEffect(() => {
		if (providers === null || config === null || saving.current) return;
		const choice = reconcileModelChoice(config, providers);
		if (choice !== null) {
			if (drafted?.provider !== choice.provider || drafted.modelId !== choice.modelId || !drafted.verified) patch({ model: choice });
			return;
		}
		const only = onlyModel(models);
		const key = only === null ? null : `${only.provider}/${only.id}`;
		if (only !== null && key !== null && !autoPicked.current.has(key)) {
			autoPicked.current.add(key);
			choose(only);
		} else if (drafted !== null) patch({ model: null });
	}, [providers, config, models, drafted, patch, choose]);

	const chosen = drafted?.verified === true ? models.find((entry) => entry.provider.id === drafted.provider && entry.model.id === drafted.modelId) : undefined;
	const chosenName = chosen === undefined ? (drafted?.verified === true ? drafted.modelId : null) : chosen.model.name || chosen.model.id;

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="brain">{t("onboarding.model.eyebrow")}</Eyebrow>
					<h1>{t("onboarding.model.title")}</h1>
					<p>{t("onboarding.model.lead")}</p>
					<p className="micro-note">{t("onboarding.model.note")}</p>
				</>
			}
		>
			<div className="card model-card">
				<div className="detected model-services">
					<div className="detected-title">{t("onboarding.model.connectedTitle")}</div>
					{connected.map((provider) => (
						<div key={provider.id} className="detected-row" data-provider-row={provider.id}>
							<span className="source-icon" aria-hidden="true">{provider.name.charAt(0).toUpperCase()}</span>
							<div>
								<strong>{provider.name}</strong>
								<small>{provider.baseUrl ?? t(provider.subscription ? "settingsCore.ai.subscriptionAccount" : `settingsCore.ai.kind.${provider.kind}`)}</small>
							</div>
							<Check size={14} aria-hidden="true" focusable="false" />
						</div>
					))}
					{providers !== null && connected.length === 0 ? <p className="model-empty">{t("onboarding.model.none")}</p> : null}
					<button type="button" className="secondary model-connect" data-connect-service onClick={(event) => setMenu({ kind: "connect", anchor: event.currentTarget })}>
						<Plus size={14} aria-hidden="true" focusable="false" />
						{t("onboarding.model.connect")}
					</button>
				</div>
				<div className="model-row">
					<span>{t("onboarding.model.modelRow")}</span>
					<button
						type="button"
						className="secondary model-trigger"
						data-model-trigger
						disabled={models.length === 0}
						onClick={(event) => setMenu({ kind: "picker", anchor: event.currentTarget })}
					>
						<span>{chosenName ?? t(models.length === 0 ? "onboarding.model.needService" : "onboarding.model.pick")}</span>
						<ChevronDown size={14} aria-hidden="true" focusable="false" />
					</button>
				</div>
				<p className="model-status" role="status">
					{chosenName === null ? (notice ?? t("onboarding.model.unready")) : t("onboarding.model.ready", { model: chosenName })}
				</p>
			</div>
			{/* The menus and dialogs are Settings' own, and their styles hang off `.settings-view`; this box adds no layout of its own. */}
			<div className="settings-view model-overlays">
				{menu !== null ? (
					<FloatingMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
						{menu.kind === "connect" ? (
							<ConnectMenu
								providers={withoutAutorag(available)}
								onSignInToAutorag={undefined}
								onConnect={(provider, authType) => {
									setMenu(null);
									connect.connect(provider, authType);
								}}
								onPickServer={(kind) => {
									setMenu(null);
									connect.openServer(kind, null);
								}}
								onPickServerExisting={(provider) => {
									setMenu(null);
									connect.openServer(provider.kind === "local" ? "local" : "custom", provider);
								}}
							/>
						) : (
							<RolePicker
								role="answer"
								models={models}
								specials={[]}
								onPick={(entry) => {
									setMenu(null);
									choose(entry);
								}}
								onSpecial={() => undefined}
							/>
						)}
					</FloatingMenu>
				) : null}
				{connect.modals}
			</div>
		</SplitScreen>
	);
}
