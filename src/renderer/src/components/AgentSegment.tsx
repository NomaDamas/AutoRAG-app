/**
 * 채팅 | 내 자동화 at the middle of the AI 에이전트 tab's head (Figma 672:3658): the two sides of one tab, each a 13px
 * glyph and its name. The side shown is a soft grey pill (the divider grey) with a hairline, in medium ink; the
 * other is the glyph and name in faint text, with no box. The pill fits its words: 31px tall, 14px either side.
 */

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { ChatBubbleIcon, ZapIcon } from "./icons";

export type AgentSide = "chat" | "automations";

export function AgentSegment({ value, onChange }: { readonly value: AgentSide; readonly onChange: (value: AgentSide) => void }): ReactElement {
	const { t } = useTranslation();
	const sides: readonly { readonly value: AgentSide; readonly label: string; readonly icon: ReactElement }[] = [
		{ value: "chat", label: t("aiSearch.segment.chat"), icon: <ChatBubbleIcon size={13} /> },
		{ value: "automations", label: t("aiSearch.segment.automations"), icon: <ZapIcon size={13} /> },
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
						"inline-flex h-31 items-center gap-6 rounded-7 border-[0.5px] px-14 text-[13px] leading-[20px] whitespace-nowrap cursor-pointer transition-colors duration-(--dur-color) ease-out",
						side.value === value ? "border-border bg-divider font-medium text-ink" : "border-transparent bg-transparent text-ink-faint hover:text-ink",
					)}
					onClick={() => {
						if (side.value !== value) onChange(side.value);
					}}
				>
					<span className="flex flex-none" aria-hidden="true">
						{side.icon}
					</span>
					{side.label}
				</button>
			))}
		</div>
	);
}
