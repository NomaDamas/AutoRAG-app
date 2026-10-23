/**
 * The 자동화 tab: every file-automation rule as a Finder-style row (name, watched
 * folder, last run, status dot) with a footer line for the background service.
 * It only draws and reports: the rules come from the shared store, editing opens
 * an AI Search draft, and delete asks before it removes anything.
 */

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule, AutomationsSnapshot } from "../../../shared/automation-contract";
import { cn } from "../lib/cn";
import { foldersText, relativeTime, ruleTitle, runTone, type RunTone } from "../state/automations";
import { ZapIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

/** Name | watched folder | last run | status: the one grid both the header and the rows use. */
const COLUMNS = "minmax(0,1fr) 150px 120px 48px";

export interface AutomationsViewProps {
	readonly state: AutomationsSnapshot;
	readonly daemonBusy: boolean;
	readonly selectedId: string | null;
	readonly onSelect: (id: string) => void;
	/** Double click or Enter: open an AI Search draft to edit the rule. */
	readonly onEdit: (id: string) => void;
	readonly onAdd: () => void;
	readonly onPreview: (id: string) => void;
	readonly onAskDelete: (id: string) => void;
	readonly onSetDaemon: (enabled: boolean) => void;
	/** Right click on a row (`id`) or on the empty space (`null`), at the pointer. */
	readonly onContextMenu: (id: string | null, at: { readonly x: number; readonly y: number }) => void;
	readonly onOpenFolder: (path: string) => void;
}

const TONE_DOT: Readonly<Record<RunTone, string>> = {
	ok: "--ok-dot",
	fail: "--error-orange-dot",
	never: "--text-faint",
};

/** The status dot: green after a clean run, orange after a failure, a hollow ring before any run. */
function RunDot({ tone, onAccent }: { readonly tone: RunTone; readonly onAccent: boolean }): ReactElement {
	if (tone === "never") {
		return (
			<span
				data-run-tone={tone}
				className={cn("flex-none size-dot rounded-full", onAccent ? "shadow-[inset_0_0_0_1.5px_var(--text-on-accent)]" : "shadow-[inset_0_0_0_1.5px_var(--text-faint)]")}
				aria-hidden="true"
			/>
		);
	}
	return (
		<span data-run-tone={tone} className="flex">
			{onAccent ? <span className="flex-none size-dot rounded-full bg-on-accent" aria-hidden="true" /> : <StatusDot token={TONE_DOT[tone]} />}
		</span>
	);
}

function RuleRow({
	rule,
	selected,
	onSelect,
	onEdit,
	onContextMenu,
}: {
	readonly rule: AutomationRule;
	readonly selected: boolean;
	readonly onSelect: (id: string) => void;
	readonly onEdit: (id: string) => void;
	readonly onContextMenu: AutomationsViewProps["onContextMenu"];
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const tone = runTone(rule.lastRun);
	// The arrow keys move the selection in the parent; the row follows it into view.
	useEffect(() => {
		if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
	}, [selected]);
	const muted = selected ? "text-on-accent" : "text-ink-muted";
	return (
		<div
			ref={ref}
			role="row"
			aria-selected={selected}
			data-rule-id={rule.id}
			className={cn(
				"row grid gap-8 items-center h-file-row px-13 select-none cursor-default [&>*]:min-w-0 [&>*]:overflow-hidden [&>*]:whitespace-nowrap [&>*]:text-ellipsis",
				selected ? "bg-accent text-on-accent" : "text-ink odd:bg-window even:bg-row-alt hover:bg-hover-row",
			)}
			style={{ gridTemplateColumns: COLUMNS }}
			onClick={() => onSelect(rule.id)}
			onDoubleClick={() => onEdit(rule.id)}
			onContextMenu={(event: ReactMouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				onContextMenu(rule.id, { x: event.clientX, y: event.clientY });
			}}
		>
			<div className="flex items-center gap-7" role="gridcell">
				<span className="flex-none w-[13px]" aria-hidden="true" />
				<span
					className={cn(
						"flex-none grid place-items-center size-16 rounded-4",
						selected ? "bg-on-accent/20 text-on-accent" : tone === "fail" ? "bg-error-orange-bg text-error-orange-text" : "bg-accent-soft text-accent-text",
					)}
					aria-hidden="true"
				>
					<ZapIcon size={11} />
				</span>
				<span className="min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-file-row">{ruleTitle(rule)}</span>
			</div>
			<span className={muted} role="gridcell">{foldersText(rule.paths)}</span>
			<span className={muted} role="gridcell">{rule.lastRun === null ? "—" : relativeTime(rule.lastRun.startedAt)}</span>
			<span className="flex justify-center" role="gridcell">
				<RunDot tone={tone} onAccent={selected} />
			</span>
		</div>
	);
}

function BackgroundLine({
	state,
	busy,
	onSetDaemon,
}: {
	readonly state: AutomationsSnapshot;
	readonly busy: boolean;
	readonly onSetDaemon: (enabled: boolean) => void;
}): ReactElement {
	const { t } = useTranslation();
	const daemon = state.daemon;
	// A registered service that is not running (crashed, or stopped by the OS) is off for the user's purposes.
	const running = daemon?.running === true;
	return (
		<footer
			data-daemon
			className="pathbar flex h-24 flex-none items-center gap-8 border-t border-border bg-chrome pl-8 pr-12 text-badge text-ink-body"
		>
			{daemon === null ? (
				<span className="inline-flex items-center gap-6 text-ink-muted">
					<StatusDot token="--text-faint" />
					{t("automations.daemon.unknown")}
				</span>
			) : (
				<span className="inline-flex items-center gap-6 text-ink-muted">
					<StatusDot token={running ? "--ok-dot" : "--text-faint"} />
					{running ? t("automations.daemon.on") : t("automations.daemon.off")}
				</span>
			)}
			<span className="text-ink-faint" aria-hidden="true">·</span>
			<span className="text-ink-muted">{t("automations.daemon.count", { count: state.rules.length })}</span>
			<span className="flex-1" />
			{daemon === null ? null : (
				<button
					type="button"
					disabled={busy}
					className="p-0 border-0 bg-transparent text-accent-text text-badge cursor-pointer disabled:text-ink-muted disabled:cursor-default"
					onClick={() => onSetDaemon(!running)}
				>
					{busy ? t("automations.daemon.busy") : running ? t("automations.daemon.turnOff") : t("automations.daemon.turnOn")}
				</button>
			)}
		</footer>
	);
}

export function AutomationsView({
	state,
	daemonBusy,
	selectedId,
	onSelect,
	onEdit,
	onAdd,
	onContextMenu,
	onSetDaemon,
}: AutomationsViewProps): ReactElement {
	const { t } = useTranslation();
	const broken = state.configError !== null;
	const empty = state.ready && !broken && state.rules.length === 0;
	return (
		<section className="flex min-h-0 flex-1 flex-col bg-window" aria-label={t("automations.list")}>
			<div
				role="rowgroup"
				data-columns
				className="col-header grid flex-none items-center gap-8 h-[24px] px-13 border-b border-border text-ink-muted text-badge font-medium cursor-default [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
				style={{ gridTemplateColumns: COLUMNS }}
			>
				<span>{t("automations.columns.name")}</span>
				<span>{t("automations.columns.folder")}</span>
				<span>{t("automations.columns.lastRun")}</span>
				<span className="text-center">{t("automations.columns.status")}</span>
			</div>
			<div
				data-rules-body
				role="grid"
				aria-label={t("automations.list")}
				className="min-h-0 flex-1 overflow-auto"
				onContextMenu={(event) => {
					event.preventDefault();
					onContextMenu(null, { x: event.clientX, y: event.clientY });
				}}
			>
				{state.error === null ? null : (
					<p role="alert" className="m-0 border-b border-border bg-error-orange-bg px-13 py-6 text-meta text-error-orange-text">
						{state.error}
					</p>
				)}
				{broken ? (
					<div className="mx-auto flex max-w-[420px] flex-col items-center gap-8 px-16 py-32 text-center">
						<strong className="text-body font-semibold text-ink">{t("automations.errors.config")}</strong>
						<p className="m-0 text-meta leading-body text-ink-muted [overflow-wrap:anywhere]">{state.configError}</p>
						<p className="m-0 text-meta leading-body text-ink-muted">{t("automations.errors.configHint")}</p>
					</div>
				) : empty ? (
					<div className="mx-auto flex max-w-[420px] flex-col items-center gap-8 px-16 py-32 text-center">
						<strong className="text-body font-semibold text-ink">{t("automations.empty.title")}</strong>
						<p className="m-0 text-meta leading-body text-ink-muted">{t("automations.empty.body")}</p>
						<button type="button" className="linear-btn" onClick={onAdd}>
							{t("automations.empty.add")}
						</button>
					</div>
				) : (
					state.rules.map((rule) => (
						<RuleRow
							key={rule.id}
							rule={rule}
							selected={rule.id === selectedId}
							onSelect={onSelect}
							onEdit={onEdit}
							onContextMenu={onContextMenu}
						/>
					))
				)}
			</div>
			{state.rules.length === 0 && state.daemon === null ? null : <BackgroundLine state={state} busy={daemonBusy} onSetDaemon={onSetDaemon} />}
		</section>
	);
}
