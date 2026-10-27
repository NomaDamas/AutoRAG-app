/** Step 3 — real sign-in through the system browser (OAuth code + PKCE), or the no-account BYOK path. */

import { useState, type ReactElement } from "react";
import { cn } from "../../lib/cn";
import { AppLogo, Icon } from "../marks";
import { openExternal } from "../parts";
import { accountLegalUrl } from "../../../../shared/account-contract";
import { APP_NAME } from "../../../../shared/app-info";
import type { OnboardingCtx } from "../context";

function GoogleMark(): ReactElement {
	return (
		<svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
			<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
			<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
			<path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.600 2.600 10.800l7.900-6.100z" />
			<path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.500-5.800c-2.100 1.400-4.800 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z" />
		</svg>
	);
}

function AppleMark(): ReactElement {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M16.4 12.700c0-2.400 2-3.500 2.100-3.600-1.100-1.700-2.900-1.900-3.500-1.900-1.500-.2-2.900.9-3.700.9-.8 0-1.900-.9-3.200-.8-1.600 0-3.100 1-4 2.400-1.700 3-.4 7.400 1.200 9.800.8 1.200 1.800 2.500 3 2.400 1.200 0 1.700-.8 3.100-.8 1.400 0 1.900.8 3.200.8 1.300 0 2.100-1.200 2.900-2.400.9-1.400 1.300-2.700 1.300-2.800 0 0-2.400-.9-2.400-3.900zM14.100 5.500c.7-.8 1.100-1.900 1-3-1 0-2.100.7-2.800 1.500-.6.700-1.100 1.800-1 2.900 1.100.1 2.100-.6 2.800-1.400z" />
		</svg>
	);
}

export function AccountStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, account } = ctx;
	const [email, setEmail] = useState("");
	const signedIn = account?.state === "signedIn";
	const signingIn = account?.state === "signingIn";
	const snapshot = account?.account ?? null;

	if (signedIn) {
		return (
			<section className="screen account-screen">
				<div className="account-done">
					<div className="account-done-mark">
						<span className="account-done-logo">
							<AppLogo />
						</span>
						<span className="account-done-check">
							<Icon name="check" size={18} />
						</span>
					</div>
					<h1>{t("onboarding.account.signedIn")}</h1>
					{snapshot === null ? null : (
						<div className="account-done-meta">
							<span className={cn("account-plan-tag", snapshot.plan !== "free" && "paid")}>{t(`onboarding.plan.plan.${snapshot.plan}.name`)}</span>
							<span>{snapshot.email}</span>
						</div>
					)}
					{account?.offline === true ? <p className="auth-note">{t("onboarding.account.offline")}</p> : null}
					<button type="button" className="account-switch" onClick={ctx.signOut}>
						{t("onboarding.account.otherAccount")}
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="screen account-screen">
			<div className="account-column">
				<div className="account-brand">
					<span className="account-logo">
						<AppLogo />
					</span>
					<h1>{`${APP_NAME} ${t("onboarding.account.getStarted")}`}</h1>
				</div>
				{signingIn ? (
					<div className="account-panel">
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
					</div>
				) : (
					<div className="account-panel">
						<div className="account-providers">
							<button type="button" className="account-btn google" onClick={ctx.signIn}>
								<GoogleMark />
								{t("onboarding.account.continueGoogle")}
							</button>
							<button type="button" className="account-btn apple" onClick={ctx.signIn}>
								<AppleMark />
								{t("onboarding.account.continueApple")}
							</button>
						</div>
						<div className="account-divider">{t("onboarding.account.or")}</div>
						<label className="account-field">
							<span>{t("onboarding.account.emailLabel")}</span>
							<input
								type="email"
								className="account-input"
								value={email}
								placeholder={t("onboarding.account.emailPlaceholder")}
								autoComplete="email"
								onChange={(event) => setEmail(event.target.value)}
							/>
						</label>
						<button type="button" className="account-btn email" onClick={ctx.signIn}>
							{t("onboarding.account.continueEmail")}
						</button>
						{account?.error ? (
							<p className="auth-note" role="alert">
								{account.error}
							</p>
						) : null}
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
					</div>
				)}
				{signingIn ? null : (
					<button type="button" className="account-guest" onClick={ctx.skipAccount}>
						{t("onboarding.account.guest")}
					</button>
				)}
			</div>
		</section>
	);
}
