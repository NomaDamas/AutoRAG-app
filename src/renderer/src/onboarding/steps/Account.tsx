/** Step 3 — placeholder sign-in (no account backend; records the method only). */

import { useState, type ReactElement } from "react";
import { BrandMark, Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen } from "../parts";
import type { OnboardingCtx } from "../context";

/** The prototype's `appIcon()` — the app mark used in the account card head. */
function AppMark(): ReactElement {
	return (
		<span className="app-mark">
			<Icon name="folder-search" size={31} />
		</span>
	);
}

export function AccountStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, authBusy } = ctx;
	const [email, setEmail] = useState("");
	const signedIn = draft.account !== null;
	const shownEmail = draft.account?.email ?? t("onboarding.account.sampleEmail");

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
							<small>{shownEmail} · {t("onboarding.account.signedInNote")}</small>
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
					{authBusy ? (
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
					) : (
						<>
							<button type="button" className="auth-btn apple" onClick={() => ctx.signIn("apple")}>
								<span className="auth-mark">
									<BrandMark name="apple" size={15} />
								</span>
								{t("onboarding.account.apple")}
							</button>
							<button type="button" className="auth-btn google" onClick={() => ctx.signIn("google")}>
								<span className="auth-mark">
									<BrandMark name="googleG" size={15} />
								</span>
								{t("onboarding.account.google")}
							</button>
							<div className="divider">{t("onboarding.account.or")}</div>
							<div className="input-row">
								<input
									className="input"
									type="email"
									placeholder={t("onboarding.account.emailPlaceholder")}
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
								<button
									type="button"
									className="auth-btn email"
									style={{ marginTop: 0, width: "auto", padding: "0 12px" }}
									onClick={() => ctx.signIn("email", email)}
								>
									{t("onboarding.account.magicLink")}
								</button>
							</div>
							<p className="auth-note">{t("onboarding.account.authNote")}</p>
						</>
					)}
				</div>
			)}
		</SplitScreen>
	);
}
