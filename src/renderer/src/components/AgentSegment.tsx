/**
 * 채팅 | 내 자동화 at the very middle of the AI 에이전트 tab's head: the two sides of one tab, so it reads as a switch
 * between two screens. Both sides sit in one grey track, each the same width (at least 112px, 28px tall) with a 13px
 * glyph and its name in medium weight; the side shown is raised on a light thumb with a soft shadow, the other is in
 * muted ink, never faint, so it still reads as something to press.
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
		<div role="tablist" aria-label={t("aiSearch.segment.label")} className="inline-flex items-center rounded-9 bg-segment-track p-3" data-agent-segment={value}>
			{sides.map((side) => (
				<button
					key={side.value}
					type="button"
					role="tab"
					aria-selected={side.value === value}
					data-side={side.value}
					className={cn(
						"inline-flex h-28 min-w-112 items-center justify-center gap-6 rounded-7 border-0 px-16 text-[13px] font-medium leading-[20px] whitespace-nowrap cursor-pointer transition-[background,color,box-shadow] duration-(--dur-color) ease-out",
						side.value === value ? "bg-segment-thumb text-ink shadow-segment-thumb" : "bg-transparent text-ink-muted hover:text-ink",
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
