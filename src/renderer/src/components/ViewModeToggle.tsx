import type { ReactElement } from "react";
import type { ViewMode } from "../state/view-mode";
import type { ShortcutId } from "../../../shared/shortcuts-contract";
import { useFormattedShortcut } from "../hooks/useShortcutSettings";
import { ColumnsViewIcon, IconsViewIcon, ListViewIcon } from "./icons";

const OPTIONS: readonly { readonly mode: ViewMode; readonly label: string; readonly shortcutId: ShortcutId; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", label: "Icons", shortcutId: "viewIcons", Icon: IconsViewIcon },
	{ mode: "list", label: "List", shortcutId: "viewList", Icon: ListViewIcon },
	{ mode: "columns", label: "Columns", shortcutId: "viewColumns", Icon: ColumnsViewIcon },
];

/** Toolbar segmented control: how the Finder shows the folder (icons, list, columns). */
export function ViewModeToggle({
	mode,
	onChange,
}: {
	readonly mode: ViewMode;
	readonly onChange: (mode: ViewMode) => void;
}): ReactElement {
	const iconsShortcut = useFormattedShortcut("viewIcons");
	const listShortcut = useFormattedShortcut("viewList");
	const columnsShortcut = useFormattedShortcut("viewColumns");
	const shortcutByMode: Readonly<Record<ViewMode, string>> = {
		icons: iconsShortcut,
		list: listShortcut,
		columns: columnsShortcut,
	};
	return (
		<div
			className="view-toggle flex flex-none items-center gap-2 h-row p-2 border border-border rounded-8 bg-window"
			role="group"
			aria-label="View"
		>
			{OPTIONS.map(({ mode: option, label, Icon }) => (
				<button
					key={option}
					type="button"
					className={[
						`view-toggle__button${option === mode ? " view-toggle__button--active" : ""}`,
						"flex items-center justify-center w-[30px] h-[26px] p-0 border-0 rounded-6 transition-[background,color] duration-(--dur-color) ease-[ease]",
						option === mode
							? "bg-hover-strong text-ink hover:bg-hover-strong"
							: "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
					].join(" ")}
					title={`as ${label} (${shortcutByMode[option]})`}
					aria-label={label}
					aria-pressed={option === mode}
					onClick={() => onChange(option)}
				>
					<Icon size={17} />
				</button>
			))}
		</div>
	);
}
