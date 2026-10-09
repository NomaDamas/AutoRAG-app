import type { ReactElement } from "react";

/**
 * A centered destructive-action confirm (issue #86's 휴지통 비우기): an overlay
 * the app cannot style around, with the action's name, the consequence, and a
 * default-focused safe cancel — the cancel stays the keyboard's "Enter" path
 * unless the operator deliberately clicks the danger button. Esc is handled by
 * the window keymap (`dismiss`), which closes this before anything else.
 */
export function ConfirmDialog({
	title,
	message,
	confirmLabel,
	cancelLabel,
	danger = false,
	onConfirm,
	onCancel,
}: {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel: string;
	readonly cancelLabel: string;
	/** The confirm runs a destructive action, so it carries the danger styling. */
	readonly danger?: boolean;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}): ReactElement {
	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onCancel();
			}}
		>
			<div
				className="flex w-360 flex-col gap-16 p-16 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="alertdialog"
				aria-modal="true"
				aria-label={title}
			>
				<div className="flex flex-col gap-6">
					<strong className="text-[13px] font-[650] text-ink">{title}</strong>
					<p className="m-0 text-[13px] leading-normal text-ink-body">
						{message}
					</p>
				</div>
				<div className="flex items-center justify-end gap-8">
					<button
						type="button"
						className="linear-btn"
						autoFocus
						onClick={onCancel}
					>
						{cancelLabel}
					</button>
					<button
						type="button"
						className={danger ? "linear-btn is-danger" : "linear-btn"}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
