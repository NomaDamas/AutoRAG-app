/**
 * shadcn/ui Switch (new-york-v4) adapted to our token CSS.
 *
 * Same Radix primitive and markup as the registry item (`radix-ui`
 * Root/Thumb, data-state attributes). The `settings-switch` /
 * `settings-switch__thumb` class names stay as stable selectors (QA drives
 * them); the shadcn Tailwind utilities resolve through the tokens.css bridge
 * to the v6 handoff tokens, not the shadcn palette
 * (#FF6363 checked / #CFCFD9 off).
 */

import type { ReactElement } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

export function Switch({
	checked,
	onChange,
	disabled = false,
	ariaLabel,
}: {
	readonly checked: boolean;
	readonly onChange: () => void;
	readonly disabled?: boolean | undefined;
	readonly ariaLabel?: string | undefined;
}): ReactElement {
	return (
		<SwitchPrimitive.Root
			className={cn(
				"settings-switch",
				"inline-flex shrink-0 items-center w-32 h-[18.4px] p-0 border border-solid border-transparent rounded-full outline-none bg-switch-off shadow-[0_1px_2px_0_rgba(0,0,0,0.05)] transition-all ease-in-out duration-(--dur-color)",
				"data-[state=checked]:bg-accent focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-flash-ring)] disabled:opacity-50 disabled:cursor-not-allowed",
			)}
			checked={checked}
			disabled={disabled}
			aria-label={ariaLabel}
			onCheckedChange={() => onChange()}
		>
			<SwitchPrimitive.Thumb
				className={cn(
					"settings-switch__thumb",
					"block size-16 rounded-full bg-window pointer-events-none shadow-none transition-transform ease-in-out duration-(--dur-color)",
					"data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-[calc(100%_-_2px)]",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}
