/**
 * BYOK role step — the reranker and Jev. A Dazzi plan serves both; someone who
 * brings their own key picks them here from the services they connected, right
 * before the first index. Both are optional (each can stay at its default or be
 * turned off), and a role no connected service serves says so instead of
 * offering an empty menu. Choices are saved to the shared config at once, the
 * same blocks Settings → AI 모델 writes.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { withoutAutorag } from "../../../../shared/account-contract";
import { jevConfigUpdates, rerankConfigUpdates } from "../../../../shared/model-config";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, ProviderSummary } from "../../../../shared/settings-contract";
import { RolePicker } from "../../components/settings/ModelPicker";
import { errorText } from "../../components/settings/configSupport";
import { jevLabel, jevOptionsFor, rerankLabel, rerankOptionsFor, type RoleOption } from "../../components/settings/roleSupport";
import { FloatingMenu } from "../../components/settings/SettingsKit";
import type { OnboardingCtx } from "../context";
import { Eyebrow, SplitScreen } from "../parts";

const settings = window.autorag.settings;

type RoleId = "rerank" | "jev";

interface MenuState {
	readonly role: RoleId;
	readonly anchor: HTMLElement;
}

export function RolesStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t } = ctx;
	const { t: settingsT } = useTranslation();
	const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
	const [config, setConfig] = useState<AutoRagConfigSnapshot["config"] | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<MenuState | null>(null);

	useEffect(() => {
		let alive = true;
		void Promise.all([settings.providersList(), settings.configGet()]).then(
			([list, snapshot]) => {
				if (!alive) return;
				setProviders(list);
				setConfig(snapshot.config);
			},
			(cause) => {
				if (!alive) return;
				setNotice(errorText(cause));
				setProviders([]);
				setConfig({});
			},
		);
		return () => {
			alive = false;
		};
	}, []);

	const connected = useMemo(() => withoutAutorag((providers ?? []).filter((provider) => provider.authConfigured)), [providers]);
	const options: Readonly<Record<RoleId, readonly RoleOption[]>> = useMemo(
		() => ({ rerank: rerankOptionsFor(connected), jev: jevOptionsFor(connected) }),
		[connected],
	);

	const save = useCallback((updates: readonly AutoRagConfigUpdate[]): void => {
		void settings
			.configPatch(updates)
			.then((next) => {
				setConfig(next.config);
				setNotice(null);
			})
			.catch((cause) => setNotice(errorText(cause)));
	}, []);

	const rows: readonly { readonly id: RoleId; readonly label: string; readonly hint: string; readonly current: string }[] =
		config === null
			? []
			: [
					{ id: "rerank", label: settingsT("settingsCore.ai.rerankModel"), hint: settingsT("settingsCore.ai.rerankHint"), current: rerankLabel(config, settingsT) },
					{ id: "jev", label: settingsT("settingsCore.ai.jevModel"), hint: settingsT("settingsCore.ai.jevHint"), current: jevLabel(config, settingsT) },
				];

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="brain">{t("onboarding.roles.eyebrow")}</Eyebrow>
					<h1>{t("onboarding.roles.title")}</h1>
					<p>{t("onboarding.roles.lead")}</p>
					<p className="micro-note">{t("onboarding.roles.note")}</p>
				</>
			}
		>
			<div className="card model-card">
				{rows.map((row) => {
					const unavailable = options[row.id].length === 0;
					return (
						<div key={row.id} className="role-row">
							<div className="role-copy">
								<strong>{row.label}</strong>
								<small data-role-unavailable={unavailable ? row.id : undefined}>{unavailable ? t("onboarding.roles.unavailable") : row.hint}</small>
							</div>
							<button
								type="button"
								className="secondary model-trigger"
								data-role-trigger={row.id}
								disabled={unavailable}
								onClick={(event) => setMenu({ role: row.id, anchor: event.currentTarget })}
							>
								<span>{row.current}</span>
								<ChevronDown size={14} aria-hidden="true" focusable="false" />
							</button>
						</div>
					);
				})}
				{notice !== null ? <p className="model-status failed" role="alert">{notice}</p> : null}
			</div>
			<div className="settings-view model-overlays">
				{menu !== null ? (
					<FloatingMenu anchor={menu.anchor} onClose={() => setMenu(null)}>
						<RolePicker
							role={menu.role}
							models={options[menu.role]}
							specials={[{ value: "off", label: settingsT("settingsCore.ai.off") }]}
							onPick={(entry) => {
								setMenu(null);
								save(menu.role === "rerank" ? rerankConfigUpdates(entry) : jevConfigUpdates(entry));
							}}
							onSpecial={() => {
								setMenu(null);
								save([{ path: [menu.role], value: false }]);
							}}
						/>
					</FloatingMenu>
				) : null}
			</div>
		</SplitScreen>
	);
}
