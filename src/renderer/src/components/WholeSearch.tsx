/**
 * The Finder's whole search (⌘F) chrome: the group tabs under the tab strip (file names, document content, one per
 * connected datasource, each with a live count) and the result lists of the non-file groups. The file-name group is
 * the Finder list itself, so it keeps every view mode, selection and drag the Finder already has.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SearchDatasource, SourceHit } from "../../../shared/source-search-contract";
import { i18n } from "../../../shared/i18n/core";
import { cn } from "../lib/cn";
import { markTerms } from "../lib/mark-terms";
import type { FinderEntry } from "../data/entries";
import type { ContentRowInput } from "../state/launcher";
import { dirname } from "../state/paths";
import type { SearchGroup, SearchGroupKey, WholeSearchState } from "../state/whole-search";
import { DatabaseIcon, FolderGlyph, LinkIcon, SearchIcon, SparklesIcon } from "./icons";
import { EntryTile } from "./primitives/EntryTile";
import { sourceTitle } from "./settings/datasourceTemplates";
import { SourceIcon } from "./settings/SourceIcon";

const SPINNER_CLASS = "size-10 flex-none rounded-full border-[1.5px] border-border border-t-accent animate-spin";

function groupLabel(group: SearchGroup, labels: { readonly files: string; readonly content: string }): string {
	if (group.key === "files") return labels.files;
	if (group.key === "content") return labels.content;
	return group.datasource === null ? group.key : sourceTitle(group.datasource);
}

function GroupGlyph({ group }: { readonly group: SearchGroup }): ReactElement {
	if (group.key === "files") return <FolderGlyph size={13} />;
	if (group.key === "content") return <DatabaseIcon size={13} />;
	const datasource = group.datasource;
	return datasource === null ? <SearchIcon size={13} /> : <SourceIcon type={datasource.type} label={sourceTitle(datasource)} small />;
}

/** The count, a spinner while the surface is still answering, or a dash when it cannot answer. */
function GroupBadge({ group, selected }: { readonly group: SearchGroup; readonly selected: boolean }): ReactElement {
	const { t } = useTranslation();
	if (group.status === "pending") return <span className={SPINNER_CLASS} role="status" aria-label={t("wholeSearch.pending")} />;
	if (group.count === null) return <span className={cn("text-badge", selected ? "text-ink-muted" : "text-ink-faint")}>–</span>;
	return (
		<span
			className={cn(
				"min-w-16 px-5 rounded-full text-badge font-semibold tabular-nums text-center",
				group.count === 0 ? "text-ink-faint" : selected ? "bg-accent text-on-accent" : "bg-hover-strong text-ink-body",
			)}
		>
			{group.count}
		</span>
	);
}

/**
 * The group tabs: a fixed order (files, content, then datasources in config order) so a tab never moves under the
 * pointer while answers land. ←/→ move between tabs like any tab list; the AI Search button on the right hands the
 * same query to the chat.
 */
export function SearchGroupTabs({
	groups,
	selected,
	onSelect,
	onAskAi,
}: {
	readonly groups: readonly SearchGroup[];
	readonly selected: SearchGroupKey;
	readonly onSelect: (key: SearchGroupKey) => void;
	readonly onAskAi: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		event.stopPropagation();
		const index = groups.findIndex((group) => group.key === selected);
		const next = groups[(index + (event.key === "ArrowRight" ? 1 : groups.length - 1)) % groups.length];
		if (next === undefined) return;
		onSelect(next.key);
		listRef.current?.querySelector<HTMLButtonElement>(`[data-group="${CSS.escape(next.key)}"]`)?.focus();
	};
	return (
		<div className="search-groups flex flex-none items-center gap-8 h-[34px] pl-10 pr-8 border-b border-divider bg-window">
			<div
				ref={listRef}
				className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none]"
				role="tablist"
				aria-label={t("wholeSearch.groups")}
				onKeyDown={onKeyDown}
			>
				{groups.map((group) => {
					const active = group.key === selected;
					const label = groupLabel(group, { files: t("wholeSearch.files"), content: t("wholeSearch.content") });
					return (
						<button
							key={group.key}
							type="button"
							role="tab"
							data-group={group.key}
							aria-selected={active}
							tabIndex={active ? 0 : -1}
							title={group.status === "error" && group.error !== null ? `${label}: ${group.error}` : label}
							className={cn(
								"search-group flex flex-none items-center gap-6 h-[24px] pl-7 pr-6 border rounded-7 text-badge whitespace-nowrap cursor-default transition-[background,color,border-color] duration-(--dur-color) ease-[ease] [&_.settings-app-icon]:grid [&_.settings-app-icon]:place-items-center",
								active ? "bg-subtle border-border text-ink font-semibold" : "bg-transparent border-transparent text-ink-muted hover:bg-hover hover:text-ink",
								group.status === "error" && "text-danger-text",
							)}
							onClick={() => onSelect(group.key)}
						>
							<GroupGlyph group={group} />
							<span>{label}</span>
							<GroupBadge group={group} selected={active} />
						</button>
					);
				})}
			</div>
			<button
				type="button"
				className="search-ask flex flex-none items-center gap-5 h-[24px] px-8 border border-border rounded-7 bg-window text-badge text-ink-body whitespace-nowrap cursor-default hover:bg-hover hover:text-ink"
				title={t("wholeSearch.askAiHint")}
				onClick={onAskAi}
			>
				<SparklesIcon size={12} />
				{t("wholeSearch.askAi")}
			</button>
		</div>
	);
}

/** A list the arrow keys walk: ↑/↓ move, Enter opens. Owns its keys so the Finder list's shortcuts stay out. */
function useListCursor(count: number, resetKey: string): { readonly index: number; readonly setIndex: (index: number) => void; readonly onKeyDown: (event: KeyboardEvent<HTMLElement>, open: (index: number) => void) => void } {
	const [cursor, setCursor] = useState({ key: resetKey, index: 0 });
	const index = cursor.key === resetKey ? Math.min(cursor.index, Math.max(0, count - 1)) : 0;
	const setIndex = (next: number): void => setCursor({ key: resetKey, index: next });
	const onKeyDown = (event: KeyboardEvent<HTMLElement>, open: (index: number) => void): void => {
		if (event.metaKey || event.ctrlKey || event.altKey || count === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			setIndex(Math.max(0, Math.min(count - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
		} else if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			open(index);
		}
	};
	return { index, setIndex, onKeyDown };
}

function useScrollIntoView(index: number): React.RefObject<HTMLDivElement | null> {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index]);
	return ref;
}

/** The centered note a group shows instead of rows: still searching, nothing matched, or why it could not answer. */
function GroupNote({ children, pending = false }: { readonly children: ReactNode; readonly pending?: boolean }): ReactElement {
	return (
		<div className="search-note flex flex-1 items-center justify-center gap-8 p-24 text-sm text-ink-muted text-center" role="status">
			{pending ? <span className={SPINNER_CLASS} /> : null}
			<span>{children}</span>
		</div>
	);
}

const LIST_CLASS = "search-results min-h-0 flex-1 overflow-y-auto p-6 bg-window outline-none";

function rowClass(selected: boolean): string {
	return cn(
		"search-hit flex items-start gap-10 px-10 py-7 rounded-7 cursor-default select-none",
		selected ? "bg-accent text-on-accent [&_mark]:text-on-accent [&_mark]:underline" : "text-ink hover:bg-hover-row [&_mark]:text-accent",
		"[&_mark]:bg-transparent [&_mark]:font-semibold",
	);
}

/** Files of the document index whose text matches, best first: the file, where it lives, and the matched passage. */
export function ContentResults({
	query,
	content,
	onOpen,
	onReveal,
}: {
	readonly query: string;
	readonly content: WholeSearchState["content"];
	readonly onOpen: (entry: FinderEntry) => void;
	readonly onReveal: (entry: FinderEntry) => void;
}): ReactElement {
	const { t } = useTranslation();
	const hits = content.hits;
	const cursor = useListCursor(hits.length, query);
	const listRef = useScrollIntoView(cursor.index);
	if (content.status === "pending") return <GroupNote pending>{t("wholeSearch.pending")}</GroupNote>;
	if (content.status === "off") return <GroupNote>{t("wholeSearch.contentOff")}</GroupNote>;
	if (content.status === "unavailable") return <GroupNote>{t("wholeSearch.contentUnavailable")}</GroupNote>;
	if (content.status === "error") return <GroupNote>{t("wholeSearch.contentError")}</GroupNote>;
	if (hits.length === 0) return <GroupNote>{t("wholeSearch.noContentHits", { query })}</GroupNote>;
	const open = (index: number): void => {
		const hit = hits[index];
		if (hit !== undefined) onOpen(hit.entry);
	};
	return (
		<div ref={listRef} className={LIST_CLASS} role="listbox" aria-label={t("wholeSearch.content")} tabIndex={0} onKeyDown={(event) => cursor.onKeyDown(event, open)}>
			{hits.map((hit: ContentRowInput, index) => {
				const selected = index === cursor.index;
				return (
					<div
						key={hit.entry.path}
						className={rowClass(selected)}
						role="option"
						aria-selected={selected}
						data-index={index}
						data-path={hit.entry.path}
						title={hit.entry.path}
						onClick={() => cursor.setIndex(index)}
						onDoubleClick={() => onOpen(hit.entry)}
					>
						<span className="flex-none pt-1">
							<EntryTile entry={hit.entry} size={22} />
						</span>
						<span className="flex min-w-0 flex-1 flex-col gap-2">
							<span className="flex min-w-0 items-baseline gap-8">
								<span className="min-w-0 truncate text-file-row font-medium">{hit.entry.name}</span>
								<span className={cn("min-w-0 flex-1 truncate text-meta", selected ? "text-on-accent/80" : "text-ink-muted")}>{dirname(hit.entry.path)}</span>
							</span>
							<span className={cn("line-clamp-2 text-meta", selected ? "text-on-accent/90" : "text-ink-body")}>{markTerms(hit.snippet, query)}</span>
						</span>
						<button
							type="button"
							className={cn(
								"search-reveal flex-none self-center h-[22px] px-7 border-0 rounded-5 text-badge whitespace-nowrap cursor-default",
								selected ? "bg-on-accent/20 text-on-accent hover:bg-on-accent/30" : "bg-transparent text-ink-muted hover:bg-hover-strong hover:text-ink",
							)}
							onClick={(event) => {
								event.stopPropagation();
								onReveal(hit.entry);
							}}
						>
							{t("wholeSearch.showInFolder")}
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** "2026. 11. 8. 오후 3:04" in the interface language. */
function formatWhen(ms: number): string {
	return new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

/**
 * One datasource's messages, mails or pages, best first. A row shows where it was said and by whom, when, and the
 * matched line; the selected row unfolds the whole passage. A page from browser history opens in the browser.
 */
export function SourceResults({
	query,
	datasource,
	answer,
	onOpenUrl,
}: {
	readonly query: string;
	readonly datasource: SearchDatasource;
	readonly answer: { readonly status: "pending" | "ready" | "error"; readonly hits: readonly SourceHit[]; readonly error: string | null } | undefined;
	readonly onOpenUrl: (url: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const hits = answer?.status === "ready" ? answer.hits : [];
	const cursor = useListCursor(hits.length, `${datasource.id}\u0000${query}`);
	const listRef = useScrollIntoView(cursor.index);
	const name = sourceTitle(datasource);
	const formatted = useMemo(() => hits.map((hit) => (hit.timestamp === null ? null : formatWhen(hit.timestamp))), [hits]);
	if (answer === undefined || answer.status === "pending") return <GroupNote pending>{t("wholeSearch.sourcePending", { source: name })}</GroupNote>;
	if (answer.status === "error") return <GroupNote>{t("wholeSearch.sourceError", { source: name, error: answer.error ?? "" })}</GroupNote>;
	if (hits.length === 0) return <GroupNote>{t("wholeSearch.noSourceHits", { source: name, query })}</GroupNote>;
	const open = (index: number): void => {
		const url = hits[index]?.url;
		if (url !== null && url !== undefined) onOpenUrl(url);
	};
	return (
		<div ref={listRef} className={LIST_CLASS} role="listbox" aria-label={name} tabIndex={0} onKeyDown={(event) => cursor.onKeyDown(event, open)}>
			{hits.map((hit, index) => {
				const selected = index === cursor.index;
				const when = formatted[index];
				return (
					<div
						key={`${hit.id}:${index}`}
						className={rowClass(selected)}
						role="option"
						aria-selected={selected}
						aria-expanded={selected}
						data-index={index}
						onClick={() => cursor.setIndex(index)}
						onDoubleClick={() => open(index)}
					>
						<span className="flex min-w-0 flex-1 flex-col gap-2">
							<span className="flex min-w-0 items-baseline gap-8">
								<span className="min-w-0 truncate text-file-row font-medium">{hit.title}</span>
								{hit.author !== null ? <span className={cn("min-w-0 truncate text-meta", selected ? "text-on-accent/80" : "text-ink-muted")}>{hit.author}</span> : null}
								<span className="flex-1" />
								{when !== null ? <span className={cn("flex-none text-meta tabular-nums", selected ? "text-on-accent/80" : "text-ink-faint")}>{when}</span> : null}
							</span>
							{selected ? (
								<span className="search-hit__body whitespace-pre-wrap break-words text-meta text-on-accent/95 max-h-[180px] overflow-y-auto">{markTerms(hit.content, query)}</span>
							) : (
								<span className="line-clamp-2 text-meta text-ink-body">{markTerms(hit.snippet, query)}</span>
							)}
						</span>
						{hit.url !== null ? (
							<button
								type="button"
								className={cn(
									"search-open flex flex-none items-center gap-4 self-center h-[22px] px-7 border-0 rounded-5 text-badge whitespace-nowrap cursor-default",
									selected ? "bg-on-accent/20 text-on-accent hover:bg-on-accent/30" : "bg-transparent text-ink-muted hover:bg-hover-strong hover:text-ink",
								)}
								onClick={(event) => {
									event.stopPropagation();
									if (hit.url !== null) onOpenUrl(hit.url);
								}}
							>
								<LinkIcon size={11} />
								{t("wholeSearch.openPage")}
							</button>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
