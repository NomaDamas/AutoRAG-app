/** Step 1 — the value pitch, built from the prototype's `welcome` view. */

import type { ReactElement, ReactNode } from "react";
import { BrandMark, brandVars, Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen, openExternal } from "../parts";
import { WELCOME_BRANDS } from "../flow";
import { accountLegalUrl } from "../../../../shared/account-contract";
import type { OnboardingCtx } from "../context";

interface FeatureCardProps {
	readonly art: ReactNode;
	readonly icon: string;
	readonly tone?: string;
	readonly title: string;
	readonly sub: string;
}

function FeatureCard({ art, icon, tone, title, sub }: FeatureCardProps): ReactElement {
	return (
		<article className="feature-card">
			<div className="feature-art">{art}</div>
			<div className="feature-label">
				<span className={tone === undefined ? "tile-icon" : `tile-icon ${tone}`}>
					<Icon name={icon} size={13} />
				</span>
				<span>
					{title}
					<small>{sub}</small>
				</span>
			</div>
		</article>
	);
}

export function WelcomeStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t } = ctx;
	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="sparkles">{t("onboarding.welcome.eyebrow")}</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.welcome.title")} />
					</h1>
					<p>{t("onboarding.welcome.lead")}</p>
					<div className="micro-note">
						<Icon name="shield-check" size={14} />
						<span>{t("onboarding.welcome.note")}</span>
					</div>
					<label className="consent usage-consent">
						<input type="checkbox" checked={ctx.shareUsage} onChange={(event) => ctx.setShareUsage(event.target.checked)} />
						<span>
							{t("onboarding.welcome.usageStats")}{" "}
							<button type="button" className="inline-link" onClick={() => openExternal(accountLegalUrl(ctx.account?.baseUrl, "privacy"))}>
								{t("onboarding.welcome.usageStatsPolicy")}
							</button>
						</span>
					</label>
				</>
			}
		>
			<div className="feature-grid">
				<FeatureCard
					icon="sparkles"
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
					icon="quote"
					tone="red"
					title={t("onboarding.feature.citation.title")}
					sub={t("onboarding.feature.citation.sub")}
					art={
						<div className="mini-evidence">
							<div className="evidence-row">
								<span className="file-tile">PDF</span>
								<span>
									<b>01</b> {t("onboarding.welcome.evidence.revenue")}
									<br />
									<span>{t("onboarding.welcome.evidence.revenueQuote")}</span>
								</span>
							</div>
							<div className="evidence-row">
								<span className="file-tile xlsx">XLS</span>
								<span>
									<b>02</b> {t("onboarding.welcome.evidence.budget")}
									<br />
									<span>{t("onboarding.welcome.evidence.budgetQuote")}</span>
								</span>
							</div>
						</div>
					}
				/>
				<FeatureCard
					icon="layers"
					tone="purple"
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
					icon="scan-eye"
					title={t("onboarding.feature.quicklook.title")}
					sub={t("onboarding.feature.quicklook.sub")}
					art={
						<div className="paper">
							<div className="paper-head" />
							<div className="mini-lines">
								<span className="mini-line" />
								<span className="mini-line short" />
								<span className="highlight" />
								<span className="mini-line" />
								<span className="mini-line short" />
							</div>
						</div>
					}
				/>
				<FeatureCard
					icon="plug-zap"
					tone="green"
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
		</SplitScreen>
	);
}
