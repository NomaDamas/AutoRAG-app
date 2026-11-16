import { Select } from "@base-ui/react";
import type { CSSProperties, ReactElement } from "react";

export interface SelectOption {
	readonly value: string;
	readonly label: string;
	readonly disabled?: boolean;
}

/** Base UI keeps `null` for "nothing chosen", so an option whose value is "" is carried under this key. */
const EMPTY = "\u0000empty";
const toInner = (value: string): string => (value.length === 0 ? EMPTY : value);
const toOuter = (value: string): string => (value === EMPTY ? "" : value);

/**
 * The one single-choice dropdown in Settings. The closed field keeps each page's own chrome (`className`, e.g.
 * `linear-select`); the open list is the 문서 읽기 popup (white card, 30px rows, ✓ on the chosen row) in every OS,
 * where a native `<select>` would draw the platform's own list.
 */
export function SelectField({
	value,
	options,
	onValueChange,
	className,
	style,
	disabled = false,
	name,
	title,
	"aria-label": ariaLabel,
	"data-testid": testId,
}: {
	readonly value: string;
	readonly options: readonly SelectOption[];
	readonly onValueChange: (value: string) => void;
	readonly className?: string;
	readonly style?: CSSProperties;
	readonly disabled?: boolean;
	readonly name?: string;
	readonly title?: string;
	readonly "aria-label"?: string;
	readonly "data-testid"?: string;
}): ReactElement {
	const current = options.find((option) => option.value === value);
	return (
		<Select.Root
			value={toInner(value)}
			onValueChange={(next) => {
				if (typeof next === "string" && toOuter(next) !== value) onValueChange(toOuter(next));
			}}
			disabled={disabled}
			name={name}
			modal={false}
		>
			<Select.Trigger className={className === undefined ? "select-field" : `select-field ${className}`} style={style} title={title} aria-label={ariaLabel} data-testid={testId} data-value={value}>
				<span className="select-field__value">{current?.label ?? ""}</span>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner className="select-field__positioner" side="bottom" align="start" sideOffset={4} alignItemWithTrigger={false}>
					<Select.Popup className="language-combobox__popup">
						<Select.List className="language-combobox__list">
							{options.map((option) => (
								<Select.Item key={option.value} className="language-combobox__item" value={toInner(option.value)} disabled={option.disabled} data-value={option.value}>
									<Select.ItemText>{option.label}</Select.ItemText>
									<Select.ItemIndicator className="language-combobox__indicator">✓</Select.ItemIndicator>
								</Select.Item>
							))}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
