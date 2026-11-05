/**
 * The phone shell's file screens: the places root (둘러보기), one folder
 * listing, Recents, and filename search. Each is a full-width page under the
 * transparent bar; rows open on tap, lift on long-press, and swipe left for
 * 휴지통 · 더보기. The shell owns navigation, selection and overlays, and
 * passes the callbacks in.
 */

import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Ellipsis, HardDrive, Search, Sparkles, Trash2, X } from "lucide-react";
import type { FsTagColor } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import type { FinderEntry } from "../data/entries";
import type { NavGroup, NavItem } from "../data/places";
import { cn } from "../lib/cn";
import { formatModified, formatSize } from "../state/format";
import { TAG_COLOR_TOKEN, tagDotsOf, type TagColors } from "../state/tags";
import type { RecentsGroup } from "./model";
import { Cell, Check, EntryName, Section, Thumb } from "./parts";

/** A tag colour as a CSS value; colour 0 (none) draws the neutral grey. */
export function tagCss(color: FsTagColor): string {
	const token = TAG_COLOR_TOKEN[color];
	return token === null ? "var(--phone-label-3)" : `var(${token})`;
}

/* ------------------------------------------------------------------ Rows -- */

export interface RowActions {
	readonly onOpen: (entry: FinderEntry) => void;
	readonly onLongPress: (entry: FinderEntry, row: HTMLElement) => void;
	readonly onMore: (entry: FinderEntry, anchor: HTMLElement) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onToggleSelect: (entry: FinderEntry) => void;
}

export interface RowContext {
	readonly selecting: boolean;
	readonly selected: ReadonlySet<string>;
	readonly tagColors: TagColors;
	readonly indexStatus: ReadonlyMap<string, IndexStatus>;
	readonly previewUrl: (entry: FinderEntry) => string | null;
	/** Swipe actions; Trash rows use 복원 instead. */
	readonly inTrash: boolean;
	/** Replace the date with the parent folder (Recents, search results). */
	readonly where?: ((entry: FinderEntry) => string) | undefined;
	readonly flashPath: string | null;
}

const LONG_PRESS_MS = 420;
const SWIPE_OPEN = 160;

export function RowMeta({ entry, ctx }: { readonly entry: FinderEntry; readonly ctx: RowContext }): ReactElement {
	const { t } = useTranslation();
	const dots = tagDotsOf(entry.finder, ctx.tagColors);
	const status = ctx.indexStatus.get(entry.path);
	const parts = [ctx.where?.(entry) ?? formatModified(entry.mtimeMs), entry.kind === "folder" ? null : formatSize(entry.size)].filter((part): part is string => part !== null);
	return (
		<div className="phone-meta">
			{dots.length === 0 ? null : (
				<span className="phone-tags" aria-hidden="true">
					{dots.map((dot) => <i key={dot.name} style={{ background: tagCss(dot.color) }} />)}
				</span>
			)}
			{status?.kind === "included" ? <span className="phone-ix" aria-label={t("mobile.info.indexed")}><Sparkles size={11} strokeWidth={2.4} /></span> : null}
			<span className="phone-meta-text">{parts.join(" · ")}</span>
		</div>
	);
}

/** One list row: tap opens, long-press lifts it into the menu, a left swipe reveals 휴지통 · 더보기. */
export function EntryRow({ entry, ctx, actions }: { readonly entry: FinderEntry; readonly ctx: RowContext; readonly actions: RowActions }): ReactElement {
	const { t } = useTranslation();
	const rowRef = useRef<HTMLDivElement>(null);
	const press = useRef<{ x: number; y: number; timer: number; fired: boolean; swiping: boolean; base: number } | null>(null);
	const [offset, setOffset] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [pressed, setPressed] = useState(false);
	/** The click a long-press or a swipe ends with is not a tap: it must not open the row. */
	const swallowClick = useRef(false);
	const selected = ctx.selected.has(entry.path);
	const firstTag = tagDotsOf(entry.finder, ctx.tagColors)[0];

	const end = (): void => {
		const state = press.current;
		if (state === null) return;
		window.clearTimeout(state.timer);
		press.current = null;
		setPressed(false);
		setDragging(false);
		if (state.fired || state.swiping) swallowClick.current = true;
		if (state.swiping) setOffset((value) => (value < -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0));
	};

	return (
		<div
			ref={rowRef}
			className={cn("phone-row", offset !== 0 && "is-open", dragging && "is-dragging", pressed && "is-pressed", ctx.flashPath === entry.path && "is-flash")}
			data-path={entry.path}
			data-testid="phone-row"
			onPointerDown={(event) => {
				if (event.button !== 0 || (event.target as HTMLElement).closest(".phone-swipe") !== null) return;
				const timer = window.setTimeout(() => {
					const state = press.current;
					if (state === null || state.swiping || ctx.selecting) return;
					state.fired = true;
					setPressed(false);
					if (rowRef.current !== null) actions.onLongPress(entry, rowRef.current);
				}, LONG_PRESS_MS);
				press.current = { x: event.clientX, y: event.clientY, timer, fired: false, swiping: false, base: offset };
				setPressed(true);
			}}
			onPointerMove={(event) => {
				const state = press.current;
				if (state === null) return;
				const dx = event.clientX - state.x;
				const dy = event.clientY - state.y;
				if (!state.swiping && Math.abs(dy) > 8) {
					end();
					return;
				}
				if (!state.swiping && !ctx.selecting && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
					state.swiping = true;
					window.clearTimeout(state.timer);
					setPressed(false);
					setDragging(true);
					(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
				}
				if (state.swiping) setOffset(Math.min(0, Math.max(-SWIPE_OPEN - 40, state.base + dx)));
			}}
			onPointerUp={end}
			onPointerCancel={end}
			onContextMenu={(event) => {
				// A desktop browser narrowed to phone width right-clicks instead of holding.
				event.preventDefault();
				if (rowRef.current !== null && !ctx.selecting) actions.onLongPress(entry, rowRef.current);
			}}
		>
			<div className="phone-swipe" style={{ width: SWIPE_OPEN }}>
				<button type="button" className="is-more" onClick={(event) => { setOffset(0); actions.onMore(entry, event.currentTarget); }}>
					<Ellipsis size={20} strokeWidth={2.2} />
					{t("mobile.swipe.more")}
				</button>
				<button type="button" className="is-trash" onClick={() => { setOffset(0); actions.onTrash(entry); }}>
					<Trash2 size={20} strokeWidth={2.2} />
					{ctx.inTrash ? t("mobile.select.restore") : t("mobile.swipe.trash")}
				</button>
			</div>
			<button
				type="button"
				className="phone-row-inner"
				style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
				aria-pressed={ctx.selecting ? selected : undefined}
				onClick={() => {
					if (swallowClick.current) {
						swallowClick.current = false;
						return;
					}
					if (offset !== 0) {
						setOffset(0);
						return;
					}
					if (ctx.selecting) actions.onToggleSelect(entry);
					else actions.onOpen(entry);
				}}
			>
				{ctx.selecting ? <Check on={selected} /> : null}
				<Thumb entry={entry} previewUrl={ctx.previewUrl(entry)} tagColor={entry.kind === "folder" && firstTag !== undefined ? tagCss(firstTag.color) : undefined} />
				<span className="phone-row-main">
					<EntryName entry={entry} />
					<RowMeta entry={entry} ctx={ctx} />
				</span>
				{ctx.selecting ? null : (
					<span
						role="button"
						tabIndex={0}
						className="phone-row-more"
						aria-label={t("mobile.moreFor", { name: entry.name })}
						onClick={(event) => {
							event.stopPropagation();
							actions.onMore(entry, event.currentTarget);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								event.stopPropagation();
								actions.onMore(entry, event.currentTarget);
							}
						}}
					>
						<Ellipsis size={20} strokeWidth={2.2} />
					</span>
				)}
			</button>
		</div>
	);
}

function EntryTile({ entry, ctx, actions }: { readonly entry: FinderEntry; readonly ctx: RowContext; readonly actions: RowActions }): ReactElement {
	const press = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
	const ref = useRef<HTMLButtonElement>(null);
	const selected = ctx.selected.has(entry.path);
	const firstTag = tagDotsOf(entry.finder, ctx.tagColors)[0];
	return (
		<button
			ref={ref}
			type="button"
			className={cn("phone-tile", ctx.flashPath === entry.path && "is-flash")}
			data-path={entry.path}
			data-testid="phone-row"
			aria-pressed={ctx.selecting ? selected : undefined}
			onPointerDown={(event) => {
				const timer = window.setTimeout(() => {
					if (press.current === null || ctx.selecting) return;
					press.current.fired = true;
					if (ref.current !== null) actions.onLongPress(entry, ref.current);
				}, LONG_PRESS_MS);
				press.current = { timer, fired: false, x: event.clientX, y: event.clientY };
			}}
			onPointerMove={(event) => {
				const state = press.current;
				if (state !== null && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 8) {
					window.clearTimeout(state.timer);
					press.current = null;
				}
			}}
			onPointerUp={() => {
				if (press.current !== null) window.clearTimeout(press.current.timer);
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				if (ref.current !== null && !ctx.selecting) actions.onLongPress(entry, ref.current);
			}}
			onClick={() => {
				const fired = press.current?.fired === true;
				press.current = null;
				if (fired) return;
				if (ctx.selecting) actions.onToggleSelect(entry);
				else actions.onOpen(entry);
			}}
		>
			<span className="phone-tile-thumb">
				<Thumb entry={entry} previewUrl={ctx.previewUrl(entry)} tagColor={entry.kind === "folder" && firstTag !== undefined ? tagCss(firstTag.color) : undefined} large />
			</span>
			{ctx.selecting ? <Check on={selected} /> : null}
			<span className="phone-tile-name">{entry.name}</span>
			<span className="phone-tile-meta">{entry.kind === "folder" ? formatModified(entry.mtimeMs) : formatSize(entry.size)}</span>
		</button>
	);
}

export function EntryList({ entries, ctx, actions, grid }: { readonly entries: readonly FinderEntry[]; readonly ctx: RowContext; readonly actions: RowActions; readonly grid: boolean }): ReactElement {
	return grid ? (
		<div className="phone-grid">{entries.map((entry) => <EntryTile key={entry.path} entry={entry} ctx={ctx} actions={actions} />)}</div>
	) : (
		<div className={cn(ctx.selecting && "phone-selecting")}>{entries.map((entry) => <EntryRow key={entry.path} entry={entry} ctx={ctx} actions={actions} />)}</div>
	);
}

/* ---------------------------------------------------------------- Places -- */

export function PlacesBody({ groups, groupLabel, itemLabel, onOpen, collapsed, onToggle, free }: {
	readonly groups: readonly NavGroup[];
	readonly groupLabel: (label: string) => string;
	readonly itemLabel: (item: NavItem) => string;
	readonly onOpen: (item: NavItem) => void;
	readonly collapsed: ReadonlySet<string>;
	readonly onToggle: (label: string) => void;
	readonly free?: ((item: NavItem) => ReactNode) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<>
			{groups.map((group) => {
				// AI 검색 and 자동화 are tabs of their own on a phone, so the sidebar's app rows drop out.
				const items = group.items.filter((item) => item.view === undefined);
				if (items.length === 0) return null;
				const label = groupLabel(group.label);
				return (
					<Section key={group.label} title={label} collapsed={collapsed.has(group.label)} onToggle={() => onToggle(group.label)} toggleLabel={t("mobile.collapse", { name: label })}>
						{items.map((item) => {
							const Icon = item.kind === "home" ? HardDrive : item.icon;
							return (
								<Cell
									key={item.path}
									icon={item.tag === undefined ? <Icon size={22} strokeWidth={2} /> : <span className="phone-tagdot" style={{ background: tagCss(item.tag.color) }} />}
									title={itemLabel(item)}
									subtitle={free?.(item)}
									onClick={item.available ? () => onOpen(item) : undefined}
									testId="phone-place"
								/>
							);
						})}
					</Section>
				);
			})}
		</>
	);
}

/* --------------------------------------------------------------- Recents -- */

export function RecentsBody({ groups, ctx, actions, grid, bucketLabel }: {
	readonly groups: readonly RecentsGroup[];
	readonly ctx: RowContext;
	readonly actions: RowActions;
	readonly grid: boolean;
	readonly bucketLabel: (group: RecentsGroup) => string;
}): ReactElement {
	const { t } = useTranslation();
	if (groups.length === 0) return <div className="phone-empty"><b>{t("mobile.recents.empty")}</b></div>;
	return (
		<>
			{groups.map((group) => (
				<div key={group.bucket}>
					<div className="phone-group-head">{bucketLabel(group)}</div>
					<EntryList entries={group.entries} ctx={ctx} actions={actions} grid={grid} />
				</div>
			))}
		</>
	);
}

/* ---------------------------------------------------------------- Search -- */

export function SearchField({ value, onChange, onClose, inputRef }: { readonly value: string; readonly onChange: (value: string) => void; readonly onClose: () => void; readonly inputRef: React.RefObject<HTMLInputElement | null> }): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="phone-bar-row is-search">
			<label className="phone-search-field phone-glass">
				<Search size={18} strokeWidth={2.2} aria-hidden="true" />
				<input
					ref={inputRef}
					type="search"
					value={value}
					placeholder={t("mobile.search.placeholder")}
					aria-label={t("mobile.tabs.search")}
					enterKeyHint="search"
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onClose();
					}}
				/>
				{value.length === 0 ? null : (
					<button type="button" className="phone-acc-x" aria-label={t("mobile.search.clear")} onClick={() => onChange("")}>
						<X size={16} strokeWidth={2.4} />
					</button>
				)}
			</label>
			<button type="button" className="phone-gbtn phone-glass" aria-label={t("mobile.search.exit")} onClick={onClose}>
				<X size={20} strokeWidth={2.2} />
			</button>
		</div>
	);
}
