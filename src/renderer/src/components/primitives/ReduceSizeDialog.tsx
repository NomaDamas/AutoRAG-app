import type { ReactElement } from "react";
import { useTranslation } from "../../../../shared/i18n";
import { formatByteSize, reducedCopyName, REDUCTION_LEVELS, type ReductionLevel } from "../../../../shared/size-reduction";
import { cn } from "../../lib/cn";
import type { ReduceSizeDialogState } from "../../state/reduce-size-dialog";
import { ProgressBar } from "./ProgressBar";

/**
 * "용량 줄이기" dialog: chooses compression strength (`light` / `balanced` / `max`)
 * and output mode (`replace` in place via Trash vs single `-reduced` copy), then
 * transforms into a live progress card with `Cancel` (and `Esc` via `dismiss`).
 */
export function ReduceSizeDialog({
	state,
	onChangeLevel,
	onChangeReplaceOriginal,
	onStart,
	onCancel,
}: {
	readonly state: ReduceSizeDialogState;
	readonly onChangeLevel: (level: ReductionLevel) => void;
	readonly onChangeReplaceOriginal: (replaceOriginal: boolean) => void;
	readonly onStart: () => void;
	readonly onCancel: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const sizeText = state.size !== null && state.size > 0 ? formatByteSize(state.size) : null;
	const copyName = reducedCopyName(state.name);

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !state.working) onCancel();
			}}
		>
			<div
				className="flex w-[460px] max-w-[calc(100vw-32px)] flex-col gap-14 p-16 border border-border rounded-10 bg-window shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="alertdialog"
				aria-modal="true"
				aria-label={t("finder.reduce.title")}
			>
				<div className="flex flex-col gap-4 min-w-0">
					<strong className="text-[13.5px] font-[650] text-ink">{t("finder.reduce.title")}</strong>
					<p className="m-0 truncate text-meta text-ink-muted" title={state.name}>
						{sizeText === null ? state.name : `${state.name} · ${sizeText}`}
					</p>
				</div>

				{state.working ? (
					<div className="flex flex-col gap-8">
						<div className="flex items-baseline justify-between gap-8 text-[13px]">
							<span className="min-w-0 flex-1 truncate text-ink-body">
								{t("inspector.actions.reducing", { name: state.name })}
							</span>
							{state.percent !== null ? (
								<span className="flex-none tabular-nums font-medium text-ink">{state.percent}%</span>
							) : null}
						</div>
						<ProgressBar
							percent={state.percent}
							tone="run"
							label={t("inspector.actions.reduceProgressAria", { name: state.name })}
						/>
						<p className="m-0 text-meta text-ink-muted">{t("finder.reduce.workingHint")}</p>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-6" role="radiogroup" aria-label={t("finder.reduce.levelLabel")}>
							<span className="text-badge font-semibold text-ink-muted">{t("finder.reduce.levelLabel")}</span>
							<div className="flex flex-col gap-6">
								{REDUCTION_LEVELS.map((level) => {
									const selected = state.level === level;
									return (
										<button
											key={level}
											type="button"
											role="radio"
											aria-checked={selected}
											data-level={level}
											className={cn(
												"flex w-full items-center justify-between gap-10 rounded-8 border px-12 py-8 text-left cursor-pointer transition-[background,border-color] duration-(--dur-color) ease-[ease]",
												selected
													? "border-accent bg-accent-wash text-ink"
													: "border-border bg-window text-ink-body hover:bg-hover",
											)}
											onClick={() => onChangeLevel(level)}
										>
											<span className="flex flex-none items-center gap-6 whitespace-nowrap text-[12.5px] font-[600] text-ink">
												{t(`finder.reduce.levels.${level}`)}
												{level === "balanced" ? (
													<span className="rounded-full bg-hover-strong px-6 py-1 text-[10.5px] font-medium text-ink-muted">
														{t("finder.reduce.recommended")}
													</span>
												) : null}
											</span>
											<span className="flex-none text-badge text-ink-muted">
												{t(`finder.reduce.specs.${state.kind}.${level}`)}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="flex flex-col gap-6" role="radiogroup" aria-label={t("finder.reduce.outputLabel")}>
							<span className="text-badge font-semibold text-ink-muted">{t("finder.reduce.outputLabel")}</span>
							<div className="grid grid-cols-2 gap-6">
								<button
									type="button"
									role="radio"
									aria-checked={state.replaceOriginal}
									data-output-mode="replace"
									className={cn(
										"h-30 rounded-8 border px-10 text-[12.5px] font-medium cursor-pointer transition-[background,border-color] duration-(--dur-color) ease-[ease]",
										state.replaceOriginal
											? "border-accent bg-accent-wash text-ink"
											: "border-border bg-window text-ink-body hover:bg-hover",
									)}
									onClick={() => onChangeReplaceOriginal(true)}
								>
									{t("finder.reduce.replaceMode")}
								</button>
								<button
									type="button"
									role="radio"
									aria-checked={!state.replaceOriginal}
									data-output-mode="copy"
									className={cn(
										"h-30 rounded-8 border px-10 text-[12.5px] font-medium cursor-pointer transition-[background,border-color] duration-(--dur-color) ease-[ease]",
										!state.replaceOriginal
											? "border-accent bg-accent-wash text-ink"
											: "border-border bg-window text-ink-body hover:bg-hover",
									)}
									onClick={() => onChangeReplaceOriginal(false)}
								>
									{t("finder.reduce.copyMode")}
								</button>
							</div>
							<p className="m-0 text-meta text-ink-muted">
								{state.replaceOriginal
									? t("finder.reduce.replaceHint", { name: state.name })
									: t("finder.reduce.copyHint", { copyName })}
							</p>
						</div>
					</>
				)}

				<div className="flex items-center justify-end gap-8 pt-2">
					<button type="button" className="linear-btn" onClick={onCancel}>
						{t("common.cancel")}
					</button>
					{state.working ? null : (
						<button
							type="button"
							data-action="confirm-reduce"
							autoFocus
							className="inline-flex h-[30px] items-center justify-center rounded-6 border border-accent bg-accent px-12 text-[12.5px] font-medium text-on-accent cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-accent-hover"
							onClick={onStart}
						>
							{t("inspector.actions.reduceSize")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
