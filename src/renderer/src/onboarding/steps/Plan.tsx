/** Step 7 — plan choice. Free/BYOK continue; Air/Pro/Max open the hosted checkout in the browser, where Pro starts with a free trial. */

import type { ReactElement } from "react";
import { isPaidPlanId, parsePromoCode } from "../../../../shared/account-contract";
import type { PlanId } from "../../../../shared/onboarding-contract";
import { i18n } from "../../../../shared/i18n";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline } from "../parts";
import type { OnboardingCtx } from "../context";
import { canSelectCloudEmbedding, isPlanSelectable, planHeld } from "../flow";
interface PlanDefinition {
	readonly id: PlanId;
	readonly per: boolean;
	readonly featureKeys: readonly string[];
}

/** The order the hosted service lists its plans in, then the bring-your-own-key path. */
const PLANS: readonly PlanDefinition[] = [
	{ id: "free", per: false, featureKeys: ["a", "b"] },
	{ id: "air", per: true, featureKeys: ["a", "b", "c"] },
	{ id: "pro", per: true, featureKeys: ["a", "b", "c"] },
	{ id: "max", per: true, featureKeys: ["a", "b", "c"] },
	{ id: "byok", per: false, featureKeys: ["a", "b", "c"] },
];

export function PlanStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, account } = ctx;
	const signedIn = account?.state === "signedIn";
	const snapshot = account?.account ?? null;
	const cloud = canSelectCloudEmbedding(account) && draft.embed === "cloud";
	const needsAccount = isPaidPlanId(draft.plan) && !signedIn;
	const date = snapshot?.periodEnd === null || snapshot === null ? "" : new Date(snapshot.periodEnd).toLocaleDateString(i18n.language);
	const proHeld = planHeld("pro", account);
	const buying = isPaidPlanId(draft.plan) && !planHeld(draft.plan, account);
	const promoInvalid = !parsePromoCode(ctx.promoCode).ok;

	return (
		<section className="screen center">
			<div className="screen-copy">
				<Eyebrow icon="zap">{t("onboarding.plan.eyebrow")}</Eyebrow>
				<h1>{planHeld(draft.plan, account) ? t("onboarding.plan.titleReady") : t("onboarding.plan.title")}</h1>
				<p>
					<Multiline text={cloud ? (proHeld ? t("onboarding.plan.leadCloudReady") : t("onboarding.plan.leadCloud")) : t("onboarding.plan.lead")} />
				</p>
				{needsAccount ? (
					<p className="auth-note" role="status">
						{t("onboarding.plan.signInFirst")}{" "}
						<button type="button" className="secondary" onClick={() => ctx.setStep("account")}>
							{t("onboarding.plan.signInAction")}
						</button>
					</p>
				) : null}
			</div>
			{cloud && !proHeld ? (
				<div className="plan-callout">
					<Icon name="cloud" size={14} />
					<span>{t("onboarding.plan.cloudCallout")}</span>
				</div>
			) : null}
			<div className="plan-list">
				{PLANS.map((plan) => {
					const selectable = isPlanSelectable(plan.id, cloud ? "cloud" : "local");
					const held = planHeld(plan.id, account) && snapshot?.plan === plan.id;
					const selected = draft.plan === plan.id;
					let badge: ReactElement | null = null;
					if (held) {
						badge = (
							<span className="tag rec">
								{snapshot?.trialing === true ? t("onboarding.plan.badgeTrial") : t("onboarding.plan.badgeSubscribed")}
							</span>
						);
					} else if (plan.id === "pro") {
						badge = <small>{t("onboarding.plan.badgeRecommended")}</small>;
					}
					const offersTrial = plan.id === "pro" && !held;
					let note = t(`onboarding.plan.plan.${plan.id}.note`);
					if (held && snapshot !== null) {
						if (snapshot.cancelScheduled) note = t("onboarding.plan.noteCancelScheduled", { date });
						else if (snapshot.trialing) note = t("onboarding.plan.noteTrialing", { date });
						else note = t("onboarding.plan.noteHeld");
					}
					return (
						<div
							key={plan.id}
							className={cn("plan-card", selected && "selected", !selectable && "disabled")}
							aria-disabled={!selectable}
							onClick={() => {
								if (selectable) ctx.choosePlan(plan.id);
							}}
						>
							<span className="radio" />
							<div className="plan-name">
								{t(`onboarding.plan.plan.${plan.id}.name`)}
								{badge}
							</div>
							<div className="plan-price">
								<b className={plan.per || plan.id === "free" ? "" : "sm"}>
									{t(`onboarding.plan.plan.${plan.id}.price`)}
								</b>
								{plan.per ? <span>{t("onboarding.plan.perMonth")}</span> : null}
							</div>
							<div className={cn("plan-note", offersTrial && "trial")}>{note}</div>
							{offersTrial ? <span className="tag rec plan-trial">{t("onboarding.plan.plan.pro.trial")}</span> : null}
							<div className="plan-desc">{t(`onboarding.plan.plan.${plan.id}.tag`)}</div>
							<ul className="plan-features">
								{plan.featureKeys.map((key) => (
									<li key={key}>{t(`onboarding.plan.plan.${plan.id}.feature.${key}`)}</li>
								))}
							</ul>
							<div className="plan-training">{t(`onboarding.plan.plan.${plan.id}.training`)}</div>
							<div className="plan-meta">
								<span className="meta-chip">{t(`onboarding.plan.plan.${plan.id}.chip`)}</span>
							</div>
						</div>
					);
				})}
			</div>
			{buying ? (
				<div className="promo-box">
					<label htmlFor="onb-promo-code">{t("onboarding.plan.promo.label")}</label>
					<input
						id="onb-promo-code"
						className="input"
						name="promo-code"
						type="text"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						maxLength={100}
						value={ctx.promoCode}
						placeholder={t("onboarding.plan.promo.placeholder")}
						aria-invalid={promoInvalid}
						onChange={(event) => ctx.setPromoCode(event.target.value)}
					/>
					{promoInvalid ? (
						<small className="promo-error" role="alert">
							{t("onboarding.plan.promo.invalid")}
						</small>
					) : (
						<small>{t("onboarding.plan.promo.hint")}</small>
					)}
					{draft.plan === "pro" ? <small>{t("onboarding.plan.trialNote")}</small> : null}
				</div>
			) : null}
		</section>
	);
}

export { PLANS };
