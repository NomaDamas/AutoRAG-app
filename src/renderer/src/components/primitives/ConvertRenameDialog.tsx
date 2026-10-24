import type { ReactElement } from "react";
import { useTranslation } from "../../../../shared/i18n";
import type { ConvertRenameState } from "../../state/convert-rename";
import { ProgressBar } from "./ProgressBar";

/**
 * The question a rename to another format asks before it converts: keep the
 * original beside the converted file, or replace it (the original goes to the
 * Trash). "Keep" is the default focus — the choice that loses nothing. Once the
 * conversion runs the same dialog turns into a progress card whose only button
 * stops it; Esc is handled by the window keymap (`dismiss`) the same way.
 */
export function ConvertRenameDialog({
	state,
	onConvert,
	onCancel,
}: {
	readonly state: ConvertRenameState;
	readonly onConvert: (keepOriginal: boolean) => void;
	readonly onCancel: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const title = `${state.from.toUpperCase()} → ${state.to.toUpperCase()}`;
	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !state.working) onCancel();
			}}
		>
			<div
				className="flex w-380 flex-col gap-16 p-16 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="alertdialog"
				aria-modal="true"
				aria-label={t("finder.convert.title")}
			>
				<div className="flex flex-col gap-6">
					<strong className="text-[13px] font-[650] text-ink">{title}</strong>
					<p className="m-0 text-[13px] leading-normal text-ink-body">
						{state.working
							? t("finder.convert.working", { newName: state.newName })
							: t("finder.convert.message", { name: state.name, newName: state.newName })}
					</p>
					{state.working ? <ProgressBar percent={null} tone="run" label={t("finder.convert.progressAria")} /> : null}
					<p className="m-0 text-meta text-ink-muted">
						{state.working ? t("finder.convert.workingHint") : t("finder.convert.replaceHint")}
					</p>
				</div>
				<div className="flex items-center justify-end gap-8">
					<button type="button" className="linear-btn" onClick={onCancel}>
						{t("common.cancel")}
					</button>
					{state.working ? null : (
						<>
							<button type="button" className="linear-btn" onClick={() => onConvert(false)}>
								{t("finder.convert.replace")}
							</button>
							<button type="button" className="linear-btn" autoFocus onClick={() => onConvert(true)}>
								{t("finder.convert.keep")}
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
