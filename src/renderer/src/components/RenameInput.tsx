import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactElement } from "react";
import type { RowCallbacks } from "./FileRow";

/** Inline rename field shared by the icon tiles and the column rows. */
export function RenameInput({
	className,
	draft,
	callbacks,
}: {
	readonly className: string;
	readonly draft: string;
	readonly callbacks: RowCallbacks;
}): ReactElement {
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: inline rename must take the caret immediately
			autoFocus
			className={className}
			type="text"
			value={draft}
			aria-label="새 이름"
			onChange={(event: ChangeEvent<HTMLInputElement>) => callbacks.onRenameChange(event.target.value)}
			onClick={(event: MouseEvent<HTMLInputElement>) => event.stopPropagation()}
			onDoubleClick={(event: MouseEvent<HTMLInputElement>) => event.stopPropagation()}
			onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
				if (event.key === "Enter") {
					event.preventDefault();
					callbacks.onRenameCommit();
				}
				if (event.key === "Escape") {
					event.preventDefault();
					callbacks.onRenameCancel();
				}
			}}
			onBlur={callbacks.onRenameCancel}
		/>
	);
}
