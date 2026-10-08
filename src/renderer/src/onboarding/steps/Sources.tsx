/** Step 6 — connectors the app found usable, streamed in as each probe finishes. */

import type { ReactElement } from "react";
import { Icon } from "../marks";
import { BrandChip, Eyebrow, Multiline, SourceIcon, SplitScreen, Switch } from "../parts";
import { connectableLater, sourceDetail } from "../flow";
import type { OnboardingCtx } from "../context";

export function SourcesStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, sources, sourcesChecking, draft } = ctx;
	// Brands the user can still connect later: everything the probes did not find.
	const more = connectableLater(sources);

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="plug-zap">{t("onboarding.sources.eyebrow")}</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.sources.title")} />
					</h1>
					<p>{t("onboarding.sources.lead")}</p>
				</>
			}
		>
			<div className="source-list">
				{sources.map((source) => {
					const on = draft.sources.find((s) => s.id === source.id)?.on === true;
					return (
						<div key={source.id} className="source-row" data-source-id={source.id}>
							<SourceIcon id={source.id} />
							<div className="source-main">
								<div className="source-name">
									{t(`onboarding.sources.name.${source.id}`)} <span className="tag">{t("onboarding.sources.detected")}</span>
								</div>
								<div className="source-detail">{sourceDetail(source.id, source.facts, t)}</div>
							</div>
							<Switch
								on={on}
								label={t(`onboarding.sources.name.${source.id}`)}
								onClick={() => ctx.setSourceOn(source.id, !on)}
							/>
						</div>
					);
				})}
			</div>
			{sourcesChecking ? (
				<div className="sources-checking" role="status" data-sources-checking>
					<Icon name="loader-circle" size={13} className="spin" />
					<span>{t("onboarding.sources.checking")}</span>
				</div>
			) : (
				<div className="connect-more" data-sources-done>
					{sources.length === 0 ? <div className="sources-empty">{t("onboarding.sources.empty")}</div> : null}
					{more.length > 0 ? (
						<>
							{t("onboarding.sources.connectMore")}
							<div className="more-chips">
								{more.map((brand) => (
									<BrandChip key={brand.brand} brand={brand.brand} label={brand.label} />
								))}
							</div>
						</>
					) : null}
				</div>
			)}
		</SplitScreen>
	);
}
