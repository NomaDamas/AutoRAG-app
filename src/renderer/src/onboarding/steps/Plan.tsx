/** Step 7 — plan choice. Free/BYOK continue; Air/Pro open the hosted checkout in the browser. */

import type { ReactElement } from "react";
import type { PlanId } from "../../../../shared/onboarding-contract";
import { cn } from "../../lib/cn";
import { Eyebrow, Multiline } from "../parts";
import type { OnboardingCtx } from "../context";
import { planHeld } from "../flow";

interface PlanDefinition {
	readonly id: PlanId;
	readonly per: boolean;
	readonly featureKeys: readonly string[];
}

const PLANS: readonly PlanDefinition[] = [
	{ id: "free", per: false, featureKeys: ["a", "b", "c"] },
	{ id: "air", per: true, featureKeys: ["a", "b", "c"] },
	{ id: "pro", per: true, featureKeys: ["a", "b", "c"] },
	{ id: "byok", per: false, featureKeys: ["a", "b", "c"] },
];

export function PlanStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, account } = ctx;
	const signedIn = account?.state === "signedIn";
	const snapshot = account?.account ?? null;
	const needsAccount = (draft.plan === "air" || draft.plan === "pro") && !signedIn;
	const date = snapshot?.periodEnd === null || snapshot === null ? "" : new Date(snapshot.periodEnd).toLocaleDateString();

	return (
		<section className="screen center">
			<div className="screen-copy">
				<Eyebrow icon="zap">{t("onboarding.plan.eyebrow")}</Eyebrow>
				<h1>{planHeld(draft.plan, account) ? t("onboarding.plan.titleReady") : t("onboarding.plan.title")}</h1>
				<p>
					<Multiline text={t("onboarding.plan.lead")} />
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
			<div className="plan-list">
				{PLANS.map((plan) => {
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
					let note = t(`onboarding.plan.plan.${plan.id}.note`);
					if (held && snapshot !== null) {
						if (snapshot.cancelScheduled) note = t("onboarding.plan.noteCancelScheduled", { date });
						else if (snapshot.trialing) note = t("onboarding.plan.noteTrialing", { date });
						else note = t("onboarding.plan.noteHeld");
					}
					return (
						<div
							key={plan.id}
							className={cn("plan-card", selected && "selected")}
							onClick={() => ctx.choosePlan(plan.id)}
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
							<div className="plan-note">{note}</div>
							<div className="plan-desc">{t(`onboarding.plan.plan.${plan.id}.tag`)}</div>
							<ul className="plan-features">
								{plan.featureKeys.map((key) => (
									<li key={key}>{t(`onboarding.plan.plan.${plan.id}.feature.${key}`)}</li>
								))}
							</ul>
							<div className="plan-meta">
								<span className="meta-chip">{t(`onboarding.plan.plan.${plan.id}.chip`)}</span>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

export { PLANS };
