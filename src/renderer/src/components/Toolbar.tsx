import { useEffect, useState } from "react";
import type { KeyboardEvent, ReactElement, RefObject } from "react";
import type { ViewMode } from "../state/view-mode";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ColumnsViewIcon,
	FolderPlusIcon,
	IconsViewIcon,
	ListRowsIcon,
	PanelLeftIcon,
	PanelRightIcon,
	SearchIcon,
} from "./icons";
import { Keycap } from "./primitives/Keycap";

const VIEW_OPTIONS: readonly { readonly mode: ViewMode; readonly label: string; readonly keycap: string; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", label: "Icons", keycap: "⌘1", Icon: IconsViewIcon },
	{ mode: "list", label: "List", keycap: "⌘2", Icon: ListRowsIcon },
	{ mode: "columns", label: "Columns", keycap: "⌘3", Icon: ColumnsViewIcon },
];

const NAV_BUTTON =
	"flex flex-none items-center justify-center size-icon-sm p-0 border-0 rounded-6 bg-transparent text-ink-body transition-[background] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-ink-faint disabled:cursor-default";

/**
 * Toolbar (v7 handoff, screenshots 01/12): back/forward, the folder title, the
 * view segmented control, the inspector toggle and the draft-commit search
 * field with its Filenames / Content suggestion dropdown.
 */
export function Toolbar({
	title,
	canGoBack,
	canGoForward,
	onBack,
	onForward,
	viewMode,
	onViewModeChange,
	inspectorVisible,
	onToggleInspector,
	committedQuery,
	onCommitQuery,
	onContentSearch,
	searchRef,
	searchFocused,
	onSearchFocus,
	onSearchBlur,
	showHotkeys,
	placeholder,
	sidebarHidden,
	onShowSidebar,
	onNewFolder,
}: {
	readonly title: string;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly onBack: () => void;
	readonly onForward: () => void;
	readonly viewMode: ViewMode;
	readonly onViewModeChange: (mode: ViewMode) => void;
	readonly inspectorVisible: boolean;
	readonly onToggleInspector: () => void;
	readonly committedQuery: string;
	readonly onCommitQuery: (query: string) => void;
	readonly onContentSearch: (query: string) => void;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	readonly searchFocused: boolean;
	readonly onSearchFocus: () => void;
	readonly onSearchBlur: () => void;
	readonly showHotkeys: boolean;
	readonly placeholder: string;
	readonly sidebarHidden: boolean;
	readonly onShowSidebar: () => void;
	readonly onNewFolder: () => void;
}): ReactElement {
	const [draft, setDraft] = useState(committedQuery);

	useEffect(() => {
		setDraft(committedQuery);
	}, [committedQuery]);

	const commit = (query: string): void => {
		onCommitQuery(query.trim());
		searchRef.current?.blur();
	};

	const runContentSearch = (): void => {
		const query = draft.trim();
		if (query !== "") onContentSearch(query);
		setDraft("");
		onCommitQuery("");
		searchRef.current?.blur();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			if (event.altKey) runContentSearch();
			else commit(draft);
		} else if (event.key === "Escape") {
			event.preventDefault();
			setDraft("");
			onCommitQuery("");
			searchRef.current?.blur();
		}
	};

	const suggestion = draft.trim();

	return (
		<div className="toolbar flex flex-none items-center gap-6 h-toolbar px-12 bg-linear-to-b from-window to-subtle-alt border-b border-border [-webkit-app-region:drag]">
			{sidebarHidden ? (
				<>
					<span className="w-[70px] flex-none" aria-hidden="true" />
					<button
						type="button"
						className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
						title="Show sidebar"
						aria-label="Show sidebar"
						onClick={onShowSidebar}
					>
						<PanelLeftIcon />
					</button>
					<button
						type="button"
						className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
						title="New folder"
						aria-label="New folder"
						onClick={onNewFolder}
					>
						<FolderPlusIcon />
					</button>
				</>
			) : null}
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title="Back"
				aria-label="Back"
				disabled={!canGoBack}
				onClick={onBack}
			>
				<ChevronLeftIcon />
			</button>
			<button
				type="button"
				className={`${NAV_BUTTON} [-webkit-app-region:no-drag]`}
				title="Forward"
				aria-label="Forward"
				disabled={!canGoForward}
				onClick={onForward}
			>
				<ChevronRightIcon />
			</button>
			<strong className="toolbar-title min-w-150 overflow-hidden whitespace-nowrap text-ellipsis text-[15px] font-[650] text-ink">
				{title}
			</strong>
			<span className="toolbar-spacer flex-1" />
			<div className="seg flex flex-none items-center p-2 rounded-10 bg-subtle-alt [-webkit-app-region:no-drag]" role="group" aria-label="View">
				{VIEW_OPTIONS.map(({ mode, label, keycap, Icon }) => (
					<button
						key={mode}
						type="button"
						className={[
							`seg__button${mode === viewMode ? " seg__button--active" : ""}`,
							"flex items-center justify-center w-[31px] h-[25px] min-w-[31px] p-0 border-0 rounded-7 transition-[background,color] duration-(--dur-color) ease-[ease]",
							mode === viewMode ? "bg-sel-mute text-ink" : "bg-transparent text-ink-muted hover:text-ink",
						].join(" ")}
						title={`as ${label} (${keycap})`}
						aria-label={label}
						aria-pressed={mode === viewMode}
						onClick={() => onViewModeChange(mode)}
					>
						<Icon size={14} />
					</button>
				))}
			</div>
			<button
				type="button"
				className={[
					"toolbar__inspector flex flex-none items-center justify-center size-icon-sm p-0 border-0 rounded-6 transition-[background,color] duration-(--dur-color) ease-[ease] [-webkit-app-region:no-drag]",
					inspectorVisible ? "bg-accent-wash text-accent" : "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
				].join(" ")}
				title={inspectorVisible ? "Hide inspector" : "Show inspector"}
				aria-label="Toggle inspector"
				aria-pressed={inspectorVisible}
				onClick={onToggleInspector}
			>
				<PanelRightIcon />
			</button>
			<div className="search-wrap relative flex flex-none items-center [-webkit-app-region:no-drag]">
				<div
					className={[
						"search flex items-center gap-8 w-search-field h-row pl-10 pr-8 border rounded-10 bg-input transition-[border-color] duration-(--dur-modal) ease-[ease]",
						"focus-within:border-accent",
						searchFocused ? "search--focused border-accent" : "border-border",
					].join(" ")}
				>
					<SearchIcon className="search__icon flex-none text-ink-muted" />
					<input
						ref={searchRef}
						className="search__input flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-meta"
						type="text"
						value={draft}
						placeholder={placeholder}
						aria-label={placeholder}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={onKeyDown}
						onFocus={onSearchFocus}
						onBlur={onSearchBlur}
					/>
					{draft !== "" ? (
						<button
							type="button"
							className="search-clear flex-none flex items-center justify-center size-16 p-0 border-0 rounded-full bg-border-strong text-on-accent text-[9px] leading-none cursor-default hover:bg-ink-muted"
							title="Clear search"
							aria-label="Clear search"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								setDraft("");
								onCommitQuery("");
								searchRef.current?.blur();
							}}
						>
							✕
						</button>
					) : showHotkeys && !searchFocused ? (
						<Keycap label="⌘F" />
					) : null}
				</div>
				{searchFocused && suggestion !== "" ? (
					<div
						className="search-dropdown absolute top-[calc(100%+6px)] right-0 z-[90] flex w-[260px] flex-col gap-2 p-4 bg-window border border-border rounded-10 shadow-menu"
						role="listbox"
						aria-label="Search suggestions"
						onMouseDown={(event) => event.preventDefault()}
					>
						<div className="search-dd-section px-8 pt-5 pb-3 text-tile font-semibold text-ink-muted uppercase tracking-[0.04em]">
							Filenames
						</div>
						<button
							type="button"
							className="search-dd-item search-dd-item--selected flex items-center gap-8 w-full h-[28px] px-9 border-0 rounded-6 bg-accent text-on-accent text-meta text-left cursor-default"
							role="option"
							aria-selected="true"
							onClick={() => commit(draft)}
						>
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								Name Contains “<strong className="font-semibold">{suggestion}</strong>”
							</span>
							<span className="search-dd-sub ml-auto flex-none text-badge text-on-accent/80">↵ Enter</span>
						</button>
						<div className="search-dd-section mt-4 px-8 pt-5 pb-3 text-tile font-semibold text-ink-muted uppercase tracking-[0.04em]">
							Content
						</div>
						<button
							type="button"
							className="search-dd-item flex items-center gap-8 w-full h-[28px] px-9 border-0 rounded-6 bg-transparent text-ink-body text-meta text-left cursor-default transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover"
							role="option"
							aria-selected="false"
							onClick={runContentSearch}
						>
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								✦ Contains “<strong className="font-semibold">{suggestion}</strong>”
							</span>
							<span className="search-dd-sub ml-auto flex-none text-badge text-ink-muted">
								⌥⌤ Option+Enter
							</span>
						</button>
					</div>
				) : null}
			</div>
		</div>
	);
}
