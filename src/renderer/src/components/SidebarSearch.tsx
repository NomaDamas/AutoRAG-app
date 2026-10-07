import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { formatShortcut, hostPlatform } from "../lib/shortcuts";
import { SearchIcon } from "./icons";
import { Keycap } from "./primitives/Keycap";

/** What Enter commits against: a filename search over the whole machine, or the AI content search. */
export type SearchMode = "name" | "content";

const CHIP_CLASS =
	"flex-1 min-w-0 h-pill px-8 border border-transparent rounded-11 text-badge whitespace-nowrap cursor-default transition-[background,color,border-color] duration-(--dur-color) ease-[ease]";

/**
 * The sidebar's instant search (mockup: `.side-search`). Sits at the top of the
 * Places list, above the nav groups. Enter commits a filename search over the
 * whole machine ("파일 이름"); ⌥Enter — or the 내용 chip — runs the AI content
 * search. The chips only appear while the field has focus, so the resting
 * sidebar stays uncluttered.
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
	/** mode + raw text; an empty text clears the committed search. */
	readonly onSubmit: (mode: SearchMode, text: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(query);
	const [mode, setMode] = useState<SearchMode>("name");
	const machine = hostPlatform() === "win32" ? t("scopeBar.thisComputer", "컴퓨터") : t("scopeBar.thisMac", "Mac");
	const chips: readonly { readonly mode: SearchMode; readonly label: string; readonly hint: string }[] = useMemo(
		() => [
			{
				mode: "name",
				label: t("sidebarSearch.fileName", "파일 이름"),
				hint: t("sidebarSearch.fileNameHint", { machine, defaultValue: `이 ${machine} 전체에서 파일 이름 검색` }),
			},
			{
				mode: "content",
				label: t("sidebarSearch.content", "내용"),
				hint: t("sidebarSearch.contentHint", {
					shortcut: formatShortcut({ key: "Enter", alt: true, primary: false }),
					defaultValue: `AI로 파일 내용 검색 (${formatShortcut({ key: "Enter", alt: true, primary: false })})`,
				}),
			},
		],
		[t, machine],
	);

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
			onSubmit(event.altKey ? "content" : mode, draft);
		} else if (event.key === "Escape") {
			event.preventDefault();
			if (draft !== "") {
				setDraft("");
				onSubmit(mode, "");
			} else {
				inputRef.current?.blur();
			}
		}
	};

	const clear = (): void => {
		setDraft("");
		onSubmit(mode, "");
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
					placeholder={t("sidebarSearch.placeholder", "검색")}
					aria-label={t("sidebarSearch.placeholder", "검색")}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					onFocus={onFocus}
					onBlur={onBlur}
				/>
				{draft !== "" ? (
					<button
						type="button"
						className="flex-none flex items-center justify-center size-16 p-0 border-0 rounded-full bg-border-strong text-on-accent text-[9px] leading-none cursor-default hover:bg-ink-muted"
						title={t("sidebarSearch.clearSearch", "검색어 지우기")}
						aria-label={t("sidebarSearch.clearSearch", "검색어 지우기")}
						onMouseDown={keepFocus}
						onClick={clear}
					>
						✕
					</button>
				) : showHotkeys && !focused ? (
					<Keycap label={formatShortcut({ key: "F" })} />
				) : null}
			</label>
			{focused ? (
				<div className="search-scopes flex gap-2 mt-6 p-2 rounded-12 bg-hover" role="group" aria-label="검색 범위">
					{chips.map((chip) => (
						<button
							key={chip.mode}
							type="button"
							className={cn(
								"scope-chip",
								CHIP_CLASS,
								mode === chip.mode
									? "bg-window border-border text-ink"
									: "bg-transparent text-ink-muted hover:bg-hover-strong hover:text-ink",
							)}
							title={chip.hint}
							aria-pressed={mode === chip.mode}
							onMouseDown={keepFocus}
							onClick={() => setMode(chip.mode)}
						>
							{chip.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
