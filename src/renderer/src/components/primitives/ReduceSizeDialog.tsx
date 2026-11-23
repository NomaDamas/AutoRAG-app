import type { ReactElement } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../../../shared/i18n";
import { formatByteSize, reducedCopyName, REDUCTION_LEVELS, type ReductionLevel } from "../../../../shared/size-reduction";
import { cn } from "../../lib/cn";
import type { ReduceSizeDialogState } from "../../state/reduce-size-dialog";
import { ProgressBar } from "./ProgressBar";

/**
 * "용량 줄이기" dialog (Figma 605:3510, 605:3563): chooses compression strength (`light` / `balanced` / `max`) and
 * output mode (`replace` in place via Trash vs single `-reduced` copy), then becomes a live progress card with
 * 취소 and 백그라운드로 전환 (`Esc` via `dismiss`).
 */
export function ReduceSizeDialog({
	state,
	onChangeLevel,
	onChangeReplaceOriginal,
	onStart,
	onCancel,
	onMinimize,
}: {
	readonly state: ReduceSizeDialogState;
	readonly onChangeLevel: (level: ReductionLevel) => void;
	readonly onChangeReplaceOriginal: (replaceOriginal: boolean) => void;
	readonly onStart: () => void;
	readonly onCancel: () => void;
	readonly onMinimize?: (() => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const sizeText = state.size !== null && state.size > 0 ? formatByteSize(state.size) : null;
	const copyName = reducedCopyName(state.name);
	const button = "inline-flex h-32 items-center justify-center rounded-6 px-12 text-meta font-medium cursor-pointer transition-opacity duration-(--dur-color) ease-out hover:opacity-80";

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					if (!state.working) onCancel();
					else onMinimize?.();
				}
			}}
		>
			<div
				className="flex w-[480px] max-w-[calc(100vw-32px)] flex-col gap-20 rounded-[16px] border border-divider bg-window p-20 shadow-[0_10px_35px_rgba(0,0,0,0.2)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="alertdialog"
				aria-modal="true"
				aria-label={t("finder.reduce.title")}
			>
				<div className="flex items-start justify-between gap-12">
					<div className="flex min-w-0 flex-col gap-4">
						<strong className="text-body font-bold leading-[19px] text-ink">{t("finder.reduce.title")}</strong>
						<p className="m-0 truncate text-badge leading-[16px] text-ink-muted" title={state.name}>
							{sizeText === null ? state.name : `${state.name} · ${sizeText}`}
						</p>
					</div>
					{/* While it runs, closing keeps it running in the background; before, it cancels. */}
					<button
						type="button"
						data-action="close-reduce"
						aria-label={t("common.close")}
						className="-mr-4 -mt-2 grid size-24 flex-none place-items-center rounded-6 border-0 bg-transparent text-ink-muted cursor-pointer hover:bg-hover hover:text-ink"
						onClick={() => (state.working ? onMinimize?.() : onCancel())}
					>
						<X size={14} aria-hidden="true" />
					</button>
				</div>

				{state.working ? (
					<div className="flex flex-col gap-8">
						<div className="flex items-baseline justify-between gap-8">
							<span className="min-w-0 flex-1 truncate text-meta leading-[16px] text-ink-body">{t("finder.reduce.working")}</span>
							{state.percent !== null ? <span className="flex-none text-[13px] font-medium tabular-nums text-ink">{state.percent}%</span> : null}
						</div>
						<ProgressBar percent={state.percent} tone="run" label={t("inspector.actions.reduceProgressAria", { name: state.name })} />
						<p className="m-0 text-badge leading-[16px] text-ink-muted">{t("finder.reduce.workingHint")}</p>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-6" role="radiogroup" aria-label={t("finder.reduce.levelLabel")}>
							<span className="text-badge font-medium leading-[14px] text-ink-muted">{t("finder.reduce.levelLabel")}</span>
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
											"flex w-full items-center gap-10 rounded-6 border px-12 py-8 text-left cursor-pointer transition-[background,border-color] duration-(--dur-color) ease-[ease]",
											selected ? "border-accent bg-subtle-alt" : "border-border bg-window hover:bg-hover",
										)}
										onClick={() => onChangeLevel(level)}
									>
										<span className="flex flex-none items-center gap-6 whitespace-nowrap text-[13px] font-medium leading-[18px] text-ink">
											{t(`finder.reduce.levels.${level}`)}
											{level === "balanced" ? (
												<span className="rounded-[5px] bg-accent-soft px-6 py-px text-badge font-normal leading-[16px] text-accent-text">{t("finder.reduce.recommended")}</span>
											) : null}
										</span>
										<span className="min-w-0 flex-1 text-right text-badge leading-[16px] text-ink-muted">{t(`finder.reduce.specs.${state.kind}.${level}`)}</span>
									</button>
								);
							})}
						</div>

						<div className="flex flex-col gap-6" role="radiogroup" aria-label={t("finder.reduce.outputLabel")}>
							<span className="text-badge font-medium leading-[14px] text-ink-muted">{t("finder.reduce.outputLabel")}</span>
							<div className="flex gap-2 rounded-10 bg-input p-3">
								{([true, false] as const).map((replace) => {
									const selected = state.replaceOriginal === replace;
									return (
										<button
											key={String(replace)}
											type="button"
											role="radio"
											aria-checked={selected}
											data-output-mode={replace ? "replace" : "copy"}
											className={cn(
												"flex-1 rounded-8 border-[0.5px] px-12 py-6 text-[13px] leading-[19px] cursor-pointer",
												selected ? "border-border bg-window font-medium text-ink" : "border-transparent bg-transparent text-ink-muted hover:text-ink",
											)}
											onClick={() => onChangeReplaceOriginal(replace)}
										>
											{t(replace ? "finder.reduce.replaceMode" : "finder.reduce.copyMode")}
										</button>
									);
								})}
							</div>
							<p className="m-0 text-badge leading-[16px] text-ink-muted">
								{state.replaceOriginal ? t("finder.reduce.replaceHint", { name: state.name }) : t("finder.reduce.copyHint", { copyName })}
							</p>
						</div>
					</>
				)}

				<div className="flex items-center justify-end gap-8">
					<button type="button" className={cn(button, "border border-border bg-window text-ink-body")} onClick={onCancel}>
						{t("common.cancel")}
					</button>
					{state.working ? (
						onMinimize === undefined ? null : (
							<button type="button" data-action="minimize-reduce" autoFocus className={cn(button, "border-0 bg-accent text-on-accent")} onClick={onMinimize}>
								{t("sidebarActivity.minimize")}
							</button>
						)
					) : (
						<button type="button" data-action="confirm-reduce" autoFocus className={cn(button, "border-0 bg-accent text-on-accent")} onClick={onStart}>
							{t("inspector.actions.reduceSize")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
