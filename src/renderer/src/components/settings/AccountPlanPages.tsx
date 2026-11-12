/**
 * Settings → 내 계정 / 요금제 및 사용량.
 *
 * Both pages show what the hosted AutoRAG service confirmed for the signed-in
 * account (`window.autorag.account`). Nothing here is invented: while signed
 * out, or before the first answer, a value reads "확인할 수 없음". Sign-in,
 * plan changes and billing happen on the hosted dashboard in the system browser, so this app
 * never sees a password or a card number.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type { AccountPlanId, AccountSnapshot, AccountStatus } from "../../../../shared/account-contract";
import { accountDashboardUrl, accountLegalUrl, creditsResetAt, splitRemaining, type AccountLegalRoute } from "../../../../shared/account-contract";
import { Note, PlainRow, SettingsPageHead } from "./SettingsKit";

function openExternal(url: string): void {
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(url);
}

/** Opens one of the server's legal pages in the system browser (the routes the web login links). */
function openLegal(baseUrl: string | undefined, route: AccountLegalRoute): void {
	openExternal(accountLegalUrl(baseUrl, route));
}

const PLAN_LABEL: Readonly<Record<AccountPlanId, string>> = { free: "Free", air: "Air", pro: "Pro", max: "Max" };

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
	const who = status?.state === "signingIn" ? t("settingsCore.account.signingIn") : (account?.email ?? (signedIn ? t("settingsCore.common.unknown") : t("settingsCore.account.signedOut")));

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.account")} description={t("settingsCore.account.description")} />
			{/* Figma 412:11464: 계정 (two 64px rows with outlined buttons), a rule, then the policy links in one line. */}
			<section className="ai-section">
				<div className="ai-section-head">
					<h2 className="ai-section-title">{t("settingsCore.account.profileTitle")}</h2>
				</div>
				<div className="account-rows">
					<PlainRow name={t("settingsCore.account.accountName")} hint={who}>
						{signedIn ? (
							<button type="button" className="settings-outline-btn" disabled={busy} onClick={() => run(() => window.autorag.account.signOut())}>
								{t("settingsCore.account.signOut")}
							</button>
						) : status?.state === "signingIn" ? (
							<button type="button" className="settings-outline-btn" onClick={() => run(() => window.autorag.account.cancelSignIn())}>
								{t("common.cancel")}
							</button>
						) : (
							<button type="button" className="settings-outline-btn" disabled={busy} onClick={() => run(() => window.autorag.account.signIn())}>
								{t("settingsCore.account.signInBrowser")}
								<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
							</button>
						)}
					</PlainRow>
					{status?.offline === true ? <Note>{t("settingsCore.account.offline")}</Note> : null}
					{status?.error ? <Note>{status.error}</Note> : null}
					{error !== null ? <Note>{error}</Note> : null}
					<PlainRow name={t("settingsCore.account.managedName")} hint={t("settingsCore.account.managedHint")}>
						<button type="button" className="settings-outline-btn" disabled={!signedIn || busy} onClick={() => run(() => window.autorag.account.useManagedModel())}>
							{t("settingsCore.account.useManaged")}
						</button>
					</PlainRow>
				</div>
			</section>
			<hr className="ai-divider account-divider" />
			<section className="account-legal">
				<h2 className="account-legal-title">{t("settingsCore.account.legal.title")}</h2>
				<div className="account-legal-links">
					{(["terms", "privacy", "acceptableUse", "subprocessors"] as const).map((route) => (
						<button key={route} type="button" className="account-legal-link" onClick={() => openLegal(status?.baseUrl, route)}>
							{t(`settingsCore.account.legal.${route}`)}
						</button>
					))}
				</div>
			</section>
		</>
	);
}

/** Re-renders once a minute so the countdown to the weekly reset stays current. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

export function PlanPage(): ReactElement {
	const { t } = useTranslation();
	const { status, error } = useAccount();
	const now = useNow();
	const account = accountOf(status);
	const plan = account?.plan ?? null;
	const limitCents = account?.creditsLimitCents ?? 0;
	const percent = limitCents > 0 ? Math.min(100, Math.round(((account?.creditsUsedCents ?? 0) / limitCents) * 100)) : 0;
	const renewal = account?.periodEnd == null ? null : new Date(account.periodEnd).toLocaleDateString();
	const reset = creditsResetAt(account, now);
	const left = splitRemaining(reset.getTime() - now.getTime());
	const remaining =
		left.days > 0
			? t("settingsCore.account.resetInDays", { days: left.days, hours: left.hours })
			: left.hours > 0
				? t("settingsCore.account.resetInHours", { hours: left.hours, minutes: left.minutes })
				: t("settingsCore.account.resetInMinutes", { minutes: left.minutes });

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.plan")} description={t("settingsCore.account.planDescription")} />
			{/* Figma 415:11812: 요금제 관리 (the plan under its name, the dashboard button), a rule, then AI 사용량 on a stage card. */}
			<section className="ai-section">
				<div className="account-rows">
					<PlainRow
						name={t("settingsCore.account.planManage")}
						hint={plan === null ? t("settingsCore.common.unknown") : `${PLAN_LABEL[plan]}${account?.trialing === true ? t("settingsCore.account.trialing") : ""}`}
					>
						<button type="button" className="settings-outline-btn" onClick={() => openExternal(accountDashboardUrl(status?.baseUrl))}>
							{t("settingsCore.account.openDashboard")}
							<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" focusable="false" />
						</button>
					</PlainRow>
					{account?.cancelScheduled === true && renewal !== null ? <Note>{t("settingsCore.account.cancelScheduled", { date: renewal })}</Note> : null}
					{account !== null && account.status === "past_due" ? <Note>{t("settingsCore.account.pastDue")}</Note> : null}
					{error !== null ? <Note>{error}</Note> : null}
				</div>
			</section>
			<hr className="ai-divider account-divider" />
			<section className="plan-usage">
				<h2 className="plan-usage-title">{t("settingsCore.account.usageName")}</h2>
				<div className="plan-usage-card">
					<div className="plan-usage-line">
						<span className="plan-usage-reset" title={account === null ? undefined : reset.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}>
							{account === null ? t("settingsCore.account.usageUnavailable") : t("settingsCore.account.resetIn", { time: remaining })}
						</span>
						{account === null ? null : <span className="plan-usage-percent">{t("settingsCore.account.usedPercent", { percent })}</span>}
					</div>
					<div className="settings-meter plan-usage-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("settingsCore.account.usageMeterAria")}>
						<span style={{ width: `${percent}%` }} />
					</div>
				</div>
			</section>
		</>
	);
}
