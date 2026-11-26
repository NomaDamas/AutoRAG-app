import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type {
	FsDocumentVersionDiff,
	FsVersionHistoryEntry,
	FsVersionHistoryMemberInput,
	FsVersionHistoryResult,
} from "../../../shared/fs-contract";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import { formatModified } from "../state/format";
import { basename, dirname } from "../state/paths";
import { VERSION_TAG_KEYS, type VersionRelation } from "../state/version-family";
import { CloseIcon, ExpandIcon, FileIcon, HistoryIcon } from "./icons";

export interface InspectorFamilyMember {
	readonly path: string;
	readonly name: string;
	readonly relation: VersionRelation;
	readonly where: string;
	readonly mtimeMs?: number;
}

export interface InspectorFamily {
	readonly headPath: string;
	readonly headName: string;
	readonly headMtimeMs?: number;
	readonly members: readonly InspectorFamilyMember[];
}

export type VersionHistoryLoader = (
	members: readonly FsVersionHistoryMemberInput[],
) => Promise<FsVersionHistoryResult>;

interface VersionHistoryCacheEntry {
	readonly result: FsVersionHistoryResult;
}

const historyCache = new Map<string, VersionHistoryCacheEntry>();

/** Clears the session-local version history cache (useful for tests). */
export function clearVersionHistoryCache(): void {
	historyCache.clear();
}

function buildInputMembers(family: InspectorFamily): readonly FsVersionHistoryMemberInput[] {
	return [
		{ path: family.headPath, relation: "latest", ...(family.headMtimeMs !== undefined ? { mtimeMs: family.headMtimeMs } : {}) },
		...family.members.map((member) => ({
			path: member.path,
			relation: member.relation,
			...(member.mtimeMs !== undefined ? { mtimeMs: member.mtimeMs } : {}),
		})),
	];
}

function familyCacheKey(members: readonly FsVersionHistoryMemberInput[]): string {
	return members
		.map((m) => `${m.path}@${m.mtimeMs ?? "?"}:${m.relation ?? ""}`)
		.sort()
		.join("|");
}

function formatShortDate(mtimeMs: number): string {
	if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "";
	return formatModified(mtimeMs);
}

/**
 * Fallback chronological list before the async diff arrives (or when no loader is available).
 * Orders by mtimeMs descending so the latest version by modification date sits at the top.
 */
function fallbackHistoryEntries(family: InspectorFamily): readonly FsVersionHistoryEntry[] {
	const raw = [
		{ path: family.headPath, name: family.headName, mtimeMs: family.headMtimeMs ?? 0, relation: "latest" as const },
		...family.members.map((m) => ({ path: m.path, name: m.name, mtimeMs: m.mtimeMs ?? 0, relation: m.relation })),
	];
	raw.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
	return raw.map((item, idx) => ({
		path: item.path,
		name: item.name,
		mtimeMs: item.mtimeMs,
		relation: idx === 0 ? "latest" : item.relation,
		isLatest: idx === 0,
		previousPath: raw[idx + 1]?.path ?? null,
		diff: null,
	}));
}

export function VersionHistorySection({
	family,
	entry,
	onOpenMember,
	loadVersionHistory,
}: {
	readonly family: InspectorFamily;
	readonly entry: FinderEntry;
	readonly onOpenMember: (path: string) => void;
	readonly loadVersionHistory?: VersionHistoryLoader | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const members = useMemo(() => buildInputMembers(family), [family]);
	const cacheKey = useMemo(() => familyCacheKey(members), [members]);
	const cached = historyCache.get(cacheKey)?.result ?? null;

	const [history, setHistory] = useState<FsVersionHistoryResult | null>(cached);
	const [loading, setLoading] = useState<boolean>(cached === null);
	const [failed, setFailed] = useState<boolean>(false);
	const [detailVersion, setDetailVersion] = useState<FsVersionHistoryEntry | null>(null);

	useEffect(() => {
		const hit = historyCache.get(cacheKey);
		if (hit !== undefined) {
			setHistory(hit.result);
			setLoading(false);
			setFailed(false);
			return;
		}
		const loader = loadVersionHistory ?? window.autorag?.fs?.versionHistory;
		if (loader === undefined) {
			setHistory(null);
			setLoading(false);
			setFailed(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setFailed(false);
		void loader(members)
			.then((result) => {
				historyCache.set(cacheKey, { result });
				if (!cancelled) {
					setHistory(result);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoading(false);
					setFailed(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [cacheKey, members, loadVersionHistory]);

	// Close detail sheet when switching to a different family.
	useEffect(() => {
		setDetailVersion(null);
	}, [cacheKey]);

	const versions: readonly FsVersionHistoryEntry[] = useMemo(() => {
		if (history !== null && history.versions.length > 0) return history.versions;
		return fallbackHistoryEntries(family);
	}, [history, family]);

	const whereByPath = useMemo(() => {
		const map = new Map<string, string>();
		map.set(family.headPath, dirname(family.headPath));
		for (const member of family.members) {
			map.set(member.path, member.where);
		}
		return map;
	}, [family]);

	return (
		<div className="versions-section flex flex-col gap-8 border-t border-divider pt-8" data-section="versions">
			<div className="section-title flex h-22 items-center justify-between">
				<span className="inline-flex items-center gap-5 text-meta font-medium leading-[16px] text-ink">
					<HistoryIcon size={13} className="text-ink-muted" />
					{t("inspector.versionHistory.title")}
				</span>
				<span className="inline-flex items-center rounded-8 border border-divider bg-window px-6 py-1 text-badge font-medium leading-[14px] text-ink">
					{versions.length}
				</span>
			</div>

			<div className="version-timeline relative flex flex-col" role="list" aria-label={t("inspector.versionHistory.title")}>
				{versions.map((item, idx) => {
					const isCurrent = item.path === entry.path;
					const isLast = idx === versions.length - 1;
					const where = whereByPath.get(item.path) ?? dirname(item.path);
					const dateLabel = formatShortDate(item.mtimeMs);
					const previousEntry = item.previousPath !== null ? versions[idx + 1] : undefined;
					const canOpenDetail = item.diff !== null && item.diff.status === "changed" && item.diff.hunks.length > 0;

					return (
						<div
							key={item.path}
							role="listitem"
							data-version-path={item.path}
							data-version-current={isCurrent ? "true" : undefined}
							className="version-timeline-item relative flex gap-8 pb-6 last:pb-0"
						>
							{/* Timeline rail + node */}
							<div className="relative flex w-14 flex-none flex-col items-center pt-10">
								<span
									aria-hidden="true"
									className={cn(
										"z-10 size-7 rounded-full border transition-colors duration-(--dur-color)",
										isCurrent
											? "border-accent bg-accent ring-2 ring-accent/20"
											: item.isLatest
												? "border-accent bg-window"
												: "border-border-strong bg-window",
									)}
								/>
								{isLast ? null : (
									<span
										aria-hidden="true"
										className="mt-3 w-px flex-1 bg-divider"
									/>
								)}
							</div>

							{/* Version card */}
							<div
								className={cn(
									"ver-row min-w-0 flex-1 rounded-10 border px-9 py-7 transition-[background,border-color] duration-(--dur-color)",
									isCurrent
										? "border-accent/35 bg-window shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
										: "border-transparent bg-transparent hover:border-divider hover:bg-window/70",
								)}
							>
								<button
									type="button"
									className="m-0 flex w-full cursor-pointer flex-col gap-3 border-0 bg-transparent p-0 text-left"
									onClick={() => onOpenMember(item.path)}
								>
									<div className="flex items-center justify-between gap-6">
										<VersionBadge relation={item.isLatest ? "latest" : item.relation} />
										{dateLabel.length > 0 ? (
											<span className="truncate text-[10px] font-medium leading-[13px] text-ink-faint">
												{dateLabel}
											</span>
										) : null}
									</div>
									<span className="ver-name truncate text-meta font-medium leading-[16px] text-ink">
										{item.name}
									</span>
									<span className="vwhere truncate text-[10.5px] leading-[13px] text-ink-faint">
										{where}
									</span>
								</button>

								{/* Inline concise delta vs. immediate predecessor */}
								<VersionDeltaSummary
									entry={item}
									previousName={previousEntry?.name ?? (item.previousPath ? basename(item.previousPath) : null)}
									loading={loading && item.previousPath !== null}
									failed={failed && item.previousPath !== null}
									onOpenDetail={canOpenDetail ? () => setDetailVersion(item) : undefined}
								/>
							</div>
						</div>
					);
				})}
			</div>

			{detailVersion !== null && detailVersion.diff !== null ? (
				<VersionDiffModal
					version={detailVersion}
					previousName={
						versions.find((v) => v.path === detailVersion.previousPath)?.name ??
						(detailVersion.previousPath ? basename(detailVersion.previousPath) : "")
					}
					diff={detailVersion.diff}
					onClose={() => setDetailVersion(null)}
					onOpenMember={(path) => {
						setDetailVersion(null);
						onOpenMember(path);
					}}
				/>
			) : null}
		</div>
	);
}

function VersionBadge({ relation }: { readonly relation: "latest" | VersionRelation }): ReactElement {
	const { t } = useTranslation();
	const tone =
		relation === "latest"
			? "bg-vtag-latest-bg text-vtag-latest-text"
			: relation === "near"
				? "bg-vtag-near-bg text-vtag-near-text"
				: "bg-vtag-exact-bg text-vtag-exact-text";
	return (
		<span className={cn("vtag flex-none inline-flex items-center px-6 py-2 rounded-7 text-tile-xs font-bold whitespace-nowrap leading-[12px]", tone)}>
			{t(VERSION_TAG_KEYS[relation])}
		</span>
	);
}

function VersionDeltaSummary({
	entry,
	previousName,
	loading,
	failed,
	onOpenDetail,
}: {
	readonly entry: FsVersionHistoryEntry;
	readonly previousName: string | null;
	readonly loading: boolean;
	readonly failed: boolean;
	readonly onOpenDetail?: (() => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();

	if (entry.previousPath === null) {
		return (
			<div className="mt-5 flex items-center text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="base">
				{t("inspector.versionHistory.baseVersion")}
			</div>
		);
	}

	if (loading) {
		return (
			<div className="mt-5 flex items-center gap-4 text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="loading">
				<span className="inline-block size-5 animate-pulse rounded-full bg-border-strong" aria-hidden="true" />
				{t("inspector.versionHistory.loading")}
			</div>
		);
	}

	if (failed || entry.diff === null) {
		return (
			<div className="mt-5 text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="error">
				{t("inspector.versionHistory.error")}
			</div>
		);
	}

	const { diff } = entry;

	if (diff.status === "identical") {
		return (
			<div className="mt-5 text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="identical">
				{t("inspector.versionHistory.identical")}
			</div>
		);
	}

	if (diff.status === "unsupported") {
		return (
			<div className="mt-5 text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="unsupported">
				{t("inspector.versionHistory.unsupported")}
			</div>
		);
	}

	if (diff.status === "error") {
		return (
			<div className="mt-5 text-[10.5px] leading-[14px] text-ink-faint" data-diff-status="error">
				{t("inspector.versionHistory.error")}
			</div>
		);
	}

	const { summary } = diff;
	const addedPreview = summary.addedHighlights.slice(0, 2);
	const removedPreview = summary.removedHighlights.slice(0, 1);

	return (
		<div
			className="mt-6 flex flex-col gap-4 border-t border-divider/70 pt-5"
			data-diff-status="changed"
		>
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-4">
					{summary.addedCount > 0 ? (
						<span className="inline-flex items-center rounded-5 bg-ok-bg px-5 py-1 text-[10px] font-semibold leading-[12px] text-ok-text">
							{t("inspector.versionHistory.addedLines", { count: summary.addedCount })}
						</span>
					) : null}
					{summary.removedCount > 0 ? (
						<span className="inline-flex items-center rounded-5 bg-danger-bg px-5 py-1 text-[10px] font-semibold leading-[12px] text-danger-text">
							{t("inspector.versionHistory.removedLines", { count: summary.removedCount })}
						</span>
					) : null}
				</div>
				{onOpenDetail !== undefined ? (
					<button
						type="button"
						data-action="version-diff-detail"
						className="inline-flex flex-none cursor-pointer items-center gap-3 rounded-5 border-0 bg-transparent px-4 py-1 text-[10.5px] font-medium leading-[13px] text-accent-text transition-colors duration-(--dur-color) hover:bg-accent-soft"
						onClick={onOpenDetail}
						title={previousName ? t("inspector.versionHistory.vsPrevious", { name: previousName }) : undefined}
					>
						<ExpandIcon size={10} />
						{t("inspector.versionHistory.viewDetail")}
					</button>
				) : null}
			</div>

			{addedPreview.length > 0 || removedPreview.length > 0 ? (
				<div className="flex flex-col gap-2">
					{addedPreview.map((line, i) => (
						<div key={`a-${i}`} className="flex items-baseline gap-4 text-[11px] leading-[15px]">
							<span className="flex-none font-mono text-[10px] font-bold text-ok-text" aria-hidden="true">+</span>
							<span className="min-w-0 truncate text-ink-body" title={line}>{line}</span>
						</div>
					))}
					{removedPreview.map((line, i) => (
						<div key={`r-${i}`} className="flex items-baseline gap-4 text-[11px] leading-[15px]">
							<span className="flex-none font-mono text-[10px] font-bold text-danger-text" aria-hidden="true">−</span>
							<span className="min-w-0 truncate text-ink-muted line-through decoration-danger-text/50" title={line}>{line}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * Clean Bloom-styled diff sheet for inspecting the exact line-level changes between
 * a version and its immediate predecessor without cluttering the narrow right sidebar.
 */
function VersionDiffModal({
	version,
	previousName,
	diff,
	onClose,
	onOpenMember,
}: {
	readonly version: FsVersionHistoryEntry;
	readonly previousName: string;
	readonly diff: FsDocumentVersionDiff;
	readonly onClose: () => void;
	readonly onOpenMember: (path: string) => void;
}): ReactElement {
	const { t } = useTranslation();

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	return (
		<div
			className="version-diff-modal fixed inset-0 z-80 flex items-center justify-center bg-black/30 p-20"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				className="flex max-h-[82vh] w-full max-w-[720px] flex-col overflow-hidden rounded-12 border border-border bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={t("inspector.versionHistory.title")}
			>
				{/* Header */}
				<div className="flex flex-none items-center justify-between gap-12 border-b border-divider bg-subtle px-16 py-12">
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						<div className="flex items-center gap-6">
							<VersionBadge relation={version.isLatest ? "latest" : version.relation} />
							<span className="truncate text-[13px] font-semibold text-ink">{version.name}</span>
						</div>
						<div className="flex items-center gap-6 text-badge text-ink-muted">
							<span className="truncate">{t("inspector.versionHistory.vsPrevious", { name: previousName })}</span>
							<span className="text-border-strong" aria-hidden="true">·</span>
							{diff.summary.addedCount > 0 ? (
								<span className="font-semibold text-ok-text">
									{t("inspector.versionHistory.addedLines", { count: diff.summary.addedCount })}
								</span>
							) : null}
							{diff.summary.removedCount > 0 ? (
								<span className="font-semibold text-danger-text">
									{t("inspector.versionHistory.removedLines", { count: diff.summary.removedCount })}
								</span>
							) : null}
						</div>
					</div>
					<div className="flex flex-none items-center gap-6">
						<button
							type="button"
							className="inline-flex h-26 cursor-pointer items-center gap-4 rounded-7 border border-border bg-window px-8 text-badge font-medium text-ink-body transition-colors duration-(--dur-color) hover:bg-hover hover:text-ink"
							onClick={() => onOpenMember(version.path)}
						>
							<FileIcon size={12} />
							{t("inspector.versionHistory.openFile")}
						</button>
						<button
							type="button"
							aria-label={t("inspector.versionHistory.close")}
							className="flex size-26 cursor-pointer items-center justify-center rounded-7 border-0 bg-transparent text-ink-muted transition-colors duration-(--dur-color) hover:bg-hover hover:text-ink"
							onClick={onClose}
						>
							<CloseIcon size={12} />
						</button>
					</div>
				</div>

				{/* Diff hunks */}
				<div className="flex-1 overflow-auto bg-window p-12">
					<div className="flex flex-col gap-10">
						{diff.hunks.map((hunk, hunkIdx) => (
							<div
								key={`${hunk.previousStart}-${hunk.currentStart}-${hunkIdx}`}
								className="overflow-hidden rounded-8 border border-divider"
							>
								<div className="flex items-center justify-between border-b border-divider bg-subtle px-10 py-4 font-mono text-[10.5px] text-ink-faint">
									<span>
										@@ -{hunk.previousStart},{hunk.previousCount} +{hunk.currentStart},{hunk.currentCount} @@
									</span>
								</div>
								<div className="flex flex-col font-mono text-[12px] leading-[19px]">
									{hunk.lines.map((line, lineIdx) => (
										<div
											key={lineIdx}
											data-diff-line={line.kind}
											className={cn(
												"flex items-stretch px-8 py-1",
												line.kind === "added" && "bg-ok-bg-soft text-ink",
												line.kind === "removed" && "bg-danger-bg-soft text-ink-body",
												line.kind === "context" && "bg-window text-ink-muted",
											)}
										>
											<span className="w-32 flex-none select-none pr-6 text-right text-[10.5px] text-ink-faint">
												{line.previousLine ?? ""}
											</span>
											<span className="w-32 flex-none select-none pr-8 text-right text-[10.5px] text-ink-faint">
												{line.currentLine ?? ""}
											</span>
											<span
												className={cn(
													"w-14 flex-none select-none font-bold",
													line.kind === "added" && "text-ok-text",
													line.kind === "removed" && "text-danger-text",
													line.kind === "context" && "text-ink-faint",
												)}
											>
												{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
											</span>
											<span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
												{line.text.length > 0 ? line.text : " "}
											</span>
										</div>
									))}
								</div>
							</div>
						))}
					</div>
					{diff.truncated ? (
						<p className="mt-10 mb-0 text-center text-badge text-ink-faint">
							{t("inspector.versionHistory.truncatedNotice")}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
