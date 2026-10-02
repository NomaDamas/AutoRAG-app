import type { ReactElement } from "react";
import type { ViewMode } from "../state/view-mode";
import { ColumnsViewIcon, IconsViewIcon, ListViewIcon } from "./icons";

const OPTIONS: readonly { readonly mode: ViewMode; readonly label: string; readonly keycap: string; readonly Icon: typeof IconsViewIcon }[] = [
	{ mode: "icons", label: "Icons", keycap: "⌘1", Icon: IconsViewIcon },
	{ mode: "list", label: "List", keycap: "⌘2", Icon: ListViewIcon },
	{ mode: "columns", label: "Columns", keycap: "⌘3", Icon: ColumnsViewIcon },
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
		<div className="view-toggle" role="group" aria-label="View">
			{OPTIONS.map(({ mode: option, label, keycap, Icon }) => (
				<button
					key={option}
					type="button"
					className={`view-toggle__button${option === mode ? " view-toggle__button--active" : ""}`}
					title={`as ${label} (${keycap})`}
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
