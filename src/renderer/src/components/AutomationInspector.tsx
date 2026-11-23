/**
 * The automations view's right column (Figma 611:3601, 611:4443). With nothing picked it is the tab's recent activity:
 * how many rules there are and whether the background service runs them, a box naming any rule whose last run failed,
 * and every rule's last run, newest first. With a rule picked it says when the rule runs, what Dazzi does, its last
 * run, and offers 수정 (an AI Search draft) and 삭제.
 *
 * Every sentence comes from `state/automations`; this file only lays them out.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule, AutomationsSnapshot } from "../../../shared/automation-contract";
import type { FsEntry } from "../../../shared/fs-contract";
import { agentAccessText, failReason, relativeTime, ruleTitle, runTone, whatText, whenText } from "../state/automations";
import { RunDot } from "./AutomationsView";
import { CircleXIcon, FileIcon, RefreshIcon, SparklesIcon, ZapIcon } from "./icons";

export interface AutomationInspectorProps {
	readonly rule: AutomationRule | null;
	/** The tab's rules and service, for the recent activity shown while no rule is picked. */
	readonly state?: AutomationsSnapshot;
	/** The rule the 새 자동화 card is making; shown while no rule is picked. */
	readonly draft?: AutomationRule | null;
	readonly onEdit: (rule: AutomationRule) => void;
	readonly onDelete: (rule: AutomationRule) => void;
	/** A row of 최근 실행: pick its rule. */
	readonly onSelect?: (id: string) => void;
}

/** A rule's action as its glyph: the search index refresh, an AI Search run, or any other program. */
export function AutomationActionGlyph({ rule, size = 20 }: { readonly rule: AutomationRule; readonly size?: number }): ReactElement {
	if (rule.agent !== undefined) return <SparklesIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "refresh") return <RefreshIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "search") return <SparklesIcon size={size} />;
	return <ZapIcon size={size} />;
}

/** "완료" after a clean run, else why it failed ("시간 초과"). */
function runResult(rule: AutomationRule): string {
	const run = rule.lastRun;
	if (run === null) return "";
	return runTone(run) === "ok" ? "" : failReason(run);
}

/** One line of 최근 실행: the dot, what ran and how it ended, and when. */
function RunRow({ rule, named, onClick }: { readonly rule: AutomationRule; readonly named: boolean; readonly onClick?: (() => void) | undefined }): ReactElement | null {
	const { t } = useTranslation();
	const run = rule.lastRun;
	if (run === null) return null;
	const result = runResult(rule);
	const text = named ? [ruleTitle(rule), result].filter((part) => part.length > 0).join(" · ") : result.length > 0 ? result : t("automations.inspector.runDone");
	const body = (
		<>
			<RunDot tone={runTone(run)} />
			<span className="min-w-0 flex-1 truncate text-meta leading-[18px] text-ink">{text}</span>
			<span className="flex-none text-badge leading-[17px] text-ink-muted">{relativeTime(run.startedAt)}</span>
		</>
	);
	return onClick === undefined ? (
		<div className="flex items-center gap-8 py-4" data-run-row={rule.id}>{body}</div>
	) : (
		<button type="button" className="flex w-full items-center gap-8 border-0 bg-transparent px-0 py-4 text-left cursor-pointer" data-run-row={rule.id} onClick={onClick}>
			{body}
		</button>
	);
}

function Caption({ children }: { readonly children: ReactNode }): ReactElement {
	return <span className="text-badge leading-[17px] text-ink-muted">{children}</span>;
}

function Activity({ state, onSelect }: { readonly state: AutomationsSnapshot; readonly onSelect?: ((id: string) => void) | undefined }): ReactElement {
	const { t } = useTranslation();
	const running = state.daemon?.running === true;
	const failed = state.rules.filter((rule) => runTone(rule.lastRun) === "fail");
	const ran = state.rules.filter((rule) => rule.lastRun !== null).sort((a, b) => (b.lastRun?.startedAt ?? 0) - (a.lastRun?.startedAt ?? 0));
	const first = failed[0];
	return (
		<div className="flex flex-col gap-16" data-automation-activity>
			<div className="flex flex-col gap-8">
				<span className="text-meta leading-[16px] text-ink-muted">
					{[
						t("automations.daemon.count", { count: state.rules.length }),
						state.daemon === null ? null : running ? t("automations.daemon.on") : t("automations.inspector.serviceOff"),
					]
						.filter((part) => part !== null)
						.join(" · ")}
				</span>
				{first === undefined ? null : (
					<div className="flex items-center gap-6 rounded-8 border border-divider bg-window px-10 py-8" data-automation-failures>
						<span className="flex flex-none text-danger-text">
							<CircleXIcon />
						</span>
						<span className="min-w-0 flex-1 text-meta leading-[18px] text-ink">
							{t("automations.inspector.failedRules", { count: failed.length, name: ruleTitle(first) })}
						</span>
					</div>
				)}
			</div>
			<div className="flex flex-col gap-4">
				<Caption>{t("automations.inspector.recentRuns")}</Caption>
				{ran.length === 0 ? (
					<span className="text-meta leading-[18px] text-ink-muted">{t("automations.inspector.noRuns")}</span>
				) : (
					<div className="flex flex-col">
						{ran.map((rule) => (
							<RunRow key={rule.id} rule={rule} named onClick={onSelect === undefined ? undefined : () => onSelect(rule.id)} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** Shown at most in the list of files the rule would take now. */
const MATCHES_SHOWN = 3;

/** Whether a file is one the rule's `include` takes: every file, or one of its extension patterns. */
function takes(rule: AutomationRule, entry: FsEntry): boolean {
	if (entry.kind !== "file") return false;
	if (rule.include.length === 0) return true;
	return rule.include.some((pattern) => /\*\.([A-Za-z0-9]+)$/.exec(pattern)?.[1]?.toLowerCase() === entry.ext);
}

/**
 * The rule the 새 자동화 card is making (Figma 611:4016): its sentence, and the files already in its folder that it
 * would take, newest first, so the person sees what the rule is about before making it.
 */
function DraftBody({ rule }: { readonly rule: AutomationRule }): ReactElement {
	const { t } = useTranslation();
	const folder = rule.paths[0] ?? null;
	const [matches, setMatches] = useState<readonly FsEntry[] | null>(null);
	const includeKey = rule.include.join("|");
	useEffect(() => {
		let live = true;
		setMatches(null);
		if (folder === null) return;
		void window.autorag?.fs
			?.listDir(folder)
			.then((listing) => {
				if (live) setMatches(listing.entries.filter((entry) => takes(rule, entry)).sort((a, b) => b.mtimeMs - a.mtimeMs));
			})
			.catch(() => {
				if (live) setMatches([]);
			});
		return () => {
			live = false;
		};
		// The folder and the kinds decide the files; the instruction does not.
	}, [folder, includeKey]);
	const task = rule.agent?.task ?? "";
	return (
		<div className="flex flex-col gap-16" data-automation-draft>
			<div className="flex flex-col gap-6">
				<Caption>{t("automations.inspector.draftRule")}</Caption>
				<div className="flex flex-col text-[13px] leading-[21px] text-ink [overflow-wrap:anywhere]">
					<span>{whenText(rule)}</span>
					{rule.agent === undefined ? <span>{whatText(rule, { full: true })}</span> : task.length === 0 ? null : <span>{t("automations.inspector.agentDoes", { task })}</span>}
				</div>
			</div>
			{matches === null ? null : (
				<div className="flex flex-col gap-6" data-automation-matches>
					<Caption>{matches.length === 0 ? t("automations.inspector.noMatches") : t("automations.inspector.matches", { count: matches.length })}</Caption>
					<div className="flex flex-col">
						{matches.slice(0, MATCHES_SHOWN).map((entry) => (
							<div key={entry.path} className="flex items-center gap-8 py-4" data-match={entry.name}>
								<span className="flex flex-none text-ink-muted">
									<FileIcon size={13} />
								</span>
								<span className="min-w-0 flex-1 truncate text-meta leading-[18px] text-ink">{entry.name}</span>
								<span className="flex-none text-badge leading-[17px] text-ink-muted">{relativeTime(entry.mtimeMs)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function RuleBody({ rule, onEdit, onDelete }: { readonly rule: AutomationRule; readonly onEdit: (rule: AutomationRule) => void; readonly onDelete: (rule: AutomationRule) => void }): ReactElement {
	const { t } = useTranslation();
	const access = agentAccessText(rule);
	return (
		<div className="flex flex-col gap-16" data-automation-rule={rule.id}>
			<h2 className="m-0 text-body font-bold leading-[21px] text-ink [overflow-wrap:anywhere]">{ruleTitle(rule)}</h2>
			<div className="flex flex-col gap-12">
				<div className="flex flex-col gap-4">
					<Caption>{t("automations.inspector.when")}</Caption>
					<span className="text-meta leading-[18px] text-ink [overflow-wrap:anywhere]">{whenText(rule)}</span>
				</div>
				<div className="flex flex-col gap-4">
					<Caption>{t("automations.create.task")}</Caption>
					<span className="text-meta leading-[18px] text-ink [overflow-wrap:anywhere]">{whatText(rule, { full: true })}</span>
					{access === null ? null : <span className="text-badge leading-[17px] text-ink-muted">{access}</span>}
				</div>
			</div>
			<div className="flex flex-col gap-4">
				<Caption>{t("automations.inspector.recentRuns")}</Caption>
				{rule.lastRun === null ? <span className="text-meta leading-[18px] text-ink-muted">{t("automations.inspector.neverRan")}</span> : <RunRow rule={rule} named={false} />}
			</div>
			<div className="flex items-center gap-6">
				<button type="button" data-action="automation-edit" className="linear-btn h-28 px-10 text-meta font-medium" onClick={() => onEdit(rule)}>
					{t("automations.inspector.menuEdit")}
				</button>
				<button
					type="button"
					data-action="automation-delete"
					className="inline-flex h-28 items-center rounded-6 border-0 bg-danger-dot px-10 text-meta font-medium text-on-accent cursor-pointer hover:opacity-80"
					onClick={() => onDelete(rule)}
				>
					{t("automations.inspector.delete")}
				</button>
			</div>
		</div>
	);
}

export function AutomationInspector({ rule, state, draft = null, onEdit, onDelete, onSelect }: AutomationInspectorProps): ReactElement {
	const { t } = useTranslation();
	return (
		<aside className="inspector w-full min-w-0 flex-1 min-h-0 flex flex-col bg-subtle overflow-hidden" aria-label={t("finderComponents.inspectorAside")}>
			<div className="inspector-body flex-1 min-h-0 overflow-auto px-16 pt-18 pb-24">
				{rule !== null ? (
					<RuleBody key={rule.id} rule={rule} onEdit={onEdit} onDelete={onDelete} />
				) : draft !== null ? (
					<DraftBody rule={draft} />
				) : state === undefined || !state.ready ? (
					<div className="flex h-full items-center justify-center px-10 text-center text-sm text-ink-muted leading-body whitespace-pre-line">{t("automations.inspector.empty")}</div>
				) : (
					<Activity state={state} onSelect={onSelect} />
				)}
			</div>
		</aside>
	);
}
