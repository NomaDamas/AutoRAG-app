import type { ReactElement, RefObject } from "react";
import type { FinderEntry } from "../data/entries";
import { tileLabel } from "../state/format";
import type { StackRow, VersionFamilyError } from "../state/version-family";
import { isHiddenName } from "../state/visibility";
import type { RowCallbacks } from "./FileRow";
import { FileTile } from "./primitives/FileTile";
import { RenameInput } from "./RenameInput";
import { VersionFamilyBanner } from "./VersionFamilyBanner";

/**
 * View mode 1: every entry as a 64px icon or OS thumbnail on a wrapping grid,
 * its name centered underneath. Same selection, open, context menu, and rename
 * behavior as the list rows.
 */
export function IconGrid({
	rows,
	listRef,
	searching,
	summary,
	emptyText,
	selectedKeys,
	focusedZone,
	flashPath,
	renamePath,
	renameDraft,
	versionFamilyError,
	onRetryVersionFamilies,
	callbacks,
}: {
	readonly rows: readonly StackRow[];
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly searching: boolean;
	readonly summary: string;
	readonly emptyText: string;
	readonly selectedKeys: readonly string[];
	readonly focusedZone: boolean;
	readonly flashPath: string | null;
	readonly renamePath: string | null;
	readonly renameDraft: string;
	readonly versionFamilyError: VersionFamilyError | null;
	readonly onRetryVersionFamilies: () => void;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	return (
		<div className="list list--icons flex-1 min-h-0 overflow-auto p-12" ref={listRef}>
			<VersionFamilyBanner error={versionFamilyError} onRetry={onRetryVersionFamilies} />
			{searching ? (
				<div className="list__summary pt-6 px-12 pb-8 text-ink-muted text-meta">{summary}</div>
			) : null}
			<div
				className="icon-grid grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-4 gap-y-8 items-start"
				role="listbox"
				aria-label="Files"
				aria-multiselectable="true"
			>
				{rows.map((row) => (
					<IconTile
						key={row.entry.path}
						entry={row.entry}
						selected={selectedKeys.includes(row.entry.path)}
						zoneFocused={focusedZone}
						flash={flashPath === row.entry.path}
						child={row.child}
						stackCount={row.stackCount}
						stackOpen={row.stackOpen}
						renameDraft={renamePath === row.entry.path ? renameDraft : null}
						callbacks={callbacks}
					/>
				))}
			</div>
			{rows.length === 0 ? (
				<div className="list__empty py-40 px-12 text-ink-muted text-body text-center">{emptyText}</div>
			) : null}
		</div>
	);
}

function IconTile({
	entry,
	selected,
	zoneFocused,
	flash,
	child,
	stackCount,
	stackOpen,
	renameDraft,
	callbacks,
}: {
	readonly entry: FinderEntry;
	readonly selected: boolean;
	readonly zoneFocused: boolean;
	readonly flash: boolean;
	readonly child: boolean;
	readonly stackCount: number;
	readonly stackOpen: boolean;
	readonly renameDraft: string | null;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	const classes = ["icon-tile"];
	if (isHiddenName(entry.name)) classes.push("icon-tile--hidden");
	if (selected) classes.push(zoneFocused ? "icon-tile--selected-focused" : "icon-tile--selected");
	if (flash) classes.push("icon-tile--flash");
	if (child) classes.push("icon-tile--child");
	classes.push(
		"group flex flex-col items-center gap-6 min-w-0 pt-8 px-4 pb-6 rounded-8 select-none cursor-default transition-[background,box-shadow] duration-(--dur-flash-fade) ease-[ease]",
		flash ? "bg-accent-flash shadow-[inset_0_0_0_1px_var(--accent-flash-ring)]" : "",
		isHiddenName(entry.name) ? "opacity-45" : "",
	);
	const labelBg = selected ? (zoneFocused ? "bg-accent-soft" : "bg-input") : "";
	return (
		<div
			className={classes.join(" ")}
			role="option"
			aria-selected={selected}
			aria-label={entry.name}
			data-path={entry.path}
			title={entry.name}
			onClick={(event) => callbacks.onClick(entry, event)}
			onDoubleClick={() => callbacks.onOpen(entry)}
			onContextMenu={(event) => callbacks.onContextMenu(entry, event)}
		>
			<div
				className={[
					"icon-tile__art relative flex items-center justify-center w-[72px] h-[72px] rounded-8",
					child ? "shadow-[inset_0_0_0_1px_var(--border-strong)]" : "",
					// The art background is the one place a selection tint does not
					// win: `.icon-tile:hover .icon-tile__art` is (0,3,0) while the
					// selected variants are (0,2,0), so the hover wash still applies.
					selected ? (zoneFocused ? "bg-accent-soft" : "bg-input") : "",
					"group-hover:bg-hover-row",
				].join(" ")}
			>
				<FileTile kind={entry.fileKind} iconDataUrl={entry.iconDataUrl} size={64} />
				{stackCount > 0 ? (
					<button
						type="button"
						className={[
							`icon-tile__stack${stackOpen ? " icon-tile__stack--open" : ""}`,
							"absolute -right-4 -bottom-2 min-w-20 h-18 px-5 border border-window rounded-9 text-badge font-semibold cursor-pointer",
							stackOpen ? "bg-border-strong text-ink" : "bg-border text-ink-body",
						].join(" ")}
						title={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-label={`다른 버전 ${stackCount}개 · 클릭하면 펼쳐집니다`}
						aria-expanded={stackOpen}
						onClick={(event) => {
							event.stopPropagation();
							callbacks.onToggleStack(entry);
						}}
						onDoubleClick={(event) => event.stopPropagation()}
					>
						{stackCount}
					</button>
				) : null}
			</div>
			{renameDraft === null ? (
				<span
					className={[
						"icon-tile__label line-clamp-2 max-w-full py-px px-4 rounded-4 text-meta leading-[1.3] text-center break-all",
						child ? "text-ink-body" : "text-ink",
						labelBg,
					].join(" ")}
				>
					{tileLabel(entry.name)}
				</span>
			) : (
				<RenameInput
					className="icon-tile__rename w-full h-pill px-5 border border-accent rounded-5 outline-none bg-window text-ink text-meta text-center"
					draft={renameDraft}
					callbacks={callbacks}
				/>
			)}
		</div>
	);
}
