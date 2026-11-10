import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useFormattedShortcut } from "../hooks/useShortcutSettings";
import { SearchIcon } from "./icons";
import { Keycap } from "./primitives/Keycap";

/**
 * The sidebar's instant search (mockup: `.side-search`). Sits at the top of the
 * Places list, above the nav groups. Enter commits one whole search: file names
 * over the whole machine, the document index, and every connected datasource,
 * each answer under its own group tab (`WholeSearchBar`). Asking the AI is the
 * AI Search chat's job, never this field's.
 */
export function SidebarSearch({
	query,
	inputRef,
	focused,
	showHotkeys,
	onFocus,
	onBlur,
	onSubmit,
}: {
	/** The committed query; the input mirrors it until the user edits again. */
	readonly query: string;
	readonly inputRef: RefObject<HTMLInputElement | null>;
	readonly focused: boolean;
	readonly showHotkeys: boolean;
	readonly onFocus: () => void;
	readonly onBlur: () => void;
	/** The raw text; an empty text clears the committed search. */
	readonly onSubmit: (text: string) => void;
}): ReactElement {
	const focusSearchShortcut = useFormattedShortcut("focusSearch");
	const { t } = useTranslation();
	const [draft, setDraft] = useState(query);
	useEffect(() => {
		setDraft(query);
	}, [query]);

	const keepFocus = (event: MouseEvent<HTMLButtonElement>): void => {
		// Never let a chip or the clear button steal focus from the field.
		event.preventDefault();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			onSubmit(draft);
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (draft !== "") {
				setDraft("");
				onSubmit("");
			} else {
				inputRef.current?.blur();
			}
		}
	};

	const clear = (): void => {
		setDraft("");
		onSubmit("");
		inputRef.current?.focus();
	};

	return (
		<div className="sidebar-search flex-none px-10 pt-2 pb-8">
			<label className="side-search flex items-center gap-7 h-30 pl-9 pr-6 border border-transparent rounded-8 bg-hover text-ink-muted transition-[background,border-color,box-shadow,color] duration-(--dur-color) ease-[ease] hover:bg-hover-strong focus-within:bg-window focus-within:border-accent focus-within:text-accent-hover focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
				<SearchIcon className="flex-none" />
				<input
					ref={inputRef}
					className="flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-meta"
					type="text"
					value={draft}
					placeholder={t("sidebarSearch.placeholder")}
					aria-label={t("sidebarSearch.placeholder")}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					onFocus={onFocus}
					onBlur={onBlur}
				/>
				{draft !== "" ? (
					<button
						type="button"
						className="flex-none flex items-center justify-center size-16 p-0 border-0 rounded-full bg-border-strong text-on-accent text-[9px] leading-none cursor-default hover:bg-ink-muted"
						title={t("sidebarSearch.clearSearch")}
						aria-label={t("sidebarSearch.clearSearch")}
						onMouseDown={keepFocus}
						onClick={clear}
					>
						✕
					</button>
				) : showHotkeys && !focused ? (
					<Keycap label={focusSearchShortcut} />
				) : null}
			</label>
		</div>
	);
}
