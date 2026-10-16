/** Step 5 — embedding location: local on this device, or Dazzi cloud when signed in. */

import type { ReactElement } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen, openExternal } from "../parts";
import { canSelectCloudEmbedding, etaMinutes, formatSize, scanTotals } from "../flow";
import { accountLegalUrl } from "../../../../shared/account-contract";
import type { OnboardingCtx } from "../context";

export function EmbeddingStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, scans, embedding, platform, account } = ctx;
	const selected = draft.folders.filter((f) => f.selected).map((f) => f.path);
	const totals = scanTotals(selected, scans);
	const localEta = etaMinutes(totals.files, "local");
	const cloudEta = etaMinutes(totals.files, "cloud");
	const cloudAvailable = canSelectCloudEmbedding(account);
	const embedMode = cloudAvailable && draft.embed === "cloud" ? "cloud" : "local";
	const cloudConsent = draft.cloudConsent === true;
	const download =
		embedding === null
			? t("onboarding.embedding.downloadUnknown")
			: embedding.cached
				? t("onboarding.embedding.cached")
				: formatSize(embedding.modelBytes);

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="lock" warn>
						{t("onboarding.embedding.eyebrow")}
					</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.embedding.title")} />
					</h1>
					<p>{t("onboarding.embedding.lead")}</p>
					<div className="copy-stat">
						<strong>{t("onboarding.embedding.files", { count: totals.files.toLocaleString() })}</strong>
						<span>{t("onboarding.embedding.selectedFiles")}</span>
						<span>·</span>
						<strong>{formatSize(totals.bytes)}</strong>
					</div>
					<div className="reindex-note">
						<Icon name="triangle-alert" size={13} />
						<span>{t("onboarding.embedding.reindexNote")}</span>
					</div>
				</>
			}
		>
			<div className="embed-wrap">
				<div className="embed-cards">
					<div
						className={cn("embed-card", embedMode === "local" && "selected")}
						onClick={() => ctx.setEmbedMode("local")}
					>
						<div className="embed-icon">
							<Icon name="laptop" size={19} />
						</div>
						<h3>{t("onboarding.embedding.localTitle")}</h3>
						<p>{t("onboarding.embedding.localLead")}</p>
						<div className="metric-grid">
							<div className="metric">
								<small>{t("onboarding.embedding.metricTime")}</small>
								<b>{t("onboarding.embedding.minutes", { minutes: localEta })}</b>
							</div>
							<div className="metric">
								<small>{t("onboarding.embedding.metricDownload")}</small>
								<b>{download}</b>
							</div>
							<div className="metric">
								<small>{t("onboarding.embedding.metricPrivacy")}</small>
								<b>{t("onboarding.embedding.privacyLocal")}</b>
							</div>
						</div>
						<ul className="bullets">
							<li>{platform === "win32" ? t("onboarding.embedding.bulletGpuWindows") : t("onboarding.embedding.bulletGpuMac")}</li>
							<li>{t("onboarding.embedding.bulletPower")}</li>
						</ul>
					</div>
					<div
						className={cn("embed-card", embedMode === "cloud" && "selected", !cloudAvailable && "disabled")}
						aria-disabled={!cloudAvailable}
						onClick={() => {
							if (cloudAvailable) ctx.setEmbedMode("cloud");
						}}
					>
						<span className="recommended">{t("onboarding.embedding.cloudBadge")}</span>
						<div className="embed-icon">
							<Icon name="cloud" size={19} />
						</div>
						<h3>{t("onboarding.embedding.cloudTitle")}</h3>
						<p>{t("onboarding.embedding.cloudLead")}</p>
						<div className="metric-grid">
							<div className="metric">
								<small>{t("onboarding.embedding.metricTime")}</small>
								<b>{t("onboarding.embedding.minutes", { minutes: cloudEta })}</b>
							</div>
							<div className="metric">
								<small>{t("onboarding.embedding.metricStorage")}</small>
								<b>{t("onboarding.embedding.storageNone")}</b>
							</div>
							<div className="metric">
								<small>{t("onboarding.embedding.metricPlan")}</small>
								<b>{t("onboarding.embedding.planPro")}</b>
							</div>
						</div>
						<ul className="bullets">
							<li>{t("onboarding.embedding.cloudBulletPerf")}</li>
							<li>{t("onboarding.embedding.cloudBulletNoStore")}</li>
							<li>
								<button
									type="button"
									className="inline-link"
									onClick={(e) => {
										e.stopPropagation();
										openExternal(accountLegalUrl(ctx.account?.baseUrl, "privacyModels"));
									}}
								>
									{t("onboarding.embedding.privacyTable")}
								</button>
							</li>
						</ul>
					</div>
				</div>
				{embedMode === "cloud" ? (
					<label className="consent">
						<input
							type="checkbox"
							checked={cloudConsent}
							onChange={(e) => ctx.setCloudConsent(e.target.checked)}
						/>
						<span>{t("onboarding.embedding.cloudConsent")}</span>
					</label>
				) : null}
			</div>
		</SplitScreen>
	);
}
