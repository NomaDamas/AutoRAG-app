/**
 * 자동화 on a phone: the rules as an inset list with the background switch on
 * top, and one page per rule (언제 · 무엇을 · 마지막 실행) — the desktop's
 * table, inspector and Quick Look folded into the iOS list/detail pattern
 * (docs/prototypes/mobile-remote). Every word comes from the same
 * `state/automations.ts` helpers the desktop surfaces use, and every action
 * goes through the shared `useAutomationsShell`.
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Bot, FolderOpen, MessageCircle, Plus, Trash2, Zap } from "lucide-react";
import type { AutomationRule, AutomationsSnapshot } from "../../../shared/automation-contract";
import { agentAccessText, failReason, foldersText, folderLabel, lastRunText, relativeTime, ruleTitle, runTone, triggerText, whatText } from "../state/automations";
import { cn } from "../lib/cn";
import { Cell, LargeTitle, Section, Switch } from "./parts";

function StatusDot({ rule }: { readonly rule: AutomationRule }): ReactElement {
	return <span className={cn("phone-dot", `is-${runTone(rule.lastRun)}`)} aria-hidden="true" />;
}

/** The 자동화 tab root: background switch, then one cell per rule. */
export function RulesBody({ state, daemonBusy, onSetDaemon, onOpen, onAdd }: {
	readonly state: AutomationsSnapshot;
	readonly daemonBusy: boolean;
	readonly onSetDaemon: (enabled: boolean) => void;
	readonly onOpen: (rule: AutomationRule) => void;
	readonly onAdd: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const running = state.daemon?.running === true;
	const daemonText = state.daemon === null ? t("automations.daemon.unknown") : running ? t("automations.daemon.on") : t("automations.daemon.off");
	return (
		<>
			<LargeTitle title={t("mobile.tabs.automations")} />
			{state.rules.length === 0 && state.daemon === null ? null : (
				<div className="phone-daemon" data-testid="phone-daemon">
					<div>
						<b>{daemonBusy ? t("automations.daemon.busy") : daemonText}</b>
						<small>{t("automations.daemon.count", { count: state.rules.length })}</small>
					</div>
					<Switch checked={running} label={t("mobile.rules.daemonToggle")} disabled={daemonBusy || state.daemon === null} onChange={onSetDaemon} />
				</div>
			)}
			{state.error === null ? null : <div className="phone-notice is-warn" role="alert">{state.error}</div>}
			{state.configError !== null ? (
				<div className="phone-empty">
					<b>{t("automations.errors.config")}</b>
					<span className="phone-selectable">{state.configError}</span>
					<span>{t("automations.errors.configHint")}</span>
				</div>
			) : !state.ready ? (
				<div className="phone-empty">{t("mobile.loading")}</div>
			) : state.rules.length === 0 ? (
				<div className="phone-empty">
					<b>{t("automations.empty.title")}</b>
					<span>{t("automations.empty.body")}</span>
					<button type="button" className="phone-big-btn" onClick={onAdd}>{t("automations.empty.add")}</button>
				</div>
			) : (
				<Section title={t("mobile.rules.section")} foot={t("mobile.rules.foot")}>
					{state.rules.map((rule) => (
						<Cell
							key={rule.id}
							icon={<StatusDot rule={rule} />}
							title={ruleTitle(rule)}
							subtitle={`${foldersText(rule.paths)} · ${lastRunText(rule)}`}
							onClick={() => onOpen(rule)}
							testId="phone-rule"
						/>
					))}
					<Cell icon={<Plus size={20} strokeWidth={2.2} />} title={t("automations.menu.add")} tone="accent" chevron={false} onClick={onAdd} />
				</Section>
			)}
		</>
	);
}

/** One rule's page: when it runs, what it does, its last run, and the edit / delete actions. */
export function RuleBody({ rule, onOpenFolder, onEdit, onDelete }: {
	readonly rule: AutomationRule;
	readonly onOpenFolder: (path: string) => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const run = rule.lastRun;
	const tone = runTone(run);
	const access = agentAccessText(rule);
	const command = rule.agent === undefined ? rule.run.join(" ") : null;
	return (
		<>
			<LargeTitle wrap title={ruleTitle(rule)} subtitle={<><StatusDot rule={rule} />{lastRunText(rule)}</>} />
			<Section title={t("automations.inspector.when")}>
				{rule.paths.map((path) => (
					<Cell key={path} icon={<FolderOpen size={20} strokeWidth={2} />} title={folderLabel(path)} subtitle={path} onClick={() => onOpenFolder(path)} />
				))}
				<Cell icon={<Zap size={20} strokeWidth={2} />} title={triggerText(rule)} subtitle={rule.include.length === 0 ? undefined : rule.include.join(", ")} />
				{rule.exclude.length === 0 ? null : <Cell title={t("automations.inspector.excluded")} subtitle={rule.exclude.join(", ")} />}
			</Section>
			<Section title={t("automations.inspector.what")}>
				<Cell icon={rule.agent === undefined ? <Zap size={20} strokeWidth={2} /> : <Bot size={20} strokeWidth={2} />} title={whatText(rule, { full: true })} subtitle={access ?? undefined} />
				{command === null || command.length === 0 ? null : <div className="phone-mono">{command}</div>}
			</Section>
			<Section title={t("automations.columns.lastRun")}>
				{run === null ? (
					<Cell title={t("automations.inspector.neverRan")} />
				) : (
					<Cell
						icon={<StatusDot rule={rule} />}
						title={tone === "ok" ? t("automations.inspector.ranOk", { time: relativeTime(run.startedAt) }) : t("automations.inspector.ranFail", { time: relativeTime(run.startedAt) })}
						subtitle={tone === "fail" ? failReason(run) : undefined}
					/>
				)}
			</Section>
			<div className="phone-btn-row">
				<button type="button" className="is-primary" onClick={onEdit}><MessageCircle size={18} strokeWidth={2.2} />{t("automations.quickLook.edit")}</button>
				<button type="button" className="is-danger" onClick={onDelete}><Trash2 size={18} strokeWidth={2.2} />{t("automations.inspector.delete")}</button>
			</div>
			<div className="phone-list-foot phone-selectable">{t("automations.inspector.ruleId")} · {rule.id}</div>
		</>
	);
}
