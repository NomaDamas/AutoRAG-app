import { Fragment } from "react";
import type { ChangeEvent, KeyboardEvent, ReactElement, RefObject } from "react";
import type { Crumb } from "../state/paths";
import type { ViewMode } from "../state/view-mode";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "./icons";
import { Keycap } from "./primitives/Keycap";
import { iconButtonClass } from "./primitives/icon-button";
import { ViewModeToggle } from "./ViewModeToggle";

/**
 * Toolbar (handoff README §2): back/forward, truncated breadcrumbs, the view
 * mode toggle, and the 236 × 32 instant-search field.
 */
export function Toolbar({
	crumbs,
	canGoBack,
	canGoForward,
	query,
	placeholder,
	searchFocused,
	showHotkeys,
	searchRef,
	viewMode,
	onViewModeChange,
	onNavigate,
	onBack,
	onForward,
	onQueryChange,
	onSearchKeyDown,
	onSearchFocus,
	onSearchBlur,
}: {
	readonly crumbs: readonly Crumb[];
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly query: string;
	readonly placeholder: string;
	readonly searchFocused: boolean;
	readonly showHotkeys: boolean;
	readonly searchRef: RefObject<HTMLInputElement | null>;
	readonly viewMode: ViewMode;
	readonly onViewModeChange: (mode: ViewMode) => void;
	readonly onNavigate: (path: string) => void;
	readonly onBack: () => void;
	readonly onForward: () => void;
	readonly onQueryChange: (value: string) => void;
	readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	readonly onSearchFocus: () => void;
	readonly onSearchBlur: () => void;
}): ReactElement {
	return (
		<div className="toolbar flex flex-none items-center gap-8 h-toolbar px-12 bg-window border-b border-border">
			<button
				type="button"
				className={`icon-button ${iconButtonClass()}`}
				title="Back"
				aria-label="Back"
				disabled={!canGoBack}
				onClick={onBack}
			>
				<ChevronLeftIcon />
			</button>
			<button
				type="button"
				className={`icon-button ${iconButtonClass()}`}
				title="Forward"
				aria-label="Forward"
				disabled={!canGoForward}
				onClick={onForward}
			>
				<ChevronRightIcon />
			</button>
			<nav className="crumbs flex flex-1 items-center gap-2 min-w-0 overflow-hidden" aria-label="Location">
				{crumbs.map((crumb) => (
					<Fragment key={crumb.path}>
						{crumb.separator ? <span className="crumbs__sep text-border-strong text-body px-2">/</span> : null}
						<button
							type="button"
							className={[
								`crumb${crumb.isLast ? " crumb--last" : ""}`,
								"min-w-0 max-w-crumb-max h-icon-sm px-6 border-0 rounded-6 bg-transparent text-body overflow-hidden whitespace-nowrap text-ellipsis transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover-icon",
								crumb.isLast ? "flex-none text-ink font-semibold" : "flex-[0_1_auto] text-ink-muted",
							].join(" ")}
							title={crumb.label}
							onClick={() => onNavigate(crumb.path)}
						>
							{crumb.label}
						</button>
					</Fragment>
				))}
			</nav>
			<ViewModeToggle mode={viewMode} onChange={onViewModeChange} />
			<div
				className={[
					`search${searchFocused ? " search--focused" : ""}`,
					"flex flex-none items-center gap-8 w-search-field h-row pl-10 pr-8 border rounded-10 bg-input transition-[border-color] duration-(--dur-modal) ease-[ease]",
					searchFocused ? "border-accent" : "border-border",
				].join(" ")}
			>
				<SearchIcon className="search__icon flex-none text-ink-muted" />
				<input
					ref={searchRef}
					className="search__input flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-meta"
					type="text"
					value={query}
					placeholder={placeholder}
					aria-label={placeholder}
					onChange={(event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value)}
					onKeyDown={onSearchKeyDown}
					onFocus={onSearchFocus}
					onBlur={onSearchBlur}
				/>
				{showHotkeys ? <Keycap label="⌘F" /> : null}
			</div>
		</div>
	);
}
