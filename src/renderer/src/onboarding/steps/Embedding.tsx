/**
 * Step 5 — how documents become searchable: keyword only, embedded on this
 * machine, or embedded by Dazzi's server. A rule-for-rule port of the
 * prototype's `views.embedding` (centred screen, three radio cards compared on
 * the same two meters, and the cloud consent under the grid).
 */

import { useRef, type KeyboardEvent, type ReactElement } from "react";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow } from "../parts";
import { localSpecMessage } from "../../../../shared/local-embedding-spec";
import { canSelectCloudEmbedding, embedCards, formatSize, localEmbeddingAllowed, resolveEmbed, scanTotals, type EmbedCard } from "../flow";
import type { OnboardingCtx } from "../context";

/** The four pips every meter shows, whether or not they are lit. */
const PIPS = [1, 2, 3, 4];

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
					<Icon name={card.icon} size={19} />
				</div>
				<div className="em-title">
					<h3>{t(card.nameKey)}</h3>
					{card.tag === null ? null : <span className={cn("em-tag", card.tag.tone)}>{t(card.tag.labelKey)}</span>}
				</div>
				<p className="em-line">{t(card.lineKey)}</p>
				{card.blocked === null ? null : <p className="em-blocked">{localSpecMessage(card.blocked, t)}</p>}
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
					<b>{t("onboarding.embedding.minutes", { minutes: card.minutes })}</b>
					{download === null ? null : (
						<>
							<span>·</span>
							{download}
						</>
					)}
				</div>
			</div>
		);
	};

	return (
		<section className="screen center em-screen">
			<div className="screen-copy">
				<Eyebrow icon="search">{t("onboarding.embedding.eyebrow")}</Eyebrow>
				<h1>{t("onboarding.embedding.title")}</h1>
			</div>
			<div ref={listRef} className="em-cards" role="radiogroup" aria-label={t("onboarding.embedding.groupLabel")}>
				{cards.map(renderCard)}
			</div>
			{selected === "cloud" ? (
				<label className="consent em-consent">
					<input
						type="checkbox"
						checked={draft.cloudConsent === true}
						onChange={(event) => ctx.setCloudConsent(event.target.checked)}
					/>
					<span>{t("onboarding.embedding.cloudConsent")}</span>
				</label>
			) : null}
		</section>
	);
}
