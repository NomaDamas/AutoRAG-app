import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useBackgroundTasks } from "../hooks/useBackgroundTasks";
import { openErrorFixDialog, useErrorFixStore } from "../hooks/useErrorFix";
import { useIndexActivity } from "../hooks/useIndexActivity";
import { useIndexProblem } from "../hooks/useIndexProblem";
import { cn } from "../lib/cn";
import { useModelDownload } from "../state/model-download";
import { collectSidebarActivities, type SidebarActivityEntry } from "../state/sidebar-activity-queue";
import { SparklesIcon } from "./icons";
import { ProgressBar } from "./primitives/ProgressBar";

function ActivityCard({
	entry,
	extraCount = 0,
	inPopover = false,
}: {
	readonly entry: SidebarActivityEntry;
	readonly extraCount?: number;
	readonly inPopover?: boolean;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			className={cn(
				"sidebar__activity flex w-full flex-col gap-4 px-8 py-6 border-0 rounded-6 bg-transparent text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover",
				!inPopover && "relative",
				entry.className,
			)}
			aria-label={entry.ariaLabel}
			title={entry.title}
			data-tone={entry.tone}
			data-activity-id={entry.id}
			onClick={() => {
				entry.onSelect?.();
			}}
		>
			<span className="flex items-center gap-6 min-w-0 text-meta text-ink-body">
				{entry.sparkle === true ? <SparklesIcon className="flex-none text-accent" /> : null}
				<span className="flex-1 min-w-0 truncate">{entry.headline}</span>
				{entry.percent !== null && entry.tone === "run" ? (
					<span className="flex-none text-ink-muted tabular-nums">{entry.percent}%</span>
				) : entry.tone === "queued" ? (
					<span className="flex-none text-badge text-ink-faint">{t("indexActivity.queued")}</span>
				) : null}
				{extraCount > 0 ? (
					<span
						data-testid="sidebar-activity-badge"
						className="flex-none rounded-full bg-hover-strong px-6 py-1 text-badge font-semibold text-ink-muted tabular-nums"
					>
						+{extraCount}
					</span>
				) : null}
			</span>
			<ProgressBar percent={entry.percent} tone={entry.tone} label={entry.headline} />
			{entry.detail !== null ? (
				<span
					className={cn(
						"min-w-0 truncate text-badge",
						entry.shimmerDetail === true && "shimmer text-ink-muted",
						entry.tone === "error" ? "text-(--error-orange-text)" : "text-ink-muted",
					)}
				>
					{entry.detail}
				</span>
			) : null}
		</button>
	);
}

/**
 * Reusable stack renderer: shows 1 primary card in flow (with a `+N` pill badge
 * and a stacked-card lip when `entries.length > 1`) and expands upward on hover
 * or keyboard focus to reveal every queued/running/completed item without
 * shifting the sidebar layout or overwriting earlier tasks.
 */
export function SidebarActivityStack({ entries }: { readonly entries: readonly SidebarActivityEntry[] }): ReactElement | null {
	const { t } = useTranslation();
	const [hovered, setHovered] = useState(false);
	const [focusedWithin, setFocusedWithin] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!hovered && !focusedWithin) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setHovered(false);
				setFocusedWithin(false);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [hovered, focusedWithin]);

	const primary = entries[0];
	if (primary === undefined) return null;

	const extra = entries.slice(1);
	const hasExtra = extra.length > 0;
	const expanded = hasExtra && (hovered || focusedWithin);

	return (
		<div
			ref={containerRef}
			data-testid="sidebar-activity-queue"
			data-expanded={expanded ? "true" : "false"}
			className="relative mb-6"
			onMouseOver={() => {
				if (hasExtra) setHovered(true);
			}}
			onMouseOut={(event) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setHovered(false);
			}}
			onFocus={(event) => {
				if (hasExtra && event.target instanceof HTMLElement && event.target.matches(":focus-visible")) {
					setFocusedWithin(true);
				}
			}}
			onBlur={(event) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setFocusedWithin(false);
			}}
		>
			{expanded ? (
				<div className="absolute inset-x-0 bottom-full z-30 pb-4">
					<div
						data-testid="sidebar-activity-popover"
						role="region"
						aria-label={t("sidebarActivity.queueAria")}
						className="flex max-h-[300px] flex-col gap-2 overflow-y-auto [scrollbar-width:thin] rounded-8 border border-border bg-window p-4 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
					>
						<div className="flex items-center justify-between px-6 py-2 text-badge font-semibold text-ink-muted">
							<span>{t("sidebarActivity.queueHeader", { count: entries.length })}</span>
						</div>
						{extra.map((entry) => (
							<ActivityCard key={entry.id} entry={entry} inPopover />
						))}
					</div>
				</div>
			) : hasExtra ? (
				<div
					aria-hidden="true"
					className="mx-6 h-3 rounded-t-6 border border-b-0 border-border bg-hover transition-opacity duration-(--dur-color)"
				/>
			) : null}
			<ActivityCard entry={primary} extraCount={extra.length} />
		</div>
	);
}

/**
 * Unified sidebar footer activity tray, above Settings: aggregates Indexing,
 * Datasource Sync, Persistent Index Problems, AI Error Fixes, Background File
 * Operations, and On-device Model Downloads into one expandable `+N` queue.
 */
export function SidebarActivityQueue({
	onOpenIndexing,
	onOpenAiSettings,
}: {
	readonly onOpenIndexing: () => void;
	readonly onOpenAiSettings?: (() => void) | undefined;
}): ReactElement | null {
	const { t } = useTranslation();
	const indexActivity = useIndexActivity();
	const indexProblem = useIndexProblem();
	const errorFix = useErrorFixStore();
	const backgroundTasks = useBackgroundTasks();
	const modelDownload = useModelDownload();

	const entries = collectSidebarActivities({
		indexActivity,
		indexProblem,
		errorFix,
		backgroundTasks,
		modelDownload: modelDownload.status,
		t,
		onOpenIndexing,
		onOpenErrorFix: (id) => openErrorFixDialog(id),
		onOpenAiSettings,
	});

	return <SidebarActivityStack entries={entries} />;
}
