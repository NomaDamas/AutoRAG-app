/**
 * The automations view's right column: one rule as the prototype's
 * `ruleInspector` draws it — its trigger → action on a 120px paper, the name a
 * person reads, the last run, the edit/delete chips, and the plain-language
 * summary with the machine fields behind 전체 정보.
 *
 * Every sentence comes from `state/automations`; this file only lays them out.
 * A null rule is the aside's empty state, exactly as the Info half shows it.
 */

import { useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule } from "../../../shared/automation-contract";
import { cn } from "../lib/cn";
import { actionShort, agentAccessText, failReason, foldersText, relativeTime, ruleTitle, runTone, whatText, whenText } from "../state/automations";
import { ChevronRightIcon, FolderGlyph, PencilIcon, RefreshIcon, SparklesIcon, TrashIcon, ZapIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

export interface AutomationInspectorProps {
	readonly rule: AutomationRule | null;
	readonly onEdit: (rule: AutomationRule) => void;
	readonly onDelete: (rule: AutomationRule) => void;
}

/** A rule's action as its glyph: the search index refresh, an AI Search run, or any other program. */
export function AutomationActionGlyph({ rule, size = 20 }: { readonly rule: AutomationRule; readonly size?: number }): ReactElement {
	if (rule.agent !== undefined) return <SparklesIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "refresh") return <RefreshIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "search") return <SparklesIcon size={size} />;
	return <ZapIcon size={size} />;
}

export function AutomationInspector({ rule, onEdit, onDelete }: AutomationInspectorProps): ReactElement {
	const { t } = useTranslation();
	return (
		<aside
			className="inspector w-full min-w-0 h-full flex flex-col bg-subtle border-l border-border overflow-hidden"
			aria-label={t("finderComponents.inspectorAside")}
		>
			{rule === null ? (
				<div className="flex-1 flex items-center justify-center px-10 text-center text-sm text-ink-muted leading-body whitespace-pre-line">
					{t("automations.inspector.empty")}
				</div>
			) : (
				// Keyed by the rule: another rule opens collapsed, never inheriting this one's 전체 정보.
				<RuleBody key={rule.id} rule={rule} onEdit={onEdit} onDelete={onDelete} />
			)}
		</aside>
	);
}

function RuleBody({ rule, onEdit, onDelete }: { readonly rule: AutomationRule; readonly onEdit: (rule: AutomationRule) => void; readonly onDelete: (rule: AutomationRule) => void }): ReactElement {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const access = agentAccessText(rule);
	const run = rule.lastRun;
	const tone = runTone(run);
	const failed = tone === "fail";
	const dot =
		tone === "never" ? (
			<span className="flex-none size-dot rounded-full shadow-[inset_0_0_0_1.5px_var(--text-faint)]" aria-hidden="true" />
		) : (
			<StatusDot token={tone === "ok" ? "--ok-dot" : "--error-orange-dot"} />
		);

	return (
		<div className="inspector-body flex-1 min-h-0 overflow-auto px-16 pt-18 pb-24">
			<div className="preview-paper flex-none flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised h-120 mb-14">
				<div className="flex items-center gap-14">
					<div className="flex flex-col items-center gap-6 w-96 text-ink-body text-badge text-center">
						<span className="grid place-items-center w-40 h-40 rounded-10 bg-subtle text-ink-muted">
							<FolderGlyph size={22} />
						</span>
						<span className="max-w-full truncate">{foldersText(rule.paths)}</span>
					</div>
					<ChevronRightIcon className="text-ink-faint" />
					<div className="flex flex-col items-center gap-6 w-96 text-ink-body text-badge text-center">
						<span
							className={cn(
								"grid place-items-center w-40 h-40 rounded-10",
								failed ? "bg-error-orange-bg text-error-orange-text" : "bg-accent-soft text-accent",
							)}
						>
							<AutomationActionGlyph rule={rule} />
						</span>
						<span className="max-w-full truncate">{actionShort(rule)}</span>
					</div>
				</div>
			</div>

			<div className="preview-title text-body font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere]">{ruleTitle(rule)}</div>
			<div className={cn("preview-sub flex items-center gap-6 mt-4 text-meta", failed ? "text-error-orange-text" : "text-ink-muted")}>
				{dot}
				{run === null
					? t("automations.inspector.neverRan")
					: tone === "ok"
						? t("automations.inspector.ranOk", { time: relativeTime(run.startedAt) })
						: t("automations.inspector.ranFail", { time: relativeTime(run.startedAt) })}
			</div>

			<div className="chip-row flex flex-wrap gap-6 mt-12 mb-16">
				<Chip accent onClick={() => onEdit(rule)}>
					<PencilIcon size={12} />
					{t("automations.inspector.edit")}
				</Chip>
				<Chip onClick={() => onDelete(rule)}>
					<TrashIcon size={12} />
					{t("automations.inspector.delete")}
				</Chip>
			</div>

			<div className="info-section border-t border-border pt-12 mt-12">
				<div className="section-title flex items-center justify-between mb-6">
					<span className="text-meta font-semibold text-ink">{t("automations.inspector.summary")}</span>
					<button
						type="button"
						className="p-0 border-0 bg-transparent text-accent-text text-badge cursor-pointer"
						onClick={() => setExpanded((current) => !current)}
					>
						{expanded ? t("automations.inspector.showLess") : t("automations.inspector.showAll")}
					</button>
				</div>
				<dl className="m-0">
					<InfoRow label={t("automations.inspector.when")} value={whenText(rule)} />
					<InfoRow label={t("automations.inspector.what")} value={whatText(rule)} />
					{access === null ? null : <InfoRow label={t("automations.inspector.agentAccess")} value={access} />}
					{failed && run !== null ? <InfoRow label={t("automations.inspector.problem")} value={failReason(run)} failed /> : null}
					{expanded ? (
						<>
							<InfoRow label={t("automations.inspector.watchedFolders")} value={rule.paths.join("\n")} stacked />
							<InfoRow label={t("automations.inspector.patterns")} value={rule.include.join(", ")} />
							<InfoRow
								label={t("automations.inspector.excluded")}
								value={rule.exclude.length === 0 ? t("automations.inspector.none") : rule.exclude.join(", ")}
							/>
							{rule.agent === undefined ? (
								<InfoRow label={t("automations.inspector.command")} value={rule.run.join(" ")} mono />
							) : (
								<InfoRow label={t("automations.inspector.agentProfile")} value={rule.agent.profile} mono />
							)}
							<InfoRow label={t("automations.inspector.ruleId")} value={rule.id} />
						</>
					) : null}
				</dl>
			</div>
		</div>
	);
}

/** The Info half's pill button, with the accent the edit chip carries. */
function Chip({ accent = false, onClick, children }: { readonly accent?: boolean; readonly onClick: () => void; readonly children: ReactNode }): ReactElement {
	return (
		<button
			type="button"
			className={cn(
				"inline-flex items-center gap-4 h-pill px-8 rounded-full border border-border bg-window text-badge font-semibold whitespace-nowrap cursor-pointer transition-[border-color] duration-(--dur-color) ease-[ease] hover:border-border-strong",
				accent ? "text-accent-text" : "text-ink-body",
			)}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

/**
 * One row of the Info half's `<dl>`. `stacked` keeps the value's own line
 * breaks (one watched folder per line), `mono` is the command's typeface, and
 * `failed` paints the reason the way an error is painted.
 */
function InfoRow({
	label,
	value,
	stacked = false,
	mono = false,
	failed = false,
}: {
	readonly label: string;
	readonly value: string;
	readonly stacked?: boolean;
	readonly mono?: boolean;
	readonly failed?: boolean;
}): ReactElement {
	return (
		<div className="flex justify-between gap-8 py-3 text-meta">
			<dt className="flex-none text-ink-muted">{label}</dt>
			<dd
				className={cn(
					"m-0 min-w-0 text-right [overflow-wrap:anywhere]",
					stacked && "whitespace-pre-line",
					mono && "font-mono text-badge",
					failed ? "text-error-orange-text" : "text-ink",
				)}
			>
				{value}
			</dd>
		</div>
	);
}
