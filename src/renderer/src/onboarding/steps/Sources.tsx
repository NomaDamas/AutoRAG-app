/** Step 6 — connectors the app found usable, streamed in as each probe finishes (Figma 07 · sources). With none found the shell moves on by itself. */

import type { ReactElement } from "react";
import { Icon } from "../marks";
import { BrandChip, SourceIcon, Switch } from "../parts";
import { connectableLater, sourceDetail } from "../flow";
import { hostPlatform } from "../../lib/shortcuts";
import type { OnboardingCtx } from "../context";

export function SourcesStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, sources, sourcesChecking, draft } = ctx;
	// Brands the user can still connect later: everything the probes did not find.
	const more = connectableLater(sources, hostPlatform());

	return (
		<section className="screen sources-screen">
			<h1>{t("onboarding.sources.title")}</h1>
			<div className="source-list">
				{sources.map((source) => {
					const on = draft.sources.find((s) => s.id === source.id)?.on === true;
					return (
						<div key={source.id} className="source-row" data-source-id={source.id}>
							<SourceIcon id={source.id} />
							<div className="source-main">
								<div className="source-name">{t(`onboarding.sources.name.${source.id}`)}</div>
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
					{more.length > 0 ? (
						<>
							<div className="more-chips">
								{more.map((brand) => (
									<BrandChip key={brand.brand} brand={brand.brand} label={brand.label} />
								))}
							</div>
							<p>{t("onboarding.sources.connectMore")}</p>
						</>
					) : null}
				</div>
			)}
		</section>
	);
}
