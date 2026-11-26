import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { CheckIcon, ChevronDownIcon } from "../icons";

export interface ChipOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly icon?: ReactNode;
	/** A thin rule above this option, to set a group apart. */
	readonly divided?: boolean;
	/** A second, smaller line under the label. */
	readonly hint?: string;
}

/**
 * A word in a 언제 sentence (the 자동화 card, the 매직액션 modal): a small white chip that opens its choices below it.
 * `footer` sits under the choices, inside the menu (the extension field of the file-kind chip).
 */
export function ChipSelect<T extends string>({
	value,
	options,
	label,
	icon,
	round = false,
	disabled = false,
	testId,
	footer,
	onChange,
}: {
	readonly value: T | null;
	readonly options: readonly ChipOption<T>[];
	readonly label: string;
	readonly icon?: ReactNode;
	readonly round?: boolean;
	/** Read, not edited: one tone lighter, and it opens nothing. */
	readonly disabled?: boolean;
	readonly testId: string;
	/** Drawn under the choices; it is handed `close` so it can shut the menu once it is done. */
	readonly footer?: (close: () => void) => ReactNode;
	readonly onChange: (value: T) => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	const current = options.find((option) => option.value === value);
	return (
		<span ref={ref} className="relative inline-flex">
			<button
				type="button"
				data-testid={testId}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
				disabled={disabled}
				className={cn(
					"inline-flex items-center gap-4 px-8 py-4 border-[0.5px] border-divider bg-window text-meta leading-[18px] whitespace-nowrap",
					disabled ? "text-ink cursor-default" : "text-ink cursor-pointer hover:border-border",
					round ? "rounded-[13px]" : "rounded-[7px]",
				)}
				onClick={() => setOpen((was) => !was)}
			>
				{current?.icon ?? icon}
				<span>{current?.label ?? label}</span>
				<ChevronDownIcon size={12} className="text-ink-muted" />
			</button>
			{open ? (
				<div className="absolute left-0 top-[calc(100%+4px)] z-30 w-max min-w-full rounded-8 border border-border bg-window p-4 shadow-menu">
					<ul role="listbox" aria-label={label} className="m-0 list-none p-0">
						{options.map((option) => (
							<li key={option.value} className={cn(option.divided === true && "mt-4 border-t-[0.5px] border-divider pt-4")}>
								<button
									type="button"
									role="option"
									aria-selected={option.value === value}
									data-testid={`${testId}-${option.value}`}
									className="flex w-full items-center gap-6 rounded-6 border-0 bg-transparent px-8 py-5 text-left text-meta text-ink whitespace-nowrap cursor-pointer hover:bg-hover"
									onClick={() => {
										onChange(option.value);
										setOpen(false);
									}}
								>
									{option.icon}
									<span className="flex flex-1 flex-col whitespace-nowrap">
										<span>{option.label}</span>
										{option.hint === undefined ? null : <span className="text-badge leading-[14px] text-ink-muted">{option.hint}</span>}
									</span>
									{option.value === value ? <CheckIcon size={12} className="text-accent-text" /> : <span className="w-12" />}
								</button>
							</li>
						))}
					</ul>
					{footer === undefined ? null : <div className="mt-4 border-t-[0.5px] border-divider pt-4">{footer(() => setOpen(false))}</div>}
				</div>
			) : null}
		</span>
	);
}
