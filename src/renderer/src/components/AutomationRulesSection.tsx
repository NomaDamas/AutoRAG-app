/**
 * The automations that watch the folder a person is looking at, in the Info
 * half's own idiom: a section header with the rule count, then one row per
 * rule (metrics follow the Versions rows). The row opens the rule; the status
 * dot gives way to the two icon buttons on hover or keyboard focus.
 *
 * The filtering happens at the call site — this renders the rules it is given.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule } from "../../../shared/automation-contract";
import { cn } from "../lib/cn";
import { lastRunText, ruleTitle, runTone } from "../state/automations";
import { PencilIcon, TrashIcon, ZapIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

export interface AutomationRulesSectionProps {
	readonly rules: readonly AutomationRule[];
	readonly onEdit: (rule: AutomationRule) => void;
	readonly onDelete: (rule: AutomationRule) => void;
	/** Right click on a row: its menu, at the pointer. Absent leaves the browser's menu alone. */
	readonly onMenu?: ((rule: AutomationRule, at: { readonly x: number; readonly y: number }) => void) | undefined;
}

const ICON_BUTTON =
	"grid place-items-center flex-none size-22 p-0 border-0 rounded-5 bg-transparent text-ink-muted cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:bg-hover-strong hover:text-ink";

export function AutomationRulesSection({ rules, onEdit, onDelete, onMenu }: AutomationRulesSectionProps): ReactElement | null {
	const { t } = useTranslation();
	if (rules.length === 0) return null;
	return (
		<div className="info-section border-t border-border pt-12 mt-12">
			<div className="section-title flex items-center justify-between mb-6">
				<span className="text-meta font-semibold text-ink">{t("automations.inspector.folderSection")}</span>
				<span className="inline-flex items-center h-[19px] px-6 rounded-full bg-input text-tile font-semibold text-ink-body">{rules.length}</span>
			</div>
			<div className="flex flex-col">
				{rules.map((rule) => (
					<RuleRow key={rule.id} rule={rule} onEdit={onEdit} onDelete={onDelete} onMenu={onMenu} />
				))}
			</div>
		</div>
	);
}

function RuleRow({
	rule,
	onEdit,
	onDelete,
	onMenu,
}: {
	readonly rule: AutomationRule;
	readonly onEdit: (rule: AutomationRule) => void;
	readonly onDelete: (rule: AutomationRule) => void;
	readonly onMenu: AutomationRulesSectionProps["onMenu"];
}): ReactElement {
	const { t } = useTranslation();
	const tone = runTone(rule.lastRun);
	return (
		<div
			role="button"
			tabIndex={0}
			className="rule-row group flex items-center gap-7 w-full min-h-26 px-5 py-3 rounded-5 border-0 bg-transparent text-left text-badge text-ink-body cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
			onClick={() => onEdit(rule)}
			onContextMenu={(event) => {
				if (onMenu === undefined) return;
				event.preventDefault();
				onMenu(rule, { x: event.clientX, y: event.clientY });
			}}
			onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onEdit(rule);
			}}
		>
			<span
				className={cn(
					"grid place-items-center flex-none size-16 rounded-4",
					tone === "fail" ? "bg-error-orange-bg text-error-orange-text" : "bg-accent-soft text-accent-text",
				)}
			>
				<ZapIcon />
			</span>
			<span className="flex-1 min-w-0">
				<span className="block truncate text-ink">{ruleTitle(rule)}</span>
				<span className="block truncate text-tile text-ink-muted">{lastRunText(rule)}</span>
			</span>
			<span className="group-hover:hidden group-focus-within:hidden">
				{tone === "never" ? (
					<span className="block size-dot rounded-full shadow-[inset_0_0_0_1.5px_var(--text-faint)]" aria-hidden="true" />
				) : (
					<StatusDot token={tone === "ok" ? "--ok-dot" : "--error-orange-dot"} />
				)}
			</span>
			<span className="hidden group-hover:flex group-focus-within:flex">
				<button
					type="button"
					className={ICON_BUTTON}
					aria-label={t("automations.inspector.edit")}
					title={t("automations.inspector.edit")}
					onClick={(event) => {
						event.stopPropagation();
						onEdit(rule);
					}}
				>
					<PencilIcon size={12} />
				</button>
				<button
					type="button"
					className={ICON_BUTTON}
					aria-label={t("automations.inspector.delete")}
					title={t("automations.inspector.delete")}
					onClick={(event) => {
						event.stopPropagation();
						onDelete(rule);
					}}
				>
					<TrashIcon size={12} />
				</button>
			</span>
		</div>
	);
}
