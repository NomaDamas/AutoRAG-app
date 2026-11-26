/**
 * The automation a chat answer quietly suggests (Figma 672:3658 → 672:3678 → 672:3698), under the answer:
 * - first a line on a soft aurora (the same glow the app puts behind what Dazzi makes): what an automation could do,
 *   만들기 and 나중에;
 * - 만들기 opens the card the suggestion fills in, to change and 추가하기 (nothing is written before that);
 * - once it is written, one line says so, with 보기 to the 자동화 side.
 */

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationDraft } from "../../../shared/automation-contract";
import type { LocaleKey } from "../../../shared/i18n/core";
import { AutomationSuggestionCard } from "./AutomationsView";
import { CheckIcon, ZapIcon } from "./icons";
import type { SuggestableTemplate } from "../state/automation-suggest";

export type NudgePhase = "nudge" | "confirm" | "created";

export function AutomationNudge({
	template,
	phase,
	onPhase,
	onLater,
	onCreate,
	onView,
	narrow = false,
}: {
	readonly template: SuggestableTemplate;
	readonly phase: NudgePhase;
	readonly onPhase: (phase: NudgePhase) => void;
	readonly onLater: () => void;
	readonly onCreate: (draft: AutomationDraft) => Promise<boolean>;
	/** 보기, to the 자동화 side; absent where the chat already sits beside it (the 자동화 side's own column). */
	readonly onView?: (() => void) | undefined;
	/** The sidebar's column: the card stacks 언제 over 할 일, and the line wraps under its words. */
	readonly narrow?: boolean;
}): ReactElement {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	if (phase === "created") {
		return (
			<div className="flex max-w-[480px] items-center gap-8 rounded-12 bg-window px-14 py-8" data-automation-nudge="created">
				<CheckIcon size={13} className="flex-none text-ok-text" />
				<span className="min-w-0 flex-1 text-meta leading-[18px] text-ink">{t("automations.nudge.created")}</span>
				{onView === undefined ? null : (
					<button type="button" className="inline-flex h-26 flex-none items-center rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink cursor-pointer hover:bg-hover" onClick={onView}>
						{t("automations.nudge.view")}
					</button>
				)}
			</div>
		);
	}
	if (phase === "confirm") {
		return (
			<div className="flex flex-col gap-8" data-automation-nudge="confirm">
				<p className={narrow ? "m-0 text-sm leading-[1.5] text-ink-body" : "m-0 text-body leading-[1.55] text-ink"}>{t("automations.nudge.lead")}</p>
				<div className="max-w-[440px]">
					<AutomationSuggestionCard
						templateId={template}
						narrow={narrow}
						onCancel={onLater}
						onCreate={async (draft) => {
							if (busy) return false;
							setBusy(true);
							const ok = await onCreate(draft);
							setBusy(false);
							if (ok) onPhase("created");
							return ok;
						}}
					/>
				</div>
			</div>
		);
	}
	return (
		// The glow is kept low here (a third of the composer's): the line is an offer, not a call to act.
		<div className="ai-glow-host max-w-[560px] [--ai-glow-opacity:0.24] [--ai-glow-blur:14px]" data-ai-glow data-automation-nudge="nudge">
			<div className="ai-glow ai-glow-warm" aria-hidden="true" />
			<div className={narrow ? "relative flex flex-wrap items-center gap-x-10 gap-y-6 rounded-10 bg-window py-8 pr-8 pl-12" : "relative flex items-center gap-10 rounded-10 bg-window py-7 pr-8 pl-14"}>
				<ZapIcon size={13} className="flex-none text-accent" />
				<span className={narrow ? "min-w-0 flex-[1_1_70%] text-meta leading-[18px] text-ink-body" : "min-w-0 flex-1 text-meta leading-[18px] text-ink-body"}>{t(`automations.nudge.${template}` as LocaleKey)}</span>
				<button type="button" data-action="automation-nudge-make" className="inline-flex h-26 flex-none items-center rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink cursor-pointer hover:bg-hover" onClick={() => onPhase("confirm")}>
					{t("automations.nudge.make")}
				</button>
				<button type="button" data-action="automation-nudge-later" className="flex-none border-0 bg-transparent px-4 text-meta text-ink-muted cursor-pointer hover:text-ink" onClick={onLater}>
					{t("automations.nudge.later")}
				</button>
			</div>
		</div>
	);
}
