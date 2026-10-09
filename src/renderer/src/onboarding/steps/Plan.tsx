/** Step 7 — plan choice. Free/BYOK continue; Air/Pro open the placeholder checkout. */

import type { ReactElement } from "react";
import type { PlanId } from "../../../../shared/onboarding-contract";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline } from "../parts";
import type { OnboardingCtx } from "../context";

interface PlanDefinition {
	readonly id: PlanId;
	readonly per: boolean;
	readonly trial: boolean;
	readonly featureKeys: readonly string[];
}

const PLANS: readonly PlanDefinition[] = [
	{ id: "free", per: false, trial: false, featureKeys: ["a", "b", "c"] },
	{ id: "air", per: true, trial: false, featureKeys: ["a", "b", "c"] },
	{ id: "pro", per: true, trial: true, featureKeys: ["a", "b", "c"] },
	{ id: "byok", per: false, trial: false, featureKeys: ["a", "b", "c"] },
];

export function PlanStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft } = ctx;
	const paid = draft.paid;

	return (
		<section className="screen center">
			<div className="screen-copy">
				<Eyebrow icon="zap">{t("onboarding.plan.eyebrow")}</Eyebrow>
				<h1>{paid === null ? t("onboarding.plan.title") : t("onboarding.plan.titleReady")}</h1>
				<p>{t("onboarding.plan.lead")}</p>
			</div>
			<div className="plan-list">
				{PLANS.map((plan) => {
					const isPaid = paid === plan.id;
					const selected = draft.plan === plan.id;
					let badge: ReactElement | null = null;
					if (isPaid) {
						badge = (
							<span className="tag rec">
								{plan.trial ? t("onboarding.plan.badgeTrial") : t("onboarding.plan.badgeSubscribed")}
							</span>
						);
					} else if (plan.id === "pro") {
						badge = <small>{t("onboarding.plan.badgeRecommended")}</small>;
					}
					const note = isPaid
						? plan.trial
							? t("onboarding.plan.noteProTrialActive")
							: t("onboarding.plan.notePaid")
						: t(`onboarding.plan.plan.${plan.id}.note`);
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
							<div className={cn("plan-note", plan.trial && !isPaid && "trial")}>{note}</div>
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
