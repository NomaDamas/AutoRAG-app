/**
 * 채팅 | 자동화 at the middle of the AI 에이전트 tab's head (Figma 672:3638, 672:3718): the two sides of one tab. The
 * side shown is a pill with a hairline, filled against its page (white on the chat's grey, grey on the white 자동화
 * page), in medium ink; the other is plain faint text.
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

export type AgentSide = "chat" | "automations";

export function AgentSegment({ value, onChange }: { readonly value: AgentSide; readonly onChange: (value: AgentSide) => void }): ReactElement {
	const { t } = useTranslation();
	const sides: readonly { readonly value: AgentSide; readonly label: string }[] = [
		{ value: "chat", label: t("aiSearch.segment.chat") },
		{ value: "automations", label: t("places.automations") },
	];
	return (
		<div role="tablist" aria-label={t("aiSearch.segment.label")} className="flex items-center" data-agent-segment={value}>
			{sides.map((side) => (
				<button
					key={side.value}
					type="button"
					role="tab"
					aria-selected={side.value === value}
					data-side={side.value}
					className={cn(
						"h-30 w-120 rounded-7 border-[0.5px] text-[13px] leading-[18px] cursor-pointer transition-colors duration-(--dur-color) ease-out",
						side.value === value
							? cn("border-border font-medium text-ink", value === "chat" ? "bg-window" : "bg-subtle-alt")
							: "border-transparent bg-transparent text-ink-faint hover:text-ink",
					)}
					onClick={() => {
						if (side.value !== value) onChange(side.value);
					}}
				>
					{side.label}
				</button>
			))}
		</div>
	);
}
