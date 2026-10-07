import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { CONTEXT_MENU_WIDTH, menuHeightForItems, menuPlacement } from "../state/context-menu";
import { GROUP_OPTIONS, type GroupKey } from "../state/grouping";
import { SORT_OPTIONS, cycleSort, type SortDirection, type SortKey, type SortState } from "../state/sort";
import { CheckIcon } from "./icons";

/** Shared native-style Sort/Group menu; both controls use the controller's state. */
export function ToolbarMenu({
	kind,
	anchor,
	trigger,
	sort,
	grouping,
	onSort,
	onGroup,
	onClose,
}: {
	readonly kind: "sort" | "group";
	readonly anchor: { readonly x: number; readonly y: number };
	readonly trigger: HTMLButtonElement;
	readonly sort: SortState | null;
	readonly grouping: GroupKey;
	readonly onSort: (key: SortKey, direction: SortDirection) => void;
	readonly onGroup: (key: GroupKey) => void;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	const closeAndFocus = (): void => {
		onClose();
		trigger.focus();
	};

	useEffect(() => {
		const node = ref.current;
		(node?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? node?.querySelector<HTMLButtonElement>("button"))?.focus();
		const outside = (event: PointerEvent): void => {
			if (!(event.target instanceof HTMLElement)) return;
			// The controls toggle themselves on click; dismissing on pointerdown
			// first would reopen the same menu instead of closing it.
			if (node?.contains(event.target) || event.target.closest(".toolbar__control")) return;
			onClose();
		};
		window.addEventListener("pointerdown", outside);
		window.addEventListener("resize", onClose);
		window.addEventListener("blur", onClose);
		return () => {
			window.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("blur", onClose);
		};
	}, [onClose, kind]);

	const itemCount = kind === "sort" ? SORT_OPTIONS.length + 2 : GROUP_OPTIONS.length;
	const height = Math.min(menuHeightForItems(itemCount) + 9, window.innerHeight - 16);
	const placement = menuPlacement(anchor, { width: CONTEXT_MENU_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight });
	const row = (label: string, selected: boolean, onClick: () => void): ReactElement => (
		<button
			key={label}
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			tabIndex={-1}
			className="menu__item flex flex-none items-center gap-8 w-full h-icon-sm px-10 border-0 rounded-6 bg-transparent text-ink text-sm text-left whitespace-nowrap cursor-default transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover focus:bg-hover focus:outline-none"
			onClick={onClick}
		>
			<span className="flex flex-none items-center justify-center size-16">{selected ? <CheckIcon /> : null}</span>
			<span className="flex-1">{label}</span>
		</button>
	);

	return (
		<div
			ref={ref}
			className="menu fixed z-60 flex flex-col w-context-menu p-4 border border-border rounded-10 bg-window shadow-menu overflow-y-auto animate-[rise_var(--dur-menu)_var(--ease-out)] [-webkit-app-region:no-drag]"
			role="menu"
			aria-label={kind === "sort" ? t("toolbar.sort", "Sort") : t("toolbar.group", "Group")}
			style={{ left: placement.left, top: placement.top, maxHeight: window.innerHeight - 16 }}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					closeAndFocus();
				} else if (event.key === "Tab") {
					onClose();
				} else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
					event.preventDefault();
					const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
					buttons[next]?.focus();
				}
			}}
		>
			{kind === "sort" ? (
				<>
					{SORT_OPTIONS.map((option) => row(t(`sort.${option.key}`, option.label), sort?.key === option.key, () => {
						const direction = sort?.key === option.key ? sort.dir : cycleSort(null, option.key)?.dir ?? 1;
						onSort(option.key, direction);
						closeAndFocus();
					}))}
					<div className="flex-none h-px mx-6 my-4 bg-border" role="separator" />
					{row(t("sort.ascending", "Ascending"), sort?.dir === 1, () => { onSort(sort?.key ?? "name", 1); closeAndFocus(); })}
					{row(t("sort.descending", "Descending"), sort?.dir === -1, () => { onSort(sort?.key ?? "name", -1); closeAndFocus(); })}
				</>
			) : (
				GROUP_OPTIONS.map((option, index) => (
					<div key={option.key} className="flex-none">
						{index === 1 ? <div className="h-px mx-6 my-4 bg-border" role="separator" /> : null}
						{row(t(`sort.${option.key}`, option.label), grouping === option.key, () => { onGroup(option.key); closeAndFocus(); })}
					</div>
				))
			)}
		</div>
	);
}
