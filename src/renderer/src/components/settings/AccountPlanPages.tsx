/**
 * Settings → 내 계정 / 구독 및 사용량.
 *
 * Both pages show what the hosted AutoRAG service confirmed for the signed-in
 * account (`window.autorag.account`). Nothing here is invented: while signed
 * out, or before the first answer, a value reads "확인할 수 없음". Sign-in,
 * checkout and the billing portal all happen in the system browser, so this app
 * never sees a password or a card number.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AccountPlanId, AccountSnapshot, AccountStatus, PaidPlanId } from "../../../../shared/account-contract";
import { planCovers } from "../../../../shared/account-contract";
import { Note, Row, Section, SettingsPageHead } from "./SettingsKit";

interface PlanTier {
	readonly id: AccountPlanId;
	readonly label: string;
	readonly priceKey: string;
	readonly perksKey: string;
}

/** Product facts the service publishes (README "Plans"); credit figures are weekly dollar budgets. */
const PLAN_TIERS = [
	{ id: "free", label: "Dazzi Free", priceKey: "settingsCore.account.plan.free.price", perksKey: "settingsCore.account.plan.free.perks" },
	{ id: "air", label: "Dazzi Air", priceKey: "settingsCore.account.plan.air.price", perksKey: "settingsCore.account.plan.air.perks" },
	{ id: "pro", label: "Dazzi Pro", priceKey: "settingsCore.account.plan.pro.price", perksKey: "settingsCore.account.plan.pro.perks" },
] as const satisfies readonly PlanTier[];

const PLAN_LABEL: Readonly<Record<AccountPlanId, string>> = { free: "Free", air: "Air", pro: "Pro" };

function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

/** The status the main process holds, kept fresh by its change events. */
function useAccount(): { readonly status: AccountStatus | null; readonly busy: boolean; readonly error: string | null; readonly run: (action: () => Promise<unknown>) => void } {
	const [status, setStatus] = useState<AccountStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const off = window.autorag.account.onChanged(setStatus);
		void window.autorag.account.status().then(setStatus);
		void window.autorag.account.refresh().then(setStatus, () => undefined);
		return off;
	}, []);

	const run = useCallback((action: () => Promise<unknown>): void => {
		setBusy(true);
		setError(null);
		action()
			.then(undefined, (cause: unknown) => {
				const text = cause instanceof Error ? cause.message : String(cause);
				setError(text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, ""));
			})
			.finally(() => setBusy(false));
	}, []);

	return { status, busy, error, run };
}

function accountOf(status: AccountStatus | null): AccountSnapshot | null {
	return status?.state === "signedIn" ? status.account : null;
}

export function AccountPage(): ReactElement {
	const { t } = useTranslation();
	const { status, busy, error, run } = useAccount();
	const account = accountOf(status);
	const signedIn = status?.state === "signedIn";

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.account")} description={t("settingsCore.account.description")} />
			<Section title={t("settingsCore.account.profileTitle")}>
				<Row name={t("settingsCore.account.accountName")} hint={t("settingsCore.account.accountHint")}>
					<span className="settings-value">
						<span className={`settings-dot ${signedIn ? "is-ok" : "is-warn"}`} aria-hidden="true" />
					</span>
					<span className="settings-value">{status?.state === "signingIn" ? t("settingsCore.account.signingIn") : signedIn ? t("settingsCore.account.signedIn") : t("settingsCore.account.signedOut")}</span>
				</Row>
				<Row name={t("settingsCore.account.email")} hint={t("settingsCore.account.emailHint")}>
					<span className="settings-value">{account?.email ?? t("settingsCore.common.unknown")}</span>
				</Row>
				{status?.offline === true ? <Note>{t("settingsCore.account.offline")}</Note> : null}
				{status?.error ? <Note>{status.error}</Note> : null}
				{error !== null ? <Note>{error}</Note> : null}
				<Row
					name={signedIn ? t("settingsCore.account.signOut") : t("settingsCore.account.signIn")}
					hint={
						status?.source === "env"
							? t("settingsCore.account.hintEnv")
							: signedIn
								? t("settingsCore.account.hintSignedIn")
								: t("settingsCore.account.hintSignedOut")
					}
				>
					{signedIn ? (
						<button type="button" className="linear-btn" disabled={busy || status?.source === "env"} onClick={() => run(() => window.autorag.account.signOut())}>
							{t("settingsCore.account.signOut")}
						</button>
					) : status?.state === "signingIn" ? (
						<button type="button" className="linear-btn" onClick={() => run(() => window.autorag.account.cancelSignIn())}>
							{t("common.cancel")}
						</button>
					) : (
						<button type="button" className="linear-btn" disabled={busy} onClick={() => run(() => window.autorag.account.signIn())}>
							{t("settingsCore.account.signInBrowser")}
						</button>
					)}
				</Row>
			</Section>
			<Section title={t("settingsCore.nav.ai")} description={t("settingsCore.account.managedDesc")}>
				<Row name={t("settingsCore.account.managedName")} hint={t("settingsCore.account.managedHint")}>
					<button type="button" className="linear-btn" disabled={!signedIn || busy} onClick={() => run(() => window.autorag.account.useManagedModel())}>
						{t("settingsCore.account.useManaged")}
					</button>
				</Row>
			</Section>
		</>
	);
}

export function PlanPage(): ReactElement {
	const { t } = useTranslation();
	const { status, busy, error, run } = useAccount();
	const account = accountOf(status);
	const signedIn = status?.state === "signedIn";
	const plan = account?.plan ?? null;
	const usedCents = account?.creditsUsedCents ?? 0;
	const limitCents = account?.creditsLimitCents ?? 0;
	const percent = limitCents > 0 ? Math.min(100, Math.round((usedCents / limitCents) * 100)) : 0;
	const renewal = account?.periodEnd == null ? null : new Date(account.periodEnd).toLocaleDateString();

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.plan")} description={t("settingsCore.account.planDescription")} />
			<Section title={t("settingsCore.account.currentPlan")}>
				<Row name={t("settingsCore.account.currentPlan")} hint={signedIn ? t("settingsCore.account.currentPlanHintSignedIn") : t("settingsCore.account.currentPlanHintSignedOut")}>
					<span className="settings-value is-strong">
						{plan === null ? t("settingsCore.common.unknown") : `${PLAN_LABEL[plan]}${account?.trialing === true ? t("settingsCore.account.trialing") : ""}`}
					</span>
				</Row>
				{account?.cancelScheduled === true && renewal !== null ? <Note>{t("settingsCore.account.cancelScheduled", { date: renewal })}</Note> : null}
				{account !== null && account.status === "past_due" ? <Note>{t("settingsCore.account.pastDue")}</Note> : null}
				{error !== null ? <Note>{error}</Note> : null}
				{PLAN_TIERS.map((tier) => {
					const held = plan !== null && plan === tier.id;
					const paid = tier.id === "air" || tier.id === "pro";
					const available = tier.id === "air" ? account?.billing.air === true : tier.id === "pro" ? account?.billing.pro === true : false;
					return (
						<Row key={tier.id} name={tier.label} hint={`${t(tier.priceKey)} · ${t(tier.perksKey)}`}>
							{held ? (
								<span className="settings-value">{t("settingsCore.account.inUse")}</span>
							) : paid && plan !== null && !planCovers(plan, tier.id) ? (
								<button type="button" className="linear-btn" disabled={busy || !available} onClick={() => run(() => window.autorag.account.checkout(tier.id as PaidPlanId))}>
									{t("settingsCore.account.openCheckout")}
								</button>
							) : null}
						</Row>
					);
				})}
				<Row name={t("settingsCore.account.billingTitle")} hint={t("settingsCore.account.billingHint")}>
					<button type="button" className="linear-btn" disabled={busy || account?.billing.portal !== true} onClick={() => run(() => window.autorag.account.portal())}>
						{t("settingsCore.account.openPortal")}
					</button>
				</Row>
			</Section>
			<Section title={t("settingsCore.account.usageTitle")}>
				<Row name={t("settingsCore.account.usageName")} hint={t("settingsCore.account.usageHint")} stack>
					<div className="settings-usage">
						<div className="settings-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("settingsCore.account.usageMeterAria")}>
							<span style={{ width: `${percent}%` }} />
						</div>
						<div className="settings-usage-legend">
							<span>{account === null ? t("settingsCore.account.usageUnavailable") : `${formatCents(usedCents)} / ${formatCents(limitCents)}`}</span>
							<span>{account === null ? "—" : `${percent}%`}</span>
						</div>
					</div>
				</Row>
				<Row name={t("settingsCore.account.creditsLeft")} hint={t("settingsCore.account.creditsLeftHint")}>
					<span className="settings-value is-strong">{account === null ? t("settingsCore.common.unknown") : formatCents(Math.max(0, limitCents - usedCents))}</span>
				</Row>
				<Row name={t("settingsCore.account.requestLimit")} hint={t("settingsCore.account.requestLimitHint")}>
					<span className="settings-value">{account === null ? t("settingsCore.common.unknown") : t("settingsCore.account.requestsPerMinute", { count: account.requestsPerMinute })}</span>
				</Row>
			</Section>
		</>
	);
}
