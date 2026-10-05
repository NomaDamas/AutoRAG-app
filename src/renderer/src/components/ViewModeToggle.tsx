import type { ReactElement } from "react";
import type { ViewMode } from "../state/view-mode";
import { formatShortcut } from "../lib/shortcuts";
import { ColumnsViewIcon, IconsViewIcon, ListViewIcon } from "./icons";

const OPTIONS: readonly { readonly mode: ViewMode; readonly label: string; readonly key: string; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", label: "Icons", key: "1", Icon: IconsViewIcon },
	{ mode: "list", label: "List", key: "2", Icon: ListViewIcon },
	{ mode: "columns", label: "Columns", key: "3", Icon: ColumnsViewIcon },
];

/** Toolbar segmented control: how the Finder shows the folder (icons, list, columns). */
export function ViewModeToggle({
	mode,
	onChange,
}: {
	readonly mode: ViewMode;
	readonly onChange: (mode: ViewMode) => void;
}): ReactElement {
	return (
		<div
			className="view-toggle flex flex-none items-center gap-2 h-row p-2 border border-border rounded-8 bg-window"
			role="group"
			aria-label="View"
		>
			{OPTIONS.map(({ mode: option, label, key, Icon }) => (
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
					title={`as ${label} (${formatShortcut({ key })})`}
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
