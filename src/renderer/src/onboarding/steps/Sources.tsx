/** Step 6 — detected connectors, with metadata-drafted descriptions. */

import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { BrandChip, Eyebrow, Multiline, SourceIcon, SplitScreen, Switch } from "../parts";
import { EXTRA_BRANDS, sourceDetail } from "../flow";
import type { OnboardingCtx } from "../context";

export function SourcesStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, sources, draft, permissions } = ctx;
	const fda = permissions?.fullDiskAccess === true;

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="plug-zap">{t("onboarding.sources.eyebrow")}</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.sources.title")} />
					</h1>
					<p>{t("onboarding.sources.lead")}</p>
					<div className="micro-note">
						<Icon name="info" size={14} />
						<span>{t("onboarding.sources.note")}</span>
					</div>
				</>
			}
		>
			<div className="source-list">
				{sources.map((source) => {
					const choice = draft.sources.find((s) => s.id === source.id);
					const on = choice?.on === true;
					const needsPermission = source.id === "mail" && !fda;
					return (
						<div key={source.id} className="source-row" data-source-id={source.id}>
							<SourceIcon id={source.id} />
							<div className="source-main">
								<div className="source-name">
									{t(`onboarding.sources.name.${source.id}`)}{" "}
									<span className={cn("tag", needsPermission && "req")}>
										{needsPermission ? t("onboarding.sources.needsPermission") : t("onboarding.sources.detected")}
									</span>
								</div>
								<div className="source-detail">{sourceDetail(source.id, source.facts, source.needsFullDiskAccess, t)}</div>
								{on ? (
									<div className="source-description">
										<textarea
											value={choice?.description ?? ""}
											onChange={(e) => ctx.setSourceDescription(source.id, e.target.value)}
										/>
										<footer>
											<span className="draft">✦ {t("onboarding.sources.draftNote")}</span>
											<button type="button" onClick={() => ctx.rewriteSource(source.id)}>
												<Icon name="wand-sparkles" size={11} /> {t("onboarding.sources.rewrite")}
											</button>
										</footer>
									</div>
								) : null}
							</div>
							<Switch
								on={on}
								disabled={needsPermission}
								label={t(`onboarding.sources.name.${source.id}`)}
								onClick={() => ctx.setSourceOn(source.id, !on)}
							/>
						</div>
					);
				})}
			</div>
			<div className="connect-more">
				{t("onboarding.sources.connectMore")}
				<div className="more-chips">
					{EXTRA_BRANDS.map((brand) => (
						<BrandChip key={brand.brand} brand={brand.brand} label={brand.label} />
					))}
				</div>
			</div>
		</SplitScreen>
	);
}
