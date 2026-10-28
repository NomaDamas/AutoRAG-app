/** Step 3 — direct Google/GitHub OAuth, native in-app Email OTP, or the no-account BYOK path. */

import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { cn } from "../../lib/cn";
import { AppLogo, BrandMark, Icon } from "../marks";
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

const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;

export function AccountStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, account } = ctx;
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [otpError, setOtpError] = useState<string | null>(null);
	const [resendIn, setResendIn] = useState(0);
	const signedIn = account?.state === "signedIn";
	const signingIn = account?.state === "signingIn";
	const snapshot = account?.account ?? null;

	useEffect(() => {
		if (resendIn <= 0) return;
		const timer = window.setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [resendIn]);

	async function requestCode(address: string): Promise<void> {
		const trimmed = address.trim();
		if (trimmed.length === 0 || busy) return;
		setOtpError(null);
		setBusy(true);
		try {
			const result = await ctx.sendEmailOtp(trimmed);
			if (!result.ok) {
				setOtpError(result.error);
				return;
			}
			setSentTo(result.email);
			setCode("");
			setResendIn(RESEND_COOLDOWN_SECONDS);
		} finally {
			setBusy(false);
		}
	}

	function submitEmail(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		void requestCode(email);
	}

	async function submitCode(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (sentTo === null || code.length !== OTP_LENGTH || busy) return;
		setOtpError(null);
		setBusy(true);
		try {
			const status = await ctx.verifyEmailOtp(sentTo, code);
			if (status != null && status.state !== "signedIn" && status.error !== null) {
				setOtpError(status.error);
			}
		} finally {
			setBusy(false);
		}
	}

	const visibleError = otpError ?? account?.error ?? null;

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
				) : sentTo !== null ? (
					<div className="account-panel">
						<form className="account-form" onSubmit={(event) => void submitCode(event)}>
							<p className="auth-note">{t("onboarding.account.codeSentNote", { email: sentTo })}</p>
							<label className="account-field">
								<span>{t("onboarding.account.codeLabel")}</span>
								<input
									type="text"
									inputMode="numeric"
									pattern="[0-9]{6}"
									maxLength={OTP_LENGTH}
									className="account-input account-code-input"
									value={code}
									placeholder="000000"
									autoComplete="one-time-code"
									autoFocus
									onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, OTP_LENGTH))}
								/>
							</label>
							<button type="submit" className="account-btn email" disabled={busy || code.length !== OTP_LENGTH}>
								{busy ? t("onboarding.account.verifyingCode") : t("onboarding.account.verifyCode")}
							</button>
						</form>
						{visibleError !== null ? (
							<p className="auth-note" role="alert">
								{visibleError}
							</p>
						) : null}
						<div className="account-otp-actions">
							<button
								type="button"
								className="inline-link"
								disabled={busy || resendIn > 0}
								onClick={() => void requestCode(sentTo)}
							>
								{resendIn > 0 ? t("onboarding.account.resendIn", { seconds: resendIn }) : t("onboarding.account.resendCode")}
							</button>
							{" · "}
							<button
								type="button"
								className="inline-link"
								disabled={busy}
								onClick={() => {
									setSentTo(null);
									setCode("");
									setOtpError(null);
									setResendIn(0);
								}}
							>
								{t("onboarding.account.useDifferentEmail")}
							</button>
						</div>
					</div>
				) : (
					<div className="account-panel">
						<div className="account-providers">
							<button type="button" className="account-btn google" disabled={busy} onClick={() => ctx.signIn({ provider: "google" })}>
								<GoogleMark />
								{t("onboarding.account.continueGoogle")}
							</button>
							<button type="button" className="account-btn github" disabled={busy} onClick={() => ctx.signIn({ provider: "github" })}>
								<BrandMark name="github" size={15} />
								{t("onboarding.account.continueGithub")}
							</button>
						</div>
						<div className="account-divider">{t("onboarding.account.or")}</div>
						<form className="account-form" onSubmit={submitEmail}>
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
							<button type="submit" className="account-btn email" disabled={busy || email.trim().length === 0}>
								{busy ? t("onboarding.account.sendingCode") : t("onboarding.account.continueEmail")}
							</button>
						</form>
						{visibleError !== null ? (
							<p className="auth-note" role="alert">
								{visibleError}
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
