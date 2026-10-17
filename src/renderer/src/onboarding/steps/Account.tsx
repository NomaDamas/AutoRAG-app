/** Step 3 — real sign-in through the system browser (OAuth code + PKCE), or the no-account BYOK path. */

import type { ReactElement } from "react";
import { AppLogo, Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen, openExternal } from "../parts";
import { accountLegalUrl } from "../../../../shared/account-contract";
import type { OnboardingCtx } from "../context";

/** The prototype's `appIcon()` — the app mark used in the account card head. */
function AppMark(): ReactElement {
	return (
		<span className="app-mark">
			<AppLogo />
		</span>
	);
}

export function AccountStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, account } = ctx;
	const signedIn = account?.state === "signedIn";
	const signingIn = account?.state === "signingIn";
	const snapshot = account?.account ?? null;

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="user-round">{t("onboarding.account.eyebrow")}</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.account.title")} />
					</h1>
					<p>{t("onboarding.account.lead")}</p>
					<div className="micro-note">
						<Icon name="external-link" size={14} />
						<span>{t("onboarding.account.note")}</span>
					</div>
				</>
			}
		>
			{signedIn ? (
				<div className="auth-card card">
					<div className="status-card">
						<div className="status-mark">
							<Icon name="check" size={16} />
						</div>
						<div>
							<strong>{t("onboarding.account.signedIn")}</strong>
							{snapshot === null ? null : (
								<small>{`${snapshot.email} · ${t("onboarding.account.planLabel", { plan: t(`onboarding.plan.plan.${snapshot.plan}.name`) })}`}</small>
							)}
							{account?.offline === true ? <small>{t("onboarding.account.offline")}</small> : null}
						</div>
					</div>
					<div className="action-row">
						<button type="button" className="secondary" onClick={ctx.signOut}>
							{t("onboarding.account.otherAccount")}
						</button>
					</div>
				</div>
			) : (
				<div className="auth-card card">
					<div className="auth-head">
						<AppMark />
						<div>
							<strong>{t("onboarding.account.cardTitle")}</strong>
							<small>{t("onboarding.account.cardSub")}</small>
						</div>
					</div>
					{signingIn ? (
						<>
							<div className="status-card">
								<div className="status-mark">
									<span className="spin">
										<Icon name="loader-circle" size={16} />
									</span>
								</div>
								<div>
									<strong>{t("onboarding.account.busy")}</strong>
									<small>{t("onboarding.account.busyNote")}</small>
								</div>
							</div>
							<div className="action-row">
								<button type="button" className="secondary" onClick={ctx.cancelSignIn}>
									{t("onboarding.account.cancel")}
								</button>
							</div>
						</>
					) : (
						<>
							<button type="button" className="auth-btn email" onClick={ctx.signIn}>
								<span className="auth-mark">
									<Icon name="external-link" size={15} />
								</span>
								{t("onboarding.account.signIn")}
							</button>
							{account?.error ? (
								<p className="auth-note" role="alert">
									{account.error}
								</p>
							) : null}
							<p className="auth-note">{t("onboarding.account.authNote")}</p>
							<p className="auth-note legal-note">
								{t("onboarding.account.agreeLead")}{" "}
								<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(account?.baseUrl, "terms"))}>
									{t("onboarding.account.agreeTerms")}
								</button>
								{" · "}
								<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(account?.baseUrl, "privacy"))}>
									{t("onboarding.account.agreePrivacy")}
								</button>
								{" · "}
								<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(account?.baseUrl, "acceptableUse"))}>
									{t("onboarding.account.agreeUse")}
								</button>
							</p>
							<div className="action-row">
								<button type="button" className="secondary" onClick={ctx.skipAccount}>
									{t("onboarding.account.skip")}
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</SplitScreen>
	);
}
