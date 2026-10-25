/**
 * BYOK model step — connect any provider Settings → AI 모델 can connect, pick
 * the answer model, and prove it answers a real call before moving on. It runs
 * on the same machinery as that page (Pi login, `providersList`, the shared
 * config), so what is connected and chosen here is exactly what Settings shows
 * afterwards; nothing is kept in a separate store. The step stays closed
 * (`draft.model.verified`) until the saved model has answered.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { withoutAutorag } from "../../../../shared/account-contract";
import { modelConfigUpdates } from "../../../../shared/model-config";
import type { ModelCheckResult, OnboardingModelChoice } from "../../../../shared/onboarding-contract";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { RolePicker } from "../../components/settings/ModelPicker";
import { ConnectMenu, useProviderConnect } from "../../components/settings/ProviderConnect";
import { errorText } from "../../components/settings/configSupport";
import { FloatingMenu } from "../../components/settings/SettingsKit";
import type { OnboardingCtx } from "../context";
import { onlyModel, reconcileModelChoice } from "../model-choice";
import { Eyebrow, SplitScreen } from "../parts";

const settings = window.autorag.settings;
const onboarding = window.autorag.onboarding;

interface MenuState {
	readonly kind: "connect" | "picker";
	readonly anchor: HTMLElement;
}

/** Where the chosen model stands: not asked yet, being asked, answered, or refused. */
type Check =
	| { readonly state: "idle" }
	| { readonly state: "checking" }
	| { readonly state: "ok"; readonly latencyMs: number }
	| { readonly state: "failed"; readonly error: string };

type ModelRef = Pick<OnboardingModelChoice, "provider" | "modelId">;

const keyOf = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`;

export function ModelStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, patch } = ctx;
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [config, setConfig] = useState<AutoRagConfigSnapshot["config"] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [active, setActive] = useState<ModelRef | null>(null);
	const [check, setCheck] = useState<Check>({ state: "idle" });
	/** A save is in flight: the sync below must not start a second one for the same state. */
	const saving = useRef(false);
	/** The models picked for the user already; each is tried once, so a save that did not stick cannot loop. */
	const autoPicked = useRef(new Set<string>());
	/** The models already sent to the check from the sync below, so one config entry is asked once. */
	const attempted = useRef(new Set<string>());
	/** Only the latest check may land: a slow answer for a model since replaced is dropped. */
	const checkRun = useRef(0);

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

	/** Asks the saved model for a short reply; the step opens only when it answers. */
	const verify = useCallback(
		async (ref: ModelRef): Promise<void> => {
			const run = ++checkRun.current;
			setActive(ref);
			setCheck({ state: "checking" });
			let result: ModelCheckResult;
			try {
				result = await onboarding.checkModel();
			} catch (cause) {
				result = { ok: false, error: errorText(cause) };
			}
			if (run !== checkRun.current) return;
			setCheck(result.ok ? { state: "ok", latencyMs: result.latencyMs } : { state: "failed", error: result.error });
			patch({ model: { provider: ref.provider, modelId: ref.modelId, verified: result.ok } });
		},
		[patch],
	);

	const choose = useCallback(
		(entry: ModelCatalogEntry): void => {
			const ref: ModelRef = { provider: entry.provider, modelId: entry.id };
			saving.current = true;
			// The config is written first: the check calls the model exactly as the smart scan and AI Search will.
			checkRun.current += 1;
			setActive(ref);
			setCheck({ state: "checking" });
			void settings
				.configPatch(modelConfigUpdates(entry))
				.then((next) => {
					attempted.current.add(keyOf(ref));
					setConfig(next.config);
					patch({ model: { ...ref, verified: false } });
					return verify(ref);
				})
				.catch((cause) => {
					setCheck({ state: "idle" });
					setNotice(errorText(cause));
				})
				.finally(() => {
					saving.current = false;
				});
		},
		[patch, verify],
	);

	// The config is the authority for the model: adopt what it holds and have it answer before the step opens,
	// drop a draft choice it no longer backs, and pick the model for the user when exactly one is on offer.
	const drafted = draft.model;
	useEffect(() => {
		if (providers === null || config === null || saving.current) return;
		const choice = reconcileModelChoice(config, providers);
		if (choice !== null) {
			const same = drafted?.provider === choice.provider && drafted.modelId === choice.modelId;
			if (same && drafted.verified) {
				setActive((previous) => previous ?? choice);
				return;
			}
			const key = keyOf(choice);
			if (attempted.current.has(key)) return;
			attempted.current.add(key);
			if (!same) patch({ model: choice });
			void verify(choice);
			return;
		}
		const only = onlyModel(models);
		const key = only === null ? null : `${only.provider}/${only.id}`;
		if (only !== null && key !== null && !autoPicked.current.has(key)) {
			autoPicked.current.add(key);
			choose(only);
		} else if (drafted !== null) patch({ model: null });
	}, [providers, config, models, drafted, patch, choose, verify]);

	const shown = active ?? (drafted === null ? null : { provider: drafted.provider, modelId: drafted.modelId });
	const entry = shown === null ? undefined : models.find((candidate) => candidate.provider.id === shown.provider && candidate.model.id === shown.modelId);
	const chosenName = shown === null ? null : entry === undefined ? shown.modelId : entry.model.name || entry.model.id;
	// A resumed draft that was already proven needs no new answer to read as ready.
	const ready = check.state === "ok" || (check.state === "idle" && drafted?.verified === true && shown !== null);

	let status: string;
	if (chosenName === null) status = notice ?? t("onboarding.model.unready");
	else if (check.state === "failed") status = t("onboarding.model.failed", { model: chosenName, error: check.error });
	else if (ready) status = check.state === "ok" ? t("onboarding.model.ready", { model: chosenName, seconds: Math.max(0.1, Math.round(check.latencyMs / 100) / 10) }) : t("onboarding.model.readyResumed", { model: chosenName });
	else status = t("onboarding.model.checking", { model: chosenName });

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
						disabled={models.length === 0 || check.state === "checking"}
						onClick={(event) => setMenu({ kind: "picker", anchor: event.currentTarget })}
					>
						<span>{chosenName ?? t(models.length === 0 ? "onboarding.model.needService" : "onboarding.model.pick")}</span>
						<ChevronDown size={14} aria-hidden="true" focusable="false" />
					</button>
				</div>
				<p className={ready ? "model-status ready" : check.state === "failed" ? "model-status failed" : "model-status"} role="status">
					{status}
				</p>
				{check.state === "failed" && shown !== null ? (
					<button type="button" className="secondary model-retry" data-model-retry onClick={() => void verify(shown)}>
						{t("onboarding.model.retry")}
					</button>
				) : null}
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
								onPick={(picked) => {
									setMenu(null);
									choose(picked);
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
