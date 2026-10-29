/** Step 1 — the value pitch (Figma 01 · welcome): a centred heading over four feature cards, then the two privacy opt-ins. */

import type { ReactElement, ReactNode } from "react";
import { BrandMark, brandVars, Icon } from "../marks";
import { Multiline, openExternal } from "../parts";
import { WELCOME_BRANDS } from "../flow";
import { accountLegalUrl } from "../../../../shared/account-contract";
import { APP_NAME } from "../../../../shared/app-info";
import type { OnboardingCtx } from "../context";

interface FeatureCardProps {
	readonly art: ReactNode;
	readonly artClass: string;
	readonly icon: string;
	readonly tone: string;
	readonly title: string;
	readonly sub: string;
}

function FeatureCard({ art, artClass, icon, tone, title, sub }: FeatureCardProps): ReactElement {
	return (
		<article className="feature-card">
			<div className={`feature-art ${artClass}`}>{art}</div>
			<div className="feature-label">
				<span className={`feature-icon ${tone}`}>
					<Icon name={icon} size={16} />
				</span>
				<span className="feature-copy">
					<strong>{title}</strong>
					<small>{sub}</small>
				</span>
			</div>
		</article>
	);
}

export function WelcomeStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t } = ctx;
	return (
		<section className="screen center welcome-screen">
			<div className="screen-copy">
				<h1>{t("onboarding.welcome.title", { app: APP_NAME })}</h1>
				<p>
					<Multiline text={t("onboarding.welcome.lead", { app: APP_NAME })} />
				</p>
			</div>
			<div className="feature-grid">
				<FeatureCard
					icon="sparkles"
					tone="blue"
					artClass="art-chat"
					title={t("onboarding.feature.ai.title")}
					sub={t("onboarding.feature.ai.sub")}
					art={
						<div className="mini-chat">
							<div className="mini-bubble user">{t("onboarding.welcome.chat.user")}</div>
							<div className="mini-bubble">
								{t("onboarding.welcome.chat.replyLead")}
								<b>18%</b>
								{t("onboarding.welcome.chat.replyTail")}
								<br />
								<span className="cite">budget.xlsx · 4</span>
								<span className="cite">{t("finderComponents.onboardingDemo.meetingNotes")} · 2</span>
							</div>
						</div>
					}
				/>
				<FeatureCard
					icon="layers"
					tone="purple"
					artClass="art-center"
					title={t("onboarding.feature.versions.title")}
					sub={t("onboarding.feature.versions.sub")}
					art={
						<div className="version-list">
							<div className="version-row">
								<span className="vtag latest">{t("onboarding.versions.latest")}</span>
								<span>proposal-final.docx</span>
							</div>
							<div className="version-row">
								<span className="vtag near">{t("onboarding.versions.near")}</span>
								<span>proposal-v3.docx</span>
							</div>
							<div className="version-row dim">
								<span className="vtag exact">{t("onboarding.versions.exact")}</span>
								<span>proposal-copy.docx</span>
							</div>
						</div>
					}
				/>
				<FeatureCard
					icon="plug-zap"
					tone="green"
					artClass="art-center"
					title={t("onboarding.feature.sources.title")}
					sub={t("onboarding.feature.sources.sub")}
					art={
						<div className="source-grid">
							{WELCOME_BRANDS.map((name) => (
								<span key={name} className="source-token brand" style={brandVars(name)}>
									<BrandMark name={name} size={17} />
								</span>
							))}
						</div>
					}
				/>
				<FeatureCard
					icon="list-checks"
					tone="amber"
					artClass="art-rank"
					title={t("onboarding.feature.hybrid.title")}
					sub={t("onboarding.feature.hybrid.sub")}
					art={
						<>
							<div className="rank-modes">
								<span>{t("onboarding.hybrid.keyword")}</span>
								<span>{t("onboarding.hybrid.semantic")}</span>
								<span>{t("onboarding.hybrid.rerank")}</span>
							</div>
							<div className="rank-list">
								<div className="rank-row">
									<span className="rank-n">1</span>
									<span>{t("finderComponents.onboardingDemo.meetingNotes")}</span>
									<span className="rank-badge">↑ 3→1</span>
								</div>
								<div className="rank-row">
									<span className="rank-n">2</span>
									<span>report-q3.pdf</span>
								</div>
								<div className="rank-row dim">
									<span className="rank-n">3</span>
									<span>old-draft.docx</span>
								</div>
							</div>
						</>
					}
				/>
			</div>
			{/* The opt-ins are the consent itself (saved when the step is left), so they stay, under the cards. */}
			<div className="welcome-consents">
				<label className="consent usage-consent">
					<input type="checkbox" checked={ctx.shareUsage} onChange={(event) => ctx.setShareUsage(event.target.checked)} />
					<span>
						{t("onboarding.welcome.usageStats")}{" "}
						<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(ctx.account?.baseUrl, "privacy"))}>
							{t("onboarding.welcome.usageStatsPolicy")}
						</button>
					</span>
				</label>
				<label className="consent usage-consent">
					<input type="checkbox" checked={ctx.shareErrors} onChange={(event) => ctx.setShareErrors(event.target.checked)} />
					<span>
						{t("onboarding.welcome.errorReports")}{" "}
						<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(ctx.account?.baseUrl, "privacy"))}>
							{t("onboarding.welcome.usageStatsPolicy")}
						</button>
					</span>
				</label>
			</div>
		</section>
	);
}
