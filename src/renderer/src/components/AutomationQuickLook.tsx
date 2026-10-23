/**
 * Quick Look for a rule: the prototype's `quickLook` panel, drawn inside the
 * renderer instead of a separate window (a rule has no file behind it, so
 * there is nothing for the OS preview window to read).
 *
 * The list view keeps the keyboard: this panel closes on its own button and on
 * a click on the scrim, and Escape or Space stay the list's business.
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from "../../../preview/ui/icons";
import type { AutomationRule } from "../../../shared/automation-contract";
import { cn } from "../lib/cn";
import { failReason, folderLabel, relativeTime, ruleTitle, runTone, triggerText, whatText } from "../state/automations";
import { AutomationActionGlyph } from "./AutomationInspector";
import { StatusDot } from "./primitives/StatusDot";

export interface AutomationQuickLookProps {
	readonly rule: AutomationRule;
	readonly onClose: () => void;
	readonly onEdit: (rule: AutomationRule) => void;
}

const TOOL_BUTTON =
	"grid place-items-center flex-none size-28 p-0 border-0 rounded-7 bg-transparent text-ql-ink-secondary cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-ql-button";

export function AutomationQuickLook({ rule, onClose, onEdit }: AutomationQuickLookProps): ReactElement {
	const { t } = useTranslation();
	const run = rule.lastRun;
	const tone = runTone(run);
	const failed = tone === "fail";
	return (
		<div
			className="fixed inset-0 z-70 flex items-center justify-center"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-label={ruleTitle(rule)}
				className="flex flex-col w-620 overflow-hidden rounded-[18px] bg-ql-panel text-ql-ink font-ql shadow-[var(--shadow-ql-panel),var(--shadow-window)] [backdrop-filter:var(--backdrop-ql-float)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
			>
				<header className="flex flex-none items-center gap-6 h-46 pl-12 pr-10">
					<button
						type="button"
						className={TOOL_BUTTON}
						aria-label={t("automations.quickLook.close")}
						title={t("automations.quickLook.close")}
						onClick={onClose}
					>
						<CloseIcon />
					</button>
					<div className="flex-1 min-w-0 ml-4" />
					<button
						type="button"
						className="flex-none h-28 ml-4 px-14 border-0 rounded-full bg-ql-button text-ql-ink text-[13px] font-medium whitespace-nowrap cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-ql-button-hover"
						onClick={() => onEdit(rule)}
					>
						{t("automations.quickLook.edit")}
					</button>
				</header>

				<div className="flex items-center gap-34 pt-4 pb-30 pl-44 pr-40">
					<span
						className={cn(
							"grid place-items-center flex-none size-132 rounded-[30px] bg-ql-paper shadow-ql-doc",
							failed ? "text-error-orange-dot" : "text-ql-accent",
						)}
					>
						<AutomationActionGlyph rule={rule} size={56} />
					</span>
					<div className="flex-1 min-w-0">
						<div className="mb-14 text-[22px] font-bold tracking-[-0.01em] leading-[1.25] [overflow-wrap:anywhere]">{ruleTitle(rule)}</div>
						<dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-12 gap-y-9 text-[14px] leading-[1.4]">
							<dt className="text-ql-ink-secondary">{t("automations.quickLook.when")}</dt>
							<dd className="m-0 [word-break:keep-all] [overflow-wrap:anywhere]">{triggerText(rule)}</dd>
							<dt className="text-ql-ink-secondary">{t("automations.quickLook.what")}</dt>
							<dd className="m-0 [word-break:keep-all] [overflow-wrap:anywhere]">{whatText(rule, { full: true })}</dd>
							<dt className="text-ql-ink-secondary">{t("automations.quickLook.folders")}</dt>
							<dd className="m-0 [word-break:keep-all] [overflow-wrap:anywhere]">{rule.paths.map(folderLabel).join(", ")}</dd>
						</dl>
						<div className={cn("flex items-center gap-6 mt-16 text-[12px]", failed ? "text-error-orange-text" : "text-ql-ink-secondary")}>
							{tone === "never" ? (
								<span className="flex-none size-dot rounded-full shadow-[inset_0_0_0_1.5px_var(--text-faint)]" aria-hidden="true" />
							) : (
								<StatusDot token={tone === "ok" ? "--ok-dot" : "--error-orange-dot"} />
							)}
							{run === null
								? t("automations.inspector.neverRan")
								: tone === "ok"
									? t("automations.inspector.ranOk", { time: relativeTime(run.startedAt) })
									: t("automations.quickLook.ranFail", { time: relativeTime(run.startedAt), reason: failReason(run) })}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
