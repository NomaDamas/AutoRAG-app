/** Step 7 — plan choice. Free/BYOK continue; Air/Pro/Max open the hosted checkout in the browser, where Pro starts with a free trial. */

import { useState, type ReactElement } from "react";
import { isPaidPlanId, parsePromoCode } from "../../../../shared/account-contract";
import type { PlanId } from "../../../../shared/onboarding-contract";
import { i18n } from "../../../../shared/i18n";
import { cn } from "../../lib/cn";
import { Eyebrow, Multiline } from "../parts";
import type { OnboardingCtx } from "../context";
import { canSelectCloudEmbedding, isPlanSelectable, planHeld } from "../flow";

interface PlanDefinition {
	readonly id: PlanId;
	/** Billed monthly: the price is followed by "/ mo". */
	readonly per: boolean;
}

/** The order the hosted service lists its plans in, then the bring-your-own-key path. */
const PLANS: readonly PlanDefinition[] = [
	{ id: "free", per: false },
	{ id: "air", per: true },
	{ id: "pro", per: true },
	{ id: "max", per: true },
	{ id: "byok", per: false },
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
	// The code is asked for on request; one already typed stays in view.
	const [promoAsked, setPromoAsked] = useState(false);
	const promoOpen = promoAsked || ctx.promoCode.length > 0;

	return (
		<section className="screen center plan-screen">
			<div className="screen-copy">
				<Eyebrow icon="zap">{t("onboarding.plan.eyebrow")}</Eyebrow>
				<h1>{planHeld(draft.plan, account) ? t("onboarding.plan.titleReady") : t("onboarding.plan.title")}</h1>
				<p>
					<Multiline text={cloud ? (proHeld ? t("onboarding.plan.leadCloudReady") : t("onboarding.plan.leadCloud")) : t("onboarding.plan.lead")} />
				</p>
			</div>
			<div className="plan-list">
				{PLANS.map((plan) => {
					const selectable = isPlanSelectable(plan.id, cloud ? "cloud" : "local");
					const held = planHeld(plan.id, account) && snapshot?.plan === plan.id;
					const selected = draft.plan === plan.id;
					const offersTrial = plan.id === "pro" && !held;
					let status: string | null = null;
					if (held && snapshot !== null) {
						if (snapshot.cancelScheduled) status = t("onboarding.plan.noteCancelScheduled", { date });
						else if (snapshot.trialing) status = t("onboarding.plan.noteTrialing", { date });
						else status = t("onboarding.plan.noteHeld");
					}
					return (
						<div
							key={plan.id}
							className={cn("plan-card", selected && "selected", !selectable && "disabled", offersTrial && "has-trial")}
							aria-disabled={!selectable}
							onClick={() => {
								if (selectable) ctx.choosePlan(plan.id);
							}}
						>
							{offersTrial ? <span className="plan-trial">{t("onboarding.plan.plan.pro.trial")}</span> : null}
							<span className="radio" />
							<div className="plan-name">
								{t(`onboarding.plan.plan.${plan.id}.name`)}
								{held ? <span className="tag rec">{snapshot?.trialing === true ? t("onboarding.plan.badgeTrial") : t("onboarding.plan.badgeSubscribed")}</span> : null}
							</div>
							<div className="plan-price">
								<b className={plan.per || plan.id === "free" ? "" : "sm"}>{t(`onboarding.plan.plan.${plan.id}.price`)}</b>
								{plan.per ? <span>{t("onboarding.plan.perMonth")}</span> : null}
							</div>
							<div className="plan-desc">{t(`onboarding.plan.plan.${plan.id}.tag`)}</div>
							{status === null ? null : <div className="plan-note">{status}</div>}
							{plan.id === "free" ? <div className="plan-training">{t("onboarding.plan.plan.free.training")}</div> : null}
						</div>
					);
				})}
			</div>
			{/* Always rendered, so the screen keeps its height (and its centring) whatever plan is picked. */}
			<div className="promo">
				{needsAccount ? (
					<p className="auth-note" role="status">
						{t("onboarding.plan.signInFirst")}{" "}
						<button type="button" className="secondary" onClick={() => ctx.setStep("account")}>
							{t("onboarding.plan.signInAction")}
						</button>
					</p>
				) : buying ? (
					promoOpen ? (
						<>
							<input
								name="promo-code"
								className="promo-input"
								type="text"
								autoFocus={promoAsked}
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								maxLength={100}
								value={ctx.promoCode}
								placeholder={t("onboarding.plan.promo.label")}
								aria-label={t("onboarding.plan.promo.label")}
								aria-invalid={promoInvalid}
								onChange={(event) => ctx.setPromoCode(event.target.value)}
							/>
							{promoInvalid ? (
								<small className="promo-error" role="alert">
									{t("onboarding.plan.promo.invalid")}
								</small>
							) : null}
						</>
					) : (
						<button type="button" className="promo-toggle" onClick={() => setPromoAsked(true)}>
							{t("onboarding.plan.promo.prompt")}
						</button>
					)
				) : null}
			</div>
		</section>
	);
}

export { PLANS };
