/**
 * 채팅 | 자동화 at the very middle of the AI 에이전트 tab's head: the two sides of one tab, so it reads as a switch
 * between two screens. Two plain tabs with no track or box, 22px apart: each a 13px glyph and its name, 32px tall.
 * The side shown is in ink and semibold over a 2px accent underline; the other is in muted ink, never faint, so it
 * still reads as something to press, and turns to ink on hover. It never shrinks or wraps: a narrow head cuts it.
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
		<div role="tablist" aria-label={t("aiSearch.segment.label")} className="inline-flex w-max flex-none items-end gap-22" data-agent-segment={value}>
			{sides.map((side) => (
				<button
					key={side.value}
					type="button"
					role="tab"
					aria-selected={side.value === value}
					data-side={side.value}
					className={cn(
						"inline-flex h-32 flex-none items-center justify-center gap-6 border-0 border-b-2 border-solid bg-transparent px-4 text-[13px] leading-[20px] whitespace-nowrap cursor-pointer transition-[color,border-color] duration-(--dur-color) ease-out",
						side.value === value ? "border-accent font-semibold text-ink" : "border-transparent font-medium text-ink-muted hover:text-ink",
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
