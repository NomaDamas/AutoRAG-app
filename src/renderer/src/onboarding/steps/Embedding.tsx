/**
 * Step 5 — how documents become searchable: keyword only, embedded on this
 * machine, or embedded by Dazzi's server. A rule-for-rule port of the
 * prototype's `views.embedding` (centred screen, three radio cards compared on
 * the same two meters, and the cloud consent under the grid).
 */

import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { localSpecMessage } from "../../../../shared/local-embedding-spec";
import type { IndexFailureReason } from "../../../../shared/index-failure";
import { canSelectCloudEmbedding, embedCards, formatSize, localEmbeddingAllowed, resolveEmbed, scanTotals, type EmbedCard } from "../flow";
import type { OnboardingCtx } from "../context";
import { ModelDownloadPanel } from "../../components/ModelDownloadPanel";

/** The four pips every meter shows, whether or not they are lit. */
const PIPS = [1, 2, 3, 4];

/** Which line says why the index stopped when the user comes here to fix it. */
function pausedNoticeKey(reason: IndexFailureReason | undefined): "config" | "disk" | "default" {
	if (reason === "embedder-config") return "config";
	if (reason === "disk-full") return "disk";
	return "default";
}

export function EmbeddingStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, scans, embedding, platform, account } = ctx;
	const cloudAvailable = canSelectCloudEmbedding(account);
	const totals = scanTotals(
		draft.folders.filter((folder) => folder.selected).map((folder) => folder.path),
		scans,
	);
	const cards = embedCards({
		files: totals.files,
		platform,
		cloudAvailable,
		modelBytes: embedding === null ? null : embedding.modelBytes,
		modelCached: embedding?.cached === true,
		localSpec: embedding === null ? null : embedding.localSpec,
	});
	const selected = resolveEmbed(draft.embed, cloudAvailable, localEmbeddingAllowed(embedding === null ? null : embedding.localSpec));
	const listRef = useRef<HTMLDivElement | null>(null);
	// The consent card stays mounted while it fades out after the box is ticked, then goes.
	const [consentClosing, setConsentClosing] = useState(false);
	const consented = draft.cloudConsent === true;
	const showConsent = selected === "cloud" && (!consented || consentClosing);
	// Until main answers the first status read the size is unknown; the embedding info already carries it.
	const reported = ctx.modelDownload.status;
	const modelStatus =
		reported.bytesTotal > 0 || embedding === null
			? reported
			: { ...reported, bytesTotal: embedding.modelBytes, ...(embedding.cached ? { state: "ready" as const, bytesDone: embedding.modelBytes } : {}) };

	const choose = (card: EmbedCard): void => {
		if (card.blocked !== null) {
			// Say why the card cannot be chosen, instead of leaving a click that does nothing.
			ctx.toast(localSpecMessage(card.blocked, t));
		} else if (!card.disabled) {
			ctx.setEmbedMode(card.id);
		}
	};

	/** Arrow keys walk the group in card order, skipping a card the account cannot use. */
	const move = (from: EmbedCard, step: number): void => {
		let index = cards.indexOf(from);
		for (let hop = 0; hop < cards.length; hop += 1) {
			index = (index + step + cards.length) % cards.length;
			const next = cards[index];
			if (next !== undefined && !next.disabled) {
				ctx.setEmbedMode(next.id);
				listRef.current?.querySelector<HTMLDivElement>(`[data-value="${next.id}"]`)?.focus();
				return;
			}
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, card: EmbedCard): void => {
		const pick = (): void => {
			// The shell advances the step on Enter; a card consumes the key itself.
			event.preventDefault();
			event.stopPropagation();
		};
		if (event.key === "Enter" || event.key === " ") {
			pick();
			choose(card);
		} else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			pick();
			move(card, 1);
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			pick();
			move(card, -1);
		}
	};

	const renderCard = (card: EmbedCard): ReactElement => {
		const checked = card.id === selected;
		const download =
			card.foot === null
				? null
				: card.foot.kind === "size"
					? formatSize(card.foot.bytes)
					: t(card.foot.kind === "cached" ? "onboarding.embedding.cached" : "onboarding.embedding.downloadUnknown");
		return (
			<div
				key={card.id}
				role="radio"
				aria-checked={checked}
				aria-disabled={card.disabled}
				tabIndex={checked && !card.disabled ? 0 : -1}
				data-value={card.id}
				className={cn("em-card", checked && "selected", card.disabled && "disabled")}
				onClick={() => choose(card)}
				onKeyDown={(event) => onKeyDown(event, card)}
			>
				<span className="em-radio" />
				<div className="embed-icon">
					<Icon name={card.icon} size={24} />
				</div>
				<div className="em-title">
					<h3>{t(card.nameKey)}</h3>
					{card.tag === null ? null : <span className={cn("em-tag", card.tag.tone)}>{t(card.tag.labelKey)}</span>}
				</div>
				<p className="em-line">{t(card.lineKey)}</p>
				<div className="em-meters">
					{card.meters.map((meter) => (
						<div
							key={meter.labelKey}
							className={cn("em-meter", meter.tone)}
							aria-label={t("onboarding.embedding.meterAria", { label: t(meter.labelKey), value: t(meter.valueKey) })}
						>
							<span className="em-m-label">{t(meter.labelKey)}</span>
							<span className="em-pips" aria-hidden="true">
								{PIPS.map((pip) => (
									<i key={pip} className={pip <= meter.fill ? "on" : ""} />
								))}
							</span>
							<b>{t(meter.valueKey)}</b>
						</div>
					))}
				</div>
				<div className="em-foot">
					<span>{t("onboarding.embedding.prepTime")}</span>
					<span className="em-eta">
						<span className="em-about">{t("onboarding.embedding.about")}</span>
						<b>{t("onboarding.embedding.minutes", { minutes: card.minutes })}</b>
						{download === null ? null : (
							<>
								<span className="em-about">·</span>
								<span>{download}</span>
							</>
						)}
					</span>
				</div>
			</div>
		);
	};

	return (
		<section className="screen center em-screen">
			<div className="screen-copy">
				<h1>{t("onboarding.embedding.title")}</h1>
			</div>
			{draft.resumeAt === "indexing" ? (
				<div className="plan-callout warn" role="status">
					<Icon name="triangle-alert" size={14} />
					<span>{t(`onboarding.embedding.pausedNotice.${pausedNoticeKey(ctx.indexStatus?.failure?.reason)}`)}</span>
				</div>
			) : null}
			<div className="em-stack">
				<div ref={listRef} className="em-cards" role="radiogroup" aria-label={t("onboarding.embedding.groupLabel")}>
					{cards.map(renderCard)}
					{cards.map((card, index) =>
						card.blocked === null ? null : (
							<p key={card.id} className="em-blocked" data-for={card.id} style={{ gridColumn: index + 1 }}>
								{localSpecMessage(card.blocked, t)}
							</p>
						),
					)}
				</div>
				{showConsent ? (
					<label
						className={cn("em-consent", consented && consentClosing && "closing")}
						onAnimationEnd={(event) => {
							if (event.animationName === "onb-consent-out") setConsentClosing(false);
						}}
					>
						<span className="em-consent-text">{t("onboarding.embedding.cloudConsent")}</span>
						<span className="em-consent-check">
							<input
								type="checkbox"
								checked={consented}
								onChange={(event) => {
									setConsentClosing(event.target.checked);
									ctx.setCloudConsent(event.target.checked);
								}}
							/>
							<span className="em-box" aria-hidden="true">
								<Icon name="check" size={10} />
							</span>
							{t("onboarding.embedding.cloudConsentCheck")}
						</span>
					</label>
				) : null}
			</div>
			{selected === "local" && embedding?.localModel !== false ? (
				<div className="em-download">
					<ModelDownloadPanel
						status={modelStatus}
						t={t}
						onStart={ctx.modelDownload.start}
						onCancel={ctx.modelDownload.cancel}
					/>
				</div>
			) : null}
		</section>
	);
}
