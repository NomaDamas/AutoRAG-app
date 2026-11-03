/**
 * Step 7 — plan choice (Figma 08c): Free, Air and a Pro/Max card with a switch, then a link for bringing your own key.
 * Free/BYOK continue; Air/Pro/Max open the hosted checkout in the browser, where Pro starts with a free trial.
 */

import { useState, type ReactElement } from "react";
import { isPaidPlanId, parsePromoCode } from "../../../../shared/account-contract";
import type { PlanId } from "../../../../shared/onboarding-contract";
import { i18n } from "../../../../shared/i18n";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Multiline } from "../parts";
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

/** The two plans that share the third card, switched between on it. */
const TIERS = ["pro", "max"] as const;
type Tier = (typeof TIERS)[number];

export function PlanStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, account } = ctx;
	const signedIn = account?.state === "signedIn";
	const snapshot = account?.account ?? null;
	const cloud = canSelectCloudEmbedding(account) && draft.embed === "cloud";
	const mode = cloud ? "cloud" : "local";
	const needsAccount = isPaidPlanId(draft.plan) && !signedIn;
	const date = snapshot?.periodEnd === null || snapshot === null ? "" : new Date(snapshot.periodEnd).toLocaleDateString(i18n.language);
	const proHeld = planHeld("pro", account);
	const buying = isPaidPlanId(draft.plan) && !planHeld(draft.plan, account);
	const promoInvalid = !parsePromoCode(ctx.promoCode).ok;
	// The code is asked for on request; one already typed stays in view.
	const [promoAsked, setPromoAsked] = useState(false);
	const promoOpen = promoAsked || ctx.promoCode.length > 0;
	// The third card shows the chosen one of Pro and Max, else the one last switched to.
	const [pickedTier, setPickedTier] = useState<Tier>(draft.plan === "max" ? "max" : "pro");
	const tier: Tier = draft.plan === "pro" || draft.plan === "max" ? draft.plan : pickedTier;

	const choose = (id: PlanId): void => {
		if (isPlanSelectable(id, mode)) ctx.choosePlan(id);
	};

	const card = (plan: PlanDefinition): ReactElement => {
		const selectable = isPlanSelectable(plan.id, mode);
		const held = planHeld(plan.id, account) && snapshot?.plan === plan.id;
		const selected = draft.plan === plan.id;
		const tiered = plan.id === "pro" || plan.id === "max";
		const offersTrial = plan.id === "pro" && !held;
		let status: string | null = null;
		if (held && snapshot !== null) {
			if (snapshot.cancelScheduled) status = t("onboarding.plan.noteCancelScheduled", { date });
			else if (snapshot.trialing) status = t("onboarding.plan.noteTrialing", { date });
			else status = t("onboarding.plan.noteHeld");
		}
		const badge = held ? <span className="tag rec">{snapshot?.trialing === true ? t("onboarding.plan.badgeTrial") : t("onboarding.plan.badgeSubscribed")}</span> : null;
		const desc = plan.id === "free" && ctx.platform === "win32" ? t("onboarding.plan.plan.free.tagPc") : t(`onboarding.plan.plan.${plan.id}.tag`);
		return (
			<div
				key={tiered ? "tier" : plan.id}
				className={cn("plan-card", tiered && "tier", selected && "selected", !selectable && "disabled")}
				data-plan={plan.id}
				aria-disabled={!selectable}
				onClick={() => choose(plan.id)}
			>
				{offersTrial ? <span className="plan-trial">{t("onboarding.plan.plan.pro.trial")}</span> : null}
				<span className="radio" />
				<div className="plan-top">
					{tiered ? (
						<div className="plan-tier-row">
							<div className="plan-tiers" role="tablist" aria-label={t("onboarding.plan.tierLabel")}>
								{TIERS.map((id) => (
									<button
										key={id}
										type="button"
										role="tab"
										aria-selected={tier === id}
										className={cn("plan-tier", tier === id && "on")}
										onClick={(event) => {
											event.stopPropagation();
											setPickedTier(id);
											choose(id);
										}}
									>
										{t(`onboarding.plan.plan.${id}.name`)}
									</button>
								))}
							</div>
							{badge}
						</div>
					) : (
						<div className="plan-name">
							{t(`onboarding.plan.plan.${plan.id}.name`)}
							{badge}
						</div>
					)}
					<div className="plan-price">
						<b>{t(`onboarding.plan.plan.${plan.id}.price`)}</b>
						{plan.per ? <span>{t("onboarding.plan.perMonth")}</span> : null}
					</div>
					<div className="plan-desc">{desc}</div>
					{status === null ? null : <div className="plan-note">{status}</div>}
				</div>
				<ul className="plan-features">
					{t(`onboarding.plan.plan.${plan.id}.features`)
						.split("\n")
						.map((line) => (
							<li key={line}>
								<Icon name="check" size={18} />
								<span>{line}</span>
							</li>
						))}
				</ul>
				{plan.id === "free" ? <div className="plan-training">{t("onboarding.plan.plan.free.training")}</div> : null}
			</div>
		);
	};

	const shown = PLANS.filter((plan) => plan.id === "free" || plan.id === "air" || plan.id === tier);
	const byokSelectable = isPlanSelectable("byok", mode);

	return (
		<section className="screen center plan-screen">
			<div className="screen-copy">
				<h1>{planHeld(draft.plan, account) ? t("onboarding.plan.titleReady") : t("onboarding.plan.title")}</h1>
				{cloud ? (
					<p>
						<Multiline text={proHeld ? t("onboarding.plan.leadCloudReady") : t("onboarding.plan.leadCloud")} />
					</p>
				) : null}
			</div>
			<div className="plan-list">{shown.map(card)}</div>
			<div className="plan-foot">
				{byokSelectable ? (
					<p className="plan-byok">
						<span>{t("onboarding.plan.byokLead")}</span>
						<button type="button" onClick={ctx.connectOwnKey}>
							{t("onboarding.plan.byokLink")}
						</button>
					</p>
				) : null}
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
			</div>
		</section>
	);
}

export { PLANS };
