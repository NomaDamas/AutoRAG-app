/** Step 5 — local embedding (cloud is unavailable; its card renders disabled). */

import type { ReactElement } from "react";
import { Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen } from "../parts";
import { etaMinutes, formatSize, scanTotals } from "../flow";
import type { OnboardingCtx } from "../context";

export function EmbeddingStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, scans, embedding, platform } = ctx;
	const selected = draft.folders.filter((f) => f.selected).map((f) => f.path);
	const totals = scanTotals(selected, scans);
	const localEta = etaMinutes(totals.files, "local");
	const cloudEta = etaMinutes(totals.files, "cloud");
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
					<div className="embed-card selected">
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
					<div className="embed-card disabled" aria-disabled="true">
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
						</ul>
					</div>
				</div>
			</div>
		</SplitScreen>
	);
}
